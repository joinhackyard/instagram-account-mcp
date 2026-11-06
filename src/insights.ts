import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AuthMode } from "./config.js";
import type { Db } from "./db.js";
import { IgError } from "./errors.js";
import { compactMedia, listMedia, productOf, type ProductType, type RawMedia } from "./library.js";
import type { Graph } from "./meta/graph.js";

/**
 * Media metrics per product type (Meta's IG Media Insights reference, 2026). `impressions`, `plays` and
 * `video_views` are gone; `views` replaces them. Album children have no insights; stories with fewer than
 * 5 viewers return an error.
 */
export const MEDIA_METRICS: Record<ProductType, string[]> = {
  FEED: [
    "views",
    "reach",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "follows",
    "profile_visits",
  ],
  REELS: [
    "views",
    "reach",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "ig_reels_avg_watch_time",
    "ig_reels_video_view_total_time",
    "reels_skip_rate",
  ],
  STORY: [
    "views",
    "reach",
    "shares",
    "total_interactions",
    "follows",
    "profile_visits",
    "navigation",
    "replies",
  ],
};

/** Newer metrics: asked for, and dropped quietly if this API version or host refuses them. */
export const OPTIONAL_MEDIA_METRICS: Record<ProductType, string[]> = {
  FEED: ["reposts"],
  REELS: ["reposts"],
  STORY: ["reposts", "link_clicks"],
};

export function metricsFor(productType: ProductType): string[] {
  return [...MEDIA_METRICS[productType], ...OPTIONAL_MEDIA_METRICS[productType]];
}

interface InsightRow {
  name: string;
  period?: string;
  values?: { value: unknown; end_time?: string }[];
  total_value?: {
    value?: unknown;
    breakdowns?: {
      dimension_keys?: string[];
      results?: { dimension_values: string[]; value: number }[];
    }[];
  };
}

function numeric(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function parseMediaInsights(data: InsightRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of data) {
    const v = numeric(row.total_value?.value) ?? numeric(row.values?.[0]?.value);
    if (v !== undefined) out[row.name] = v;
  }
  return out;
}

/**
 * Which metrics Meta refused. Its error usually lists the valid values ("metric[3] must be one of the
 * following values: ...") or names the bad metric; otherwise drop the optional ones.
 */
export function refusedMetrics(message: string, asked: string[], optional: string[]): string[] {
  const m = /must be one of the following values:\s*([\w,\s]+)/i.exec(message);
  if (m) {
    const valid = new Set(m[1].split(/[,\s]+/).filter(Boolean));
    const bad = asked.filter((x) => !valid.has(x));
    if (bad.length && bad.length < asked.length) return bad;
  }
  const named = asked.filter((x) => new RegExp(`\\b${x}\\b`).test(message));
  if (named.length && named.length < asked.length) return named;
  return optional.filter((x) => asked.includes(x));
}

/**
 * Lifetime insights for one post. Only metrics valid for its product type are requested; if Meta refuses
 * some (error 100), they are dropped and the call is retried once.
 */
export async function mediaInsights(
  graph: Graph,
  mediaId: string,
  productType: ProductType,
  _mode: AuthMode,
): Promise<Record<string, number>> {
  const asked = metricsFor(productType);
  const call = (metrics: string[]) =>
    graph.get<{ data: InsightRow[] }>(`${mediaId}/insights`, { metric: metrics.join(",") });
  try {
    return parseMediaInsights((await call(asked)).data ?? []);
  } catch (e) {
    if (!(e instanceof IgError) || e.code !== "invalid_request") throw e;
    const drop = refusedMetrics(e.message, asked, OPTIONAL_MEDIA_METRICS[productType]);
    const retry = asked.filter((x) => !drop.includes(x));
    if (!drop.length || !retry.length) throw e;
    return parseMediaInsights((await call(retry)).data ?? []);
  }
}

/** mediaInsights with a short cache (insights move slowly; analysis tools read many posts). */
export async function cachedMediaInsights(
  db: Db | undefined,
  graph: Graph,
  mediaId: string,
  productType: ProductType,
  mode: AuthMode,
  maxAgeMs = 3 * 3_600_000,
): Promise<Record<string, number>> {
  const key = `insights:media:${mediaId}`;
  const hit = db?.cached<Record<string, number>>(key, maxAgeMs);
  if (hit) return hit;
  const v = await mediaInsights(graph, mediaId, productType, mode);
  db?.putCache(key, v);
  return v;
}

export interface MediaWithMetrics {
  id: string;
  product: ProductType;
  type: string;
  timestamp?: string;
  permalink?: string;
  caption?: string;
  metrics: Record<string, number>;
  error?: string;
}

/** Insights for many posts; failures (e.g. too-small stories) are reported per post, never fatal. */
export async function insightsForMedia(
  db: Db | undefined,
  graph: Graph,
  media: RawMedia[],
  mode: AuthMode,
): Promise<MediaWithMetrics[]> {
  const out: MediaWithMetrics[] = [];
  for (const m of media) {
    const c = compactMedia(m, 120);
    const base = {
      id: m.id,
      product: productOf(m),
      type: c.type,
      timestamp: m.timestamp,
      permalink: m.permalink,
      caption: c.caption,
    };
    try {
      out.push({
        ...base,
        metrics: await cachedMediaInsights(db, graph, m.id, base.product, mode),
      });
    } catch (e) {
      if (e instanceof IgError && (e.code === "auth_expired" || e.code === "rate_limited")) throw e;
      out.push({ ...base, metrics: {}, error: (e as Error).message });
    }
  }
  return out;
}

