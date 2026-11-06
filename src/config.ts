import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "instagram-account-mcp";
/** npm package name (published under the joinhackyard organisation). */
export const PACKAGE = "@joinhackyard/instagram-account-mcp";
/** Single source of truth: the version in package.json. */
export const VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

export type ConfirmPolicy = "public" | "always" | "never";

/**
 * facebook: "Instagram API with Facebook Login" (graph.facebook.com). Account linked to a Facebook Page;
 *   local videos upload straight to Meta (resumable), Page tokens do not expire.
 * instagram: "Instagram API with Instagram Login" (graph.instagram.com). No Facebook Page needed;
 *   every file needs a public URL (media host), tokens last 60 days and are refreshed automatically.
 */
export type AuthMode = "facebook" | "instagram";

export type MediaHostKind = "auto" | "tunnel" | "s3" | "azure";

export interface S3Settings {
  /** S3-compatible endpoint, e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com */
  endpoint?: string;
  region: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** If the bucket (or a CDN in front of it) is public: base URL for objects. Otherwise presigned URLs are used. */
  publicBaseUrl?: string;
  prefix: string;
  /** Path-style URLs (https://endpoint/bucket/key). R2, MinIO and most S3-compatible stores need this. */
  pathStyle: boolean;
}

export interface AzureBlobSettings {
  /** Storage account name (with accountKey) ... */
  account?: string;
  accountKey?: string;
  container?: string;
  /** ... or a container SAS URL with read, create, write and delete permission. */
  containerSasUrl?: string;
  prefix: string;
}

export interface MediaSettings {
  host: MediaHostKind;
  /** How long hosted files stay reachable (presigned URL lifetime and cleanup age). */
  ttlHours: number;
  cloudflaredPath?: string;
  s3: S3Settings;
  azure: AzureBlobSettings;
}

export interface Config {
  home: string;
  meta: {
    appId?: string;
    appSecret?: string;
    /** Facebook Login for Business configuration ID (optional; scopes are requested directly without it). */
    configId?: string;
    authMode: AuthMode;
    graphVersion: string;
    /** Fixed loopback port: Meta only accepts redirect URIs registered in the app, port included. */
    redirectPort: number;
    /** Override the redirect URI (e.g. https://localhost:8765/callback when Meta insists on HTTPS). */
    redirectUri?: string;
  };
  confirmPolicy: ConfirmPolicy;
  /** Instagram allows 100 API-published posts per account per rolling 24 hours (carousels count once). */
  publishLimit: number;
  maxUploadBytes: number;
  templatesDir: string;
  media: MediaSettings;
  ai: AiSettings;
}

/** AI providers the server can call itself. All optional: without them, tools return briefs for your AI app. */
export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "azure",
  "gemini",
  "openrouter",
  "groq",
  "ollama",
  "custom",
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** What a model is used for. text: writing and analysis; vision: judging thumbnails; image: making thumbnails. */
export const AI_TASKS = ["text", "vision", "image", "transcribe"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiProviderSettings {
  apiKey?: string;
  /** OpenAI-compatible base URL (OpenRouter, Groq, Ollama, custom) or override. */
  baseUrl?: string;
  /** Azure OpenAI resource endpoint, e.g. https://name.openai.azure.com */
  endpoint?: string;
  apiVersion?: string;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, AiProviderSettings>>;
  /** Per task: "provider:model" (for Azure the model is the deployment name). */
  models: Partial<Record<AiTask, string>>;
  /** Reasoning effort for Claude and OpenAI reasoning models. */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const trimUrl = (u?: string) => (u ? u.trim().replace(/\/+$/, "") : undefined);

export const DEFAULT_GRAPH_VERSION = "v27.0";
export const DEFAULT_REDIRECT_PORT = 8765;

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IG_MCP_HOME) return env.IG_MCP_HOME;
  if (process.platform === "linux" && env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, APP);
  return join(homedir(), `.${APP}`);
}

