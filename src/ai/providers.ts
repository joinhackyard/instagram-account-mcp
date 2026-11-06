import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI, { AzureOpenAI, toFile } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  aiFromEnv,
  AI_PROVIDERS,
  PACKAGE,
  SECRET,
  type AiProviderId,
  type AiProviderSettings,
  type AiSettings,
  type AiTask,
} from "../config.js";
import type { Db } from "../db.js";
import { IgError } from "../errors.js";
import type { TokenVault } from "../vault.js";

export const AI_NOT_CONFIGURED_HINT = `Connect an AI provider (Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama...) with \`npx ${PACKAGE} ai\`, or let your AI app do the writing from the brief.`;

interface ProviderInfo {
  label: string;
  kind: "anthropic" | "openai" | "azure" | "gemini";
  /** Default OpenAI-compatible base URL. */
  baseUrl?: string;
  needsKey: boolean;
  tasks: AiTask[];
  /** Sensible starting models; `ai` lists the live catalogue so users can pick others. */
  defaults: Partial<Record<AiTask, string>>;
  keyUrl?: string;
}

export const PROVIDERS: Record<AiProviderId, ProviderInfo> = {
  anthropic: {
    label: "Anthropic Claude",
    kind: "anthropic",
    needsKey: true,
    tasks: ["text", "vision"],
    defaults: { text: "claude-opus-5-5", vision: "claude-opus-5-5" },
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    tasks: ["text", "vision", "image", "transcribe"],
    defaults: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2", transcribe: "whisper-1" },
    keyUrl: "https://platform.openai.com/api-keys",
  },
  azure: {
    label: "Azure OpenAI / Azure AI Foundry",
    kind: "azure",
    needsKey: true,
    tasks: ["text", "vision", "image", "transcribe"],
    defaults: {},
  },
  gemini: {
    label: "Google Gemini",
    kind: "gemini",
    needsKey: true,
    tasks: ["text", "vision", "image", "transcribe"],
    defaults: {
      text: "gemini-2.5-pro",
      vision: "gemini-2.5-pro",
      image: "gemini-2.5-flash-image",
      transcribe: "gemini-2.5-flash",
    },
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    tasks: ["text", "vision"],
    defaults: {},
    keyUrl: "https://openrouter.ai/keys",
  },
  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    tasks: ["text", "transcribe"],
    defaults: { transcribe: "whisper-large-v3" },
    keyUrl: "https://console.groq.com/keys",
  },
  ollama: {
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    tasks: ["text", "vision"],
    defaults: {},
  },
  custom: {
    label: "Other OpenAI-compatible API",
    kind: "openai",
    needsKey: false,
    tasks: ["text", "vision", "image", "transcribe"],
    defaults: {},
  },
};

const SAVED = "ai";
interface SavedAi {
  providers?: Partial<
    Record<AiProviderId, Omit<AiProviderSettings, "apiKey"> & { enabled?: boolean }>
  >;
  models?: AiSettings["models"];
  effort?: AiSettings["effort"];
}

function readSaved(db: Db): SavedAi {
  try {
    return JSON.parse(db.setting(SAVED) ?? "{}") as SavedAi;
  } catch {
    return {};
  }
}

/**
 * Rebuild `ai` from the environment plus what `ai` saved (non-secret settings in the DB, keys in the vault).
 * Environment values win. Safe to call again after saving: nothing stale from an earlier load survives.
 */
export async function loadAiSettings(
  ai: AiSettings,
  env: NodeJS.ProcessEnv,
  db: Db,
  vault: TokenVault,
) {
  const fresh = aiFromEnv(env);
  const saved = readSaved(db);
  const providers: AiSettings["providers"] = {};
  for (const id of AI_PROVIDERS) {
    const { enabled, ...stored } = (saved.providers?.[id] ?? {}) as AiProviderSettings & {
      enabled?: boolean;
    };
    const cur: AiProviderSettings = { ...stored, ...(fresh.providers[id] ?? {}) };
    if (!cur.apiKey) cur.apiKey = (await vault.get(SECRET.aiKey(id))) ?? undefined;
    if (!cur.apiKey) delete cur.apiKey;
    if (cur.apiKey || cur.endpoint || cur.baseUrl || enabled) providers[id] = cur;
  }
  ai.providers = providers;
  ai.models = { ...(saved.models ?? {}), ...fresh.models };
  ai.effort = env.IG_AI_EFFORT ? fresh.effort : (saved.effort ?? fresh.effort);
}

