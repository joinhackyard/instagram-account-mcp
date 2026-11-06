import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { decrypt, encrypt } from "./crypto.js";
import { log } from "./log.js";
import { APP } from "./config.js";

const SERVICE = APP;

/** Where Google refresh tokens (and local secrets) live. Never in the repo, never in plain text. */
export interface TokenVault {
  readonly kind: "keychain" | "encrypted-file";
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

interface KeyringEntry {
  setPassword(p: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

/** OS keychain: macOS Keychain, Windows Credential Manager, Linux Secret Service. */
export class KeychainVault implements TokenVault {
  readonly kind = "keychain" as const;
  constructor(private readonly Entry: new (service: string, user: string) => KeyringEntry) {}

  static tryCreate(): KeychainVault | null {
    try {
      const require = createRequire(import.meta.url);
      const mod = require("@napi-rs/keyring") as {
        Entry: new (s: string, u: string) => KeyringEntry;
      };
      // Read-only probe: throws when no keychain backend is available (e.g. headless Linux).
      new mod.Entry(SERVICE, "__probe__").getPassword();
      return new KeychainVault(mod.Entry);
    } catch (e) {
      log.debug("OS keychain unavailable", { error: String(e) });
      return null;
    }
  }

  async get(name: string) {
    try {
      return new this.Entry(SERVICE, name).getPassword();
    } catch {
      return null;
    }
  }
  async set(name: string, value: string) {
    new this.Entry(SERVICE, name).setPassword(value);
  }
  async delete(name: string) {
    try {
      new this.Entry(SERVICE, name).deletePassword();
    } catch {
      /* already gone */
    }
  }
}

/** Fallback for headless machines without a keychain: AES-GCM file, key in a separate 0600 file. */
export class EncryptedFileVault implements TokenVault {
  readonly kind = "encrypted-file" as const;
  private readonly key: Buffer;
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "vault");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keyFile = join(home, "vault.key");
    try {
      // `wx`: if two processes start together, exactly one creates the key.
      writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    chmodSync(keyFile, 0o600);
    this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  }

  /** One file per secret: no shared read-modify-write, so concurrent writers cannot lose each other's tokens. */
  private path(name: string) {
    return join(this.dir, `${name.replace(/[^\w.-]/g, "_")}.enc`);
  }
  async get(name: string) {
    const f = this.path(name);
    if (!existsSync(f)) return null;
    try {
      return decrypt(this.key, readFileSync(f, "utf8"));
    } catch (e) {
      log.warn("could not decrypt stored secret", { name, error: String(e) });
      return null;
    }
  }
  async set(name: string, value: string) {
    const f = this.path(name);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, encrypt(this.key, value), { mode: 0o600 });
    renameSync(tmp, f);
  }
  async delete(name: string) {
    rmSync(this.path(name), { force: true });
  }
}

/**
 * The first run decides keychain vs encrypted file and remembers it, so a terminal `setup` and a
 * GUI-launched server never end up reading from different stores.
 */
export function openVault(home: string, mode = process.env.IG_MCP_VAULT): TokenVault {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = join(home, "vault-kind");
  const forced = mode === "file" ? "file" : undefined;
  const saved = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
  if (forced === "file" || saved === "file") return new EncryptedFileVault(home);
  const kc = KeychainVault.tryCreate();
  if (kc) {
    if (!saved) writeFileSync(marker, "keychain\n");
    return kc;
  }
  if (saved === "keychain")
    log.warn(
      "OS keychain was used before but is unavailable now; secrets saved there cannot be read",
    );
  else writeFileSync(marker, "file\n");
  return new EncryptedFileVault(home);
}
