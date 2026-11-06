#!/usr/bin/env node
import "./quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  clearAi,
  describeAi,
  isConfigured,
  listModels,
  loadAiSettings,
  parseModelRef,
  PROVIDERS,
  removeProvider,
  resolveModel,
  saveModels,
  saveProvider,
  testAi,
} from "./ai/providers.js";
import { AI_PROVIDERS, AI_TASKS, type AiProviderId, type AiTask } from "./config.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { hasFfmpeg } from "./ai/transcript.js";
import { describeAccount } from "./accounts.js";
import { createApp, saveConfig, type App } from "./app.js";
import { CLIENTS, launchSpec, manualSnippets } from "./clients.js";
import { APP, PACKAGE, SECRET, VERSION, type AuthMode } from "./config.js";
import { loopbackPort, openBrowser } from "./connect.js";
import { IgError } from "./errors.js";
import { log } from "./log.js";
import { findCloudflared, installCloudflared } from "./media/hosts/tunnel.js";
import { buildServer } from "./mcp/server.js";
import { redirectUriFor } from "./meta/oauth.js";

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = "") => process.stdout.write(s + "\n");

const HELP = `${bold(`${APP} ${VERSION}`)}
Run and grow your Instagram account from Claude, Hermes, Cursor, Codex and any MCP client.

${bold("Get started")}
  npx ${PACKAGE} setup            Guided setup: Meta app, media host, connect, add to your AI apps

${bold("Commands")}
  setup                        Run the guided setup (safe to re-run)
  connect                      Connect or reconnect Instagram accounts (opens the Meta sign-in)
  status                       Show connected accounts, scheduled posts and configuration
  media [tunnel|s3|azure|test] Choose and test where local files are hosted for Meta to fetch
  install [client...]          Add the server to AI apps: ${CLIENTS.map((c) => c.id).join(", ")}, or "all"
  uninstall [client...]        Remove it from AI apps
  ai                           Connect AI providers: Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama
  config                       Print config snippets for any other MCP client
  doctor                       Check everything and explain what to fix
  serve                        Run the MCP server over stdio (what AI apps start)
  daemon                       Run background work only: scheduled posts, A/B tests, token refresh
  service install|uninstall|status
                               Keep the daemon running in the background (launchd / systemd / Task Scheduler)

${bold("Options for install")}
  --npx                        Launch with "npx -y ${PACKAGE}@latest" (always latest)
  --node                       Launch this installed copy directly with node

Docs: https://github.com/joinhackyard/${APP}#readme`;

async function ask(
  rl: ReturnType<typeof createInterface>,
  q: string,
  def?: string,
): Promise<string> {
  const a = (await rl.question(`${q}${def ? dim(` [${def}]`) : ""} `)).trim();
  return a || def || "";
}

