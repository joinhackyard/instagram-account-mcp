import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { createApp, type App } from "../src/app.js";
import { SECRET } from "../src/config.js";
import { classifyMetaError } from "../src/errors.js";
import { blobSas } from "../src/media/hosts/azure.js";
import { presignGet, signHeaders } from "../src/media/hosts/s3.js";
import { TunnelHost } from "../src/media/hosts/tunnel.js";
import {
  encodeParams,
  Graph,
  peakUsage,
  setGraphFetchForTests,
  usageFor,
} from "../src/meta/graph.js";
import { authorizeUrl, completeSignIn, type StoredToken } from "../src/meta/oauth.js";
import { loopbackPort } from "../src/connect.js";
import { redact } from "../src/log.js";

const apps: App[] = [];
async function makeApp(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "igm-core-"));
  const app = await createApp({
    IG_MCP_HOME: home,
    IG_MCP_VAULT: "file",
    IG_MCP_APP_ID: "1234567890",
    IG_MCP_APP_SECRET: "app-secret",
    ...env,
  });
  apps.push(app);
  return app;
}

afterEach(() => setGraphFetchForTests(undefined));
after(async () => {
  for (const a of apps) {
    a.connector.close();
    await a.hosts.close();
    a.db.close();
  }
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("classifies Meta errors", () => {
  const e = (error: object, status = 400) => classifyMetaError({ status, error });
  assert.equal(e({ code: 190, message: "expired" }).code, "auth_expired");
  assert.equal(
    e({ code: 9, error_subcode: 2207042, message: "limit" }).code,
    "publish_limit_reached",
  );
  assert.equal(e({ code: 4, message: "too many" }).code, "rate_limited");
  assert.equal(e({ code: 80002, message: "ig throttled" }).code, "rate_limited");
  assert.equal(e({ code: 10, message: "perm" }, 403).code, "forbidden");
  assert.equal(
    e({ code: 100, error_subcode: 2207052, message: "fetch" }).code,
    "media_unreachable",
  );
  assert.equal(e({ code: 100, error_subcode: 2207026, message: "fmt" }).code, "media_error");
  assert.equal(e({ code: 100, message: "bad param" }).code, "invalid_request");
  assert.equal(e({ code: 2, message: "temp", is_transient: true }, 500).code, "server_error");
  assert.ok(e({ code: 2, message: "temp" }, 500).retryable);
  const net = classifyMetaError(Object.assign(new TypeError("fetch failed"), {}));
  assert.equal(net.code, "network");
  assert.ok(net.retryable);
});

test("encodes Graph params: objects as JSON, drops empties", () => {
  const q = encodeParams({ a: 1, b: undefined, c: null, d: [1, 2], e: { x: "y" }, f: true });
  assert.equal(q.get("a"), "1");
  assert.equal(q.has("b"), false);
  assert.equal(q.has("c"), false);
  assert.equal(q.get("d"), "[1,2]");
  assert.equal(q.get("e"), '{"x":"y"}');
  assert.equal(q.get("f"), "true");
});

test("Graph client: token in query/body, retries transient errors, records usage", async () => {
  const seen: { url: string; method: string; body?: string }[] = [];
  let calls = 0;
  setGraphFetchForTests(async (input, init) => {
    calls++;
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : undefined,
    });
    if (calls === 1)
      return json({ error: { code: 2, message: "temporary", is_transient: true } }, 500);
    return json({ id: "1" }, 200, {
      "x-app-usage": JSON.stringify({ call_count: 42, total_cputime: 3, total_time: 5 }),
    });
  });
  const g = new Graph("instagram", "v27.0", async () => "TOKEN", "ig-1");
  const r = await g.get<{ id: string }>("123", { fields: "id" });
  assert.equal(r.id, "1");
  assert.equal(calls, 2);
  assert.match(seen[1].url, /^https:\/\/graph\.instagram\.com\/v27\.0\/123\?/);
  assert.match(seen[1].url, /access_token=TOKEN/);
  assert.equal(peakUsage(usageFor("ig-1")), 42);
  await g.post("123/media", { caption: "hi", children: ["a", "b"] });
  const post = seen.at(-1)!;
  assert.equal(post.method, "POST");
  assert.match(post.body!, /access_token=TOKEN/);
  assert.match(post.body!, /children=%5B%22a%22%2C%22b%22%5D/);
});

