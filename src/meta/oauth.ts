import type { AuthMode, Config } from "../config.js";
import { PACKAGE } from "../config.js";
import { IgError } from "../errors.js";
import { encodeParams, GRAPH_BASE, graphJson } from "./graph.js";

/**
 * Two ways to sign in, both official (developers.facebook.com/documentation/instagram-platform/overview):
 *
 * facebook  - Facebook Login for Business. The Instagram account is linked to a Facebook Page. Page tokens
 *             from a long-lived user token do not expire. Adds resumable video upload, delete, hashtag search,
 *             competitor lookup (Business Discovery) and Facebook-only insight metrics.
 * instagram - Instagram API with Instagram Login. No Facebook Page needed. 60-day tokens, refreshed
 *             automatically. Media must be fetched from a public URL.
 */
export const FACEBOOK_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "instagram_manage_messages",
  "instagram_manage_contents",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "business_management",
];

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  "instagram_business_manage_insights",
];

/** Without these the account is not usable at all. */
const REQUIRED: Record<AuthMode, string[]> = {
  facebook: ["instagram_basic", "instagram_content_publish", "pages_show_list"],
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
};

export interface StoredToken {
  /** page: Facebook Page token (Facebook Login). instagram: Instagram Login user token. */
  kind: "page" | "instagram";
  access_token: string;
  issued_at: number;
  /** ms epoch; absent = does not expire. */
  expires_at?: number;
  /** Facebook Login: the long-lived user token the Page token came from (used for revoke and /me calls). */
  user_token?: string;
  user_expires_at?: number;
}

export interface DiscoveredAccount {
  ig_user_id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
  followers_count?: number;
  auth_mode: AuthMode;
  page_id?: string;
  page_name?: string;
  scopes: string[];
  token: StoredToken;
}

export function redirectUriFor(cfg: Config): string {
  return cfg.meta.redirectUri ?? `http://localhost:${cfg.meta.redirectPort}/callback`;
}

function requireApp(cfg: Config): { appId: string; appSecret: string } {
  const { appId, appSecret } = cfg.meta;
  if (!appId || !appSecret)
    throw new IgError("not_configured", "Your Meta app is not configured yet.", {
      hint: `Run \`npx ${PACKAGE} setup\` in a terminal. It walks you through creating a free Meta app (about 5 minutes) and stores its ID and secret in your OS keychain.`,
    });
  return { appId, appSecret };
}

export function authorizeUrl(cfg: Config, redirectUri: string, state: string): string {
  const { appId } = requireApp(cfg);
  if (cfg.meta.authMode === "instagram") {
    const q = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
      enable_fb_login: "0",
      force_reauth: "true",
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  }
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  });
  if (cfg.meta.configId) q.set("config_id", cfg.meta.configId);
  else q.set("scope", FACEBOOK_SCOPES.join(","));
  return `https://www.facebook.com/${cfg.meta.graphVersion}/dialog/oauth?${q}`;
}

function missingScopes(mode: AuthMode, granted: string[]) {
  return REQUIRED[mode].filter((s) => !granted.includes(s));
}

/** Exchange the callback code and find every Instagram professional account it gives access to. */
export async function completeSignIn(
  cfg: Config,
  code: string,
  redirectUri: string,
): Promise<DiscoveredAccount[]> {
  if (!code) throw new IgError("cancelled", "The sign-in returned no code.");
  return cfg.meta.authMode === "instagram"
    ? instagramSignIn(cfg, code, redirectUri)
    : facebookSignIn(cfg, code, redirectUri);
}

async function facebookSignIn(
  cfg: Config,
  code: string,
  redirectUri: string,
): Promise<DiscoveredAccount[]> {
  const { appId, appSecret } = requireApp(cfg);
  const base = `${GRAPH_BASE.facebook}/${cfg.meta.graphVersion}`;
  const short = await graphJson<{ access_token: string }>(
    `${base}/oauth/access_token?${encodeParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`,
    undefined,
    "Facebook code exchange",
  );
  const long = await graphJson<{ access_token: string; expires_in?: number }>(
    `${base}/oauth/access_token?${encodeParams({ grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token })}`,
    undefined,
    "Facebook long-lived token",
  );
  const userToken = long.access_token;
  const now = Date.now();
  const userExpires = long.expires_in ? now + long.expires_in * 1000 : undefined;

  const perms = await graphJson<{ data: { permission: string; status: string }[] }>(
    `${base}/me/permissions?${encodeParams({ access_token: userToken })}`,
    undefined,
    "Facebook permissions",
  );
  const granted = perms.data.filter((p) => p.status === "granted").map((p) => p.permission);
  const missing = missingScopes("facebook", granted);
  if (missing.length)
    throw new IgError("forbidden", "Some required permissions were not granted.", {
      hint: `Connect again and allow every permission (and select your Page and Instagram account). Missing: ${missing.join(", ")}`,
    });

  type PageRow = {
    id: string;
    name: string;
    access_token?: string;
    instagram_business_account?: {
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
      followers_count?: number;
    };
  };
  const pages: PageRow[] = [];
  let next: string | undefined = `${base}/me/accounts?${encodeParams({
    fields:
      "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url,followers_count}",
    limit: 100,
    access_token: userToken,
  })}`;
  while (next && pages.length < 500) {
    const page: { data: PageRow[]; paging?: { next?: string } } = await graphJson(
      next,
      undefined,
      "Facebook Pages",
    );
    pages.push(...page.data);
    next = page.paging?.next;
  }
  const out: DiscoveredAccount[] = pages
    .filter((p) => p.instagram_business_account?.id && p.access_token)
    .map((p) => ({
      ig_user_id: p.instagram_business_account!.id,
      username: p.instagram_business_account!.username,
      name: p.instagram_business_account!.name,
      profile_picture_url: p.instagram_business_account!.profile_picture_url,
      followers_count: p.instagram_business_account!.followers_count,
      account_type: "BUSINESS_OR_CREATOR",
      auth_mode: "facebook" as const,
      page_id: p.id,
      page_name: p.name,
      scopes: granted,
      token: {
        kind: "page" as const,
        access_token: p.access_token!,
        issued_at: now,
        user_token: userToken,
        user_expires_at: userExpires,
      },
    }));
  if (!out.length)
    throw new IgError(
      "not_found",
      "No Instagram professional account is linked to the Pages you shared.",
      {
        hint: pages.length
          ? `Found Pages: ${pages.map((p) => p.name).join(", ")}. Link your Instagram account to one of them (Instagram app → Settings → Account type and tools, or Meta Business Suite → Settings → Instagram accounts), then connect again and select that Page.`
          : "No Facebook Pages were shared. Connect again and select the Page your Instagram account is linked to. Personal Instagram accounts must first switch to Business or Creator.",
      },
    );
  return out;
}