async function askYes(
  rl: ReturnType<typeof createInterface>,
  q: string,
  def = true,
): Promise<boolean> {
  const a = (await rl.question(`${q} ${dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
  return a ? a.startsWith("y") : def;
}

/** Ask for a secret without echoing what is typed. */
async function askSecret(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  const r = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = r._writeToOutput;
  let promptShown = false;
  r._writeToOutput = function (this: unknown, out: string) {
    if (!promptShown || out === "\r\n" || out === "\n") {
      promptShown = true;
      orig.call(this, out);
    }
  };
  try {
    return (await rl.question(`${q} `)).trim();
  } finally {
    r._writeToOutput = orig;
  }
}

const META_STEPS: Record<AuthMode, (redirect: string) => [string, string][]> = {
  facebook: (redirect) => [
    [
      'Create a Meta app: "Create app" → use case "Other" → app type "Business" (any name, e.g. "Instagram MCP")',
      "https://developers.facebook.com/apps/creation/",
    ],
    [
      'In the app dashboard, add the product "Instagram" → "API setup with Facebook login", and the product "Facebook Login for Business"',
      "https://developers.facebook.com/apps/",
    ],
    [
      `Facebook Login for Business → Settings → Valid OAuth Redirect URIs: add ${redirect} and save`,
      "https://developers.facebook.com/apps/",
    ],
    [
      "App settings → Basic: copy the App ID and App secret (you paste them below)",
      "https://developers.facebook.com/apps/",
    ],
    [
      "Your Instagram account must be a Business or Creator account linked to a Facebook Page you manage (Instagram app → Settings → Account type and tools)",
      "https://help.instagram.com/399237934150902",
    ],
  ],
  instagram: (redirect) => [
    [
      'Create a Meta app: "Create app" → use case "Manage messaging & content on Instagram"',
      "https://developers.facebook.com/apps/creation/",
    ],
    [
      `Instagram → "API setup with Instagram business login" → Business login settings → OAuth redirect URIs: add ${redirect} and save`,
      "https://developers.facebook.com/apps/",
    ],
    [
      "On the same page copy the Instagram app ID and Instagram app secret (not the Meta app ID)",
      "https://developers.facebook.com/apps/",
    ],
    [
      'App roles → Roles → add your Instagram account as an "Instagram Tester", then accept it in Instagram: Settings → Website permissions → Apps and websites → Tester invites',
      "https://developers.facebook.com/apps/",
    ],
    [
      "Your Instagram account must be a Business or Creator account (free switch in the Instagram app → Settings → Account type and tools)",
      "https://help.instagram.com/502981923235522",
    ],
  ],
};

async function setupMeta(app: App, rl: ReturnType<typeof createInterface>) {
  const configured = Boolean(app.cfg.meta.appId && app.cfg.meta.appSecret);
  if (configured) {
    say(
      `✓ Meta app configured ${dim(`(${app.cfg.meta.appId}, ${app.cfg.meta.authMode === "facebook" ? "Facebook Login" : "Instagram Login"})`)}`,
    );
    if (!(await askYes(rl, "Change it?", false))) return;
  }
  say(bold("\nStep 1 · Meta app") + dim(" (one time, about 5 minutes, free)"));
  say("Instagram only lets tools post through a Meta app you own. Choose how you sign in:\n");
  say(
    `  [1] Facebook Login ${dim("(recommended: your Instagram is linked to a Facebook Page. Adds direct video upload, delete, hashtag search and competitor lookup)")}`,
  );
  say(
    `  [2] Instagram Login ${dim("(no Facebook Page needed. Every file is fetched through the media host; no delete / hashtag search / competitor lookup)")}`,
  );
  const pick = await ask(rl, "Choose 1 or 2:", app.cfg.meta.authMode === "instagram" ? "2" : "1");
  const mode: AuthMode = pick.trim() === "2" ? "instagram" : "facebook";
  app.cfg.meta.authMode = mode;
  const redirect = redirectUriFor(app.cfg);
  const steps = META_STEPS[mode](redirect);
  say();
  steps.forEach(([t, url], i) => say(`  ${i + 1}. ${t}\n     ${dim(url)}`));
  say(
    dim(
      `\n  If Meta refuses ${redirect} (it may insist on https), register https://localhost:${app.cfg.meta.redirectPort}/callback instead and enter it below; you will paste the page address back after signing in.`,
    ),
  );
  say();
  if (await askYes(rl, "Open the Meta developer site in your browser now?", true))
    openBrowser(steps[0][1]);

  const redirectAns = await ask(rl, "\nRedirect URI you registered:", redirect);
  const appId = (
    await ask(rl, mode === "facebook" ? "App ID:" : "Instagram app ID:", app.cfg.meta.appId)
  ).trim();
  let appSecret = await askSecret(
    rl,
    app.cfg.meta.appSecret ? "App secret (Enter to keep the saved one):" : "App secret:",
  );
  if (!appSecret) appSecret = app.cfg.meta.appSecret ?? "";
  if (!/^\d{6,}$/.test(appId) || !appSecret) {
    say(
      "✗ The app ID is a long number and the secret is required. Run setup again when you have them.",
    );
    return;
  }
  let configId: string | undefined;
  if (mode === "facebook") {
    configId =
      (
        await ask(
          rl,
          "Facebook Login for Business configuration ID (optional, Enter to skip and request permissions directly):",
          app.cfg.meta.configId ?? "",
        )
      ).trim() || undefined;
  }
  await app.vault.set(SECRET.metaAppId, appId);
  await app.vault.set(SECRET.metaAppSecret, appSecret);
  app.cfg.meta.appId = appId;
  app.cfg.meta.appSecret = appSecret;
  app.cfg.meta.configId = configId;
  const redirectUri = redirectAns.trim() || redirect;
  const port = /^https?:\/\/(localhost|127\.0\.0\.1):(\d+)/.exec(redirectUri)?.[2];
  saveConfig(app.db, {
    authMode: mode,
    configId,
    redirectUri:
      redirectUri === `http://localhost:${app.cfg.meta.redirectPort}/callback`
        ? undefined
        : redirectUri,
    redirectPort: port ? Number(port) : undefined,
  });
  app.cfg.meta.redirectUri =
    redirectUri === `http://localhost:${app.cfg.meta.redirectPort}/callback`
      ? undefined
      : redirectUri;
  if (port) app.cfg.meta.redirectPort = Number(port);
  say(
    `✓ Saved in ${app.vault.kind === "keychain" ? "your OS keychain" : `an encrypted file in ${app.cfg.home}`}.`,
  );
}