test("Graph client does not retry auth errors and reports them", async () => {
  let flagged = "";
  setGraphFetchForTests(async () =>
    json({ error: { code: 190, message: "Session expired" } }, 400),
  );
  const g = new Graph(
    "facebook",
    "v27.0",
    async () => "T",
    "k",
    (e) => (flagged = e.message),
  );
  await assert.rejects(g.get("me"), (e: Error & { code?: string }) => e.code === "auth_expired");
  assert.match(flagged, /expired/);
});

test("authorize URLs for both login types", async () => {
  const fb = await makeApp();
  const u1 = new URL(authorizeUrl(fb.cfg, "http://localhost:8765/callback", "st"));
  assert.equal(u1.hostname, "www.facebook.com");
  assert.equal(u1.pathname, "/v27.0/dialog/oauth");
  assert.equal(u1.searchParams.get("client_id"), "1234567890");
  assert.match(u1.searchParams.get("scope")!, /instagram_content_publish/);
  assert.equal(u1.searchParams.get("state"), "st");

  const withConfig = await makeApp({ IG_MCP_CONFIG_ID: "999" });
  const u2 = new URL(authorizeUrl(withConfig.cfg, "http://localhost:8765/callback", "s"));
  assert.equal(u2.searchParams.get("config_id"), "999");
  assert.equal(u2.searchParams.has("scope"), false);

  const ig = await makeApp({ IG_AUTH_MODE: "instagram" });
  const u3 = new URL(authorizeUrl(ig.cfg, "http://localhost:8765/callback", "s"));
  assert.equal(u3.hostname, "www.instagram.com");
  assert.equal(u3.searchParams.get("response_type"), "code");
  assert.match(u3.searchParams.get("scope")!, /instagram_business_content_publish/);
});

test("Facebook sign-in finds Instagram accounts behind Pages", async () => {
  const app = await makeApp();
  setGraphFetchForTests(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) {
      return u.searchParams.get("grant_type") === "fb_exchange_token"
        ? json({ access_token: "EAALONG", expires_in: 5_000_000 })
        : json({ access_token: "EAASHORT" });
    }
    if (u.pathname.endsWith("/me/permissions"))
      return json({
        data: ["instagram_basic", "instagram_content_publish", "pages_show_list"].map((p) => ({
          permission: p,
          status: "granted",
        })),
      });
    if (u.pathname.endsWith("/me/accounts"))
      return json({
        data: [
          { id: "p1", name: "No IG Page", access_token: "PAGE1" },
          {
            id: "p2",
            name: "Hackyard",
            access_token: "PAGE2",
            instagram_business_account: {
              id: "1784",
              username: "the.hackyard",
              followers_count: 10,
            },
          },
        ],
      });
    return json({ error: { code: 100, message: `unexpected ${u.pathname}` } }, 400);
  });
  const found = await completeSignIn(app.cfg, "CODE", "http://localhost:8765/callback");
  assert.equal(found.length, 1);
  assert.equal(found[0].ig_user_id, "1784");
  assert.equal(found[0].page_id, "p2");
  assert.equal(found[0].token.kind, "page");
  assert.equal(found[0].token.access_token, "PAGE2");
  assert.equal(found[0].token.expires_at, undefined);

  const rows = await app.accounts.saveDiscovered(found);
  assert.equal(rows[0].is_default, 1);
  assert.equal(app.accounts.resolve("@the.hackyard").id, rows[0].id);
  assert.equal(await app.accounts.accessToken(rows[0].id), "PAGE2");
});