export async function saveProvider(
  db: Db,
  vault: TokenVault,
  id: AiProviderId,
  s: AiProviderSettings,
) {
  const saved = readSaved(db);
  const { apiKey, ...rest } = s;
  if (apiKey) await vault.set(SECRET.aiKey(id), apiKey);
  saved.providers = {
    ...saved.providers,
    [id]: { ...(saved.providers?.[id] ?? {}), ...stripEmpty(rest), enabled: true },
  };
  db.setSetting(SAVED, JSON.stringify(saved));
}

export async function removeProvider(db: Db, vault: TokenVault, id: AiProviderId) {
  const saved = readSaved(db);
  delete saved.providers?.[id];
  for (const t of Object.keys(saved.models ?? {}) as AiTask[]) {
    if (saved.models?.[t]?.startsWith(`${id}:`)) delete saved.models[t];
  }
  db.setSetting(SAVED, JSON.stringify(saved));
  await vault.delete(SECRET.aiKey(id));
}

export function saveModels(
  db: Db,
  models: Partial<Record<AiTask, string | null>>,
  effort?: AiSettings["effort"],
) {
  const saved = readSaved(db);
  saved.models = { ...saved.models };
  for (const [t, v] of Object.entries(models) as [AiTask, string | null][]) {
    if (v) saved.models[t] = v;
    else delete saved.models[t];
  }
  if (effort) saved.effort = effort;
  db.setSetting(SAVED, JSON.stringify(saved));
}

export async function clearAi(db: Db, vault: TokenVault) {
  for (const id of AI_PROVIDERS) await vault.delete(SECRET.aiKey(id));
  db.setSetting(SAVED, "{}");
}

const stripEmpty = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

export function isConfigured(ai: AiSettings, id: AiProviderId): boolean {
  const p = ai.providers[id];
  if (!p) return false;
  if (id === "azure") return Boolean(p.apiKey && p.endpoint);
  if (id === "custom") return Boolean(p.baseUrl);
  if (id === "ollama") return true;
  return Boolean(p.apiKey);
}

export interface ModelTarget {
  provider: AiProviderId;
  model: string;
}

export function parseModelRef(ref: string): ModelTarget | null {
  const i = ref.indexOf(":");
  if (i < 0) return null;
  const provider = ref.slice(0, i) as AiProviderId;
  const model = ref.slice(i + 1);
  return (AI_PROVIDERS as readonly string[]).includes(provider) && model
    ? { provider, model }
    : null;
}

const AUTO_ORDER: AiProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "openrouter",
  "groq",
  "ollama",
  "custom",
];

/** The model used for a task: the one chosen with `ai models`, else the first configured provider with a default. */
export function resolveModel(ai: AiSettings, task: AiTask): ModelTarget | null {
  const chosen = ai.models[task] ? parseModelRef(ai.models[task]!) : null;
  if (
    chosen &&
    isConfigured(ai, chosen.provider) &&
    PROVIDERS[chosen.provider].tasks.includes(task)
  )
    return chosen;
  if (task === "vision" && ai.models.text) {
    const t = parseModelRef(ai.models.text);
    if (t && isConfigured(ai, t.provider) && PROVIDERS[t.provider].tasks.includes("vision"))
      return t;
  }
  for (const id of AUTO_ORDER) {
    const d = PROVIDERS[id].defaults[task];
    if (d && isConfigured(ai, id)) return { provider: id, model: d };
  }
  return null;
}

export function describeAi(ai: AiSettings) {
  const ref = (t: AiTask) => {
    const m = resolveModel(ai, t);
    return m ? `${m.provider}:${m.model}` : null;
  };
  return {
    providers: AI_PROVIDERS.filter((id) => isConfigured(ai, id)).map((id) => ({
      id,
      name: PROVIDERS[id].label,
    })),
    models: {
      text: ref("text"),
      vision: ref("vision"),
      image: ref("image"),
      transcribe: ref("transcribe"),
    },
    effort: ai.effort,
    // 1.0-compatible fields
    writing: ref("text"),
    transcription: ref("transcribe"),
  };
}

// ---- clients --------------------------------------------------------------------------------------

const clients = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!clients.has(key)) clients.set(key, make());
  return clients.get(key) as T;
}