async function connectInteractive(app: App, rl?: ReturnType<typeof createInterface>) {
  const { url, done, listening, redirectUri } = await app.connector.start();
  say(
    app.cfg.meta.authMode === "facebook"
      ? "\nOpening the Facebook sign-in. Select the Facebook Page(s) your Instagram account is linked to, and allow every permission."
      : "\nOpening the Instagram sign-in. Log in to the professional account and allow every permission.",
  );
  say(dim(`If no browser opens, visit:\n${url}\n`));
  openBrowser(url);
  if (!listening) {
    const own = rl ?? createInterface({ input: process.stdin, output: process.stdout });
    try {
      const pasted = await ask(
        own,
        `After approving, copy the full address of the page you land on (${redirectUri}?code=…) and paste it here:`,
      );
      const rows = await app.connector.complete(pasted);
      for (const r of rows) say(`✓ Connected ${bold(`@${r.username}`)} ${dim(r.name ?? "")}`);
      return;
    } finally {
      if (!rl) own.close();
    }
  }
  const rows = await done;
  for (const r of rows) say(`✓ Connected ${bold(`@${r.username}`)} ${dim(r.name ?? "")}`);
}

/** Choose and test the media host. Secrets go to the vault, the rest to the database. */
async function setupMedia(app: App, rl: ReturnType<typeof createInterface>, forced?: string) {
  say(bold("\nStep 2 · Media host") + dim(" (how Meta fetches files from this computer)"));
  say("Meta downloads every image (and, with Instagram Login, every video) from a public link.\n");
  say(
    `  [1] Tunnel ${dim("(zero setup, free: a temporary Cloudflare link while publishing; this computer must be online)")}`,
  );
  say(
    `  [2] S3-compatible bucket ${dim("(AWS S3, Cloudflare R2, Backblaze B2, MinIO: survives restarts, best for scheduling)")}`,
  );
  say(`  [3] Azure Blob Storage`);
  const cur = app.hosts.activeKind();
  const pick =
    forced ??
    (await ask(rl, "Choose 1, 2 or 3:", cur === "s3" ? "2" : cur === "azure" ? "3" : "1"));
  const kind =
    pick === "2" || pick === "s3" ? "s3" : pick === "3" || pick === "azure" ? "azure" : "tunnel";

  if (kind === "tunnel") {
    let bin = findCloudflared(app.cfg.home, app.cfg.media.cloudflaredPath);
    if (!bin) {
      say("The tunnel needs cloudflared (Cloudflare's free tunnel tool).");
      if (await askYes(rl, "Download it into the data folder now?", true)) {
        try {
          bin = await installCloudflared(app.cfg.home);
          say(`✓ cloudflared installed at ${bin}`);
        } catch (e) {
          say(`✗ ${(e as Error).message}`);
        }
      }
      if (!bin)
        say(
          dim(
            "Install it later: brew install cloudflared (or see the README), then run `media test`.",
          ),
        );
    }
  } else if (kind === "s3") {
    const s = app.cfg.media.s3;
    say(dim("Use a key limited to this one bucket (put, get, delete)."));
    const endpoint = (
      await ask(
        rl,
        "Endpoint (Enter for AWS S3; R2: https://<account>.r2.cloudflarestorage.com):",
        s.endpoint ?? "",
      )
    ).replace(/\/+$/, "");
    const region = await ask(
      rl,
      "Region (R2: auto):",
      s.region || (endpoint.includes("r2.") ? "auto" : "us-east-1"),
    );
    const bucket = await ask(rl, "Bucket:", s.bucket);
    const accessKeyId = await ask(rl, "Access key ID:", s.accessKeyId);
    const secret = await askSecret(
      rl,
      s.secretAccessKey ? "Secret access key (Enter to keep):" : "Secret access key:",
    );
    const publicBaseUrl = (
      await ask(
        rl,
        "Public base URL if the bucket is public (Enter to use private presigned links):",
        s.publicBaseUrl ?? "",
      )
    ).replace(/\/+$/, "");
    if (secret) {
      await app.vault.set(SECRET.s3SecretKey, secret);
      s.secretAccessKey = secret;
    }
    Object.assign(s, {
      endpoint: endpoint || undefined,
      region,
      bucket,
      accessKeyId,
      publicBaseUrl: publicBaseUrl || undefined,
    });
    saveConfig(app.db, {
      media: {
        s3: {
          endpoint: endpoint || undefined,
          region,
          bucket,
          accessKeyId,
          publicBaseUrl: publicBaseUrl || undefined,
        },
      },
    });
  } else {
    const a = app.cfg.media.azure;
    say(dim("Recommended: storage account name + key (each file gets its own read-only link)."));
    const account = await ask(
      rl,
      "Storage account name (Enter to use a container SAS URL instead):",
      a.account ?? "",
    );
    if (account) {
      const container = await ask(rl, "Container:", a.container ?? "instagram-media");
      const key = await askSecret(
        rl,
        a.accountKey ? "Account key (Enter to keep):" : "Account key:",
      );
      if (key) {
        await app.vault.set(SECRET.azureKey, key);
        a.accountKey = key;
      }
      Object.assign(a, { account, container });
      saveConfig(app.db, { media: { azure: { account, container } } });
    } else {
      const sas = await askSecret(rl, "Container SAS URL (racwd permissions):");
      if (sas) {
        await app.vault.set(SECRET.azureSasUrl, sas);
        a.containerSasUrl = sas;
      }
    }
  }
  app.cfg.media.host = kind;
  saveConfig(app.db, { media: { host: kind } });
  say("Testing…");
  const c = await app.hosts.check(kind);
  say(`${c.ok ? "✓" : "✗"} ${c.detail}${c.fix ? dim(`\n    → ${c.fix}`) : ""}`);
}

