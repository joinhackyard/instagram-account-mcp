/**
 * Instagram fetches every image (and, with Instagram Login, every video) from a public URL. A MediaHost
 * turns a local file into such a URL for as long as publishing takes, then removes it.
 *
 * - tunnel: a tiny local file server exposed through a Cloudflare quick tunnel (cloudflared). Zero setup,
 *   free, nothing stored anywhere; this computer must stay online until Meta has fetched the file.
 * - s3: any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO...), presigned GET URLs.
 * - azure: Azure Blob Storage, read-only SAS URLs.
 */
export type HostKind = "tunnel" | "s3" | "azure";

export interface HostedFile {
  /** URL Meta can fetch. */
  url: string;
  /** Host-specific key used to remove it later. */
  key: string;
  /** When the URL stops working (ms epoch). */
  expiresAt: number;
}

export interface HostCheck {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface MediaHost {
  readonly kind: HostKind;
  /** Is it configured and reachable? Cheap; no upload. */
  check(): Promise<HostCheck>;
  /** Make a local file publicly fetchable. `name` is a safe file name hint (extension matters to Meta). */
  put(localPath: string, contentType: string, name: string): Promise<HostedFile>;
  /** Remove a file. Must not throw when it is already gone. */
  remove(key: string): Promise<void>;
  /** Release resources (stop the tunnel / server). */
  close(): Promise<void>;
}
