import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, type App } from "../src/app.js";
import { buildServer } from "../src/mcp/server.js";
import {
  checkDmWindow,
  compactComment,
  dmWindow,
  filterComments,
  messagesPath,
  privateReply,
  sendDm,
  type EngageAccount,
} from "../src/engage.js";
import { IgError } from "../src/errors.js";
import { Graph, setGraphFetchForTests } from "../src/meta/graph.js";

afterEach(() => setGraphFetchForTests(undefined));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  url: URL;
  body?: URLSearchParams;
}

function fakeNetwork(handler: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  setGraphFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: init?.body instanceof URLSearchParams ? init.body : undefined,
    };
    calls.push(c);
    return handler(c);
  }) as typeof fetch);
  return calls;
}

const IG: EngageAccount = {
  ig_user_id: "ig1",
  auth_mode: "instagram",
  page_id: null,
  username: "me",
};
const FB: EngageAccount = {
  ig_user_id: "ig1",
  auth_mode: "facebook",
  page_id: "page1",
  username: "me",
};
const g = (host: "facebook" | "instagram") => new Graph(host, "v27.0", async () => "TOKEN", "ig1");

const NOW = Date.parse("2026-11-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** Conversation list + one conversation whose last message from them was `h` hours ago. */
function conversationNetwork(h: number | null) {
  return fakeNetwork((c) => {
    if (c.method === "POST") return json({ recipient_id: "u9", message_id: "mid.1" });
    if (/conversations$/.test(c.url.pathname))
      return json({
        data:
          h === null
            ? []
            : [
                {
                  id: "conv1",
                  participants: {
                    data: [
                      { id: "ig1", username: "me" },
                      { id: "u9", username: "fan" },
                    ],
                  },
                },
              ],
      });
    return json({
      id: "conv1",
      messages: {
        data: [
          {
            id: "m2",
            created_time: hoursAgo((h ?? 0) - 0.5),
            from: { id: "ig1", username: "me" },
            message: "hi!",
          },
          {
            id: "m1",
            created_time: hoursAgo(h ?? 0),
            from: { id: "u9", username: "fan" },
            message: "hello",
          },
        ],
      },
    });
  });
}

test("messages go to the IG user on Instagram Login and to the Page on Facebook Login", async () => {
  assert.equal(messagesPath(IG), "ig1/messages");
  assert.equal(messagesPath(FB), "page1/messages");
  assert.throws(() => messagesPath({ ...FB, page_id: null }), IgError);

  let calls = fakeNetwork(() => json({ message_id: "x" }));
  await sendDm(g("instagram"), IG, "u9", "hello", { skipWindowCheck: true });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.href.split("?")[0], "https://graph.instagram.com/v27.0/ig1/messages");
  assert.equal(calls[0].body?.get("recipient"), JSON.stringify({ id: "u9" }));
  assert.equal(calls[0].body?.get("message"), JSON.stringify({ text: "hello" }));

  calls = fakeNetwork(() => json({ message_id: "x" }));
  await sendDm(g("facebook"), FB, "u9", "hello", { skipWindowCheck: true });
  assert.equal(calls[0].url.href.split("?")[0], "https://graph.facebook.com/v27.0/page1/messages");
});

test("conversations are listed from the Page on Facebook Login", async () => {
  const calls = conversationNetwork(2);
  await checkDmWindow(g("facebook"), FB, "u9", false, NOW);
  assert.equal(calls[0].url.pathname, "/v27.0/page1/conversations");
  assert.equal(calls[0].url.searchParams.get("platform"), "instagram");
  assert.equal(calls[0].url.searchParams.get("user_id"), "u9");
});