async function printAiTest(app: App) {
  for (const r of await testAi(app.cfg.ai)) {
    if (!r.target) continue;
    say(`${r.ok ? "✓" : "✗"} ${r.task.padEnd(10)} ${r.target} ${dim(r.detail)}`);
  }
}

const TASK_LABEL: Record<AiTask, string> = {
  text: "Writing & analysis (captions, hashtags, diagnosis, comments, ideas)",
  vision: "Vision (judging covers and images)",
  image: "Image generation (covers, carousel slides)",
  transcribe: "Transcription (captions from video, reel finder)",
};

/** Choose a model per task from the live catalogue of the connected providers. */
async function chooseModels(app: App, rl: ReturnType<typeof createInterface>) {
  const connected = AI_PROVIDERS.filter((id) => isConfigured(app.cfg.ai, id));
  if (!connected.length) return;
  const catalog = new Map<AiProviderId, string[]>();
  for (const id of connected) catalog.set(id, await listModels(app.cfg.ai, id).catch(() => []));
  const chosen: Partial<Record<AiTask, string | null>> = {};
  for (const task of AI_TASKS) {
    const providers = connected.filter((id) => PROVIDERS[id].tasks.includes(task));
    if (!providers.length) continue;
    const cur = resolveModel(app.cfg.ai, task);
    say(`\n${bold(TASK_LABEL[task])}`);
    const options: string[] = [];
    for (const id of providers) {
      const d = PROVIDERS[id].defaults[task];
      if (d) options.push(`${id}:${d}`);
    }
    if (options.length) say(dim(`  suggested: ${options.join("  ")}`));
    for (const id of providers) {
      const list = catalog.get(id) ?? [];
      if (list.length)
        say(dim(`  ${id} models: ${list.slice(0, 25).join(", ")}${list.length > 25 ? ", …" : ""}`));
      else if (id === "azure") say(dim("  azure: type a deployment name, e.g. azure:gpt-5-chat"));
    }
    const ans = await ask(
      rl,
      `  Use (provider:model, "none", or Enter to keep):`,
      cur ? `${cur.provider}:${cur.model}` : "none",
    );
    chosen[task] = ans === "none" ? null : ans;
    if (ans !== "none") app.cfg.ai.models[task] = ans;
    else delete app.cfg.ai.models[task];
  }
  saveModels(app.db, chosen);
}

