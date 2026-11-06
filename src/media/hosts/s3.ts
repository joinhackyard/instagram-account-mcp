import { createHash, createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { S3Settings } from "../../config.js";
import { randomToken } from "../../crypto.js";
import { IgError } from "../../errors.js";
import type { HostCheck, HostedFile, MediaHost } from "../host.js";

const UNSIGNED = "UNSIGNED-PAYLOAD";
const EMPTY_SHA = createHash("sha256").update("").digest("hex");

const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** RFC 3986 encoding as SigV4 wants it; `/` kept in object keys. */
export function uriEncode(s: string, keepSlash = false): string {
  return [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
}

function amzDates(now: Date) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function signingKey(secret: string, day: string, region: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
}

function canonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** SigV4 header signing. Returns the headers to send. */
export function signHeaders(i: SignInput): Record<string, string> {
  const { amzDate, day } = amzDates(i.now ?? new Date());
  const payloadHash = i.payloadHash ?? EMPTY_SHA;
  const headers: Record<string, string> = {
    ...i.headers,
    host: i.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim()}\n`).join("");
  const signed = names.join(";");
  const canonical = [
    i.method,
    uriEncode(decodeURIComponent(i.url.pathname), true),
    canonicalQuery(i.url),
    canonicalHeaders,
    signed,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const sig = hmac(signingKey(i.secretAccessKey, day, i.region), toSign).toString("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

/** SigV4 presigned GET URL (query-string auth), max 7 days. */
export function presignGet(
  i: Omit<SignInput, "method" | "headers" | "payloadHash"> & { expiresSec: number },
) {
  const { amzDate, day } = amzDates(i.now ?? new Date());
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const url = new URL(i.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${i.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(Math.min(604_800, Math.max(60, i.expiresSec))));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonical = [
    "GET",
    uriEncode(decodeURIComponent(url.pathname), true),
    canonicalQuery(url),
    `host:${url.host}\n`,
    "host",
    UNSIGNED,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  url.searchParams.set(
    "X-Amz-Signature",
    hmac(signingKey(i.secretAccessKey, day, i.region), toSign).toString("hex"),
  );
  return url.toString();
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setS3FetchForTests(f: typeof fetch | undefined) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

/** Any S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO... */
export class S3Host implements MediaHost {
  readonly kind = "s3" as const;

  constructor(
    private readonly s: S3Settings,
    private readonly ttlHours: number,
  ) {}

  private configured(): HostCheck | null {
    const missing = (
      [
        ["bucket", this.s.bucket],
        ["access key id", this.s.accessKeyId],
        ["secret access key", this.s.secretAccessKey],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length)
      return {
        ok: false,
        detail: `S3 media host is missing: ${missing.join(", ")}.`,
        fix: "Run `setup` (Media host step) or set IG_S3_BUCKET, IG_S3_ACCESS_KEY_ID, IG_S3_SECRET_ACCESS_KEY (and IG_S3_ENDPOINT for R2/B2/MinIO).",
      };
    return null;
  }

  /** Region for signing. R2 uses "auto"; AWS needs the bucket's real region. */
  private get region() {
    if (this.s.region && this.s.region !== "auto") return this.s.region;
    const m = /s3[.-]([a-z0-9-]+)\.amazonaws\.com/.exec(this.s.endpoint ?? "");
    return m?.[1] ?? (this.s.endpoint ? "auto" : "us-east-1");
  }

  objectUrl(key: string): URL {
    const endpoint = this.s.endpoint ?? `https://s3.${this.region}.amazonaws.com`;
    const base = new URL(endpoint);
    const path = uriEncode(key, true);
    if (this.s.pathStyle || !this.s.endpoint?.includes("amazonaws.com"))
      return new URL(`${base.origin}/${uriEncode(this.s.bucket!)}/${path}`);
    return new URL(`${base.protocol}//${this.s.bucket}.${base.host}/${path}`);
  }

  private publicUrl(key: string, expiresSec: number): string {
    if (this.s.publicBaseUrl) return `${this.s.publicBaseUrl}/${uriEncode(key, true)}`;
    return presignGet({
      url: this.objectUrl(key),
      region: this.region,
      accessKeyId: this.s.accessKeyId!,
      secretAccessKey: this.s.secretAccessKey!,
      expiresSec,
    });
  }

  async check(): Promise<HostCheck> {
    const bad = this.configured();
    if (bad) return bad;
    // Write, read back through the public URL, delete: proves Meta will be able to fetch.
    const key = `${this.s.prefix}healthcheck-${randomToken("", 6)}.txt`;
    try {
      await this.send("PUT", key, Buffer.from("ok"), "text/plain");
      const r = await fetchImpl(this.publicUrl(key, 300), { signal: AbortSignal.timeout(20_000) });
      await this.remove(key);
      if (!r.ok)
        return {
          ok: false,
          detail: `Uploaded, but the public URL returned HTTP ${r.status}.`,
          fix: this.s.publicBaseUrl
            ? "Check IG_S3_PUBLIC_BASE_URL points at this bucket and that it is publicly readable."
            : "Check the region (IG_S3_REGION) and that the key may read objects.",
        };
      return { ok: true, detail: `S3 bucket ${this.s.bucket} (${this.s.endpoint ?? "AWS"})` };
    } catch (e) {
      return { ok: false, detail: `S3 check failed: ${(e as Error).message}` };
    }
  }

  private async send(
    method: "PUT" | "DELETE",
    key: string,
    body?: Buffer | { path: string; size: number },
    contentType?: string,
  ) {
    const url = this.objectUrl(key);
    const headers: Record<string, string> = {};
    let payload: RequestInit["body"] | undefined;
    let payloadHash = EMPTY_SHA;
    if (Buffer.isBuffer(body)) {
      payload = new Uint8Array(body);
      payloadHash = createHash("sha256").update(body).digest("hex");
      headers["content-length"] = String(body.length);
    } else if (body && "path" in body) {
      payload = Readable.toWeb(createReadStream(body.path)) as unknown as NonNullable<
        RequestInit["body"]
      >;
      payloadHash = UNSIGNED;
      headers["content-length"] = String(body.size);
    }
    if (contentType) headers["content-type"] = contentType;
    const signed = signHeaders({
      method,
      url,
      region: this.region,
      accessKeyId: this.s.accessKeyId!,
      secretAccessKey: this.s.secretAccessKey!,
      headers,
      payloadHash,
    });
    delete signed.host;
    const res = await fetchImpl(url, {
      method,
      headers: signed,
      body: payload,
      // Node needs this for streamed request bodies.
      ...(payload && !Buffer.isBuffer(body) ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit);
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new IgError(
        res.status >= 500 ? "network" : "not_configured",
        `S3 ${method} failed: HTTP ${res.status}${code ? ` ${code}` : ""}`,
        {
          retryable: res.status >= 500,
          hint:
            code === "SignatureDoesNotMatch"
              ? "Check the secret key and region (R2 uses region auto)."
              : code === "NoSuchBucket"
                ? "Check the bucket name and endpoint."
                : undefined,
        },
      );
    }
  }

  async put(localPath: string, contentType: string, name: string): Promise<HostedFile> {
    const bad = this.configured();
    if (bad) throw new IgError("not_configured", bad.detail, { hint: bad.fix });
    const key = `${this.s.prefix}${randomToken("", 16)}/${name.replace(/[^\w.-]/g, "_")}`;
    const size = statSync(localPath).size;
    await this.send("PUT", key, { path: localPath, size }, contentType);
    const ttl = this.ttlHours * 3600;
    return { url: this.publicUrl(key, ttl), key, expiresAt: Date.now() + ttl * 1000 };
  }

  async remove(key: string): Promise<void> {
    if (this.configured()) return;
    await this.send("DELETE", key);
  }

  async close() {}
}
