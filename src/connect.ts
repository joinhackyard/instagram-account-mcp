import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AccountRow, Accounts } from "./accounts.js";
import type { Config } from "./config.js";
import { randomToken } from "./crypto.js";
import { IgError } from "./errors.js";
import { authorizeUrl, completeSignIn, redirectUriFor } from "./meta/oauth.js";
import { log } from "./log.js";

export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}

const page = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8edf5;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:440px;padding:40px}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#a7b0c0;margin:0}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Pending {
  url: string;
  state: string;
  redirectUri: string;
  done: Promise<AccountRow[]>;
  settle: (u: URL) => Promise<{ ok: boolean; title: string; body: string }>;
  server?: Server;
  startedAt: number;
}

/** http://localhost:<port>/... or http://127.0.0.1:<port>/... can be caught by a loopback server. */
export function loopbackPort(redirectUri: string): number | null {
  const u = new URL(redirectUri);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname)) return null;
  return Number(u.port || 80);
}

/**
 * Meta sign-in. Meta only accepts redirect URIs registered in the app (port included), so the URI is fixed
 * (default http://localhost:8765/callback). When it is a plain-http localhost URI, a one-shot loopback server
 * catches the callback. Otherwise (e.g. Meta insisted on https) the user pastes the address-bar URL of the
 * page they land on into complete_connect. Random state; closes after one callback or 10 minutes.
 */
export class Connector {
  private pending?: Pending;

  constructor(
    private readonly cfg: Config,
    private readonly accounts: Accounts,
    private readonly onConnected: (rows: AccountRow[]) => void,
  ) {}

  /** Stop a pending sign-in (its loopback server would otherwise keep the process alive). */
  close() {
    this.pending?.server?.close();
    this.pending = undefined;
  }

  async start(): Promise<{
    url: string;
    done: Promise<AccountRow[]>;
    reused: boolean;
    redirectUri: string;
    listening: boolean;
  }> {
    const redirectUri = redirectUriFor(this.cfg);
    if (
      this.pending &&
      this.pending.redirectUri === redirectUri &&
      Date.now() - this.pending.startedAt < 9 * 60_000
    ) {
      const p = this.pending;
      return { url: p.url, done: p.done, reused: true, redirectUri, listening: Boolean(p.server) };
    }
    this.close();
    const state = randomToken("", 24);
    const url = authorizeUrl(this.cfg, redirectUri, state); // throws when the app is not configured

    let resolveDone!: (rows: AccountRow[]) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<AccountRow[]>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let handled = false;
    const timer = setTimeout(() => {
      this.close();
      rejectDone(
        new IgError("cancelled", "Sign-in timed out after 10 minutes.", {
          hint: "Run connect_account again.",
        }),
      );
    }, 10 * 60_000);
    timer.unref();

    const settle = async (u: URL) => {
      if (handled) return { ok: true, title: "Already handled", body: "You can close this tab." };
      // Instagram appends "#_" to the redirect; the state survives in the query string.
      if (u.searchParams.get("state") !== state)
        return { ok: false, title: "Sign-in link mismatch", body: "Start again from your AI app." };
      handled = true;
      clearTimeout(timer);
      const err =
        u.searchParams.get("error_description") ??
        u.searchParams.get("error_reason") ??
        u.searchParams.get("error");
      if (err) {
        rejectDone(new IgError("cancelled", `Sign-in was cancelled (${err}).`));
        return { ok: false, title: "Sign-in cancelled", body: escapeHtml(err) };
      }
      try {
        const code = (u.searchParams.get("code") ?? "").replace(/#_$/, "");
        const found = await completeSignIn(this.cfg, code, redirectUri);
        const rows = await this.accounts.saveDiscovered(found);
        this.onConnected(rows);
        resolveDone(rows);
        return {
          ok: true,
          title: `Connected ${escapeHtml(rows.map((r) => `@${r.username}`).join(", "))}`,
          body: "You can close this tab and go back to your AI app.",
        };
      } catch (e) {
        const y = e instanceof IgError ? e : new IgError("unknown", String(e));
        rejectDone(y);
        return {
          ok: false,
          title: "Could not connect",
          body: escapeHtml(`${y.message} ${y.hint ?? ""}`),
        };
      }
    };

    let server: Server | undefined;
    const port = loopbackPort(redirectUri);
    if (port) {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once("error", (e: NodeJS.ErrnoException) =>
          reject(
            e.code === "EADDRINUSE"
              ? new IgError(
                  "invalid_request",
                  `Port ${port} is busy, so the sign-in callback cannot be received.`,
                  {
                    hint: "Close whatever uses it, or set IG_REDIRECT_PORT to a free port and register http://localhost:<port>/callback in your Meta app.",
                  },
                )
              : e,
          ),
        );
        server!.listen(port, "127.0.0.1", () => resolve());
      });
      const path = new URL(redirectUri).pathname;
      server.on("request", async (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        if (u.pathname !== path) {
          res.writeHead(404).end();
          return;
        }
        const r = await settle(u);
        res
          .writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page(r.title, r.body));
        if (handled) server?.close();
      });
    }

    void done
      .catch((e) => log.warn("connect failed", { error: String(e) }))
      .finally(() => {
        clearTimeout(timer);
        if (this.pending?.state === state) {
          this.pending.server?.close();
          this.pending = undefined;
        }
      });
    this.pending = { url, state, redirectUri, done, settle, server, startedAt: Date.now() };
    return { url, done, reused: false, redirectUri, listening: Boolean(server) };
  }

  /** Finish a sign-in with the URL the browser landed on (when the callback could not be caught). */
  async complete(callbackUrl: string): Promise<AccountRow[]> {
    const p = this.pending;
    if (!p)
      throw new IgError("invalid_request", "No sign-in is in progress.", {
        hint: "Call connect_account first, sign in, then pass the address-bar URL you land on.",
      });
    let u: URL;
    try {
      u = new URL(callbackUrl.trim().replace(/#_$/, ""));
    } catch {
      throw new IgError(
        "invalid_request",
        "That is not a URL. Paste the full address from the browser's address bar.",
      );
    }
    const r = await p.settle(u);
    if (!r.ok && r.title === "Sign-in link mismatch")
      throw new IgError("invalid_request", "That URL belongs to a different sign-in attempt.", {
        hint: "Use the URL from the most recent connect_account link.",
      });
    return p.done;
  }
}