async function addProviderInteractive(
  app: App,
  rl: ReturnType<typeof createInterface>,
  id: AiProviderId,
) {
  const info = PROVIDERS[id];
  const cur = app.cfg.ai.providers[id] ?? {};
  if (info.keyUrl) say(dim(`Get a key at ${info.keyUrl}`));
  const settings: { apiKey?: string; baseUrl?: string; endpoint?: string; apiVersion?: string } =
    {};
  if (id === "azure") {
    settings.endpoint = (
      await ask(
        rl,
        "Endpoint (https://<resource>.openai.azure.com or .cognitiveservices.azure.com):",
        cur.endpoint,
      )
    ).replace(/\/+$/, "");
    settings.apiVersion = await ask(rl, "API version:", cur.apiVersion ?? "2025-04-01-preview");
  }
  if (id === "custom" || id === "ollama") {
    settings.baseUrl = (
      await ask(rl, "Base URL (ending in /v1):", cur.baseUrl ?? info.baseUrl)
    ).replace(/\/+$/, "");
  }
  if (info.needsKey || id === "custom") {
    const key = await askSecret(
      rl,
      cur.apiKey
        ? "API key (Enter to keep the saved one):"
        : `API key${info.needsKey ? "" : " (optional)"}:`,
    );
    if (key) settings.apiKey = key;
  }
  await saveProvider(app.db, app.vault, id, settings);
  await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
  say(`✓ ${info.label} saved${settings.apiKey ? " (key in your keychain)" : ""}.`);
}

async function setupAi(
  app: App,
  rl: ReturnType<typeof createInterface>,
  step = "Step 4 · AI providers",
) {
  say(bold(`\n${step}`) + dim(" (optional)"));
  say(
    "Connect Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama or any OpenAI-compatible API so the server can",
  );
  say(
    "write captions and hashtags, diagnose posts, triage comments, find reels in long videos, judge covers, and transcribe.",
  );
  say("Your AI app can still do the writing itself without this.");
  for (;;) {
    const d = describeAi(app.cfg.ai);
    say(dim(`Connected: ${d.providers.map((p) => p.id).join(", ") || "none"}`));
    const menu = AI_PROVIDERS.map(
      (id, i) => `[${i + 1}] ${PROVIDERS[id].label}${isConfigured(app.cfg.ai, id) ? " ✓" : ""}`,
    ).join("  ");
    say(menu);
    const pick = (
      await ask(rl, "Add or update a provider (number), or Enter when done:", "")
    ).trim();
    if (!pick) break;
    const id = AI_PROVIDERS[Number(pick) - 1];
    if (!id) continue;
    await addProviderInteractive(app, rl, id);
  }
  if (describeAi(app.cfg.ai).providers.length) {
    if (await askYes(rl, "Choose which model does each job now?", true))
      await chooseModels(app, rl);
    say("\nTesting…");
    await printAiTest(app);
    if (resolveModel(app.cfg.ai, "transcribe") && !(await hasFfmpeg()))
      say("Install ffmpeg for transcription and reels (macOS: brew install ffmpeg).");
  }
}

/**
 * `ai` with no arguments is interactive. Scriptable forms (keys via stdin so they never reach shell history):
 *   ai add <provider> [--endpoint U] [--base-url U] [--api-version V] [--key-stdin]
 *   ai models [--text p:m] [--vision p:m] [--image p:m] [--transcribe p:m] [--effort E]
 *   ai list <provider> | ai test | ai status | ai remove <provider> | ai off
 */
