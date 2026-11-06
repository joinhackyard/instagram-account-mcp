import { IgError } from "../errors.js";
import type { Graph } from "../meta/graph.js";
import type { ItemSpec, PostSpec } from "./types.js";

/**
 * Container parameters for /<IG_ID>/media, per the IG User Media reference:
 * single image: image_url (no media_type) · reel: media_type=REELS · story: media_type=STORIES ·
 * carousel child: is_carousel_item=true (+ media_type=VIDEO for videos) · carousel: media_type=CAROUSEL + children.
 */
export type ContainerRole = "single" | "child" | "parent";

export interface ContainerMedia {
  /** Public URL Meta fetches (image_url / video_url). */
  url?: string;
  /** Create a resumable-upload container instead (Facebook Login, videos only). */
  resumable?: boolean;
  isVideo: boolean;
}

const usernames = (tags?: { username: string }[]) =>
  tags?.length ? tags.map((t) => ({ username: t.username.replace(/^@/, "") })) : undefined;

const positioned = (tags?: { username: string; x?: number; y?: number }[]) =>
  tags?.length
    ? tags.map((t) => ({ username: t.username.replace(/^@/, ""), x: t.x ?? 0.5, y: t.y ?? 0.5 }))
    : undefined;

const cleanList = (xs?: string[]) =>
  xs?.length ? xs.map((x) => x.replace(/^@/, "").trim()).filter(Boolean) : undefined;

export function containerParams(
  spec: PostSpec,
  role: ContainerRole,
  media: ContainerMedia | null,
  extra: { item?: ItemSpec; children?: string[]; coverUrl?: string } = {},
): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const item = extra.item;
  const setMedia = () => {
    if (!media) return;
    if (media.resumable) p.upload_type = "resumable";
    else if (media.url) p[media.isVideo ? "video_url" : "image_url"] = media.url;
  };

  if (role === "parent") {
    p.media_type = "CAROUSEL";
    p.children = (extra.children ?? []).join(",");
    if (spec.caption) p.caption = spec.caption;
    if (spec.location_id) p.location_id = spec.location_id;
    p.collaborators = cleanList(spec.collaborators);
    if (spec.is_ai_generated) p.is_ai_generated = true;
    return p;
  }

  if (role === "child") {
    p.is_carousel_item = true;
    if (media?.isVideo) p.media_type = "VIDEO";
    setMedia();
    if (!media?.isVideo) {
      if (item?.alt_text) p.alt_text = item.alt_text;
      p.user_tags = positioned(item?.user_tags);
    }
    return p;
  }

  // single
  switch (spec.kind) {
    case "photo":
      setMedia();
      if (spec.caption) p.caption = spec.caption;
      if (item?.alt_text) p.alt_text = item.alt_text;
      p.user_tags = positioned(item?.user_tags);
      if (spec.location_id) p.location_id = spec.location_id;
      p.collaborators = cleanList(spec.collaborators);
      if (spec.is_ai_generated) p.is_ai_generated = true;
      break;
    case "story":
      p.media_type = "STORIES";
      setMedia();
      p.user_tags = media?.isVideo ? usernames(item?.user_tags) : positioned(item?.user_tags);
      break;
    case "reel":
      p.media_type = "REELS";
      setMedia();
      if (spec.caption) p.caption = spec.caption;
      if (spec.share_to_feed !== undefined) p.share_to_feed = spec.share_to_feed;
      if (extra.coverUrl) p.cover_url = extra.coverUrl;
      else if (spec.thumb_offset_ms !== undefined) p.thumb_offset = spec.thumb_offset_ms;
      if (spec.audio_name) p.audio_name = spec.audio_name;
      p.user_tags = usernames(item?.user_tags);
      if (spec.location_id) p.location_id = spec.location_id;
      p.collaborators = cleanList(spec.collaborators);
      if (spec.is_ai_generated) p.is_ai_generated = true;
      if (spec.trial) p.trial_params = { graduation_strategy: spec.trial.graduation };
      break;
    default:
      throw new IgError("invalid_request", `Unknown post kind ${spec.kind as string}.`);
  }
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