async function instagramSignIn(
  cfg: Config,
  code: string,
  redirectUri: string,
): Promise<DiscoveredAccount[]> {
  const { appId, appSecret } = requireApp(cfg);
  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const raw = await graphJson<{
    data?: { access_token: string; user_id: string | number; permissions?: string | string[] }[];
    access_token?: string;
    user_id?: string | number;
    permissions?: string | string[];
  }>(
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    "Instagram code exchange",
  );
  const first = raw.data?.[0] ?? raw;
  if (!first.access_token) throw new IgError("auth_expired", "Instagram returned no access token.");
  const perms = first.permissions;
  const granted = (Array.isArray(perms) ? perms : (perms ?? "").split(/[,\s]+/)).filter(Boolean);
  const missing = missingScopes("instagram", granted);
  if (granted.length && missing.length)
    throw new IgError("forbidden", "Some required permissions were not granted.", {
      hint: `Connect again and allow every permission. Missing: ${missing.join(", ")}`,
    });

  const long = await graphJson<{ access_token: string; expires_in?: number }>(
    `${GRAPH_BASE.instagram}/access_token?${encodeParams({ grant_type: "ig_exchange_token", client_secret: appSecret, access_token: first.access_token })}`,
    undefined,
    "Instagram long-lived token",
  );
  const now = Date.now();
  const me = await graphJson<{
    user_id?: string | number;
    id?: string;
    username?: string;
    name?: string;
    account_type?: string;
    profile_picture_url?: string;
    followers_count?: number;
  }>(
    `${GRAPH_BASE.instagram}/${cfg.meta.graphVersion}/me?${encodeParams({
      fields: "user_id,username,name,account_type,profile_picture_url,followers_count",
      access_token: long.access_token,
    })}`,
    undefined,
    "Instagram profile",
  );
  const igId = String(me.user_id ?? first.user_id ?? me.id ?? "");
  if (!igId) throw new IgError("unknown", "Could not read the Instagram account ID.");
  if (me.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(me.account_type))
    throw new IgError("forbidden", `@${me.username} is a personal account.`, {
      hint: "Switch it to a Professional account (Business or Creator) in the Instagram app: Settings → Account type and tools. It is free.",
    });
  return [
    {
      ig_user_id: igId,
      username: me.username,
      name: me.name,
      account_type: me.account_type,
      profile_picture_url: me.profile_picture_url,
      followers_count: me.followers_count,
      auth_mode: "instagram",
      scopes: granted.length ? granted : INSTAGRAM_SCOPES,
      token: {
        kind: "instagram",
        access_token: long.access_token,
        issued_at: now,
        expires_at: now + (long.expires_in ?? 60 * 86_400) * 1000,
      },
    },
  ];
}

/** Instagram Login tokens: refresh (must be at least 24 hours old and still valid) for another 60 days. */
export async function refreshInstagramToken(t: StoredToken): Promise<StoredToken> {
  if (t.kind !== "instagram") return t;
  const r = await graphJson<{ access_token: string; expires_in?: number }>(
    `${GRAPH_BASE.instagram}/refresh_access_token?${encodeParams({ grant_type: "ig_refresh_token", access_token: t.access_token })}`,
    undefined,
    "Instagram token refresh",
  );
  const now = Date.now();
  return {
    ...t,
    access_token: r.access_token,
    issued_at: now,
    expires_at: now + (r.expires_in ?? 60 * 86_400) * 1000,
  };
}

/** Facebook Login: remove the app's permissions for this user. Instagram Login has no revoke endpoint. */
export async function revokeToken(cfg: Config, t: StoredToken): Promise<void> {
  if (t.kind !== "page" || !t.user_token) return;
  await graphJson(
    `${GRAPH_BASE.facebook}/${cfg.meta.graphVersion}/me/permissions?${encodeParams({ access_token: t.user_token })}`,
    { method: "DELETE" },
    "Revoke permissions",
  );
}

/** What each login type can do (Meta's capability table), for clear errors before calling the API. */
export const CAPABILITIES = {
  resumableUpload: ["facebook"],
  deleteMedia: ["facebook"],
  hashtagSearch: ["facebook"],
  businessDiscovery: ["facebook"],
  productTags: ["facebook"],
} as const satisfies Record<string, readonly AuthMode[]>;

export function requireCapability(mode: AuthMode, cap: keyof typeof CAPABILITIES, what: string) {
  if (!(CAPABILITIES[cap] as readonly AuthMode[]).includes(mode))
    throw new IgError(
      "forbidden",
      `${what} is only available when the account is connected with Facebook Login.`,
      {
        hint: "Meta offers this only through Facebook Login for Business. Run `setup`, choose Facebook Login, and connect the account through its Facebook Page.",
      },
    );
}
