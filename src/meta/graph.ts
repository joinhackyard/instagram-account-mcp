import { classifyMetaError, errorFromResponse, IgError } from "../errors.js";
import { log } from "../log.js";

export type GraphHost = "facebook" | "instagram";

export const GRAPH_BASE: Record<GraphHost, string> = {
  facebook: "https://graph.facebook.com",
  instagram: "https://graph.instagram.com",
};

/** Usage percentages Meta reports in X-App-Usage / X-Business-Use-Case-Usage (0-100). */
export interface Usage {
  at: number;
  app?: { call_count?: number; total_cputime?: number; total_time?: number };
  business?: {
    type?: string;
    call_count?: number;
    total_cputime?: number;
    total_time?: number;
    estimated_time_to_regain_access?: number;
  }[];
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests replace the network. */
export function setGraphFetchForTests(f: typeof fetch | undefined) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}
export const graphFetch = (...a: Parameters<typeof fetch>) => fetchImpl(...a);

const lastUsage = new Map<string, Usage>();
export function usageFor(key: string): Usage | undefined {
  return lastUsage.get(key);
}

export function peakUsage(u?: Usage): number {
  if (!u) return 0;
  const vals = [
    u.app?.call_count,
    u.app?.total_cputime,
    u.app?.total_time,
    ...(u.business ?? []).flatMap((b) => [b.call_count, b.total_cputime, b.total_time]),
  ].filter((x): x is number => typeof x === "number");
  return vals.length ? Math.max(...vals) : 0;
}

type Params = Record<string, unknown>;

/** Graph parameters are strings; arrays and objects go as JSON (children, user_tags, trial_params...). */
export function encodeParams(params: Params = {}): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return q;
}

export interface Page<T> {
  data: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin Graph API client. One per account and host. Retries transient failures (network, 5xx, is_transient)
 * with backoff; never retries rate limits or the publishing limit in a loop.
 */
export class Graph {
  constructor(
    readonly host: GraphHost,
    readonly version: string,
    private readonly token: () => Promise<string>,
    /** Key for usage tracking, e.g. the IG user id. */
    readonly usageKey = "default",
    /** Called when Meta says the token is no longer valid (code 190), so the account can be flagged. */
    private readonly onAuthError?: (e: IgError) => void,
  ) {}

  get base() {
    return `${GRAPH_BASE[this.host]}/${this.version}`;
  }

  url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.base}/${path.replace(/^\/+/, "")}`;
  }

  async get<T = Record<string, unknown>>(path: string, params?: Params): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  async post<T = Record<string, unknown>>(
    path: string,
    params?: Params,
    opts?: { retry?: boolean },
  ): Promise<T> {
    return this.request<T>("POST", path, params, opts);
  }

  async delete<T = Record<string, unknown>>(path: string, params?: Params): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }

  /** Follow `paging.next` until `limit` items are collected (or pages run out). */
  async paginate<T>(path: string, params: Params, limit: number): Promise<T[]> {
    const out: T[] = [];
    let page = await this.get<Page<T>>(path, params);
    for (;;) {
      out.push(...(page.data ?? []));
      if (out.length >= limit || !page.paging?.next) break;
      page = await this.request<Page<T>>("GET", page.paging.next);
    }
    return out.slice(0, limit);
  }

  /** `retry: false` sends once (for calls that must never be repeated blindly, like media_publish). */
  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Params,
    opts: { retry?: boolean } = {},
  ): Promise<T> {
    const context = `${method} ${path.replace(/^https?:\/\/[^/]+/, "").split("?")[0]}`;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, params, context);
      } catch (e) {
        const err = classifyMetaError(e, context);
        if (err.code === "auth_expired" && err.opts.reason?.startsWith("190"))
          this.onAuthError?.(err);
        const transient = err.retryable && (err.code === "network" || err.code === "server_error");
        if (!transient || attempt >= 4 || opts.retry === false) throw err;
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
        log.debug("graph retry", { context, attempt, code: err.code, wait });
        await sleep(wait);
      }
    }
  }

  private async once<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Params | undefined,
    context: string,
  ): Promise<T> {
    const token = await this.token();
    const u = new URL(this.url(path));
    const body = encodeParams(params);
    let init: RequestInit;
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of body) u.searchParams.set(k, v);
      if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", token);
      init = { method };
    } else {
      if (!body.has("access_token")) body.set("access_token", token);
      init = {
        method,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      };
    }
    const res = await graphFetch(u, { ...init, signal: AbortSignal.timeout(120_000) });
    this.recordUsage(res);
    if (!res.ok) throw await errorFromResponse(res, context);
    const text = await res.text();
    if (!text) return {} as T;
    const data = JSON.parse(text) as T & { error?: unknown };
    if (data && typeof data === "object" && "error" in data && data.error)
      throw classifyMetaError({ status: res.status, error: data.error }, context);
    return data;
  }

  private recordUsage(res: Response) {
    try {
      const app = res.headers.get("x-app-usage");
      const biz = res.headers.get("x-business-use-case-usage");
      const ig = res.headers.get("x-ig-app-usage") ?? res.headers.get("x-ad-account-usage");
      if (!app && !biz && !ig) return;
      const u: Usage = { at: Date.now() };
      if (app) u.app = JSON.parse(app) as Usage["app"];
      else if (ig) u.app = JSON.parse(ig) as Usage["app"];
      if (biz) {
        const parsed = JSON.parse(biz) as Record<string, NonNullable<Usage["business"]>>;
        u.business = Object.values(parsed).flat();
      }
      lastUsage.set(this.usageKey, u);
      const peak = peakUsage(u);
      if (peak >= 90) log.warn("Meta API usage is high", { key: this.usageKey, peak });
    } catch {
      /* malformed header: ignore */
    }
  }
}

/** For calls made before an account exists (token exchange): explicit token, no retries needed. */
export async function graphJson<T>(
  url: string | URL,
  init?: RequestInit,
  context = "Meta request",
) {
  const res = await graphFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw await errorFromResponse(res, context);
  return (await res.json()) as T;
}

export function assertId(id: string | undefined, what: string): string {
  if (!id || !/^[\w.-]+$/.test(id))
    throw new IgError("invalid_request", `Missing or malformed ${what}.`);
  return id;
}