/** Environment variables override; secrets not in the environment are read from the vault at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = defaultHome(env);
  const policy = (env.IG_CONFIRM ?? "public").toLowerCase();
  const mode = (env.IG_AUTH_MODE ?? "").toLowerCase();
  const host = (env.IG_MEDIA_HOST ?? "auto").toLowerCase();
  return {
    home,
    meta: {
      appId: env.IG_MCP_APP_ID || env.META_APP_ID || undefined,
      appSecret: env.IG_MCP_APP_SECRET || env.META_APP_SECRET || undefined,
      configId: env.IG_MCP_CONFIG_ID || undefined,
      authMode: mode === "instagram" ? "instagram" : "facebook",
      graphVersion: env.IG_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
      redirectPort: int(env.IG_REDIRECT_PORT, DEFAULT_REDIRECT_PORT) || DEFAULT_REDIRECT_PORT,
      redirectUri: env.IG_REDIRECT_URI || undefined,
    },
    confirmPolicy: policy === "always" || policy === "never" ? policy : "public",
    publishLimit: int(env.IG_DAILY_POST_LIMIT, 100),
    maxUploadBytes: int(env.IG_MAX_UPLOAD_MB, 1024) * 1024 ** 2,
    templatesDir: env.IG_TEMPLATES_DIR || join(home, "templates"),
    media: {
      host: (["tunnel", "s3", "azure"].includes(host) ? host : "auto") as MediaHostKind,
      ttlHours: int(env.IG_MEDIA_TTL_HOURS, 48) || 48,
      cloudflaredPath: env.IG_CLOUDFLARED || undefined,
      s3: {
        endpoint: trimUrl(env.IG_S3_ENDPOINT),
        region: env.IG_S3_REGION || "auto",
        bucket: env.IG_S3_BUCKET || undefined,
        accessKeyId: env.IG_S3_ACCESS_KEY_ID || undefined,
        secretAccessKey: env.IG_S3_SECRET_ACCESS_KEY || undefined,
        publicBaseUrl: trimUrl(env.IG_S3_PUBLIC_BASE_URL),
        prefix: env.IG_S3_PREFIX ?? "instagram-mcp/",
        pathStyle: env.IG_S3_PATH_STYLE !== "false",
      },
      azure: {
        account: env.IG_AZURE_STORAGE_ACCOUNT || undefined,
        accountKey: env.IG_AZURE_STORAGE_KEY || undefined,
        container: env.IG_AZURE_CONTAINER || undefined,
        containerSasUrl: env.IG_AZURE_CONTAINER_SAS_URL || undefined,
        prefix: env.IG_AZURE_PREFIX ?? "instagram-mcp/",
      },
    },
    ai: aiFromEnv(env),
  };
}

/** AI settings from the environment. Values saved with `ai` (keychain + database) fill in what is missing. */
export function aiFromEnv(env: NodeJS.ProcessEnv): AiSettings {
  const p: AiSettings["providers"] = {};
  const set = (id: AiProviderId, v: AiProviderSettings) => {
    const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as AiProviderSettings;
    if (Object.keys(clean).length) p[id] = clean;
  };
  set("anthropic", { apiKey: env.ANTHROPIC_API_KEY });
  set("openai", { apiKey: env.OPENAI_API_KEY, baseUrl: trimUrl(env.OPENAI_BASE_URL) });
  set("azure", {
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: trimUrl(env.AZURE_OPENAI_ENDPOINT),
    apiVersion: env.AZURE_OPENAI_API_VERSION,
  });
  set("gemini", { apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY });
  set("openrouter", { apiKey: env.OPENROUTER_API_KEY });
  set("groq", { apiKey: env.GROQ_API_KEY });
  set("ollama", { baseUrl: trimUrl(env.OLLAMA_BASE_URL) });
  set("custom", { apiKey: env.AI_CUSTOM_API_KEY, baseUrl: trimUrl(env.AI_CUSTOM_BASE_URL) });
  const models: AiSettings["models"] = {};
  if (env.IG_AI_TEXT_MODEL) models.text = env.IG_AI_TEXT_MODEL;
  if (env.IG_AI_VISION_MODEL) models.vision = env.IG_AI_VISION_MODEL;
  if (env.IG_AI_IMAGE_MODEL) models.image = env.IG_AI_IMAGE_MODEL;
  if (env.IG_AI_TRANSCRIBE_MODEL) models.transcribe = env.IG_AI_TRANSCRIBE_MODEL;
  const effort = env.IG_AI_EFFORT;
  return {
    providers: p,
    models,
    effort:
      effort === "low" || effort === "high" || effort === "xhigh" || effort === "max"
        ? effort
        : "medium",
  };
}

/** Names of secrets kept in the OS keychain (or encrypted file) by `setup`. */
export const SECRET = {
  metaAppId: "config:meta-app-id",
  metaAppSecret: "config:meta-app-secret",
  s3SecretKey: "config:s3-secret-access-key",
  azureKey: "config:azure-storage-key",
  azureSasUrl: "config:azure-container-sas-url",
  /** Access token(s) for a connected account, JSON. */
  accountToken: (rowId: string) => `account-token:${rowId}`,
  /** Per-provider AI keys: `ai-key:anthropic`, `ai-key:openai`, ... */
  aiKey: (provider: string) => `ai-key:${provider}`,
} as const;