// ---- account insights ------------------------------------------------------------------------------

export const ACCOUNT_METRICS = [
  "reach",
  "views",
  "accounts_engaged",
  "total_interactions",
  "likes",
  "comments",
  "saves",
  "shares",
  "replies",
  "reposts",
  "follows_and_unfollows",
  "profile_links_taps",
] as const;

export interface AccountInsightsQuery {
  metrics: string[];
  period?: "day" | "week" | "days_28" | "lifetime";
  metric_type?: "total_value" | "time_series";
  breakdown?: string;
  timeframe?: string;
  since?: string;
  until?: string;
}

export interface AccountMetric {
  metric: string;
  total?: number;
  series?: { date: string; value: number }[];
  breakdown?: { key: string; value: number }[];
  /** Meta refused this metric for this account / API version. */
  unavailable?: boolean;
}

const toUnix = (d: string) => Math.floor(Date.parse(d) / 1000);

export function parseAccountInsights(data: InsightRow[]): AccountMetric[] {
  return data.map((row) => {
    const out: AccountMetric = { metric: row.name };
    const total = numeric(row.total_value?.value);
    if (total !== undefined) out.total = total;
    const results = row.total_value?.breakdowns?.[0]?.results;
    if (results?.length)
      out.breakdown = results
        .map((r) => ({ key: r.dimension_values.join(" / "), value: r.value }))
        .sort((a, b) => b.value - a.value);
    const vals = row.values?.filter((v) => numeric(v.value) !== undefined);
    if (vals?.length && out.total === undefined && !out.breakdown)
      out.series = vals.map((v) => ({
        date: (v.end_time ?? "").slice(0, 10),
        value: numeric(v.value)!,
      }));
    return out;
  });
}

export async function accountInsights(
  graph: Graph,
  igId: string,
  q: AccountInsightsQuery,
): Promise<AccountMetric[]> {
  const params: Record<string, unknown> = {
    metric: q.metrics.join(","),
    period: q.period ?? "day",
    metric_type: q.metric_type,
    breakdown: q.breakdown,
    timeframe: q.timeframe,
  };
  // Meta allows at most 30 days between since and until.
  if (q.since) params.since = toUnix(q.since);
  if (q.until) params.until = toUnix(q.until);
  if (q.since && q.until && toUnix(q.until) - toUnix(q.since) > 30 * 86_400)
    throw new IgError("invalid_request", "Account insights cover at most 30 days per request.", {
      hint: "Use a shorter range, or call several times.",
    });
  const call = (metrics: string[]) =>
    graph.get<{ data: InsightRow[] }>(`${igId}/insights`, { ...params, metric: metrics.join(",") });
  try {
    return parseAccountInsights((await call(q.metrics)).data ?? []);
  } catch (e) {
    if (!(e instanceof IgError) || e.code !== "invalid_request" || q.metrics.length < 2) throw e;
    const drop = refusedMetrics(e.message, q.metrics, ["reposts", "replies"]);
    const retry = q.metrics.filter((x) => !drop.includes(x));
    if (!drop.length || !retry.length) throw e;
    const r = parseAccountInsights((await call(retry)).data ?? []);
    return [...r, ...drop.map((m) => ({ metric: m, unavailable: true }))];
  }
}

export type Preset = "overview" | "daily" | "reach_breakdown" | "follows";

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Ready-made account reports (last `days` days, up to 30). */
export async function accountPreset(
  graph: Graph,
  igId: string,
  preset: Preset,
  days = 28,
): Promise<Record<string, unknown>> {
  const d = Math.min(Math.max(days, 1), 30);
  const until = isoDay(Date.now());
  const since = isoDay(Date.now() - d * 86_400_000);
  const range = { since, until };
  switch (preset) {
    case "overview":
      return {
        range,
        metrics: await accountInsights(graph, igId, {
          metrics: [...ACCOUNT_METRICS],
          period: "day",
          metric_type: "total_value",
          ...range,
        }),
      };
    case "daily":
      return {
        range,
        metrics: await accountInsights(graph, igId, {
          metrics: ["reach"],
          period: "day",
          metric_type: "time_series",
          ...range,
        }),
      };
    case "reach_breakdown": {
      const [byProduct, byFollow] = await Promise.all([
        accountInsights(graph, igId, {
          metrics: ["reach"],
          period: "day",
          metric_type: "total_value",
          breakdown: "media_product_type",
          ...range,
        }),
        accountInsights(graph, igId, {
          metrics: ["reach"],
          period: "day",
          metric_type: "total_value",
          breakdown: "follow_type",
          ...range,
        }),
      ]);
      return {
        range,
        by_product_type: byProduct[0]?.breakdown,
        by_follow_type: byFollow[0]?.breakdown,
      };
    }
    case "follows":
      return {
        range,
        metrics: await accountInsights(graph, igId, {
          metrics: ["follows_and_unfollows"],
          period: "day",
          metric_type: "total_value",
          breakdown: "follow_type",
          ...range,
        }),
      };
  }
}

