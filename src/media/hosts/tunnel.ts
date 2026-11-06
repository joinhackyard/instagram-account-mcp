import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { randomToken } from "../../crypto.js";
import { IgError } from "../../errors.js";
import { log } from "../../log.js";
import type { HostCheck, HostedFile, MediaHost } from "../host.js";

interface Served {
  path: string;
  contentType: string;
  size: number;
  expiresAt: number;
}

const IDLE_MS = 10 * 60_000;

/** Where `setup` puts a downloaded cloudflared. */
export function bundledCloudflared(home: string): string {
  return join(home, "bin", platform() === "win32" ? "cloudflared.exe" : "cloudflared");
}

export function findCloudflared(home: string, configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const bundled = bundledCloudflared(home);
  if (existsSync(bundled)) return bundled;
  const exe = platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const dirs = (process.env.PATH ?? "").split(delimiter);
  if (platform() !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  for (const d of dirs) {
    const p = join(d, exe);
    if (d && existsSync(p)) return p;
  }
  return null;
}

/** Official release asset for this machine (github.com/cloudflare/cloudflared/releases). */
export function cloudflaredAsset(): { name: string; archive: boolean } | null {
  const a = arch() === "arm64" ? "arm64" : arch() === "x64" ? "amd64" : null;
  if (!a) return null;
  switch (platform()) {
    case "darwin":
      return { name: `cloudflared-darwin-${a}.tgz`, archive: true };
    case "linux":
      return { name: `cloudflared-linux-${a}`, archive: false };
    case "win32":
      return a === "amd64" ? { name: "cloudflared-windows-amd64.exe", archive: false } : null;
    default:
      return null;
  }
}

/** Download cloudflared from Cloudflare's GitHub releases into the data folder. */
export async function installCloudflared(home: string): Promise<string> {
  const asset = cloudflaredAsset();
  if (!asset)
    throw new IgError("not_configured", `No cloudflared build for ${platform()}/${arch()}.`, {
      hint: "Install it yourself: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    });
  const dest = bundledCloudflared(home);
  mkdirSync(join(home, "bin"), { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body)
    throw new IgError("network", `Downloading cloudflared failed: HTTP ${res.status}`, {
      retryable: true,
    });
  const tmp = `${dest}.download`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  if (asset.archive) {
    const r = spawnSync("tar", ["-xzf", tmp, "-C", join(home, "bin")], { encoding: "utf8" });
    rmSync(tmp, { force: true });
    if (r.status !== 0)
      throw new IgError("file_error", `Unpacking cloudflared failed: ${r.stderr}`);
  } else renameSync(tmp, dest);
  if (platform() !== "win32") chmodSync(dest, 0o755);
  const v = spawnSync(dest, ["--version"], { encoding: "utf8" });
  if (v.status !== 0) throw new IgError("file_error", "The downloaded cloudflared does not run.");
  return dest;
}

/**
 * Zero-setup media host: a local file server that only answers for registered files (random 128-bit paths),
 * exposed through a Cloudflare quick tunnel (https://<random>.trycloudflare.com). Nothing is stored online.
 * The tunnel starts on first use and stops when idle; this process must keep running until Meta has fetched
 * the file (the publish job waits for that).
 */
export class TunnelHost implements MediaHost {
  readonly kind = "tunnel" as const;
  private readonly files = new Map<string, Served>();
  private server?: Server;
  private proc?: ChildProcess;
  private publicBase?: string;
  private starting?: Promise<string>;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly home: string,
    private readonly ttlHours: number,
    private readonly cloudflaredPath?: string,
  ) {}

  async check(): Promise<HostCheck> {
    const bin = findCloudflared(this.home, this.cloudflaredPath);
    if (!bin)
      return {
        ok: false,
        detail: "cloudflared is not installed (needed for the tunnel media host).",
        fix: "Run `setup` (it can download it), or: brew install cloudflared / see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      };
    const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (v.status !== 0) return { ok: false, detail: `cloudflared at ${bin} does not run.` };
    return {
      ok: true,
      detail: `Cloudflare quick tunnel (${v.stdout.trim().split("\n")[0]}). This computer must be online while posts publish.`,
    };
  }

  private async startServer(): Promise<number> {
    if (this.server) return (this.server.address() as AddressInfo).port;
    const server = createServer((req, res) => {
      const m = /^\/m\/([\w-]{20,})\/[^/]*$/.exec((req.url ?? "").split("?")[0]);
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      const f = m ? this.files.get(m[1]) : undefined;
      if (!f || f.expiresAt < Date.now() || (req.method !== "GET" && req.method !== "HEAD")) {
        res.writeHead(404).end();
        return;
      }
      let start = 0;
      let end = f.size - 1;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        } else start = Math.max(0, f.size - Number(range[2]));
        if (start > end || start >= f.size) {
          res.writeHead(416, { "content-range": `bytes */${f.size}` }).end();
          return;
        }
      }
      const headers = {
        "content-type": f.contentType,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        ...(range ? { "content-range": `bytes ${start}-${end}/${f.size}` } : {}),
      };
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      log.debug("tunnel serving", { bytes: end - start + 1, ua: req.headers["user-agent"] });
      createReadStream(f.path, { start, end }).pipe(res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  /** Start (or reuse) the tunnel; resolves with the public base URL once it answers. */
  private ensureTunnel(): Promise<string> {
    if (this.publicBase && this.proc && this.proc.exitCode === null)
      return Promise.resolve(this.publicBase);
    this.starting ??= this.startTunnel().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async startTunnel(): Promise<string> {
    const bin = findCloudflared(this.home, this.cloudflaredPath);
    if (!bin)
      throw new IgError(
        "not_configured",
        "cloudflared is not installed, so local files cannot be published.",
        {
          hint: "Run `npx @joinhackyard/instagram-account-mcp setup` (it can download cloudflared), install it (brew install cloudflared), or configure an S3/R2/Azure media host.",
        },
      );
    const port = await this.startServer();
    const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.unref();
    const base = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        reject(
          new IgError("network", "The Cloudflare tunnel did not start within 45 seconds.", {
            retryable: true,
          }),
        );
      }, 45_000);
      const onData = (d: Buffer) => {
        buf += d.toString();
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
        if (buf.length > 100_000) buf = buf.slice(-10_000);
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new IgError("network", `cloudflared exited (${code}) before the tunnel was ready.`, {
            retryable: true,
          }),
        );
      });
    });
    // Quick tunnels take a few seconds before their hostname resolves everywhere.
    for (let i = 0; i < 20; i++) {
      const ok = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    proc.once("exit", () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.publicBase = undefined;
      }
    });
    this.publicBase = base;
    log.info("tunnel ready", { base });
    return base;
  }

  async put(localPath: string, contentType: string, name: string): Promise<HostedFile> {
    const base = await this.ensureTunnel();
    const f = this.register(localPath, contentType, name);
    return { ...f, url: `${base}${f.path}` };
  }

  /** Register a file on the local server (no tunnel); `path` is relative to the server root. */
  register(localPath: string, contentType: string, name: string) {
    const token = randomToken("", 24);
    const expiresAt = Date.now() + this.ttlHours * 3_600_000;
    this.files.set(token, {
      path: localPath,
      contentType,
      size: statSync(localPath).size,
      expiresAt,
    });
    this.armIdle();
    return {
      key: token,
      expiresAt,
      path: `/m/${token}/${encodeURIComponent(name.replace(/[^\w.-]/g, "_"))}`,
    };
  }

  /** Start the local file server only (tests, diagnostics). */
  async localPort(): Promise<number> {
    return this.startServer();
  }

  async remove(key: string): Promise<void> {
    this.files.delete(key);
    this.armIdle();
  }

  /** Stop the tunnel when nothing has been served for a while. */
  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.files.size) return;
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
    this.idleTimer.unref();
  }

  /** True if this process can still serve the key (tunnels die with the process). */
  serves(key: string): boolean {
    return this.files.has(key) && Boolean(this.proc && this.proc.exitCode === null);
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.proc?.kill();
    this.proc = undefined;
    this.publicBase = undefined;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }
}
