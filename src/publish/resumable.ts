import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { IgError } from "../errors.js";
import { log } from "../log.js";
import { graphFetch, type Graph } from "../meta/graph.js";

/**
 * Upload a local video straight to Meta (Facebook Login only): the container was created with
 * upload_type=resumable and returned an `uri` on rupload.facebook.com. The body is the file from `offset`.
 * https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads
 */
export async function ruploadFile(opts: {
  uri: string;
  token: string;
  filePath: string;
  fileSize: number;
  contentType?: string;
  offset?: number;
  signal?: AbortSignal;
  onProgress?: (sent: number) => void;
}): Promise<void> {
  const u = new URL(opts.uri);
  if (u.protocol !== "https:" || !/(^|\.)facebook\.com$/.test(u.hostname))
    throw new IgError("invalid_request", `Unexpected upload URI host: ${u.hostname}`);
  const offset = Math.max(0, Math.min(opts.offset ?? 0, opts.fileSize));
  let sent = offset;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      opts.onProgress?.(sent);
      cb(null, chunk);
    },
  });
  const file = createReadStream(opts.filePath, { start: offset });
  file.on("error", (e) => counter.destroy(e));
  const body = Readable.toWeb(file.pipe(counter)) as unknown as NonNullable<RequestInit["body"]>;
  let res: Response;
  try {
    res = await graphFetch(u, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${opts.token}`,
        offset: String(offset),
        file_size: String(opts.fileSize),
        "Content-Type": opts.contentType ?? "application/octet-stream",
      },
      body,
      duplex: "half",
      signal: opts.signal ?? AbortSignal.timeout(60 * 60_000),
    } as RequestInit);
  } catch (e) {
    if (opts.signal?.aborted) throw new IgError("cancelled", "Upload stopped.");
    throw new IgError("network", `Upload to Meta interrupted: ${(e as Error).message}`, {
      retryable: true,
    });
  }
  const text = await res.text().catch(() => "");
  let data: {
    success?: boolean;
    message?: string;
    debug_info?: { retriable?: boolean; type?: string; message?: string };
    error?: { message?: string };
  } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    /* non-JSON */
  }
  if (res.ok && data.success !== false && !data.debug_info) return;
  const msg =
    data.debug_info?.message ?? data.error?.message ?? data.message ?? `HTTP ${res.status}`;
  const retryable = data.debug_info?.retriable ?? res.status >= 500;
  log.warn("rupload failed", { status: res.status, type: data.debug_info?.type });
  throw new IgError(
    res.status === 401 || /unauthorized/i.test(msg)
      ? "auth_expired"
      : retryable
        ? "network"
        : "media_error",
    `Uploading the video to Meta failed: ${msg}`,
    {
      retryable,
      status: res.status,
      hint: /unauthorized/i.test(msg)
        ? "The token was rejected for this upload. Reconnect the account with connect_account."
        : undefined,
    },
  );
}

/**
 * How many bytes Meta already has for a resumable container. Not in the reference docs, but shown in the
 * resumable-upload guide (video_status.uploading_phase.bytes_transferred); falls back to 0 (re-send all).
 */
export async function uploadedBytes(graph: Graph, containerId: string): Promise<number> {
  try {
    const r = await graph.get<{
      video_status?: { uploading_phase?: { status?: string; bytes_transferred?: number } };
    }>(containerId, { fields: "video_status" });
    return Number(r.video_status?.uploading_phase?.bytes_transferred ?? 0) || 0;
  } catch {
    return 0;
  }
}
