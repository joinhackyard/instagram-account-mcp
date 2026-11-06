import type { Config } from "../../config.js";
import { newId } from "../../crypto.js";
import type { Db } from "../../db.js";
import { log } from "../../log.js";
import type { HostCheck, HostKind, MediaHost } from "../host.js";
import { AzureHost } from "./azure.js";
import { S3Host } from "./s3.js";
import { TunnelHost } from "./tunnel.js";

export interface HostedRow {
  id: string;
  host: HostKind;
  key: string;
  url: string;
  job_id: string | null;
  created_at: number;
  expires_at: number;
  removed_at: number | null;
}

export function s3Configured(cfg: Config) {
  const s = cfg.media.s3;
  return Boolean(s.bucket && s.accessKeyId && s.secretAccessKey);
}

export function azureConfigured(cfg: Config) {
  const a = cfg.media.azure;
  return Boolean((a.account && a.accountKey && a.container) || a.containerSasUrl);
}

/** Picks the configured media host and keeps a ledger of hosted files so they are always cleaned up. */
export class MediaHosts {
  private readonly cache = new Map<HostKind, MediaHost>();

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  /** auto: a configured bucket (S3/R2, then Azure) beats the tunnel, because it survives restarts. */
  activeKind(): HostKind {
    const h = this.cfg.media.host;
    if (h !== "auto") return h;
    if (s3Configured(this.cfg)) return "s3";
    if (azureConfigured(this.cfg)) return "azure";
    return "tunnel";
  }

  host(kind: HostKind = this.activeKind()): MediaHost {
    let h = this.cache.get(kind);
    if (!h) {
      const ttl = this.cfg.media.ttlHours;
      h =
        kind === "s3"
          ? new S3Host(this.cfg.media.s3, ttl)
          : kind === "azure"
            ? new AzureHost(this.cfg.media.azure, ttl)
            : new TunnelHost(this.cfg.home, ttl, this.cfg.media.cloudflaredPath);
      this.cache.set(kind, h);
    }
    return h;
  }

  async check(kind: HostKind = this.activeKind()): Promise<HostCheck & { kind: HostKind }> {
    return { kind, ...(await this.host(kind).check()) };
  }

  /** Upload / expose a local file and record it. */
  async put(
    localPath: string,
    contentType: string,
    name: string,
    jobId?: string,
  ): Promise<HostedRow> {
    const kind = this.activeKind();
    const f = await this.host(kind).put(localPath, contentType, name);
    const row: HostedRow = {
      id: newId(),
      host: kind,
      key: f.key,
      url: f.url,
      job_id: jobId ?? null,
      created_at: Date.now(),
      expires_at: f.expiresAt,
      removed_at: null,
    };
    this.db.run(
      "insert into hosted_media(id, host, key, url, job_id, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.host,
      row.key,
      // Signed links (presigned / SAS) stay out of the database; the job keeps what it needs.
      row.url.split("?")[0],
      row.job_id,
      row.created_at,
      row.expires_at,
    );
    return row;
  }

  get(id: string): HostedRow | undefined {
    return this.db.get<HostedRow>("select * from hosted_media where id = ?", id);
  }

  /**
   * Can Meta still fetch this file? Bucket links work until they expire; tunnel links only while the
   * process that registered them is alive.
   */
  stillServes(id: string): boolean {
    const r = this.get(id);
    if (!r || r.removed_at || r.expires_at < Date.now() + 10 * 60_000) return false;
    const h = this.host(r.host) as Partial<TunnelHost>;
    if (typeof h.serves === "function") return h.serves(r.key);
    return true;
  }

  /** Tests: replace a host implementation. */
  setHostForTests(kind: HostKind, host: MediaHost) {
    this.cache.set(kind, host);
  }

  async release(id: string | undefined): Promise<void> {
    if (!id) return;
    const r = this.get(id);
    if (!r || r.removed_at) return;
    try {
      await this.host(r.host).remove(r.key);
      this.db.run("update hosted_media set removed_at = ? where id = ?", Date.now(), id);
    } catch (e) {
      log.warn("could not remove hosted media; will retry", { host: r.host, error: String(e) });
    }
  }

  /** Remove expired files and those whose job ended (retries failed removals). */
  async cleanup(): Promise<void> {
    const rows = this.db.all<HostedRow>(
      `select h.* from hosted_media h left join jobs j on j.id = h.job_id
       where h.removed_at is null and (h.expires_at < ? or j.finished_at is not null or (h.job_id is not null and j.id is null))
       limit 200`,
      Date.now(),
    );
    for (const r of rows) {
      if (r.host === "tunnel") {
        // Tunnel files only live in memory of the process that served them.
        await this.host("tunnel").remove(r.key);
        this.db.run("update hosted_media set removed_at = ? where id = ?", Date.now(), r.id);
      } else await this.release(r.id);
    }
  }

  async close() {
    for (const h of this.cache.values()) await h.close().catch(() => undefined);
  }
}
