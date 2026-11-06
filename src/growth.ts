import type { AccountRow } from "./accounts.js";
import type { Db } from "./db.js";
import { IgError } from "./errors.js";
import { insightsForMedia, type MediaWithMetrics } from "./insights.js";
import { listMedia, productOf, type ProductType } from "./library.js";
import type { Graph } from "./meta/graph.js";
import { requireCapability } from "./meta/oauth.js";
import { median, round } from "./stats.js";

/** round() that always returns a number (NaN for non-finite input, which JSON shows as null). */
const rnd = (x: number, d = 2): number => round(x, d) ?? NaN;

// ---- per-post ratios -----------------------------------------------------------------------------------

const per = (a?: number, b?: number) => (a !== undefined && b ? a / b : undefined);

/** Rates that compare fairly across posts of different reach. */
export function derived(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const set = (k: string, v?: number) => {
    if (v !== undefined && Number.isFinite(v)) out[k] = rnd(v, 4);
  };
  set("engagement_rate", per(m.total_interactions, m.reach));
  set("save_share_rate", per((m.saved ?? 0) + (m.shares ?? 0), m.reach) ?? undefined);
  set("views_per_reach", per(m.views, m.reach));
  set("follows_per_1k_reach", per((m.follows ?? 0) * 1000, m.reach));
  return out;
}

/** value ÷ median of the baseline (1 = typical, 2 = twice the usual). Undefined without a usable baseline. */
export function outlierScore(value: number | undefined, baseline: number[]): number | undefined {
  const xs = baseline.filter((x) => Number.isFinite(x));
  if (value === undefined || xs.length < 3) return undefined;
  const m = median(xs);
  if (!m) return undefined;
  return rnd(value / m, 2);
}

export interface Baseline {
  product: ProductType;
  posts: number;
  medians: Record<string, number>;
  sample: MediaWithMetrics[];
}

/** The account's recent posts of one product type with their insights (cached). */
export async function baseline(
  db: Db,
  graph: Graph,
  row: AccountRow,
  product: ProductType,
  o: { size?: number; excludeId?: string; minAgeHours?: number } = {},
): Promise<Baseline> {
  const size = Math.min(o.size ?? 30, 60);
  const minAge = (o.minAgeHours ?? 48) * 3_600_000;
  const media = (await listMedia(graph, row.ig_user_id, { limit: Math.min(size * 3, 150) }))
    .filter((m) => productOf(m) === product && m.id !== o.excludeId)
    // Posts younger than 2 days are still growing; they would drag the baseline down.
    .filter((m) => !m.timestamp || Date.now() - Date.parse(m.timestamp) > minAge)
    .slice(0, size);
  const sample = (await insightsForMedia(db, graph, media, row.auth_mode)).filter((s) => !s.error);
  const keys = new Set(sample.flatMap((s) => Object.keys({ ...s.metrics, ...derived(s.metrics) })));
  const medians: Record<string, number> = {};
  for (const k of keys) {
    const xs = sample
      .map((s) => ({ ...s.metrics, ...derived(s.metrics) })[k])
      .filter((x): x is number => typeof x === "number");
    if (xs.length) medians[k] = rnd(median(xs), 4);
  }
  return { product, posts: sample.length, medians, sample };
}

export interface PostAnalysis {
  id: string;
  product: ProductType;
  permalink?: string;
  timestamp?: string;
  age_hours?: number;
  metrics: Record<string, number>;
  rates: Record<string, number>;
  vs_median: Record<string, number>;
  outlier_score?: number;
  baseline_posts: number;
  verdict: string;
  notes: string[];
}

const KEY_COMPARE = [
  "views",
  "reach",
  "total_interactions",
  "saved",
  "shares",
  "follows",
  "ig_reels_avg_watch_time",
  "reels_skip_rate",
  "engagement_rate",
  "save_share_rate",
];

