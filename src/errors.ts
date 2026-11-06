export type ErrorCode =
  | "publish_limit_reached"
  | "rate_limited"
  | "auth_expired"
  | "not_connected"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "media_error"
  | "media_unreachable"
  | "file_error"
  | "network"
  | "server_error"
  | "cancelled"
  | "not_configured"
  | "unknown";

export class IgError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: {
      retryable?: boolean;
      hint?: string;
      status?: number;
      /** Meta error code / subcode, e.g. "190" or "9/2207042". */
      reason?: string;
      /** Milliseconds to wait before retrying, when Meta says so. */
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "IgError";
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
  get hint() {
    return this.opts.hint;
  }
}

/** The `error` object of a Graph API error response. */
export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  is_transient?: boolean;
  fbtrace_id?: string;
}

/** Media subcodes Meta returns from container creation / processing, with what to do about them. */
const MEDIA_SUBCODES: Record<number, string> = {
  2207001: "Instagram's server rejected the media. Try again in a few minutes.",
  2207003: "Meta timed out downloading the media. Check that the URL is fast and public.",
  2207004: "The image is too large (max 8 MB).",
  2207005: "Unsupported image format. Use JPEG (prepare_media converts it).",
  2207006: "The media was not found at the URL, or permissions are missing.",
  2207008: "The container expired (containers last 24 hours). Publish again.",
  2207009: "Aspect ratio not supported. Feed: 4:5 to 1.91:1. Reels and stories: 9:16.",
  2207010: "Caption too long (max 2,200 characters, 30 hashtags, 20 @mentions).",
  2207020: "The media expired before it was published. Publish again.",
  2207023: "Unknown media type.",
  2207026: "Video format not supported. Use MP4/MOV, H.264 + AAC (prepare_media converts it).",
  2207027: "The media is not ready to publish yet. Wait for status FINISHED.",
  2207028: "Carousel needs 2 to 20 items, each finished processing.",
  2207032: "Creating the media failed. Try again.",
  2207035: "Product tags are not supported for this media.",
  2207042: "Instagram's daily publishing limit (100 API posts per 24 hours) is reached.",
  2207050: "The Instagram account is restricted or inactive. Open the Instagram app and check.",
  2207051: "Instagram flagged this content (spam/abuse). Change the caption or media.",
  2207052: "Meta could not fetch the media from the URL. The URL must be public when publishing.",
  2207053: "Unknown upload error. Try again.",
  2207057: "Thumbnail offset is beyond the end of the video.",
  2207067: "Collaborators are not allowed on this media type.",
};

const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006, 80008]);

/** Turn a Graph API error (parsed JSON), a fetch failure or anything thrown into an IgError. */
export function classifyMetaError(err: unknown, context = "Instagram request"): IgError {
  if (err instanceof IgError) return err;
  const e = (err ?? {}) as {
    status?: number;
    error?: MetaErrorBody;
    message?: string;
    code?: string;
    cause?: { code?: string };
  };
  const body = e.error;
  const status = e.status;
  if (body && (body.code !== undefined || body.message)) {
    const code = body.code ?? 0;
    const sub = body.error_subcode ?? 0;
    const reason = sub ? `${code}/${sub}` : String(code);
    const msg =
      [body.error_user_title, body.error_user_msg].filter(Boolean).join(": ") ||
      body.message ||
      `${context} failed`;
    if (sub === 2207042 || (code === 9 && sub === 2207042))
      return new IgError("publish_limit_reached", MEDIA_SUBCODES[2207042], {
        status,
        reason,
        hint: "Stopped instead of retrying. Check publish_budget; the oldest post leaves the rolling 24-hour window first.",
      });
    if (code === 190 || code === 102 || sub === 463 || sub === 460 || sub === 467)
      return new IgError("auth_expired", "The Instagram sign-in has expired or was revoked.", {
        status,
        reason,
        hint: "Run connect_account to sign in again.",
      });
    if (RATE_CODES.has(code) || status === 429)
      return new IgError("rate_limited", `Meta is rate limiting requests (${msg}).`, {
        retryable: true,
        status,
        reason,
        retryAfterMs: 60_000,
      });
    if (sub === 2207052 || sub === 2207003 || sub === 2207006)
      return new IgError("media_unreachable", MEDIA_SUBCODES[sub], {
        status,
        reason,
        retryable: sub === 2207003,
        hint: "With the tunnel media host, this computer must stay online until publishing finishes. A bucket host (S3/R2/Azure) avoids this.",
      });
    if (MEDIA_SUBCODES[sub])
      return new IgError("media_error", MEDIA_SUBCODES[sub], {
        status,
        reason,
        retryable: sub === 2207001 || sub === 2207032 || sub === 2207053,
      });
    if (code === 10 || (code >= 200 && code <= 299))
      return new IgError("forbidden", msg, {
        status,
        reason,
        hint: "The app is missing a permission for this. Reconnect with connect_account and grant every permission, and make sure your Meta app has the Instagram product with these permissions added.",
      });
    if (code === 100 && sub === 33) return new IgError("not_found", msg, { status, reason });
    if (code === 24 || code === 803) return new IgError("not_found", msg, { status, reason });
    if (code === 100 || status === 400)
      return new IgError("invalid_request", msg, { status, reason });
    if (code === 1 || code === 2 || body.is_transient || (status ?? 0) >= 500)
      return new IgError("server_error", msg, { status, reason, retryable: true });
    if (status === 404) return new IgError("not_found", msg, { status, reason });
    return new IgError("unknown", msg, { status, reason });
  }
  const message = e.message ?? String(err);
  // fetch with AbortSignal.timeout() rejects with a DOMException named TimeoutError (numeric code 23).
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError")
    return new IgError("network", `Request timed out: ${message}`, { retryable: true });
  const netCode = e.code ?? e.cause?.code;
  if (
    (netCode &&
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR/.test(netCode)) ||
    (err instanceof TypeError && /fetch failed|network/i.test(message))
  )
    return new IgError("network", `Network error: ${message}`, { retryable: true });
  if (status === 429)
    return new IgError("rate_limited", message, { retryable: true, status, retryAfterMs: 60_000 });
  if (status && status >= 500)
    return new IgError("server_error", message, { retryable: true, status });
  if (status === 401) return new IgError("auth_expired", message, { status });
  if (status === 403) return new IgError("forbidden", message, { status });
  if (status === 404) return new IgError("not_found", message, { status });
  return new IgError("unknown", message, { status });
}

/** Parse a Graph JSON error body from a raw fetch Response. */
export async function errorFromResponse(res: Response, context: string): Promise<IgError> {
  let data: { error?: MetaErrorBody } | undefined;
  const text = await res.text().catch(() => "");
  try {
    data = JSON.parse(text) as { error?: MetaErrorBody };
  } catch {
    /* non-JSON body */
  }
  return classifyMetaError(
    {
      status: res.status,
      error: data?.error,
      message: `${context} failed with HTTP ${res.status}${text && !data ? `: ${text.slice(0, 200)}` : ""}`,
    },
    context,
  );
}