/** Test hook: route every SDK request through a fake fetch. */
let fetchOverride: typeof fetch | undefined;
export function setAiFetchForTests(f: typeof fetch | undefined) {
  fetchOverride = f;
  clients.clear();
}

function anthropicClient(ai: AiSettings) {
  const p = ai.providers.anthropic!;
  return cached(
    `anthropic:${p.apiKey}`,
    () => new Anthropic({ apiKey: p.apiKey, maxRetries: 2, fetch: fetchOverride }),
  );
}

function openaiClient(ai: AiSettings, id: AiProviderId, deployment?: string): OpenAI {
  const p = ai.providers[id]!;
  if (id === "azure") {
    return cached(
      `azure:${p.endpoint}:${p.apiVersion}:${deployment}:${p.apiKey}`,
      () =>
        new AzureOpenAI({
          endpoint: p.endpoint,
          apiKey: p.apiKey,
          apiVersion: p.apiVersion || "2025-04-01-preview",
          deployment,
          maxRetries: 2,
          fetch: fetchOverride,
        }),
    );
  }
  const baseURL = p.baseUrl || PROVIDERS[id].baseUrl;
  return cached(
    `${id}:${baseURL}:${p.apiKey}`,
    () =>
      new OpenAI({
        apiKey: p.apiKey || "not-needed",
        baseURL,
        maxRetries: 2,
        fetch: fetchOverride,
        defaultHeaders:
          id === "openrouter"
            ? {
                "HTTP-Referer": "https://github.com/joinhackyard/instagram-account-mcp",
                "X-Title": "Instagram Account MCP",
              }
            : undefined,
      }),
  );
}

function geminiClient(ai: AiSettings) {
  const p = ai.providers.gemini!;
  return cached(`gemini:${p.apiKey}`, () => new GoogleGenAI({ apiKey: p.apiKey }));
}

function wrapError(provider: AiProviderId, err: unknown): IgError {
  if (err instanceof IgError) return err;
  const e = err as { status?: number; message?: string };
  const label = PROVIDERS[provider].label;
  const msg = `${label} request failed: ${(e.message ?? String(err)).replace(/\b(sk|key|AIza)[-_A-Za-z0-9*]{6,}/g, "[redacted]")}`;
  if (e.status === 401 || e.status === 403) {
    return new IgError("not_configured", msg, {
      hint: `Check the ${label} key with \`npx ${PACKAGE} ai test\`.`,
    });
  }
  if (e.status === 429) return new IgError("rate_limited", msg, { retryable: true });
  if (e.status === 404)
    return new IgError("not_configured", msg, {
      hint: "The model or deployment name may be wrong. Run `ai models` to pick another.",
    });
  return new IgError("server_error", msg, { retryable: (e.status ?? 0) >= 500 });
}

// ---- structured generation ------------------------------------------------------------------------

export interface ImageInput {
  mime: "image/jpeg" | "image/png" | "image/webp";
  data: string; // base64
}

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  images?: ImageInput[];
  maxTokens?: number;
}

/** Claude models that accept server-side refusal fallbacks (fallbacks: "default"). */
const CLAUDE_FALLBACK = /^claude-(opus-5-5|opus-5$|fable-5-1|sonnet-5-5)/;
/** Claude models without the effort parameter. */
const CLAUDE_NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