export function comparePost(post: MediaWithMetrics, base: Baseline): PostAnalysis {
  const rates = derived(post.metrics);
  const all = { ...post.metrics, ...rates };
  const vs: Record<string, number> = {};
  for (const k of KEY_COMPARE) {
    const v = all[k];
    const b = base.medians[k];
    if (v !== undefined && b) vs[k] = rnd(v / b, 2);
  }
  const main = post.product === "STORY" ? "reach" : "views";
  const score = outlierScore(
    all[main],
    base.sample.map((s) => s.metrics[main]).filter((x): x is number => x !== undefined),
  );
  const age = post.timestamp ? (Date.now() - Date.parse(post.timestamp)) / 3_600_000 : undefined;
  const notes: string[] = [];
  if (age !== undefined && age < 48)
    notes.push(
      `Only ${Math.round(age)} hours old: numbers are still moving, compare again after 2-3 days.`,
    );
  if (base.posts < 5)
    notes.push(`Baseline has only ${base.posts} comparable posts, so comparisons are rough.`);
  if (vs.reels_skip_rate !== undefined && vs.reels_skip_rate > 1.2)
    notes.push(
      "More people swiped away in the first seconds than usual: the hook is the first thing to fix.",
    );
  if (vs.ig_reels_avg_watch_time !== undefined && vs.ig_reels_avg_watch_time < 0.8)
    notes.push("Average watch time is below usual: tighten the middle or shorten the reel.");
  if (vs.save_share_rate !== undefined && vs.save_share_rate > 1.5)
    notes.push(
      "Saves and shares per viewer are well above usual: this topic or format is worth repeating.",
    );
  if (vs.engagement_rate !== undefined && vs.engagement_rate < 0.7)
    notes.push(
      "People saw it but interacted less than usual: the caption or call to action may be weak.",
    );
  const verdict =
    score === undefined
      ? "Not enough comparable posts to score."
      : score >= 2
        ? `Outlier: ${score}x your usual ${main}.`
        : score >= 1.2
          ? `Above your usual ${main} (${score}x).`
          : score >= 0.8
            ? `About your usual ${main} (${score}x).`
            : `Below your usual ${main} (${score}x).`;
  return {
    id: post.id,
    product: post.product,
    permalink: post.permalink,
    timestamp: post.timestamp,
    age_hours: age !== undefined ? Math.round(age) : undefined,
    metrics: post.metrics,
    rates,
    vs_median: vs,
    outlier_score: score,
    baseline_posts: base.posts,
    verdict,
    notes,
  };
}

/** Rank posts against the median of the same set. */
export function rankOutliers(
  posts: MediaWithMetrics[],
  metric: string,
  top = 5,
): {
  median: number;
  best: (MediaWithMetrics & { score: number })[];
  worst: (MediaWithMetrics & { score: number })[];
} {
  const valued = posts
    .map((p) => ({ p, v: { ...p.metrics, ...derived(p.metrics) }[metric] }))
    .filter((x): x is { p: MediaWithMetrics; v: number } => typeof x.v === "number");
  const med = median(valued.map((x) => x.v));
  const scored = valued
    .map((x) => ({ ...x.p, score: med ? rnd(x.v / med, 2) : 0 }))
    .sort((a, b) => b.score - a.score);
  return {
    median: rnd(med, 2),
    best: scored.slice(0, top),
    worst: scored.slice(-top).reverse(),
  };
}

// ---- best publish time ---------------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(iso: string, timeZone: string): { weekday: number; hour: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { weekday: WEEKDAYS.indexOf(parts.weekday), hour: Number(parts.hour) % 24 };
}

export interface TimeSlot {
  slot: string;
  posts: number;
  /** Median of (metric ÷ the account's overall median): 1 = typical. */
  lift: number;
}

/**
 * When your own posts did best. Groups by weekday and by 3-hour block in `timeZone`, scoring each post
 * relative to the overall median so a few viral posts do not dominate.
 */
