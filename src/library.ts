import type { AccountRow } from "./accounts.js";
import { IgError } from "./errors.js";
import type { Graph } from "./meta/graph.js";
import { requireCapability } from "./meta/oauth.js";

/** Insight product types (what decides which metrics exist). */
export type ProductType = "FEED" | "REELS" | "STORY";

export interface RawMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  shortcode?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  comment_enabled?: boolean;
  username?: string;
  children?: {
    data: { id: string; media_type?: string; media_url?: string; thumbnail_url?: string }[];
  };
}

export interface MediaRow {
  id: string;
  type: string;
  product: ProductType;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  likes?: number;
  comments?: number;
  media_url?: string;
  thumbnail_url?: string;
  username?: string;
}

const BASE_FIELDS = [
  "id",
  "media_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "like_count",
  "comments_count",
];

/** Fields Meta documents for one login type only. Requested, and dropped if Meta refuses them. */
export const OPTIONAL_FIELDS = ["caption", "media_product_type", "shortcode"];

/** Fields Meta rejected on a host, so we do not ask twice. */
const refused = new Map<string, Set<string>>();

function rejectedFields(err: IgError, fields: string[]): string[] {
  if (err.code !== "invalid_request") return [];
  const msg = err.message.toLowerCase();
  return fields.filter((f) => msg.includes(f.toLowerCase()));
}

/**
 * GET with a field list where some fields may be unsupported on this host: on error 100 naming them, drop and
 * retry once (and remember for this host).
 */
export async function getWithOptionalFields<T>(
  graph: Graph,
  path: string,
  fields: string[],
  optional: string[],
  params: Record<string, unknown> = {},
  opts: { paginate?: number } = {},
): Promise<T> {
  const skip = refused.get(graph.host) ?? new Set<string>();
  const wanted = [...fields, ...optional.filter((f) => !skip.has(f))];
  const call = (fs: string[]) =>
    opts.paginate
      ? (graph.paginate(path, { ...params, fields: fs.join(",") }, opts.paginate) as Promise<T>)
      : graph.get<T>(path, { ...params, fields: fs.join(",") });
  try {
    return await call(wanted);
  } catch (e) {
    const err = e instanceof IgError ? e : null;
    const bad = err ? rejectedFields(err, optional) : [];
    const anyOptional = optional.some((f) => wanted.includes(f));
    if (!err || err.code !== "invalid_request" || !anyOptional) throw e;
    const drop = bad.length ? bad : optional;
    for (const f of drop) skip.add(f);
    refused.set(graph.host, skip);
    return call(wanted.filter((f) => !drop.includes(f)));
  }
}

/** Since 2022 every new video post is a reel; without media_product_type that is the best guess. */
export function productOf(m: Pick<RawMedia, "media_type" | "media_product_type">): ProductType {
  const p = (m.media_product_type ?? "").toUpperCase();
  if (p === "REELS" || p === "STORY") return p;
  if (p === "FEED" || p === "AD") return "FEED";
  return m.media_type === "VIDEO" ? "REELS" : "FEED";
}

export function compactMedia(m: RawMedia, captionChars = 160): MediaRow {
  const cap = m.caption?.replace(/\s+/g, " ").trim();
  return {
    id: m.id,
    type: m.media_type ?? "UNKNOWN",
    product: productOf(m),
    caption: cap && cap.length > captionChars ? `${cap.slice(0, captionChars - 1)}…` : cap,
    permalink: m.permalink,
    timestamp: m.timestamp,
    likes: m.like_count,
    comments: m.comments_count,
    media_url: m.media_url,
    thumbnail_url: m.thumbnail_url,
    username: m.username,
  };
}

export interface ListMediaOptions {
  limit?: number;
  /** ISO date or date-time: only media published on or after. */
  since?: string;
  until?: string;
  /** Filter by product: FEED (photos/carousels), REELS, or a media_type such as CAROUSEL_ALBUM. */
  type?: string;
}

export async function listMedia(
  graph: Graph,
  igId: string,
  o: ListMediaOptions = {},
): Promise<RawMedia[]> {
  const limit = Math.min(Math.max(o.limit ?? 25, 1), 500);
  // Fetch extra when filtering, so the filter still returns `limit` rows when possible.
  const fetchN = o.type || o.since ? Math.min(limit * 3, 500) : limit;
  const params: Record<string, unknown> = { limit: Math.min(fetchN, 100) };
  if (o.since) params.since = Math.floor(Date.parse(o.since) / 1000);
  if (o.until) params.until = Math.floor(Date.parse(o.until) / 1000);
  const rows = await getWithOptionalFields<RawMedia[]>(
    graph,
    `${igId}/media`,
    BASE_FIELDS,
    OPTIONAL_FIELDS,
    params,
    { paginate: fetchN },
  );
  const since = o.since ? Date.parse(o.since) : undefined;
  const until = o.until ? Date.parse(o.until) : undefined;
  const type = o.type?.toUpperCase();
  return rows
    .filter((m) => {
      const t = m.timestamp ? Date.parse(m.timestamp) : undefined;
      if (since !== undefined && t !== undefined && t < since) return false;
      if (until !== undefined && t !== undefined && t > until) return false;
      if (type && productOf(m) !== type && m.media_type !== type) return false;
      return true;
    })
    .slice(0, limit);
}

export async function getMedia(graph: Graph, mediaId: string): Promise<RawMedia> {
  return getWithOptionalFields<RawMedia>(
    graph,
    mediaId,
    [
      ...BASE_FIELDS,
      "comment_enabled",
      "username",
      "children{id,media_type,media_url,thumbnail_url}",
    ],
    OPTIONAL_FIELDS,
  );
}

export async function listStories(graph: Graph, igId: string): Promise<RawMedia[]> {
  return getWithOptionalFields<RawMedia[]>(
    graph,
    `${igId}/stories`,
    ["id", "media_type", "media_url", "thumbnail_url", "permalink", "timestamp"],
    OPTIONAL_FIELDS,
    { limit: 50 },
    { paginate: 100 },
  );
}

/** Media other accounts tagged this account in. */
export async function listTagged(graph: Graph, igId: string, limit = 25): Promise<RawMedia[]> {
  return getWithOptionalFields<RawMedia[]>(
    graph,
    `${igId}/tags`,
    [
      "id",
      "caption",
      "media_type",
      "permalink",
      "timestamp",
      "username",
      "like_count",
      "comments_count",
    ],
    [],
    { limit: Math.min(limit, 100) },
    { paginate: limit },
  );
}

export async function setCommentsEnabled(graph: Graph, mediaId: string, enabled: boolean) {
  return graph.post<{ success?: boolean }>(mediaId, { comment_enabled: enabled });
}

/** Facebook Login only (needs instagram_manage_contents). Whole posts, reels, stories or carousels. */
export async function deleteMedia(graph: Graph, row: AccountRow, mediaId: string) {
  requireCapability(row.auth_mode, "deleteMedia", "Deleting posts");
  const r = await graph.delete<{ success?: boolean; deleted_id?: string }>(mediaId);
  return { deleted: r.success !== false, id: r.deleted_id ?? mediaId };
}
