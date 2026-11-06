import type { AuthMode, Config } from "./config.js";
import { SECRET } from "./config.js";
import { newId } from "./crypto.js";
import type { Db } from "./db.js";
import { IgError } from "./errors.js";
import { log } from "./log.js";
import { Graph } from "./meta/graph.js";
import {
  refreshInstagramToken,
  revokeToken,
  type DiscoveredAccount,
  type StoredToken,
} from "./meta/oauth.js";
import type { TokenVault } from "./vault.js";

export interface AccountRow {
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  followers_count: number | null;
  auth_mode: AuthMode;
  page_id: string | null;
  page_name: string | null;
  app_id: string | null;
  scopes: string | null;
  token_expires_at: number | null;
  status: "ok" | "needs_reconnect";
  status_detail: string | null;
  is_default: number;
  connected_at: number;
  refreshed_at: number | null;
}

const DAY = 86_400_000;

export function describeAccount(a: AccountRow) {
  return {
    username: a.username ? `@${a.username}` : null,
    name: a.name,
    ig_user_id: a.ig_user_id,
    url: a.username ? `https://www.instagram.com/${a.username}/` : undefined,
    account_type: a.account_type ?? undefined,
    followers: a.followers_count ?? undefined,
    login: a.auth_mode === "facebook" ? "Facebook Login (via Page)" : "Instagram Login",
    facebook_page: a.page_name ?? undefined,
    token_expires: a.token_expires_at ? new Date(a.token_expires_at).toISOString() : "never",
    default: Boolean(a.is_default),
    status: a.status,
    status_detail: a.status_detail ?? undefined,
    connected_at: new Date(a.connected_at).toISOString(),
  };
}

export class Accounts {
  private readonly clients = new Map<string, Graph>();
  private readonly refreshing = new Map<string, Promise<StoredToken>>();

  constructor(
    private readonly db: Db,
    private readonly vault: TokenVault,
    private readonly cfg: Config,
  ) {}

  list(): AccountRow[] {
    return this.db.all<AccountRow>("select * from accounts order by is_default desc, connected_at");
  }

  byRowId(rowId: string): AccountRow | undefined {
    return this.db.get<AccountRow>("select * from accounts where id = ?", rowId);
  }

  /** Resolve by @username, username, IG user id or name; the default account when `ref` is empty. */
  resolve(ref?: string | null): AccountRow {
    const all = this.list();
    if (!all.length)
      throw new IgError("not_connected", "No Instagram account is connected yet.", {
        hint: "Call connect_account and finish the sign-in in the browser.",
      });
    let found: AccountRow | undefined;
    if (ref) {
      const r = ref.trim().replace(/^@/, "").toLowerCase();
      found =
        all.find((a) => a.ig_user_id === r || a.id.toLowerCase() === r) ??
        all.find((a) => (a.username ?? "").toLowerCase() === r) ??
        all.find((a) => (a.name ?? "").toLowerCase() === r) ??
        all.find((a) => (a.name ?? "").toLowerCase().includes(r));
      if (!found)
        throw new IgError("not_found", `No connected account matches "${ref}".`, {
          hint: `Connected: ${all.map((a) => `@${a.username}`).join(", ")}`,
        });
    } else found = all.find((a) => a.is_default) ?? all[0];
    if (found.status === "needs_reconnect")
      throw new IgError("auth_expired", `The sign-in for @${found.username} has expired.`, {
        hint: "Call connect_account to sign in again. Scheduled and unfinished posts continue after reconnecting.",
      });
    return found;
  }

  /** Graph client for an account, on the host its login type uses. Tokens refresh themselves. */
  client(row: AccountRow): Graph {
    const cached = this.clients.get(row.id);
    if (cached) return cached;
    const g = new Graph(
      row.auth_mode === "instagram" ? "instagram" : "facebook",
      this.cfg.meta.graphVersion,
      () => this.accessToken(row.id),
      row.ig_user_id,
      (e) => this.markNeedsReconnect(row.id, e.message),
    );
    this.clients.set(row.id, g);
    return g;
  }

  async storedToken(rowId: string): Promise<StoredToken> {
    const raw = await this.vault.get(SECRET.accountToken(rowId));
    if (!raw) {
      this.markNeedsReconnect(rowId, "No stored token");
      throw new IgError("auth_expired", "No stored Instagram token for this account.", {
        hint: "Call connect_account to sign in again.",
      });
    }
    return JSON.parse(raw) as StoredToken;
  }

  /** Current access token; refreshes Instagram Login tokens well before their 60 days run out. */
  async accessToken(rowId: string): Promise<string> {
    const t = await this.storedToken(rowId);
    const now = Date.now();
    if (t.kind === "instagram" && t.expires_at) {
      if (t.expires_at <= now) {
        this.markNeedsReconnect(rowId, "Instagram token expired");
        throw new IgError("auth_expired", "The Instagram token expired (60 days without use).", {
          hint: "Call connect_account to sign in again.",
        });
      }
      // Meta only refreshes tokens older than 24 hours.
      if (now - t.issued_at > DAY && t.expires_at - now < 30 * DAY) {
        try {
          return (await this.refresh(rowId, t)).access_token;
        } catch (e) {
          log.warn("instagram token refresh failed; using the current token", { error: String(e) });
        }
      }
    }
    return t.access_token;
  }