export function publishTimeStats(
  posts: { timestamp?: string; value?: number }[],
  timeZone: string,
  minPosts = 2,
): {
  by_weekday: TimeSlot[];
  by_hour_block: TimeSlot[];
  best_slots: TimeSlot[];
  posts_used: number;
} {
  const usable = posts.filter(
    (p): p is { timestamp: string; value: number } => !!p.timestamp && typeof p.value === "number",
  );
  const med = median(usable.map((p) => p.value)) || 1;
  const groups = (key: (w: number, h: number) => string) => {
    const g = new Map<string, number[]>();
    for (const p of usable) {
      const { weekday, hour } = localParts(p.timestamp, timeZone);
      const k = key(weekday, hour);
      g.set(k, [...(g.get(k) ?? []), p.value / med]);
    }
    return [...g.entries()]
      .filter(([, xs]) => xs.length >= minPosts)
      .map(([slot, xs]) => ({ slot, posts: xs.length, lift: rnd(median(xs), 2) }))
      .sort((a, b) => b.lift - a.lift);
  };
  const block = (h: number) => {
    const s = Math.floor(h / 3) * 3;
    return `${String(s).padStart(2, "0")}:00-${String(s + 3).padStart(2, "0")}:00`;
  };
  return {
    by_weekday: groups((w) => WEEKDAYS[w]),
    by_hour_block: groups((_, h) => block(h)),
    best_slots: groups((w, h) => `${WEEKDAYS[w]} ${block(h)}`).slice(0, 5),
    posts_used: usable.length,
  };
}

/**
 * online_followers (followers online per hour). Listed only in Meta's limitation notes, so it may not
 * exist for every account or version: failures return null.
 */
export async function onlineFollowers(
  graph: Graph,
  igId: string,
): Promise<{ hour: number; followers: number }[] | null> {
  try {
    const r = await graph.get<{ data: { values?: { value?: Record<string, number> }[] }[] }>(
      `${igId}/insights`,
      { metric: "online_followers", period: "lifetime" },
    );
    const vals = r.data?.[0]?.values ?? [];
    const sums = new Map<number, number[]>();
    for (const v of vals)
      for (const [h, n] of Object.entries(v.value ?? {}))
        sums.set(Number(h), [...(sums.get(Number(h)) ?? []), n]);
    if (!sums.size) return null;
    return [...sums.entries()]
      .map(([hour, xs]) => ({
        hour,
        followers: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
      }))
      .sort((a, b) => a.hour - b.hour);
  } catch {
    return null;
  }
}

// ---- hashtag research (Facebook Login only) -----------------------------------------------------------

export const HASHTAG_LIMIT = 30;
export const HASHTAG_WINDOW_MS = 7 * 86_400_000;

const budgetKey = (igId: string) => `hashtag_budget:${igId}`;

export function hashtagBudget(db: Db, igId: string, now = Date.now()) {
  let used: { tag: string; at: number }[] = [];
  try {
    used = JSON.parse(db.setting(budgetKey(igId)) ?? "[]") as { tag: string; at: number }[];
  } catch {
    used = [];
  }
  used = used.filter((u) => now - u.at < HASHTAG_WINDOW_MS);
  return {
    used,
    remaining: Math.max(0, HASHTAG_LIMIT - used.length),
    next_slot_at: used.length
      ? new Date(Math.min(...used.map((u) => u.at)) + HASHTAG_WINDOW_MS).toISOString()
      : undefined,
  };
}

