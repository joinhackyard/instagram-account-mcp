import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { IgError } from "../errors.js";

export function expandPath(p: string): string {
  const t = p.trim().replace(/^['"]|['"]$/g, "");
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? resolve(homedir(), t.slice(2)) : t;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Check a local media file exists and is within the size limit. */
export async function inspectLocalFile(
  path: string,
  maxBytes: number,
): Promise<{ path: string; size: number; mtimeMs: number }> {
  const full = expandPath(path);
  let s;
  try {
    s = await stat(full);
  } catch {
    throw new IgError("file_error", `File not found: ${full}`, {
      hint: "Pass an absolute path, e.g. ~/Pictures/launch.jpg.",
    });
  }
  if (!s.isFile()) throw new IgError("file_error", `Not a file: ${full}`);
  if (s.size === 0) throw new IgError("file_error", `File is empty: ${full}`);
  if (s.size > maxBytes)
    throw new IgError(
      "file_error",
      `File is ${(s.size / 1024 ** 2).toFixed(0)} MB; the limit is ${(maxBytes / 1024 ** 2).toFixed(0)} MB.`,
    );
  return { path: full, size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(v);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return isPrivateAddress(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return true;
  }
  return (
    v === "::1" ||
    v === "::" ||
    /^f[cd]/.test(v) ||
    /^fe[89ab]/.test(v) ||
    /^fe[c-f]/.test(v) ||
    v.startsWith("2002:") ||
    v.startsWith("ff")
  );
}

/** Validate a URL and return the (public) address to connect to, so DNS cannot change between check and connect. */
async function resolvePublic(raw: string): Promise<{ url: URL; address: string; family: number }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new IgError("invalid_request", `Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new IgError("invalid_request", "Only http(s) URLs can be fetched.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new IgError("invalid_request", `Cannot resolve ${host}.`);
  if (addrs.some((a) => isPrivateAddress(a.address)))
    throw new IgError(
      "forbidden",
      "URLs pointing at private or internal addresses are not allowed.",
    );
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

const STALL_MS = 60_000;

function request(
  target: { url: URL; address: string; family: number },
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((res, reject) => {
    const mod = target.url.protocol === "https:" ? https : http;
    const req = mod.get(
      target.url,
      {
        headers: { "User-Agent": "instagram-account-mcp" },
        signal,
        // Pin the connection to the address that passed the private-network check.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all
            ? cb(null, [{ address: target.address, family: target.family }])
            : cb(null, target.address, target.family)) as never,
      },
      res,
    );
    req.setTimeout(STALL_MS, () =>
      req.destroy(
        new IgError("network", "The download stalled for 60 seconds.", { retryable: true }),
      ),
    );
    req.on("error", reject);
  });
}

/** Download a public media URL to `dest`, following up to 5 redirects with SSRF checks on every hop. */
export async function downloadUrl(
  raw: string,
  dest: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ size: number; contentType: string | null; filename: string }> {
  let target = await resolvePublic(raw);
  let res: IncomingMessage | undefined;
  for (let hop = 0; hop < 6; hop++) {
    res = await request(target, signal);
    const loc = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
      res.resume();
      target = await resolvePublic(new URL(loc, target.url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.statusCode || res.statusCode >= 300) {
    res?.resume();
    throw new IgError(
      "file_error",
      `Download failed: HTTP ${res?.statusCode ?? "no response"} from ${target.url.hostname}.`,
      { retryable: (res?.statusCode ?? 0) >= 500 },
    );
  }
  const contentType = res.headers["content-type"] ?? null;
  if (contentType && /^text\/html/i.test(contentType)) {
    res.resume();
    throw new IgError("file_error", "That URL returned a web page, not a media file.", {
      hint: "Use a direct link to the image or video file.",
    });
  }
  const total = Number(res.headers["content-length"]) || null;
  if (total && total > maxBytes) {
    res.resume();
    throw new IgError("file_error", "The remote file is larger than the upload limit.");
  }
  let got = 0;
  res.on("data", (chunk: Buffer) => {
    got += chunk.length;
    if (got > maxBytes)
      res!.destroy(new IgError("file_error", "The remote file is larger than the upload limit."));
  });
  try {
    await pipeline(res, createWriteStream(dest));
  } catch (e) {
    await rm(dest, { force: true });
    throw e instanceof IgError
      ? e
      : new IgError("network", `Download interrupted: ${(e as Error).message}`, {
          retryable: true,
        });
  }
  let name = target.url.pathname.split("/").pop() || "media";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw name */
  }
  return { size: got, contentType, filename: name };
}

/** File extension for a download, from the URL or the content type. */
export function extensionFor(filename: string, contentType: string | null): string {
  const e = extname(filename).toLowerCase();
  if (e && e.length <= 5) return e;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("jpeg")) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("quicktime")) return ".mov";
  if (ct.includes("mp4")) return ".mp4";
  return ".bin";
}
