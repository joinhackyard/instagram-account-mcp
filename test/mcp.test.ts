import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, type App } from "../src/app.js";
import { buildServer } from "../src/mcp/server.js";
import { setGraphFetchForTests } from "../src/meta/graph.js";

let app: App;
let client: Client;
let home: string;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

before(async () => {
  home = mkdtempSync(join(tmpdir(), "igm-mcp-"));
  app = await createApp({
    IG_MCP_HOME: home,
    IG_MCP_VAULT: "file",
    IG_MCP_APP_ID: "1234567890",
    IG_MCP_APP_SECRET: "secret",
  });
  // One connected Facebook-Login account; the network is never reached in these tests.
  await app.accounts.saveDiscovered([
    {
      ig_user_id: "1784",
      username: "the.hackyard",
      auth_mode: "facebook",
      page_id: "p1",
      page_name: "Hackyard",
      scopes: ["instagram_basic", "instagram_content_publish"],
      token: { kind: "page", access_token: "PAGE", issued_at: Date.now() },
    },
  ]);
  setGraphFetchForTests(async () => {
    throw new Error("network disabled in mcp.test");
  });
  const server = buildServer(app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

after(async () => {
  setGraphFetchForTests(undefined);
  await client.close();
  app.connector.close();
  await app.hosts.close();
  app.db.close();
});

test("exposes the full tool set, each with a title, description and annotations", async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const n of [
    "auth_status",
    "connect_account",
    "complete_connect",
    "publish_photo",
    "publish_reel",
    "publish_carousel",
    "publish_story",
    "publish_trial_reel",
    "get_publish_status",
    "list_scheduled",
    "publish_budget",
    "media_host_status",
    "list_media",
    "list_comments",
    "reply_to_comment",
    "private_reply",
    "send_dm",
    "get_media_insights",
    "get_account_insights",
    "get_audience",
    "analyze_post",
    "find_outliers",
    "best_publish_time",
    "hashtag_research",
    "benchmark_competitor",
    "create_ab_test",
    "get_ab_test",
    "generate_caption",
    "repurpose_video",
    "ai_status",
    "list_templates",
  ])
    assert.ok(names.has(n), `missing tool ${n}`);
  assert.ok(tools.length >= 60, `expected 60+ tools, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has no title`);
    assert.ok((t.description ?? "").length > 20, `${t.name} has a thin description`);
    assert.ok(t.annotations, `${t.name} has no annotations`);
  }
  // Anything destructive must say so.
  for (const n of ["delete_media", "delete_comment", "disconnect_account", "cancel_scheduled"]) {
    const t = tools.find((x) => x.name === n)!;
    assert.equal(t.annotations?.destructiveHint, true, `${n} must be marked destructive`);
  }
});

test("auth_status reports the account, login type and media host", async () => {
  const r = await client.callTool({ name: "auth_status", arguments: {} });
  const j = JSON.parse(text(r)) as {
    meta_app_configured: boolean;
    login_type: string;
    accounts: { username: string }[];
    media_host: string;
  };
  assert.equal(j.meta_app_configured, true);
  assert.equal(j.login_type, "Facebook Login");
  assert.equal(j.accounts[0].username, "@the.hackyard");
  assert.equal(j.media_host, "tunnel");
});

test("publishing asks for confirmation first and does nothing until approved", async () => {
  const img = join(home, "a.jpg");
  writeFileSync(img, Buffer.alloc(2048, 1));
  const r = await client.callTool({
    name: "publish_photo",
    arguments: { file_path: img, caption: "Hello", prepare: false },
  });
  assert.match(text(r), /CONFIRMATION REQUIRED/);
  assert.match(text(r), /the\.hackyard/);
  assert.equal(app.jobs.list({}).length, 0);
});

test("a confirmation token cannot be reused for different arguments", async () => {
  const img = join(home, "b.jpg");
  writeFileSync(img, Buffer.alloc(2048, 1));
  const first = await client.callTool({
    name: "publish_photo",
    arguments: { file_path: img, caption: "One", prepare: false },
  });
  const token = /confirmation_token="([^"]+)"/.exec(text(first))?.[1];
  assert.ok(token);
  const second = await client.callTool({
    name: "publish_photo",
    arguments: { file_path: img, caption: "Two", prepare: false, confirmation_token: token },
  });
  assert.equal(second.isError, true);
  assert.match(text(second), /arguments changed/);
});

test("Facebook-Login-only features fail clearly on Instagram Login accounts", async () => {
  const igApp = await createApp({
    IG_MCP_HOME: mkdtempSync(join(tmpdir(), "igm-mcp2-")),
    IG_MCP_VAULT: "file",
    IG_MCP_APP_ID: "1",
    IG_MCP_APP_SECRET: "s",
    IG_AUTH_MODE: "instagram",
  });
  await igApp.accounts.saveDiscovered([
    {
      ig_user_id: "55",
      username: "creator",
      auth_mode: "instagram",
      scopes: [],
      token: {
        kind: "instagram",
        access_token: "IG",
        issued_at: Date.now(),
        expires_at: Date.now() + 1e10,
      },
    },
  ]);
  const server = buildServer(igApp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), c.connect(b)]);
  try {
    const r = await c.callTool({ name: "hashtag_research", arguments: { hashtags: ["builders"] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Facebook Login/);
  } finally {
    await c.close();
    igApp.connector.close();
    await igApp.hosts.close();
    igApp.db.close();
  }
});