async function aiCommand(args: string[]) {
  const [sub, ...rest] = args;
  const opt = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const readStdin = async () => {
    if (!rest.includes("--key-stdin")) return undefined;
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim() || undefined;
  };
  const app = await createApp();
  const providerArg = () => {
    const id = rest[0] as AiProviderId;
    if (!(AI_PROVIDERS as readonly string[]).includes(id))
      throw new IgError("invalid_request", `Provider must be one of: ${AI_PROVIDERS.join(", ")}`);
    return id;
  };
  try {
    switch (sub) {
      case undefined: {
        if (!process.stdin.isTTY)
          throw new IgError(
            "invalid_request",
            "Run `ai` in a terminal, or use `ai add <provider> --key-stdin`.",
          );
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await setupAi(app, rl, "AI providers");
        } finally {
          rl.close();
        }
        return;
      }
      case "add": {
        const id = providerArg();
        await saveProvider(app.db, app.vault, id, {
          apiKey: await readStdin(),
          endpoint: opt("endpoint"),
          baseUrl: opt("base-url"),
          apiVersion: opt("api-version"),
        });
        await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
        say(`✓ ${PROVIDERS[id].label} saved.`);
        break;
      }
      case "models": {
        const models: Partial<Record<AiTask, string | null>> = {};
        for (const t of AI_TASKS) {
          const v = opt(t);
          if (v !== undefined) models[t] = v === "none" ? null : v;
        }
        for (const [t, v] of Object.entries(models)) {
          if (!v) continue;
          const ref = parseModelRef(v);
          if (!ref)
            throw new IgError(
              "invalid_request",
              `--${t} must be provider:model, e.g. anthropic:claude-opus-5-5`,
            );
          if (!PROVIDERS[ref.provider].tasks.includes(t as AiTask))
            throw new IgError("invalid_request", `${PROVIDERS[ref.provider].label} can't do ${t}.`);
        }
        const effortArg = opt("effort");
        if (effortArg && !["low", "medium", "high", "xhigh", "max"].includes(effortArg))
          throw new IgError("invalid_request", "--effort must be low, medium, high, xhigh or max.");
        const effort = effortArg as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
        saveModels(app.db, models, effort);
        await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
        for (const [t, v] of Object.entries(models)) if (v) app.cfg.ai.models[t as AiTask] = v;
        break;
      }
      case "list": {
        const id = providerArg();
        const models = await listModels(app.cfg.ai, id);
        say(
          models.length
            ? models.join("\n")
            : "This provider has no model list (Azure: use your deployment names).",
        );
        return;
      }
      case "remove":
        await removeProvider(app.db, app.vault, providerArg());
        say("Removed.");
        return;
      case "off":
        await clearAi(app.db, app.vault);
        say("All AI providers and keys removed.");
        return;
      case "test":
      case "status":
        break;
      default:
        say(`Usage:
  ${APP} ai                                   interactive setup
  ${APP} ai add <provider> [--endpoint <url>] [--base-url <url>] [--api-version <v>] [--key-stdin]
  ${APP} ai models [--text p:m] [--vision p:m] [--image p:m] [--transcribe p:m] [--effort low|medium|high|xhigh|max]
  ${APP} ai list <provider>                   show the provider's models
  ${APP} ai test | status | remove <provider> | off

Providers: ${AI_PROVIDERS.join(", ")}
Example (Azure key straight from the az CLI, never in shell history):
  az cognitiveservices account keys list -g <rg> -n <resource> --query key1 -o tsv | \\
    ${APP} ai add azure --endpoint https://<resource>.cognitiveservices.azure.com --key-stdin
  ${APP} ai models --text azure:gpt-6-astra --image azure:gpt-image-2 --transcribe azure:whisper`);
        return;
    }
    const d = describeAi(app.cfg.ai);
    say(`Providers:  ${d.providers.map((p) => p.name).join(", ") || "none"}`);
    for (const t of AI_TASKS) say(`${t.padEnd(11)} ${d.models[t] ?? dim("off")}`);
    say(`effort      ${d.effort}`);
    if (sub === "test" && d.providers.length) {
      say("");
      await printAiTest(app);
    }
  } finally {
    app.db.close();
  }
}

async function installClients(ids: string[], mode: "auto" | "npx" | "node") {
  const spec = launchSpec(mode);
  const targets = ids.includes("all")
    ? CLIENTS.filter((c) => c.detect())
    : CLIENTS.filter((c) => ids.includes(c.id));
  const unknown = ids.filter((i) => i !== "all" && !CLIENTS.some((c) => c.id === i));
  if (unknown.length)
    say(`Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`);
  for (const c of targets) {
    try {
      say(`✓ ${c.install(spec)}`);
    } catch (e) {
      say(`✗ ${c.name}: ${(e as Error).message}`);
    }
  }
  if (!targets.length)
    say("No supported AI apps found. Use `config` to print snippets for your client.");
}

