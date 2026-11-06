import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { captionBrief } from "../src/ai/brief.js";
import {
  describeAi,
  generateJson,
  loadAiSettings,
  parseModelRef,
  resolveModel,
  saveModels,
  saveProvider,
  setAiFetchForTests,
} from "../src/ai/providers.js";
import { draftCaptions } from "../src/ai/writer.js";
import { aiFromEnv, type AiSettings } from "../src/config.js";
import { Db } from "../src/db.js";
import { reviewCaption } from "../src/mcp/tools/ai.js";
import type { Template } from "../src/templates.js";
import { EncryptedFileVault } from "../src/vault.js";

after(() => setAiFetchForTests(undefined));

const settings = (env: Record<string, string>): AiSettings => aiFromEnv(env);

test("model resolution: explicit choice, auto default, capability checks", () => {
  const ai = settings({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  assert.deepEqual(resolveModel(ai, "text"), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.equal(resolveModel(settings({ ANTHROPIC_API_KEY: "a" }), "image"), null);
  ai.models.text = "openai:gpt-5.5";
  assert.deepEqual(resolveModel(ai, "text"), { provider: "openai", model: "gpt-5.5" });
  assert.deepEqual(parseModelRef("ollama:llama3.2:8b"), {
    provider: "ollama",
    model: "llama3.2:8b",
  });
  assert.equal(parseModelRef("nope:x"), null);
  assert.equal(describeAi(settings({})).providers.length, 0);
});

test("settings: keys in the vault, choices in the database, env wins", async () => {
  const home = mkdtempSync(join(tmpdir(), "igm-ai-"));
  const db = new Db(join(home, "state.db"));
  const vault = new EncryptedFileVault(home);
  await saveProvider(db, vault, "azure", {
    apiKey: "secret",
    endpoint: "https://r.openai.azure.com",
  });
  saveModels(db, { text: "azure:gpt-6-astra" }, "high");
  const ai = settings({});
  await loadAiSettings(ai, {}, db, vault);
  assert.equal(ai.providers.azure?.apiKey, "secret");
  assert.equal(ai.effort, "high");
  assert.ok(!db.setting("ai")?.includes("secret"), "keys never go into the database");
  const env = settings({});
  await loadAiSettings(env, { IG_AI_TEXT_MODEL: "azure:other" }, db, vault);
  assert.equal(env.models.text, "azure:other");
  db.close();
});

function fakeFetch(handler: (url: string, body: any) => unknown) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify(handler(url, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

const claude = (json: unknown) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: JSON.stringify(json) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

test("no provider: generateJson returns null so tools fall back to briefs", async () => {
  assert.equal(
    await generateJson(settings({}), "text", {
      system: "s",
      prompt: "p",
      schema: z.object({ a: z.string() }),
    }),
    null,
  );
  const b = captionBrief({ context: "launch day", format: "reel", count: 3 });
  assert.match(b.instructions.join("\n"), /on-screen hook/);
  assert.equal(b.material, "launch day");
});

test("draftCaptions: options come back with the template applied and checked", async () => {
  const tpl: Template = {
    name: "hackyard",
    description: "",
    caption_footer: "Find your people. hackyard.org",
    hashtags: ["Hackyard"],
    guidance: "calm, specific",
  };
  const { f, calls } = fakeFetch(() =>
    claude({
      options: [
        {
          hook: "48 hours, 300 builders, one room.",
          caption: "48 hours, 300 builders, one room.\n\nWhat would you build?",
          hashtags: ["builders", "#hackathon"],
          cta: "question",
          on_screen_hook: "300 builders. 48 hours.",
          angle: "scale",
        },
        {
          hook: "x",
          caption: "y".repeat(2300),
          hashtags: [],
          cta: "",
          on_screen_hook: "",
          angle: "too long",
        },
      ],
      recommended: 7,
    }),
  );
  setAiFetchForTests(f);
  const r = await draftCaptions(settings({ ANTHROPIC_API_KEY: "k" }), {
    context: "Build 2026 recap",
    format: "reel",
    template: tpl,
    count: 2,
  });
  assert.match(String(calls[0].body.system), /Account voice \(must follow\): calm, specific/);
  assert.equal(r.recommended, 1, "out-of-range index is clamped");
  assert.equal(
    r.options[0].ready_to_use?.caption,
    "48 hours, 300 builders, one room.\n\nWhat would you build?\n\n#builders #hackathon\n\nFind your people. hackyard.org\n\n#Hackyard",
  );
  assert.equal(r.options[1].ready_to_use, undefined);
  assert.match(r.options[1].problems.join(), /2200/);
});

test("reviewCaption: limits and craft rules", () => {
  const good = reviewCaption("Short hook.\n\n#builders #hackathon #india\n\nWhat would you build?");
  assert.equal(good.ok, true);
  assert.deepEqual(good.suggestions, []);
  const bad = reviewCaption(
    `#start ${"long ".repeat(40)}\nhttps://hackyard.org ${Array.from({ length: 16 }, (_, i) => `#h${i}`).join(" ")}`,
  );
  const s = bad.suggestions.join("\n");
  assert.match(s, /first line/i);
  assert.match(s, /start with hashtags/);
  assert.match(s, /reads as spam/);
  assert.match(s, /not clickable/);
  assert.match(s, /No call to action/);
  assert.equal(bad.stats.hashtags, 17);
});