/** Ask the task's model for JSON matching `schema`. Returns null when no provider is configured for the task. */
export async function generateJson<T>(
  ai: AiSettings,
  task: "text" | "vision",
  req: JsonRequest<T>,
): Promise<{ data: T; model: string } | null> {
  const target = resolveModel(ai, task);
  if (!target) return null;
  const { provider, model } = target;
  const info = PROVIDERS[provider];
  try {
    if (info.kind === "anthropic") {
      const client = anthropicClient(ai);
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        ...(req.images ?? []).map((im) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: im.mime, data: im.data },
        })),
        { type: "text" as const, text: req.prompt },
      ];
      const response = await client.beta.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: {
          ...(CLAUDE_NO_EFFORT.test(model) ? {} : { effort: ai.effort }),
          format: betaZodOutputFormat(req.schema as z.ZodType),
        },
        ...(CLAUDE_FALLBACK.test(model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      if (response.stop_reason === "refusal") {
        throw new IgError(
          "forbidden",
          `Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`,
        );
      }
      if (response.stop_reason === "max_tokens")
        throw new IgError("server_error", "Claude's answer was cut off (max_tokens).");
      if (!response.parsed_output)
        throw new IgError("server_error", "Claude returned no structured output.");
      return { data: response.parsed_output as T, model: `${provider}:${response.model}` };
    }

    if (info.kind === "gemini") {
      const g = geminiClient(ai);
      const parts = [
        ...(req.images ?? []).map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })),
        { text: req.prompt },
      ];
      const res = await g.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(req.schema as z.ZodType),
          maxOutputTokens: req.maxTokens ?? 16000,
        },
      });
      return { data: parseJson(req.schema, res.text ?? ""), model: `${provider}:${model}` };
    }

    // OpenAI, Azure OpenAI and every OpenAI-compatible API.
    const client = openaiClient(ai, provider, provider === "azure" ? model : undefined);
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: "text", text: req.prompt },
      ...(req.images ?? []).map((im) => ({
        type: "image_url" as const,
        image_url: { url: `data:${im.mime};base64,${im.data}` },
      })),
    ];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      { role: "user", content: userContent },
    ];
    try {
      const res = await client.chat.completions.parse({
        model,
        messages,
        response_format: zodResponseFormat(req.schema as z.ZodType, "result"),
      });
      const msg = res.choices[0]?.message;
      if (msg?.refusal) throw new IgError("forbidden", `The model declined: ${msg.refusal}`);
      if (msg?.parsed) return { data: msg.parsed as T, model: `${provider}:${res.model || model}` };
      throw new IgError("server_error", "The model returned no structured output.");
    } catch (err) {
      // Many compatible servers (Ollama, Groq, some OpenRouter models) only support JSON mode.
      const status = (err as { status?: number }).status;
      const message = String((err as { message?: string }).message ?? "");
      if (
        provider === "openai" ||
        provider === "azure" ||
        status !== 400 ||
        !/response_format|json_schema|structured/i.test(message)
      )
        throw err;
      const res = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: `${req.system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema as z.ZodType))}`,
          },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      });
      return {
        data: parseJson(req.schema, res.choices[0]?.message?.content ?? ""),
        model: `${provider}:${res.model || model}`,
      };
    }
  } catch (err) {
    throw wrapError(provider, err);
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IgError("server_error", "The model did not return valid JSON.");
  }
  const r = schema.safeParse(value);
  if (!r.success)
    throw new IgError(
      "server_error",
      `The model's JSON did not match the expected shape: ${r.error.issues[0]?.message ?? "invalid"}`,
    );
  return r.data;
}

// ---- images ---------------------------------------------------------------------------------------

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  model: string;
}

/** Generate a 16:9 image (thumbnail art). `reference` lets the model build on a video frame. Null when no image model. */
export async function generateImage(
  ai: AiSettings,
  prompt: string,
  reference?: ImageInput,
): Promise<GeneratedImage | null> {
  const target = resolveModel(ai, "image");
  if (!target) return null;
  const { provider, model } = target;
  try {
    if (PROVIDERS[provider].kind === "gemini") {
      const g = geminiClient(ai);
      const res = await g.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              ...(reference
                ? [{ inlineData: { mimeType: reference.mime, data: reference.data } }]
                : []),
              { text: `${prompt}\n\nWide 16:9 landscape composition.` },
            ],
          },
        ],
        config: { responseModalities: ["IMAGE", "TEXT"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new IgError("server_error", "Gemini returned no image.");
      return {
        data: Buffer.from(part.inlineData.data, "base64"),
        mime: part.inlineData.mimeType ?? "image/png",
        model: `${provider}:${model}`,
      };
    }
    const client = openaiClient(ai, provider, provider === "azure" ? model : undefined);
    const res = reference
      ? await client.images.edit({
          model,
          image: await toFile(
            Buffer.from(reference.data, "base64"),
            `frame.${reference.mime.split("/")[1]}`,
            { type: reference.mime },
          ),
          prompt,
          size: "1536x1024",
        })
      : await client.images.generate({ model, prompt, size: "1536x1024", n: 1 });
    const img = res.data?.[0];
    if (img?.b64_json)
      return {
        data: Buffer.from(img.b64_json, "base64"),
        mime: "image/png",
        model: `${provider}:${model}`,
      };
    if (img?.url) {
      const r = await fetch(img.url);
      return {
        data: Buffer.from(await r.arrayBuffer()),
        mime: r.headers.get("content-type") ?? "image/png",
        model: `${provider}:${model}`,
      };
    }
    throw new IgError("server_error", "The image model returned no image.");
  } catch (err) {
    throw wrapError(provider, err);
  }
}