export type DemoBreakdown = "age" | "city" | "country" | "gender";

/** Who follows (or engages with) the account. Needs 100+ followers; Meta returns the top 45 per breakdown. */
export async function audience(
  graph: Graph,
  igId: string,
  o: {
    who: "followers" | "engaged";
    breakdowns: DemoBreakdown[];
    timeframe?: "this_week" | "this_month";
    top?: number;
  },
): Promise<Record<string, { key: string; value: number; share: number }[]>> {
  const metric = o.who === "engaged" ? "engaged_audience_demographics" : "follower_demographics";
  const out: Record<string, { key: string; value: number; share: number }[]> = {};
  for (const b of o.breakdowns) {
    const r = await accountInsights(graph, igId, {
      metrics: [metric],
      period: "lifetime",
      metric_type: "total_value",
      breakdown: b,
      timeframe: o.timeframe ?? "this_month",
    });
    const rows = r[0]?.breakdown ?? [];
    const sum = rows.reduce((n, x) => n + x.value, 0) || 1;
    out[b] = rows
      .slice(0, o.top ?? 15)
      .map((x) => ({ ...x, share: Math.round((x.value / sum) * 1000) / 10 }));
  }
  return out;
}

// ---- export -------------------------------------------------------------------------------------------

export const EXPORT_COLUMNS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "total_interactions",
  "follows",
  "profile_visits",
  "ig_reels_avg_watch_time",
  "reels_skip_rate",
] as const;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with = + - @, tab or CR; captions
 * and comments come from strangers) gets a leading apostrophe so it is shown as text. Numbers stay numbers.
 */
export function csvCell(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: MediaWithMetrics[]): string {
  const head = [
    "id",
    "timestamp",
    "product",
    "type",
    "permalink",
    "caption",
    ...EXPORT_COLUMNS,
    "error",
  ];
  const lines = rows.map((r) =>
    [
      r.id,
      r.timestamp,
      r.product,
      r.type,
      r.permalink,
      r.caption,
      ...EXPORT_COLUMNS.map((c) => r.metrics[c]),
      r.error,
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

export interface ExportPlan {
  path: string;
  /** False when the file goes outside <data folder>/exports, which needs the user's approval. */
  insideExports: boolean;
}

/** Add -1, -2, ... before the extension until the name is free: exports never overwrite a file. */
export function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const c = `${stem}-${i}${ext}`;
    if (!existsSync(c)) return c;
  }
  throw new IgError("file_error", `Too many files named like ${basename(p)}.`, {
    hint: "Choose another file name.",
  });
}

/**
 * Where an export goes. Default and relative paths land in <home>/exports. "~/..." expands to the home
 * folder; "~user" forms are refused. Always a .csv, never an existing file.
 */
export function planExportPath(home: string, given?: string, now = new Date()): ExportPlan {
  const exportsDir = resolve(home, "exports");
  let p: string;
  if (!given?.trim()) p = join(exportsDir, `insights-${now.toISOString().slice(0, 10)}.csv`);
  else {
    const g = given.trim();
    if (g.startsWith("~") && g !== "~" && !g.startsWith("~/"))
      throw new IgError("invalid_request", 'Only "~/..." paths are supported, not "~user".', {
        hint: "Give an absolute path, a path starting with ~/, or a bare file name (saved in the exports folder).",
      });
    if (g === "~") throw new IgError("invalid_request", "Give a file name, not just ~.");
    const expanded = g.startsWith("~/") ? join(homedir(), g.slice(2)) : g;
    p = isAbsolute(expanded) ? resolve(expanded) : resolve(exportsDir, expanded);
    if (g.endsWith("/") || g.endsWith("\\"))
      p = join(p, `insights-${now.toISOString().slice(0, 10)}.csv`);
    if (extname(p).toLowerCase() !== ".csv") p = `${p}.csv`;
  }
  const rel = relative(exportsDir, p);
  const insideExports = !rel.startsWith("..") && !isAbsolute(rel) && rel !== "";
  return { path: uniquePath(p), insideExports };
}

export async function exportInsights(
  db: Db,
  graph: Graph,
  igId: string,
  mode: AuthMode,
  o: { path: string; limit?: number; since?: string; until?: string },
): Promise<{ path: string; rows: number; failed: number }> {
  const media = await listMedia(graph, igId, {
    limit: o.limit ?? 50,
    since: o.since,
    until: o.until,
  });
  const rows = await insightsForMedia(db, graph, media, mode);
  mkdirSync(dirname(o.path), { recursive: true });
  // The path was free when planned; take a fresh one if something appeared since. "wx" never overwrites.
  const path = uniquePath(o.path);
  writeFileSync(path, toCsv(rows), { flag: "wx", mode: 0o600 });
  return { path, rows: rows.length, failed: rows.filter((r) => r.error).length };
}