  private refresh(rowId: string, t: StoredToken): Promise<StoredToken> {
    const running = this.refreshing.get(rowId);
    if (running) return running;
    const p = (async () => {
      const fresh = await refreshInstagramToken(t);
      await this.vault.set(SECRET.accountToken(rowId), JSON.stringify(fresh));
      this.db.run(
        "update accounts set token_expires_at = ?, refreshed_at = ? where id = ?",
        fresh.expires_at ?? null,
        Date.now(),
        rowId,
      );
      return fresh;
    })().finally(() => this.refreshing.delete(rowId));
    this.refreshing.set(rowId, p);
    return p;
  }

  /** Refresh every Instagram Login token that is due. Run by the scheduler, so idle accounts stay signed in. */
  async refreshDue(): Promise<void> {
    for (const a of this.list()) {
      if (a.auth_mode !== "instagram" || a.status !== "ok") continue;
      await this.accessToken(a.id).catch((e) =>
        log.warn("token refresh check failed", { account: a.username, error: String(e) }),
      );
    }
  }

  markNeedsReconnect(rowId: string, detail: string) {
    this.clients.delete(rowId);
    this.db.run(
      "update accounts set status = 'needs_reconnect', status_detail = ? where id = ?",
      detail,
      rowId,
    );
    log.warn("account needs reconnect", { rowId, detail });
  }

  /** Upsert the accounts a sign-in returned. */
  async saveDiscovered(found: DiscoveredAccount[]): Promise<AccountRow[]> {
    const rows: AccountRow[] = [];
    for (const d of found) {
      const existing = this.db.get<AccountRow>(
        "select * from accounts where ig_user_id = ?",
        d.ig_user_id,
      );
      const rowId = existing?.id ?? newId();
      const hasDefault = this.db.get("select 1 from accounts where is_default = 1");
      const fields = [
        d.username ?? null,
        d.name ?? null,
        d.profile_picture_url ?? null,
        d.account_type ?? null,
        d.followers_count ?? null,
        d.auth_mode,
        d.page_id ?? null,
        d.page_name ?? null,
        this.cfg.meta.appId ?? null,
        d.scopes.join(","),
        d.token.expires_at ?? null,
      ] as const;
      if (existing)
        this.db.run(
          `update accounts set username = ?, name = ?, profile_picture_url = ?, account_type = ?, followers_count = ?,
             auth_mode = ?, page_id = ?, page_name = ?, app_id = ?, scopes = ?, token_expires_at = ?,
             status = 'ok', status_detail = null, refreshed_at = ? where id = ?`,
          ...fields,
          Date.now(),
          rowId,
        );
      else
        this.db.run(
          `insert into accounts(id, ig_user_id, username, name, profile_picture_url, account_type, followers_count,
             auth_mode, page_id, page_name, app_id, scopes, token_expires_at, is_default, connected_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rowId,
          d.ig_user_id,
          ...fields,
          hasDefault ? 0 : 1,
          Date.now(),
        );
      await this.vault.set(SECRET.accountToken(rowId), JSON.stringify(d.token));
      this.clients.delete(rowId);
      this.db.audit("account.connected", { username: d.username, mode: d.auth_mode }, d.ig_user_id);
      rows.push(this.byRowId(rowId)!);
    }
    return rows;
  }

  /** Refresh cached profile fields (followers, picture). */
  async refreshProfile(row: AccountRow): Promise<AccountRow> {
    const p = await this.client(row).get<{
      username?: string;
      name?: string;
      profile_picture_url?: string;
      followers_count?: number;
    }>(row.ig_user_id, { fields: "username,name,profile_picture_url,followers_count" });
    this.db.run(
      "update accounts set username = coalesce(?, username), name = coalesce(?, name), profile_picture_url = coalesce(?, profile_picture_url), followers_count = coalesce(?, followers_count) where id = ?",
      p.username ?? null,
      p.name ?? null,
      p.profile_picture_url ?? null,
      p.followers_count ?? null,
      row.id,
    );
    return this.byRowId(row.id)!;
  }

  setDefault(rowId: string) {
    this.db.run("update accounts set is_default = case when id = ? then 1 else 0 end", rowId);
  }

  async disconnect(rowId: string, revoke = false) {
    const row = this.byRowId(rowId);
    if (!row) throw new IgError("not_found", "Account not found.");
    if (revoke) {
      const t = await this.storedToken(rowId).catch(() => null);
      if (t)
        await revokeToken(this.cfg, t).catch((e) =>
          log.warn("token revoke failed", { error: String(e) }),
        );
    }
    await this.vault.delete(SECRET.accountToken(rowId));
    this.clients.delete(rowId);
    this.db.tx(() => {
      this.db.run("delete from accounts where id = ?", rowId);
      if (row.is_default)
        this.db.run(
          "update accounts set is_default = 1 where id = (select id from accounts order by connected_at limit 1)",
        );
    });
    this.db.audit("account.disconnected", { username: row.username }, row.ig_user_id);
  }
}
