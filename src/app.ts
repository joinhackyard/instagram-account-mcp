import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Accounts } from "./accounts.js";
import { loadAiSettings } from "./ai/providers.js";
import { loadConfig, SECRET, type Config } from "./config.js";
import { Connector } from "./connect.js";
import { Db } from "./db.js";
import { Experiments } from "./experiments.js";
import { MediaHosts } from "./media/hosts/index.js";
import { JobManager } from "./publish/jobs.js";
import { Scheduler } from "./scheduler.js";
import { TemplateStore } from "./templates.js";
import { openVault, type TokenVault } from "./vault.js";

export interface App {
  cfg: Config;
  db: Db;
  vault: TokenVault;
  accounts: Accounts;
  hosts: MediaHosts;
  templates: TemplateStore;
  jobs: JobManager;
  connector: Connector;
  experiments: Experiments;
  scheduler: Scheduler;
}

/** Fill secrets that are not in the environment from the vault (saved by `setup`). */
async function loadSecrets(cfg: Config, vault: TokenVault) {
  cfg.meta.appId ??= (await vault.get(SECRET.metaAppId)) ?? undefined;
  cfg.meta.appSecret ??= (await vault.get(SECRET.metaAppSecret)) ?? undefined;
  cfg.media.s3.secretAccessKey ??= (await vault.get(SECRET.s3SecretKey)) ?? undefined;
  cfg.media.azure.accountKey ??= (await vault.get(SECRET.azureKey)) ?? undefined;
  cfg.media.azure.containerSasUrl ??= (await vault.get(SECRET.azureSasUrl)) ?? undefined;
}

/** Non-secret settings saved by `setup` (DB key "config"); environment variables win. */
export interface SavedConfig {
  authMode?: Config["meta"]["authMode"];
  configId?: string;
  redirectPort?: number;
  redirectUri?: string;
  graphVersion?: string;
  media?: {
    host?: Config["media"]["host"];
    ttlHours?: number;
    cloudflaredPath?: string;
    s3?: Partial<Omit<Config["media"]["s3"], "secretAccessKey">>;
    azure?: Partial<Omit<Config["media"]["azure"], "accountKey" | "containerSasUrl">>;
  };
}

export function readSavedConfig(db: Db): SavedConfig {
  try {
    return JSON.parse(db.setting("config") ?? "{}") as SavedConfig;
  } catch {
    return {};
  }
}

export function saveConfig(db: Db, patch: SavedConfig) {
  const cur = readSavedConfig(db);
  const next: SavedConfig = {
    ...cur,
    ...patch,
    media: {
      ...cur.media,
      ...patch.media,
      s3: { ...cur.media?.s3, ...patch.media?.s3 },
      azure: { ...cur.media?.azure, ...patch.media?.azure },
    },
  };
  db.setSetting("config", JSON.stringify(next));
}

export function applySavedConfig(cfg: Config, saved: SavedConfig, env: NodeJS.ProcessEnv) {
  if (!env.IG_AUTH_MODE && saved.authMode) cfg.meta.authMode = saved.authMode;
  if (!env.IG_MCP_CONFIG_ID && saved.configId) cfg.meta.configId = saved.configId;
  if (!env.IG_REDIRECT_PORT && saved.redirectPort) cfg.meta.redirectPort = saved.redirectPort;
  if (!env.IG_REDIRECT_URI && saved.redirectUri) cfg.meta.redirectUri = saved.redirectUri;
  if (!env.IG_GRAPH_VERSION && saved.graphVersion) cfg.meta.graphVersion = saved.graphVersion;
  const m = saved.media;
  if (!m) return;
  if (!env.IG_MEDIA_HOST && m.host) cfg.media.host = m.host;
  if (!env.IG_MEDIA_TTL_HOURS && m.ttlHours) cfg.media.ttlHours = m.ttlHours;
  if (!env.IG_CLOUDFLARED && m.cloudflaredPath) cfg.media.cloudflaredPath = m.cloudflaredPath;
  for (const [k, v] of Object.entries(m.s3 ?? {}))
    if (v !== undefined && (cfg.media.s3 as unknown as Record<string, unknown>)[k] === undefined)
      (cfg.media.s3 as unknown as Record<string, unknown>)[k] = v;
  if (m.s3?.region && !env.IG_S3_REGION) cfg.media.s3.region = m.s3.region;
  if (m.s3?.prefix !== undefined && env.IG_S3_PREFIX === undefined)
    cfg.media.s3.prefix = m.s3.prefix;
  if (m.s3?.pathStyle !== undefined && env.IG_S3_PATH_STYLE === undefined)
    cfg.media.s3.pathStyle = m.s3.pathStyle;
  for (const [k, v] of Object.entries(m.azure ?? {}))
    if (v !== undefined && (cfg.media.azure as unknown as Record<string, unknown>)[k] === undefined)
      (cfg.media.azure as unknown as Record<string, unknown>)[k] = v;
  if (m.azure?.prefix !== undefined && env.IG_AZURE_PREFIX === undefined)
    cfg.media.azure.prefix = m.azure.prefix;
}

export async function createApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const cfg = loadConfig(env);
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  const vault = openVault(cfg.home, env.IG_MCP_VAULT);
  await loadSecrets(cfg, vault);

  const db = new Db(join(cfg.home, "state.db"));
  applySavedConfig(cfg, readSavedConfig(db), env);
  await loadAiSettings(cfg.ai, env, db, vault);

  const accounts = new Accounts(db, vault, cfg);
  const hosts = new MediaHosts(db, cfg);
  const templates = new TemplateStore(cfg.templatesDir);
  const jobs = new JobManager(db, cfg, accounts, hosts, templates);
  const connector = new Connector(cfg, accounts, (rows) => {
    for (const r of rows) jobs.requeueForAccount(r.id);
  });
  const experiments = new Experiments(db, cfg, accounts, jobs);
  jobs.onPublished = (job) => experiments.onJobPublished(job);
  const scheduler = new Scheduler(db, [
    { name: "experiments", run: (renew) => experiments.tick(renew) },
    { name: "tokens", run: () => accounts.refreshDue(), everyMs: 6 * 3_600_000 },
    { name: "media-cleanup", run: () => hosts.cleanup(), everyMs: 30 * 60_000 },
  ]);
  return { cfg, db, vault, accounts, hosts, templates, jobs, connector, experiments, scheduler };
}