test("Facebook sign-in without granted permissions is refused with a hint", async () => {
  const app = await makeApp();
  setGraphFetchForTests(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: "EAAX" });
    if (u.pathname.endsWith("/me/permissions"))
      return json({ data: [{ permission: "instagram_basic", status: "granted" }] });
    return json({ data: [] });
  });
  await assert.rejects(
    completeSignIn(app.cfg, "C", "http://localhost:8765/callback"),
    (e: Error & { code?: string; hint?: string }) =>
      e.code === "forbidden" && /instagram_content_publish/.test(e.hint ?? ""),
  );
});

test("Instagram sign-in, then automatic token refresh after 24 hours", async () => {
  const app = await makeApp({ IG_AUTH_MODE: "instagram" });
  setGraphFetchForTests(async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "api.instagram.com") {
      assert.equal(init?.method, "POST");
      return json({
        data: [
          {
            access_token: "IGSHORT",
            user_id: 555,
            permissions: "instagram_business_basic,instagram_business_content_publish",
          },
        ],
      });
    }
    if (u.pathname === "/access_token")
      return json({ access_token: "IGLONG", expires_in: 5_184_000 });
    if (u.pathname.endsWith("/me"))
      return json({ user_id: "17841", username: "creator", account_type: "MEDIA_CREATOR" });
    if (u.pathname === "/refresh_access_token")
      return json({ access_token: "IGFRESH", expires_in: 5_184_000 });
    return json({ error: { code: 100, message: `unexpected ${u.pathname}` } }, 400);
  });
  const found = await completeSignIn(app.cfg, "CODE#_", "http://localhost:8765/callback");
  assert.equal(found[0].ig_user_id, "17841");
  assert.equal(found[0].token.kind, "instagram");
  const [row] = await app.accounts.saveDiscovered(found);
  // Fresh token: no refresh.
  assert.equal(await app.accounts.accessToken(row.id), "IGLONG");
  // Age it: 40 days old, 20 days left → refreshed.
  const t = JSON.parse((await app.vault.get(SECRET.accountToken(row.id)))!) as StoredToken;
  t.issued_at = Date.now() - 40 * 86_400_000;
  t.expires_at = Date.now() + 20 * 86_400_000;
  await app.vault.set(SECRET.accountToken(row.id), JSON.stringify(t));
  assert.equal(await app.accounts.accessToken(row.id), "IGFRESH");
  const after = app.accounts.byRowId(row.id)!;
  assert.ok(after.token_expires_at! > Date.now() + 50 * 86_400_000);
});

test("Instagram sign-in rejects personal accounts", async () => {
  const app = await makeApp({ IG_AUTH_MODE: "instagram" });
  setGraphFetchForTests(async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "api.instagram.com") return json({ access_token: "S", user_id: 1 });
    if (u.pathname === "/access_token") return json({ access_token: "L", expires_in: 100 });
    return json({ user_id: "1", username: "me", account_type: "PERSONAL" });
  });
  await assert.rejects(
    completeSignIn(app.cfg, "C", "http://localhost:8765/callback"),
    /personal account/,
  );
});

test("connect: loopback only for plain-http localhost redirect URIs", () => {
  assert.equal(loopbackPort("http://localhost:8765/callback"), 8765);
  assert.equal(loopbackPort("http://127.0.0.1:9000/cb"), 9000);
  assert.equal(loopbackPort("https://localhost:8765/callback"), null);
  assert.equal(loopbackPort("https://example.com/cb"), null);
});