// ---- transcription --------------------------------------------------------------------------------

export interface TranscriptPart {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

const SegmentsSchema = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

/** Transcribe one audio file (under ~20 MB). Null when no transcription model is configured. */
export async function transcribeAudio(
  ai: AiSettings,
  path: string,
  language?: string,
): Promise<TranscriptPart | null> {
  const target = resolveModel(ai, "transcribe");
  if (!target) return null;
  const { provider, model } = target;
  try {
    const audio = await readFile(path);
    if (PROVIDERS[provider].kind === "gemini") {
      const g = geminiClient(ai);
      const res = await g.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "audio/mpeg", data: audio.toString("base64") } },
              {
                text: `Transcribe this audio verbatim${language ? ` (language: ${language})` : ""}. Split into segments of one or two sentences with start and end times in seconds from the start of the audio.`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(SegmentsSchema),
        },
      });
      const { segments } = parseJson(SegmentsSchema, res.text ?? "");
      return { text: segments.map((s) => s.text).join(" "), segments };
    }
    const client = openaiClient(ai, provider, provider === "azure" ? model : undefined);
    // gpt-4o-*-transcribe models don't return timestamps; whisper models do.
    const verbose = !/gpt-4o|transcribe/i.test(model);
    const res = (await client.audio.transcriptions.create({
      model,
      file: await toFile(audio, basename(path), { type: "audio/mpeg" }),
      response_format: verbose ? "verbose_json" : "json",
      ...(language ? { language } : {}),
    })) as { text?: string; segments?: { start: number; end: number; text: string }[] };
    return {
      text: res.text ?? "",
      segments: (res.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })),
    };
  } catch (err) {
    throw wrapError(provider, err);
  }
}

// ---- setup helpers --------------------------------------------------------------------------------

/** Models a provider offers (for `ai models`). Azure lists nothing: there you type your deployment names. */
export async function listModels(ai: AiSettings, id: AiProviderId): Promise<string[]> {
  try {
    if (id === "azure") return [];
    if (PROVIDERS[id].kind === "anthropic") {
      const out: string[] = [];
      for await (const m of anthropicClient(ai).models.list()) out.push(m.id);
      return out;
    }
    if (PROVIDERS[id].kind === "gemini") {
      const out: string[] = [];
      const pager = await geminiClient(ai).models.list();
      for await (const m of pager) if (m.name) out.push(m.name.replace(/^models\//, ""));
      return out;
    }
    const out: string[] = [];
    for await (const m of openaiClient(ai, id).models.list()) out.push(m.id);
    return out.sort();
  } catch (err) {
    throw wrapError(id, err);
  }
}

/** One tiny live request per configured task model. */
export async function testAi(ai: AiSettings) {
  const results: { task: AiTask; target: string | null; ok: boolean; detail: string }[] = [];
  for (const task of ["text", "vision", "image", "transcribe"] as AiTask[]) {
    const t = resolveModel(ai, task);
    if (!t) {
      results.push({ task, target: null, ok: false, detail: "not configured" });
      continue;
    }
    const ref = `${t.provider}:${t.model}`;
    try {
      if (task === "text") {
        const r = await generateJson(ai, "text", {
          system: "You are a health check.",
          prompt: 'Reply with {"ok": true}.',
          schema: z.object({ ok: z.boolean() }),
          maxTokens: 2000,
        });
        results.push({ task, target: ref, ok: Boolean(r?.data.ok), detail: "answered" });
      } else {
        // Image, vision and transcription cost money per call: confirm the model exists instead.
        const models = await listModels(ai, t.provider).catch(() => [] as string[]);
        const known =
          !models.length || models.some((m) => m === t.model || m.endsWith(`/${t.model}`));
        results.push({
          task,
          target: ref,
          ok: known,
          detail: known
            ? models.length
              ? "model available"
              : "not checked (no model list)"
            : "model not found in the provider's list",
        });
      }
    } catch (e) {
      results.push({ task, target: ref, ok: false, detail: (e as Error).message });
    }
  }
  return results;
}