test("DMs are refused 24 hours after their last message, without sending", async () => {
  const calls = conversationNetwork(30);
  await assert.rejects(
    sendDm(g("instagram"), IG, "u9", "late reply", { now: NOW }),
    (e: IgError) => {
      assert.equal(e.code, "forbidden");
      assert.match(e.message, /30 hours ago/);
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("DMs inside the window are sent; human agent extends to 7 days with the tag", async () => {
  let calls = conversationNetwork(2);
  await sendDm(g("instagram"), IG, "u9", "thanks!", { now: NOW });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);

  calls = conversationNetwork(30);
  await sendDm(g("instagram"), IG, "u9", "following up", { humanAgent: true, now: NOW });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.body?.get("tag"), "HUMAN_AGENT");
  assert.equal(post.body?.get("messaging_type"), "MESSAGE_TAG");

  conversationNetwork(8 * 24);
  await assert.rejects(
    sendDm(g("instagram"), IG, "u9", "too late", { humanAgent: true, now: NOW }),
  );
});

test("no conversation means no DM (businesses cannot message first)", async () => {
  conversationNetwork(null);
  const w = await checkDmWindow(g("instagram"), IG, "u9", false, NOW);
  assert.equal(w.allowed, false);
  assert.match(w.reason ?? "", /wrote first/);
});

test("window math", () => {
  assert.equal(dmWindow(NOW - 23 * 3_600_000, false, NOW).allowed, true);
  assert.equal(dmWindow(NOW - 25 * 3_600_000, false, NOW).allowed, false);
  assert.equal(dmWindow(NOW - 6 * 86_400_000, true, NOW).allowed, true);
  assert.equal(dmWindow(undefined, true, NOW).allowed, false);
});

test("DM text over 1000 bytes is refused before any call", async () => {
  const calls = fakeNetwork(() => json({}));
  await assert.rejects(
    sendDm(g("instagram"), IG, "u9", "é".repeat(600), { skipWindowCheck: true }),
    /1000 bytes/,
  );
  assert.equal(calls.length, 0);
});

test("private replies: comment_id recipient, refused after 7 days", async () => {
  const calls = fakeNetwork(() => json({ message_id: "x" }));
  await privateReply(g("instagram"), IG, "c1", "Here is the link", hoursAgo(5), NOW);
  assert.equal(calls[0].body?.get("recipient"), JSON.stringify({ comment_id: "c1" }));
  await assert.rejects(
    privateReply(g("instagram"), IG, "c1", "late", hoursAgo(8 * 24), NOW),
    /within 7 days/,
  );
  assert.equal(calls.length, 1);
});

test("comments: answered detection and unanswered filter", () => {
  const rows = [
    compactComment(
      {
        id: "c1",
        text: "Love it",
        username: "fan",
        replies: { data: [{ id: "r1", text: "thanks", username: "Me" }] },
      },
      "me",
    ),
    compactComment({ id: "c2", text: "Price?", from: { id: "u2", username: "buyer" } }, "me"),
    compactComment({ id: "c3", text: "my own note", username: "me" }, "me"),
    compactComment({ id: "c4", text: "spam", username: "bot", hidden: true }, "me"),
  ];
  assert.equal(rows[0].answered, true);
  assert.equal(rows[1].answered, false);
  assert.equal(rows[1].user, "buyer");
  assert.deepEqual(
    filterComments(rows, { unanswered: true }, "me").map((c) => c.id),
    ["c2", "c4"],
  );
  assert.deepEqual(
    filterComments(rows, { hidden: true }, "me").map((c) => c.id),
    ["c4"],
  );
});

// ---- tools: every check runs before the user is asked to confirm ----------------------------------------

let app: App;
let client: Client;

before(async () => {
  app = await createApp({
    IG_MCP_HOME: mkdtempSync(join(tmpdir(), "igm-engage-tools-")),
    IG_MCP_VAULT: "file",
    IG_MCP_APP_ID: "1234567890",
    IG_MCP_APP_SECRET: "app-secret",
  });
  await app.accounts.saveDiscovered([
    {
      ig_user_id: "ig1",
      username: "me",
      auth_mode: "instagram",
      scopes: [],
      token: {
        kind: "instagram",
        access_token: "IGTOKEN",
        issued_at: Date.now(),
        expires_at: Date.now() + 50 * 86_400_000,
      },
    },
  ]);
  const server = buildServer(app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

after(async () => {
  await client.close();
  app.connector.close();
  await app.hosts.close();
  app.db.close();
});

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

/** Meta as seen by the tools: a few comments, a post with comments off, a conversation. */
function toolNetwork(lastInboundHoursAgo = 2) {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return fakeNetwork((c) => {
    if (c.method !== "GET") return json({ id: "new1", message_id: "mid.1", success: true });
    const p = c.url.pathname.replace("/v27.0/", "");
    if (p === "c_reply")
      return json({ id: "c_reply", parent_id: "c_top", text: "a reply", username: "x" });
    if (p === "c_hidden") return json({ id: "c_hidden", hidden: true, text: "hm", username: "x" });
    if (p === "c_old")
      return json({ id: "c_old", text: "old", username: "x", timestamp: ago(8 * 24) });
    if (p === "c_ok") return json({ id: "c_ok", text: "link?", username: "x", timestamp: ago(1) });
    if (p === "m_off") return json({ id: "m_off", comment_enabled: false, media_type: "IMAGE" });
    if (p === "me/conversations")
      return json({
        data: [{ id: "conv1", participants: { data: [{ id: "ig1" }, { id: "u9" }] } }],
      });
    if (p === "conv1")
      return json({
        id: "conv1",
        messages: {
          data: [
            { id: "m1", created_time: ago(lastInboundHoursAgo), from: { id: "u9" }, message: "hi" },
          ],
        },
      });
    if (p === "ig1/media")
      return json({
        data: [{ id: "m1", media_type: "IMAGE", timestamp: ago(72), caption: "=cmd()" }],
      });
    if (p === "m1/insights") return json({ data: [{ name: "views", values: [{ value: 7 }] }] });
    return json({ error: { code: 100, message: `unexpected ${p}` } }, 400);
  });
}

const refusedBeforeConfirm = (r: unknown, pattern: RegExp) => {
  assert.equal((r as { isError?: boolean }).isError, true, text(r));
  assert.match(text(r), pattern);
  assert.doesNotMatch(text(r), /CONFIRMATION REQUIRED|confirmation_token/);
};

test("send_dm: over-long text and closed windows fail before confirmation, with no send", async () => {
  let calls = toolNetwork();
  refusedBeforeConfirm(
    await call("send_dm", { recipient_id: "u9", message: "é".repeat(600) }),
    /1000 bytes/,
  );
  assert.equal(calls.length, 0);

  calls = toolNetwork(30);
  refusedBeforeConfirm(
    await call("send_dm", { recipient_id: "u9", message: "hello" }),
    /30 hours ago/,
  );
  assert.ok(!calls.some((c) => c.method === "POST"));

  calls = toolNetwork(2);
  const r = await call("send_dm", { recipient_id: "u9", message: "hello" });
  assert.match(text(r), /CONFIRMATION REQUIRED/);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("comment tools validate text and target before confirmation", async () => {
  let calls = toolNetwork();
  refusedBeforeConfirm(
    await call("reply_to_comment", { comment_id: "c_ok", message: "   " }),
    /empty/,
  );
  assert.equal(calls.length, 0);
  refusedBeforeConfirm(
    await call("reply_to_comment", { comment_id: "c_reply", message: "thanks" }),
    /top-level/,
  );
  refusedBeforeConfirm(
    await call("reply_to_comment", { comment_id: "c_hidden", message: "thanks" }),
    /hidden/,
  );
  refusedBeforeConfirm(
    await call("comment_on_media", { media_id: "m_off", message: "note" }),
    /turned off/,
  );
  refusedBeforeConfirm(
    await call("private_reply", { comment_id: "c_old", message: "link" }),
    /7 days/,
  );
  calls = toolNetwork();
  refusedBeforeConfirm(await call("private_reply", { comment_id: "c_ok", message: " " }), /empty/);
  assert.equal(calls.length, 0);
  refusedBeforeConfirm(await call("delete_media", { media_id: "m1" }), /Facebook Login/);
  assert.equal(calls.length, 0);
  assert.ok(!calls.some((c) => c.method !== "GET"));

  const ok = await call("reply_to_comment", { comment_id: "c_ok", message: "Sent!" });
  assert.match(text(ok), /CONFIRMATION REQUIRED/);
});

test("export_insights: exports/ by default, approval for other paths, never overwrites", async () => {
  let calls = toolNetwork();
  const outside = join(mkdtempSync(join(tmpdir(), "igm-out-")), "r.csv");
  const gated = await call("export_insights", { path: outside });
  assert.match(text(gated), /CONFIRMATION REQUIRED/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(outside), false);

  calls = toolNetwork();
  const first = await call("export_insights", { path: "report" });
  assert.doesNotMatch(text(first), /CONFIRMATION/);
  const p1 = join(app.cfg.home, "exports", "report.csv");
  assert.ok(existsSync(p1));
  assert.ok(readFileSync(p1, "utf8").includes(",'=cmd(),"));
  await call("export_insights", { path: "report" });
  assert.ok(existsSync(join(app.cfg.home, "exports", "report-1.csv")));
  assert.equal(readFileSync(p1, "utf8").split("\n").length > 1, true);
  assert.ok(calls.length > 0);
});