async function setup() {
  const app = await createApp();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say(bold(`\nInstagram Account MCP · setup`) + dim(`  (data: ${app.cfg.home})`));
    await setupMeta(app, rl);
    await setupMedia(app, rl);

    say(bold("\nStep 3 · Connect your Instagram account"));
    const existing = app.accounts.list();
    for (const a of existing)
      say(`  ✓ @${a.username} ${dim(a.status === "ok" ? "" : "(needs reconnect)")}`);
    if (
      !existing.length || existing.some((a) => a.status !== "ok")
        ? true
        : await askYes(rl, "Connect another account?", false)
    ) {
      const listening = loopbackPort(redirectUriFor(app.cfg)) !== null;
      if (listening) rl.pause();
      try {
        await connectInteractive(app, listening ? undefined : rl);
      } catch (e) {
        const y = e as IgError;
        say(`✗ ${y.message} ${y.hint ?? ""}`);
      }
      if (listening) rl.resume();
    }

    await setupAi(app, rl);

    say(bold("\nStep 5 · Add to your AI apps"));
    const found = CLIENTS.filter((c) => c.detect());
    if (found.length) {
      say(`Found: ${found.map((c) => c.name).join(", ")}`);
      const pick = await ask(
        rl,
        'Install into which? (comma-separated ids, "all", or "none")',
        "all",
      );
      if (pick !== "none")
        await installClients(
          pick.split(",").map((s) => s.trim()),
          "auto",
        );
    } else say("No supported apps detected.");
    say(bold("\nStep 6 · Background service") + dim(" (recommended)"));
    say(
      "Publishes scheduled posts, finishes A/B tests and keeps sign-ins fresh even when no AI app is open.",
    );
    if (serviceStatus() === "not installed" && (await askYes(rl, "Install it?", true))) {
      try {
        say(`✓ ${installService()}`);
      } catch (e) {
        say(`✗ ${(e as Error).message}`);
      }
    } else say(dim(`Background service: ${serviceStatus()}`));
    say(dim("\nOther clients:\n") + dim(manualSnippets(launchSpec())));
    say(
      bold("\nDone.") +
        ' Restart your AI app and ask: "Check my Instagram connection" or "How did my last 10 reels do?".\n',
    );
  } finally {
    rl.close();
    await app.hosts.close();
    app.db.close();
  }
}

async function status() {
  const app = await createApp();
  const accounts = app.accounts.list().map(describeAccount);
  say(bold(`${APP} ${VERSION}`));
  say(`Data folder:      ${app.cfg.home}`);
  say(`Token storage:    ${app.vault.kind}`);
  say(
    `Meta app:         ${app.cfg.meta.appId ? `${app.cfg.meta.appId} (${app.cfg.meta.authMode === "facebook" ? "Facebook Login" : "Instagram Login"})` : "NOT configured (run setup)"}`,
  );
  say(`Redirect URI:     ${redirectUriFor(app.cfg)}`);
  say(`Media host:       ${app.hosts.activeKind()}`);
  const ai = describeAi(app.cfg.ai);
  say(`AI providers:     ${ai.providers.map((p) => p.id).join(", ") || "none (run ai)"}`);
  say(`Background:       ${serviceStatus()}`);
  const tests = app.experiments.list().filter((e) => ["publishing", "running"].includes(e.status));
  if (tests.length) say(`A/B tests:        ${tests.length} active`);
  say(`Accounts:${accounts.length ? "" : "         none (run connect)"}`);
  for (const a of accounts)
    say(
      `  ${a.default ? "★" : " "} ${a.username} ${dim(`${a.name ?? ""} · ${a.login} · ${a.status}`)}`,
    );
  const jobs = app.jobs.list({ limit: 8 });
  if (jobs.length) {
    say("Recent and scheduled posts:");
    for (const j of jobs)
      say(
        `  ${j.status.padEnd(13)} ${j.kind.padEnd(8)} ${j.permalink ?? (j.publish_at ? `at ${new Date(j.publish_at).toLocaleString()}` : j.id)}`,
      );
  }
  app.db.close();
}

async function doctor() {
  const app = await createApp();
  const check = (okay: boolean, label: string, fix?: string) =>
    say(`${okay ? "✓" : "✗"} ${label}${!okay && fix ? dim(`\n    → ${fix}`) : ""}`);
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 13),
    `Node.js ${process.versions.node}`,
    "Install Node.js 22.13 or newer: https://nodejs.org",
  );
  say(
    `✓ Token storage: ${app.vault.kind === "keychain" ? "OS keychain" : `encrypted file in ${app.cfg.home} (no OS keychain found)`}`,
  );
  check(
    Boolean(app.cfg.meta.appId && app.cfg.meta.appSecret),
    `Meta app (${app.cfg.meta.authMode === "facebook" ? "Facebook Login" : "Instagram Login"}, redirect ${redirectUriFor(app.cfg)})`,
    `Run: npx ${PACKAGE} setup`,
  );
  const accounts = app.accounts.list();
  check(
    accounts.length > 0,
    `${accounts.length} account(s) connected`,
    `Run: npx ${PACKAGE} connect`,
  );
  for (const a of accounts) {
    try {
      const p = await app.accounts.client(a).get(a.ig_user_id, { fields: "username" });
      check(true, `  @${String(p.username ?? a.username)}: sign-in valid`);
    } catch (e) {
      check(false, `  @${a.username}: ${(e as Error).message}`, `Run: npx ${PACKAGE} connect`);
    }
  }
  const host = await app.hosts.check();
  check(host.ok, `Media host (${host.kind}): ${host.detail}`, host.fix);
  check(
    await hasFfmpeg(),
    "ffmpeg (converts media to Instagram's specs, transcription, reels from long videos)",
    "brew install ffmpeg / apt install ffmpeg / winget install ffmpeg",
  );
  if (describeAi(app.cfg.ai).providers.length) await printAiTest(app);
  else say(dim("  AI providers: none (optional; run `ai`)"));
  say(dim(`  Background service: ${serviceStatus()}`));
  for (const c of CLIENTS) if (c.detect()) say(dim(`  found ${c.name}`));
  await app.hosts.close();
  app.db.close();
}