test("connect: complete with a pasted callback URL", async () => {
  const app = await makeApp({ IG_REDIRECT_URI: "https://localhost:8765/callback" });
  setGraphFetchForTests(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: "EAAL" });
    if (u.pathname.endsWith("/me/permissions"))
      return json({
        data: ["instagram_basic", "instagram_content_publish", "pages_show_list"].map((p) => ({
          permission: p,
          status: "granted",
        })),
      });
    return json({
      data: [
        {
          id: "pg",
          name: "Pg",
          access_token: "PT",
          instagram_business_account: { id: "9", username: "x" },
        },
      ],
    });
  });
  const { url, listening } = await app.connector.start();
  assert.equal(listening, false);
  const state = new URL(url).searchParams.get("state")!;
  await assert.rejects(
    app.connector.complete("https://localhost:8765/callback?code=a&state=wrong"),
    /different sign-in/,
  );
  const rows = await app.connector.complete(
    `https://localhost:8765/callback?code=abc&state=${state}#_`,
  );
  assert.equal(rows[0].username, "x");
});

test("S3 SigV4 matches AWS's published examples", () => {
  const creds = {
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T00:00:00Z"),
  };
  const presigned = new URL(
    presignGet({
      ...creds,
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      expiresSec: 86400,
    }),
  );
  assert.equal(
    presigned.searchParams.get("X-Amz-Signature"),
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  const h = signHeaders({
    ...creds,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9" },
  });
  assert.match(
    h.authorization,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
});

test("Azure blob SAS is read-only, https-only and scoped to one blob", () => {
  const q = new URLSearchParams(
    blobSas({
      account: "acct",
      accountKey: Buffer.from("k".repeat(64)).toString("base64"),
      container: "c",
      blob: "a/b.jpg",
      permissions: "r",
      expiresAt: Date.parse("2030-01-01T00:00:00Z"),
    }),
  );
  assert.equal(q.get("sp"), "r");
  assert.equal(q.get("sr"), "b");
  assert.equal(q.get("spr"), "https");
  assert.equal(q.get("se"), "2030-01-01T00:00:00Z");
  assert.ok(q.get("sig"));
});

test("tunnel file server: only registered files, with byte ranges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "igm-tun-"));
  const file = join(dir, "a.jpg");
  writeFileSync(file, Buffer.from("0123456789"));
  const t = new TunnelHost(dir, 1);
  try {
    const port = await t.localPort();
    const f = t.register(file, "image/jpeg", "a photo.jpg");
    assert.match(f.path, /^\/m\/[\w-]{30,}\/a_photo\.jpg$/);
    const base = `http://127.0.0.1:${port}`;
    const full = await fetch(base + f.path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "image/jpeg");
    assert.equal(await full.text(), "0123456789");
    const part = await fetch(base + f.path, { headers: { range: "bytes=2-4" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "234");
    assert.equal((await fetch(`${base}/m/${"x".repeat(32)}/a.jpg`)).status, 404);
    await t.remove(f.key);
    assert.equal((await fetch(base + f.path)).status, 404);
  } finally {
    await t.close();
  }
});

test("media host selection: bucket beats tunnel in auto mode", async () => {
  const a = await makeApp();
  assert.equal(a.hosts.activeKind(), "tunnel");
  const b = await makeApp({
    IG_S3_BUCKET: "b",
    IG_S3_ACCESS_KEY_ID: "k",
    IG_S3_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(b.hosts.activeKind(), "s3");
  const c = await makeApp({
    IG_AZURE_CONTAINER_SAS_URL: "https://a.blob.core.windows.net/c?sv=x&sig=y",
  });
  assert.equal(c.hosts.activeKind(), "azure");
  const d = await makeApp({
    IG_MEDIA_HOST: "tunnel",
    IG_S3_BUCKET: "b",
    IG_S3_ACCESS_KEY_ID: "k",
    IG_S3_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(d.hosts.activeKind(), "tunnel");
});

test("logs redact Meta tokens and signed URLs", () => {
  const s = redact(
    "url https://graph.facebook.com/v27.0/me?access_token=EAAB1234567890abcdefghijklmn&x=1 sig X-Amz-Signature=abcdef token IGAAQ1234567890abcdefghijklmnopqrstuv",
  );
  assert.doesNotMatch(s, /EAAB1234567890/);
  assert.doesNotMatch(s, /X-Amz-Signature=abcdef/);
  assert.doesNotMatch(s, /IGAAQ1234567890/);
});