export async function createContainer(
  graph: Graph,
  igId: string,
  params: Record<string, unknown>,
): Promise<{ id: string; uri?: string }> {
  const r = await graph.post<{ id?: string; uri?: string }>(`${igId}/media`, params);
  if (!r.id)
    throw new IgError("server_error", "Meta created no media container.", { retryable: true });
  return { id: r.id, uri: r.uri };
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

let timing = { first: 3_000, max: 30_000 };
/** Tests shorten the polling. */
export function setPollTimingForTests(t?: { first: number; max: number }) {
  timing = t ?? { first: 3_000, max: 30_000 };
}

export async function containerStatus(
  graph: Graph,
  id: string,
): Promise<{ status_code: ContainerStatus; status?: string }> {
  const r = await graph.get<{ status_code?: ContainerStatus; status?: string }>(id, {
    fields: "status_code,status",
  });
  return { status_code: r.status_code ?? "IN_PROGRESS", status: r.status };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new IgError("cancelled", "Stopped."));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new IgError("cancelled", "Stopped."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export { sleep as abortableSleep };

/** Map a container ERROR status text to an error: fetch failures are re-hostable. */
export function containerError(id: string, status?: string): IgError {
  const text = status ?? "Unknown processing error";
  const sub = /(\d{7})/.exec(text)?.[1];
  if (
    /\b(download(ing|ed)?|fetch(ing|ed)?|retriev(e|ing|ed)|unreachable|not reachable|could not (be )?(accessed|reached))\b/i.test(
      text,
    ) ||
    /\bmedia (uri|url)\b.*\b(invalid|not|fail)/i.test(text) ||
    sub === "2207052" ||
    sub === "2207003"
  )
    return new IgError("media_unreachable", `Meta could not fetch the media: ${text}`, {
      reason: sub,
      hint: "The media URL must stay public until processing finishes. With the tunnel host, keep this computer online.",
    });
  return new IgError(
    "media_error",
    `Instagram could not process the media (container ${id}): ${text}`,
    {
      reason: sub,
      hint: "Check the format with prepare_media (JPEG images; H.264/AAC MP4 videos; allowed aspect ratios and lengths).",
    },
  );
}

/** Poll until FINISHED (or PUBLISHED). Throws on ERROR / EXPIRED / timeout. */
export async function waitFinished(
  graph: Graph,
  id: string,
  opts: { timeoutMs: number; signal?: AbortSignal; onPoll?: (s: ContainerStatus) => void },
): Promise<ContainerStatus> {
  const start = Date.now();
  let wait = timing.first;
  for (;;) {
    const s = await containerStatus(graph, id);
    opts.onPoll?.(s.status_code);
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return s.status_code;
    if (s.status_code === "ERROR") throw containerError(id, s.status);
    if (s.status_code === "EXPIRED")
      throw new IgError("media_error", "The media container expired before it was published.", {
        reason: "expired",
      });
    if (Date.now() - start > opts.timeoutMs)
      throw new IgError(
        "server_error",
        "Instagram is still processing the media; will keep checking.",
        {
          retryable: true,
          reason: "processing_timeout",
        },
      );
    await sleep(wait, opts.signal);
    wait = Math.min(timing.max, Math.round(wait * 1.6));
  }
}

/**
 * media_publish, sent exactly once: a blind retry after an ambiguous failure (timeout, 5xx) could publish
 * twice. The caller checks the container status to resolve ambiguity.
 */
export async function publishContainer(graph: Graph, igId: string, containerId: string) {
  const r = await graph.post<{ id?: string }>(
    `${igId}/media_publish`,
    { creation_id: containerId },
    { retry: false },
  );
  if (!r.id) throw new IgError("server_error", "Instagram returned no media id after publishing.");
  return r.id;
}

export interface PublishedMedia {
  id: string;
  permalink?: string;
  media_product_type?: string;
  media_type?: string;
  shortcode?: string;
  timestamp?: string;
}

export async function readPublished(graph: Graph, mediaId: string): Promise<PublishedMedia> {
  try {
    return await graph.get<PublishedMedia>(mediaId, {
      fields: "id,permalink,media_type,media_product_type,shortcode,timestamp",
    });
  } catch {
    // media_product_type is Facebook-Login only on some versions: retry with the portable fields.
    return graph.get<PublishedMedia>(mediaId, { fields: "id,permalink,media_type,timestamp" });
  }
}

export interface PublishingLimit {
  used: number;
  total: number;
  window_hours: number;
}

/** GET /<IG_ID>/content_publishing_limit. Docs disagree on 50 vs 100 posts, so read the real cap. */
export async function publishingLimit(graph: Graph, igId: string): Promise<PublishingLimit> {
  const r = await graph.get<{
    data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
  }>(`${igId}/content_publishing_limit`, { fields: "quota_usage,config" });
  const d = r.data?.[0];
  if (!d || typeof d.quota_usage !== "number")
    throw new IgError("server_error", "No publishing limit in Meta's answer.");
  return {
    used: d.quota_usage,
    total: d.config?.quota_total ?? 100,
    window_hours: Math.round((d.config?.quota_duration ?? 86_400) / 3600),
  };
}