export const normTag = (t: string) => t.trim().replace(/^#/, "").toLowerCase();

/** Reserve slots for new hashtags (repeats inside the window are free). Throws when it would exceed 30. */
export function reserveHashtags(db: Db, igId: string, tags: string[], now = Date.now()): string[] {
  const b = hashtagBudget(db, igId, now);
  const known = new Set(b.used.map((u) => u.tag));
  const fresh = [...new Set(tags.map(normTag))].filter((t) => t && !known.has(t));
  if (fresh.length > b.remaining)
    throw new IgError(
      "rate_limited",
      `Instagram allows ${HASHTAG_LIMIT} different hashtags per 7 days per account; ${b.remaining} left, ${fresh.length} new requested.`,
      {
        hint: `Already searched (free to repeat): ${[...known].join(", ") || "none"}. Next slot frees at ${b.next_slot_at}.`,
      },
    );
  db.setSetting(
    budgetKey(igId),
    JSON.stringify([...b.used, ...fresh.map((tag) => ({ tag, at: now }))]),
  );
  return fresh;
}

interface HashtagMedia {
  id: string;
  caption?: string;
  media_type?: string;
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  timestamp?: string;
}

export function topCoHashtags(captions: (string | undefined)[], exclude: string[], n = 15) {
  const ex = new Set(exclude.map(normTag));
  const counts = new Map<string, number>();
  for (const c of captions)
    for (const m of (c ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) {
      const t = m[1].toLowerCase();
      if (!ex.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag, posts]) => ({ tag: `#${tag}`, posts }));
}

export async function hashtagResearch(
  db: Db,
  graph: Graph,
  row: AccountRow,
  tags: string[],
  o: { edge?: "top_media" | "recent_media"; limit?: number } = {},
) {
  requireCapability(row.auth_mode, "hashtagSearch", "Hashtag search");
  const clean = [...new Set(tags.map(normTag).filter(Boolean))];
  if (!clean.length) throw new IgError("invalid_request", "Give at least one hashtag.");
  reserveHashtags(db, row.ig_user_id, clean);
  const edge = o.edge ?? "top_media";
  const results = [];
  for (const tag of clean) {
    const idKey = `hashtag_id:${tag}`;
    let hid = db.cached<string>(idKey, 30 * 86_400_000);
    if (!hid) {
      const s = await graph.get<{ data: { id: string }[] }>("ig_hashtag_search", {
        user_id: row.ig_user_id,
        q: tag,
      });
      hid = s.data?.[0]?.id;
      if (!hid) {
        results.push({ hashtag: `#${tag}`, error: "Instagram has no such hashtag." });
        continue;
      }
      db.putCache(idKey, hid);
    }
    const media = await graph.paginate<HashtagMedia>(
      `${hid}/${edge}`,
      {
        user_id: row.ig_user_id,
        fields: "id,caption,media_type,like_count,comments_count,permalink,timestamp",
        limit: 50,
      },
      Math.min(o.limit ?? 30, 100),
    );
    const likes = media.map((m) => m.like_count).filter((x): x is number => typeof x === "number");
    const comments = media
      .map((m) => m.comments_count)
      .filter((x): x is number => typeof x === "number");
    const types = new Map<string, number>();
    for (const m of media)
      types.set(m.media_type ?? "?", (types.get(m.media_type ?? "?") ?? 0) + 1);
    results.push({
      hashtag: `#${tag}`,
      edge,
      posts_sampled: media.length,
      median_likes: likes.length ? median(likes) : undefined,
      median_comments: comments.length ? median(comments) : undefined,
      format_mix: Object.fromEntries(types),
      related_hashtags: topCoHashtags(
        media.map((m) => m.caption),
        [tag],
      ),
      top_posts: [...media]
        .sort(
          (a, b) =>
            (b.like_count ?? 0) +
            (b.comments_count ?? 0) -
            ((a.like_count ?? 0) + (a.comments_count ?? 0)),
        )
        .slice(0, 5)
        .map((m) => ({
          permalink: m.permalink,
          type: m.media_type,
          likes: m.like_count,
          comments: m.comments_count,
          caption: m.caption?.replace(/\s+/g, " ").slice(0, 140),
        })),
    });
  }
  const b = hashtagBudget(db, row.ig_user_id);
  return {
    results,
    hashtag_budget: { remaining: b.remaining, window: "7 days", next_slot_at: b.next_slot_at },
  };
}

// ---- competitor benchmark (Facebook Login only) --------------------------------------------------------

interface DiscoveryMedia {
  id: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
  timestamp?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
}

interface Discovery {
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  media?: { data: DiscoveryMedia[] };
}

export function benchmarkStats(d: Discovery) {
  const media = d.media?.data ?? [];
  const eng = media.map((m) => (m.like_count ?? 0) + (m.comments_count ?? 0));
  const followers = d.followers_count ?? 0;
  const times = media
    .map((m) => (m.timestamp ? Date.parse(m.timestamp) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spanWeeks = times.length > 1 ? (times[times.length - 1] - times[0]) / (7 * 86_400_000) : 0;
  const mix = new Map<string, number>();
  for (const m of media) {
    const k = m.media_product_type ?? m.media_type ?? "?";
    mix.set(k, (mix.get(k) ?? 0) + 1);
  }
  return {
    posts_sampled: media.length,
    median_likes: media.length ? median(media.map((m) => m.like_count ?? 0)) : undefined,
    median_comments: media.length ? median(media.map((m) => m.comments_count ?? 0)) : undefined,
    median_views: (() => {
      const v = media.map((m) => m.view_count).filter((x): x is number => typeof x === "number");
      return v.length ? median(v) : undefined;
    })(),
    engagement_rate_per_follower:
      followers && eng.length ? rnd(median(eng) / followers, 4) : undefined,
    posts_per_week: spanWeeks > 0 ? rnd(media.length / spanWeeks, 1) : undefined,
    format_mix: Object.fromEntries(mix),
    top_hashtags: topCoHashtags(
      media.map((m) => m.caption),
      [],
      10,
    ),
    top_posts: media
      .map((m, i) => ({ m, e: eng[i] }))
      .sort((a, b) => b.e - a.e)
      .slice(0, 5)
      .map(({ m, e }) => ({
        permalink: m.permalink,
        type: m.media_product_type ?? m.media_type,
        likes: m.like_count,
        comments: m.comments_count,
        views: m.view_count,
        engagement: e,
        posted: m.timestamp,
        caption: m.caption?.replace(/\s+/g, " ").slice(0, 160),
      })),
  };
}

export async function benchmarkCompetitor(
  db: Db,
  graph: Graph,
  row: AccountRow,
  username: string,
  posts = 30,
) {
  requireCapability(row.auth_mode, "businessDiscovery", "Competitor lookup (Business Discovery)");
  const u = username.trim().replace(/^@/, "");
  if (!/^[\w.]{1,30}$/.test(u))
    throw new IgError("invalid_request", "That is not a valid Instagram username.");
  const n = Math.min(Math.max(posts, 1), 100);
  const key = `discovery:${u.toLowerCase()}:${n}`;
  let d = db.cached<Discovery>(key, 6 * 3_600_000);
  if (!d) {
    const mediaBase = "id,caption,like_count,comments_count,timestamp,media_type,permalink";
    const profile = "username,name,biography,website,followers_count,follows_count,media_count";
    const ask = (media: string) =>
      graph.get<{ business_discovery?: Discovery }>(row.ig_user_id, {
        fields: `business_discovery.username(${u}){${profile},media.limit(${n}){${media}}}`,
      });
    let r: { business_discovery?: Discovery };
    try {
      r = await ask(`${mediaBase},view_count,media_product_type`);
    } catch (e) {
      if (!(e instanceof IgError) || e.code !== "invalid_request") throw e;
      // Some versions refuse view_count/media_product_type inside discovery: ask for the basics.
      r = await ask(mediaBase);
    }
    d = r.business_discovery;
    if (!d)
      throw new IgError("not_found", `@${u} was not found or is not a business/creator account.`, {
        hint: "Business Discovery only works for public Business and Creator accounts.",
      });
    db.putCache(key, d);
  }
  return {
    account: {
      username: d.username,
      name: d.name,
      followers: d.followers_count,
      following: d.follows_count,
      posts: d.media_count,
      website: d.website,
      bio: d.biography,
    },
    stats: benchmarkStats(d),
  };
}