/** `media` [tunnel|s3|azure|test]: choose, configure and test the media host. */
async function mediaCommand(args: string[]) {
  const app = await createApp();
  try {
    if (args[0] === "test" || args[0] === "status") {
      const c = await app.hosts.check();
      say(`${c.ok ? "✓" : "✗"} ${c.kind}: ${c.detail}${c.fix ? dim(`\n    → ${c.fix}`) : ""}`);
      if (!c.ok) process.exitCode = 1;
      return;
    }
    if (!process.stdin.isTTY)
      throw new IgError(
        "invalid_request",
        "Run `media` in a terminal, or use IG_MEDIA_HOST and IG_S3_* / IG_AZURE_* environment variables.",
      );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await setupMedia(app, rl, args[0]);
    } finally {
      rl.close();
    }
  } finally {
    await app.hosts.close();
    app.db.close();
  }
}

/** Background-only process for the service: publishes scheduled posts, runs A/B tests, refreshes tokens. */
async function daemon() {
  const app = await createApp();
  app.jobs.start();
  app.scheduler.start(true);
  log.info("daemon running", { version: VERSION, home: app.cfg.home });
  const shutdown = () => {
    app.jobs.stop();
    app.scheduler.stop();
    void app.hosts.close().finally(() => {
      app.db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function serve() {
  const app = await createApp();
  app.jobs.start();
  app.scheduler.start();
  const server = buildServer(app);
  await server.connect(new StdioServerTransport());
  log.info("stdio server ready", { version: VERSION, home: app.cfg.home });
  const shutdown = () => {
    app.jobs.stop();
    app.scheduler.stop();
    app.connector.close();
    void Promise.all([server.close(), app.hosts.close()]).finally(() => {
      app.db.close();
      process.exit(0);
    });
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const mode = flags.has("--npx") ? "npx" : flags.has("--node") ? "node" : "auto";
  switch (cmd) {
    case undefined:
      if (process.stdin.isTTY) {
        say(HELP);
        return;
      }
      return serve();
    case "serve":
    case "stdio":
      return serve();
    case "setup":
      return setup();
    case "connect": {
      const app = await createApp();
      await connectInteractive(app);
      app.db.close();
      process.exit(0);
    }
    // falls through (process.exit above)
    case "media":
      return mediaCommand(args);
    case "status":
      return status();
    case "doctor":
      return doctor();
    case "install":
      return installClients(args.length ? args : ["all"], mode);
    case "uninstall":
      for (const c of CLIENTS.filter(
        (x) => args.includes("all") || !args.length || args.includes(x.id),
      )) {
        try {
          say(c.remove());
        } catch (e) {
          say(`✗ ${c.name}: ${(e as Error).message}`);
        }
      }
      return;
    case "daemon":
      return daemon();
    case "service": {
      const sub = args[0] ?? "status";
      if (sub === "install") say(`✓ ${installService()}`);
      else if (sub === "uninstall") say(uninstallService());
      else say(`Background service: ${serviceStatus()}`);
      return;
    }
    case "ai":
      return aiCommand(rest);
    case "config":
      say(manualSnippets(launchSpec(mode)));
      return;
    case "-v":
    case "--version":
    case "version":
      say(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      say(HELP);
      return;
    default:
      say(`Unknown command "${cmd}".\n`);
      say(HELP);
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  const y = e instanceof IgError ? e : null;
  process.stderr.write(
    `✗ ${y ? `${y.message}${y.hint ? `\n  ${y.hint}` : ""}` : e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(1);
});
