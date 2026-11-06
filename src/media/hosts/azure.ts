import { createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { AzureBlobSettings } from "../../config.js";
import { randomToken } from "../../crypto.js";
import { IgError } from "../../errors.js";
import type { HostCheck, HostedFile, MediaHost } from "../host.js";
import { uriEncode } from "./s3.js";

const VERSION = "2022-11-02";

let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setAzureFetchForTests(f: typeof fetch | undefined) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Service SAS for one blob (signed version 2020-12-06 or later string-to-sign layout).
 * https://learn.microsoft.com/rest/api/storageservices/create-service-sas
 */
export function blobSas(opts: {
  account: string;
  accountKey: string;
  container: string;
  blob: string;
  permissions: string;
  expiresAt: number;
  startsAt?: number;
}): string {
  const st = iso(opts.startsAt ?? Date.now() - 5 * 60_000);
  const se = iso(opts.expiresAt);
  const resource = `/blob/${opts.account}/${opts.container}/${opts.blob}`;
  const toSign = [
    opts.permissions,
    st,
    se,
    resource,
    "", // signedIdentifier
    "", // signedIP
    "https",
    VERSION,
    "b",
    "", // signedSnapshotTime
    "", // signedEncryptionScope
    "",
    "",
    "",
    "",
    "",
  ].join("\n");
  const sig = createHmac("sha256", Buffer.from(opts.accountKey, "base64"))
    .update(toSign, "utf8")
    .digest("base64");
  const q = new URLSearchParams({
    sv: VERSION,
    st,
    se,
    sr: "b",
    sp: opts.permissions,
    spr: "https",
    sig,
  });
  return q.toString();
}

/** Azure Blob Storage: account name + key (read-only SAS per file), or a container SAS URL. */
export class AzureHost implements MediaHost {
  readonly kind = "azure" as const;

  constructor(
    private readonly s: AzureBlobSettings,
    private readonly ttlHours: number,
  ) {}

  private mode(): "key" | "sas" | null {
    if (this.s.account && this.s.accountKey && this.s.container) return "key";
    if (this.s.containerSasUrl) return "sas";
    return null;
  }

  private container(): { origin: string; name: string; sas?: string; account: string } {
    if (this.mode() === "sas") {
      const u = new URL(this.s.containerSasUrl!);
      const name = u.pathname.replace(/^\/+|\/+$/g, "");
      return { origin: u.origin, name, sas: u.search.slice(1), account: u.hostname.split(".")[0] };
    }
    return {
      origin: `https://${this.s.account}.blob.core.windows.net`,
      name: this.s.container!,
      account: this.s.account!,
    };
  }

  private blobUrl(key: string, sas?: string) {
    const c = this.container();
    return `${c.origin}/${c.name}/${uriEncode(key, true)}${sas ? `?${sas}` : ""}`;
  }

  private sasFor(key: string, permissions: string, ttlMs: number): string {
    const c = this.container();
    if (c.sas) return c.sas;
    return blobSas({
      account: c.account,
      accountKey: this.s.accountKey!,
      container: c.name,
      blob: key,
      permissions,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async check(): Promise<HostCheck> {
    if (!this.mode())
      return {
        ok: false,
        detail: "Azure media host is not configured.",
        fix: "Run `setup` (Media host step), or set IG_AZURE_STORAGE_ACCOUNT + IG_AZURE_STORAGE_KEY + IG_AZURE_CONTAINER, or IG_AZURE_CONTAINER_SAS_URL.",
      };
    const tmp = `${this.s.prefix}healthcheck-${randomToken("", 6)}.txt`;
    try {
      await this.upload(tmp, Buffer.from("ok"), "text/plain");
      const hosted = await this.readUrl(tmp, 300_000);
      const r = await fetchImpl(hosted, { signal: AbortSignal.timeout(20_000) });
      await this.remove(tmp);
      if (!r.ok)
        return { ok: false, detail: `Uploaded, but reading it back returned HTTP ${r.status}.` };
      return {
        ok: true,
        detail: `Azure Blob container ${this.container().name} (${this.mode() === "key" ? "read-only links per file" : "container SAS link"})`,
        fix:
          this.mode() === "sas"
            ? "With a container SAS URL, that SAS is part of every link Meta fetches. Prefer account name + key (read-only links per file), or a dedicated container."
            : undefined,
      };
    } catch (e) {
      return { ok: false, detail: `Azure check failed: ${(e as Error).message}` };
    }
  }

  private async upload(
    key: string,
    body: Buffer | { path: string; size: number },
    contentType: string,
  ) {
    const url = this.blobUrl(key, this.sasFor(key, "cw", 3_600_000));
    const file = Buffer.isBuffer(body) ? undefined : (body as { path: string; size: number });
    const buf = Buffer.isBuffer(body) ? body : undefined;
    const isBuf = Boolean(buf);
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": VERSION,
        "content-type": contentType,
        "content-length": String(buf ? buf.length : file!.size),
      },
      body: buf
        ? new Uint8Array(buf)
        : (Readable.toWeb(createReadStream(file!.path)) as unknown as NonNullable<
            RequestInit["body"]
          >),
      ...(isBuf ? {} : { duplex: "half" }),
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new IgError(
        res.status >= 500 ? "network" : "not_configured",
        `Azure upload failed: HTTP ${res.status}${code ? ` ${code}` : ""}`,
        {
          retryable: res.status >= 500,
          hint:
            code === "AuthenticationFailed"
              ? "Check the storage key or SAS (needs create + write + read + delete, and not expired)."
              : code === "ContainerNotFound"
                ? "Create the container first."
                : undefined,
        },
      );
    }
  }

  /** A URL Meta can fetch: plain if the container allows anonymous blob reads, otherwise a SAS link. */
  private async readUrl(key: string, ttlMs: number): Promise<string> {
    const plain = this.blobUrl(key);
    const head = await fetchImpl(plain, {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (head?.ok) return plain;
    return this.blobUrl(key, this.sasFor(key, "r", ttlMs));
  }

  async put(localPath: string, contentType: string, name: string): Promise<HostedFile> {
    if (!this.mode())
      throw new IgError("not_configured", "Azure media host is not configured.", {
        hint: "Run `setup` and choose the Azure media host.",
      });
    const key = `${this.s.prefix}${randomToken("", 16)}/${name.replace(/[^\w.-]/g, "_")}`;
    await this.upload(key, { path: localPath, size: statSync(localPath).size }, contentType);
    const ttl = this.ttlHours * 3_600_000;
    return { url: await this.readUrl(key, ttl), key, expiresAt: Date.now() + ttl };
  }

  async remove(key: string): Promise<void> {
    if (!this.mode()) return;
    const res = await fetchImpl(this.blobUrl(key, this.sasFor(key, "d", 600_000)), {
      method: "DELETE",
      headers: { "x-ms-version": VERSION },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404)
      throw new IgError("network", `Azure delete failed: HTTP ${res.status}`, { retryable: true });
  }

  async close() {}
}
