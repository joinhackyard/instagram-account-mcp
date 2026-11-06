import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Accounts } from "../src/accounts.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import type { HostedFile, MediaHost } from "../src/media/host.js";
import { MediaHosts } from "../src/media/hosts/index.js";
import { setGraphFetchForTests } from "../src/meta/graph.js";
import { containerParams, setPollTimingForTests } from "../src/publish/containers.js";
import {
  JobManager,
  parseState,
  setSettleDelayForTests,
  validateSpec,
} from "../src/publish/jobs.js";
import type { PostSpec } from "../src/publish/types.js";
import { TemplateStore } from "../src/templates.js";
import { openVault } from "../src/vault.js";

setPollTimingForTests({ first: 10, max: 20 });
setSettleDelayForTests(10);
after(() => {
  setGraphFetchForTests(undefined);
  setPollTimingForTests(undefined);
  setSettleDelayForTests(undefined);
});

interface Call {
  method: string;
  host: string;
  path: string;
  params: URLSearchParams;
  headers: Headers;
  body?: Buffer;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const IG = "17841400000000001";

async function setup(
  mode: "facebook" | "instagram",
  handler: (c: Call) => Response | undefined | Promise<Response | undefined>,
) {
  const home = mkdtempSync(join(tmpdir(), "igm-pub-"));
  const cfg = loadConfig({ IG_MCP_HOME: home });
  const db = new Db(join(home, "state.db"));
  const vault = openVault(home, "file");
  const accounts = new Accounts(db, vault, cfg);
  const [row] = await accounts.saveDiscovered([
    {
      ig_user_id: IG,
      username: "tester",
      auth_mode: mode,
      scopes: [],
      token: {
        kind: mode === "facebook" ? "page" : "instagram",
        access_token: "tok",
        issued_at: Date.now(),
        expires_at: mode === "instagram" ? Date.now() + 50 * 86_400_000 : undefined,
      },
    },
  ]);
  const hosts = new MediaHosts(db, cfg);
  const hosted: string[] = [];
  const removed: string[] = [];
  const fake: MediaHost & { serves(k: string): boolean } = {
    kind: "tunnel",
    check: async () => ({ ok: true, detail: "fake" }),
    put: async (_p: string, _ct: string, name: string): Promise<HostedFile> => {
      const key = `${hosted.length}-${name}`;
      hosted.push(key);
      return { url: `https://cdn.test/${key}`, key, expiresAt: Date.now() + 3_600_000 };
    },
    remove: async (k: string) => {
      removed.push(k);
    },
    close: async () => {},
    serves: (k: string) => !removed.includes(k),
  };
  hosts.setHostForTests("tunnel", fake);

  const calls: Call[] = [];
  setGraphFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    let params = u.searchParams;
    let body: Buffer | undefined;
    if (init?.body instanceof URLSearchParams) params = init.body;
    else if (init?.body)
      body = Buffer.from(
        await new Response(init.body as NonNullable<RequestInit["body"]>).arrayBuffer(),
      );
    const c: Call = {
      method: init?.method ?? "GET",
      host: u.host,
      path: u.pathname.replace(/^\/v\d+\.\d+\//, "/"),
      params,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(c);
    const r = await handler(c);
    return r ?? json({ error: { message: `unhandled ${c.method} ${c.path}`, code: 100 } }, 400);
  }) as typeof fetch);

  const jobs = new JobManager(db, cfg, accounts, hosts, new TemplateStore(join(home, "templates")));
  const file = (name: string, size = 4096) => {
    const p = join(home, name);
    writeFileSync(p, randomBytes(size));
    return p;
  };
  return { home, db, row, jobs, hosts, calls, hosted, removed, file };
}

const limitOk = (c: Call) =>
  c.path === `/${IG}/content_publishing_limit`
    ? json({ data: [{ quota_usage: 1, config: { quota_total: 100, quota_duration: 86400 } }] })
    : undefined;

const photo = (file: string): PostSpec => ({
  kind: "photo",
  items: [{ source: { file_path: file }, type: "image" }],
  prepare: false,
});

test("validateSpec rejects what Instagram would", () => {
  const img = { source: { file_path: "/a.jpg" }, type: "image" as const };
  const vid = { source: { file_path: "/a.mp4" }, type: "video" as const };
  assert.throws(() => validateSpec({ kind: "carousel", items: [img] }), /2 to 20/);
  assert.throws(() => validateSpec({ kind: "reel", items: [img] }), /needs a video/);
  assert.throws(
    () => validateSpec({ kind: "photo", items: [img], collaborators: ["a", "b", "c", "d"] }),
    /3 collaborators/,
  );
  assert.throws(
    () => validateSpec({ kind: "carousel", items: [img, { ...vid, alt_text: "x" }] }),
    /alt text/,
  );
  assert.throws(
    () => validateSpec({ kind: "photo", items: [img], trial: { graduation: "MANUAL" } }),
    /trial/,
  );
  assert.throws(() => validateSpec({ kind: "story", items: [img], caption: "hi" }), /no caption/);
  assert.throws(
    () =>
      validateSpec({
        kind: "photo",
        items: [{ source: { file_path: "/a", url: "https://x" }, type: "image" }],
      }),
    /exactly one/,
  );
  assert.throws(
    () => validateSpec({ kind: "photo", items: [img], caption: "#a ".repeat(31) }),
    /hashtags/,
  );
  validateSpec({ kind: "carousel", items: Array.from({ length: 20 }, () => img), caption: "ok" });
});

test("containerParams per kind", () => {
  const spec: PostSpec = {
    kind: "reel",
    items: [
      {
        source: { url: "https://x/v.mp4" },
        type: "video",
        user_tags: [{ username: "@bob", x: 0.2 }],
      },
    ],
    caption: "c",
    collaborators: ["@ann"],
    trial: { graduation: "SS_PERFORMANCE" },
    thumb_offset_ms: 1500,
    share_to_feed: false,
  };
  const p = containerParams(
    spec,
    "single",
    { url: "https://x/v.mp4", isVideo: true },
    { item: spec.items[0] },
  );
  assert.equal(p.media_type, "REELS");
  assert.equal(p.video_url, "https://x/v.mp4");
  assert.deepEqual(p.trial_params, { graduation_strategy: "SS_PERFORMANCE" });
  assert.deepEqual(p.user_tags, [{ username: "bob" }]);
  assert.deepEqual(p.collaborators, ["ann"]);
  assert.equal(p.thumb_offset, 1500);
  assert.equal(p.share_to_feed, false);
  const story = containerParams(
    { kind: "story", items: [{ source: { url: "u" }, type: "image" }] },
    "single",
    { url: "https://x/i.jpg", isVideo: false },
  );
  assert.equal(story.media_type, "STORIES");
  assert.equal(story.caption, undefined);
  const child = containerParams(spec, "child", { resumable: true, isVideo: true });
  assert.equal(child.is_carousel_item, true);
  assert.equal(child.media_type, "VIDEO");
  assert.equal(child.upload_type, "resumable");
});

test("photo post: host → container → publish → first comment, hosted copy removed", async () => {
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) {
      assert.equal(c.host, "graph.instagram.com");
      assert.match(c.params.get("image_url") ?? "", /^https:\/\/cdn\.test\//);
      assert.equal(c.params.get("caption"), "Hello world");
      assert.equal(c.params.get("alt_text"), "a cat");
      return json({ id: "c1" });
    }
    if (c.method === "GET" && c.path === "/c1") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) {
      assert.equal(c.params.get("creation_id"), "c1");
      return json({ id: "m1" });
    }
    if (c.method === "GET" && c.path === "/m1")
      return json({ id: "m1", permalink: "https://www.instagram.com/p/abc/" });
    if (c.method === "POST" && c.path === "/m1/comments") {
      assert.equal(c.params.get("message"), "#first");
      return json({ id: "cm1" });
    }
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, {
      kind: "photo",
      items: [{ source: { file_path: s.file("photo.jpg") }, type: "image", alt_text: "a cat" }],
      caption: "Hello world",
      first_comment: "#first",
      prepare: false,
    });
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(done.media_id, "m1");
    assert.equal(done.permalink, "https://www.instagram.com/p/abc/");
    assert.equal(s.hosted.length, 1);
    assert.deepEqual(s.removed, s.hosted);
    const v = s.jobs.view(done);
    assert.equal((v.result as { first_comment: { ok: boolean } }).first_comment.ok, true);
    assert.equal(s.db.get<{ n: number }>("select count(*) as n from publish_log")?.n, 1);
  } finally {
    s.jobs.stop();
  }
});

test("carousel: children first, then the parent with children and caption", async () => {
  let n = 0;
  const created: URLSearchParams[] = [];
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) {
      created.push(c.params);
      return json({ id: `c${++n}` });
    }
    if (c.method === "GET" && /^\/c\d$/.test(c.path)) return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) {
      assert.equal(c.params.get("creation_id"), "c3");
      return json({ id: "m2" });
    }
    if (c.method === "GET" && c.path === "/m2")
      return json({ id: "m2", permalink: "https://i/p/2" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, {
      kind: "carousel",
      items: [
        { source: { file_path: s.file("a.jpg") }, type: "image" },
        { source: { file_path: s.file("b.jpg") }, type: "image" },
      ],
      caption: "Two slides",
      prepare: false,
    });
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(created.length, 3);
    for (const p of created.slice(0, 2)) {
      assert.equal(p.get("is_carousel_item"), "true");
      assert.equal(p.get("caption"), null);
    }
    assert.equal(created[2].get("media_type"), "CAROUSEL");
    assert.equal(created[2].get("children"), "c1,c2");
    assert.equal(created[2].get("caption"), "Two slides");
  } finally {
    s.jobs.stop();
  }
});

test("Facebook Login reel: resumable upload to rupload with OAuth, offset and file_size", async () => {
  let uploaded = 0;
  const s = await setup("facebook", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) {
      assert.equal(c.host, "graph.facebook.com");
      assert.equal(c.params.get("upload_type"), "resumable");
      assert.equal(c.params.get("media_type"), "REELS");
      assert.equal(c.params.get("video_url"), null);
      return json({ id: "c9", uri: "https://rupload.facebook.com/ig-api-upload/v27.0/c9" });
    }
    if (c.host === "rupload.facebook.com") {
      assert.equal(c.headers.get("authorization"), "OAuth tok");
      assert.equal(c.headers.get("offset"), "0");
      uploaded = c.body?.length ?? 0;
      assert.equal(c.headers.get("file_size"), String(uploaded));
      return json({ success: true, message: "Upload successful." });
    }
    if (c.method === "GET" && c.path === "/c9") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) return json({ id: "m9" });
    if (c.method === "GET" && c.path === "/m9")
      return json({ id: "m9", permalink: "https://i/r/9" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, {
      kind: "reel",
      items: [{ source: { file_path: s.file("clip.mp4", 300_000) }, type: "video" }],
      caption: "Reel",
      prepare: false,
    });
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(uploaded, 300_000);
    assert.equal(s.hosted.length, 0, "videos on Facebook Login do not use the media host");
  } finally {
    s.jobs.stop();
  }
});

test("publishing limit reached → waiting_limit with a retry time", async () => {
  let published = false;
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: "c1" });
    if (c.method === "GET" && c.path === "/c1") return json({ status_code: "FINISHED" });
    if (c.path === `/${IG}/content_publishing_limit`)
      return json({
        data: [{ quota_usage: 50, config: { quota_total: 50, quota_duration: 86400 } }],
      });
    if (c.path === `/${IG}/media_publish`) published = true;
    return undefined;
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, {
      kind: "photo",
      items: [{ source: { file_path: s.file("p.jpg") }, type: "image" }],
      prepare: false,
    });
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "waiting_limit");
    assert.equal(done.error_code, "publish_limit_reached");
    assert.ok((done.next_attempt_at ?? 0) > Date.now());
    assert.equal(published, false);
  } finally {
    s.jobs.stop();
  }
});

test("scheduled posts are not touched before their lead time", async () => {
  const s = await setup("instagram", () => undefined);
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(
      s.row.id,
      {
        kind: "photo",
        items: [{ source: { file_path: s.file("s.jpg") }, type: "image" }],
        prepare: false,
      },
      { publishAt: Date.now() + 2 * 3_600_000 },
    );
    assert.equal(job.status, "scheduled");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.jobs.get(job.id)?.status, "scheduled");
    assert.equal(s.calls.length, 0);
    const moved = s.jobs.reschedule(job.id, Date.now() + 3 * 3_600_000);
    assert.equal(moved.status, "scheduled");
    assert.equal(s.jobs.cancel(job.id).status, "cancelled");
  } finally {
    s.jobs.stop();
  }
});

test("a 5xx on media_publish: checked (not published), then retried by the queue, not by Graph", async () => {
  let attempts = 0;
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: "c1" });
    if (c.method === "GET" && c.path === "/c1") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) {
      attempts++;
      if (attempts === 1)
        return json({ error: { message: "temporary", code: 2, is_transient: true } }, 500);
      return json({ id: "m5" });
    }
    if (c.method === "GET" && c.path === "/m5")
      return json({ id: "m5", permalink: "https://i/p/5" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, photo(s.file("r.jpg")));
    const deadline = Date.now() + 10_000;
    let cur = s.jobs.get(job.id)!;
    while (!(cur.status === "queued" && cur.error_code) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      cur = s.jobs.get(job.id)!;
    }
    assert.equal(cur.error_code, "server_error");
    assert.equal(attempts, 1, "Graph must not resend media_publish");
    assert.equal(parseState(cur.items, photo("x")).publish_attempted_at, undefined);
    s.db.run("update jobs set next_attempt_at = ? where id = ?", Date.now(), job.id);
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(attempts, 2);
  } finally {
    s.jobs.stop();
  }
});

test("container ERROR about fetching → re-host and recreate, then publish", async () => {
  let created = 0;
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: `c${++created}` });
    if (c.method === "GET" && c.path === "/c1")
      return json({ status_code: "ERROR", status: "Error: Media download has failed." });
    if (c.method === "GET" && c.path === "/c2") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) return json({ id: "m7" });
    if (c.method === "GET" && c.path === "/m7")
      return json({ id: "m7", permalink: "https://i/p/7" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, {
      kind: "photo",
      items: [{ source: { file_path: s.file("h.jpg") }, type: "image" }],
      prepare: false,
    });
    const done = await s.jobs.waitFor(job.id, 25_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(created, 2);
    assert.equal(s.hosted.length, 2);
  } finally {
    s.jobs.stop();
  }
});

test("unclear media_publish failure is never retried blindly: published container is adopted", async () => {
  let publishCalls = 0;
  let c1Gets = 0;
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: "c1" });
    if (c.method === "GET" && c.path === "/c1")
      return json({ status_code: ++c1Gets > 2 ? "PUBLISHED" : "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) {
      publishCalls++;
      return json({ error: { message: "temporary", code: 2, is_transient: true } }, 500);
    }
    if (c.method === "GET" && c.path === `/${IG}/media`)
      return json({ data: [{ id: "m11", timestamp: new Date().toISOString() }] });
    if (c.method === "GET" && c.path === "/m11")
      return json({ id: "m11", permalink: "https://i/p/11" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, photo(s.file("a.jpg")));
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(done.media_id, "m11");
    assert.equal(publishCalls, 1, "media_publish must be sent once");
  } finally {
    s.jobs.stop();
  }
});

test("published but unidentifiable media: no placeholder id, warning instead", async () => {
  let c1Gets = 0;
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: "c1" });
    if (c.method === "GET" && c.path === "/c1")
      return json({ status_code: ++c1Gets > 2 ? "PUBLISHED" : "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`)
      return json({ error: { message: "timeout", code: 2, is_transient: true } }, 500);
    if (c.method === "GET" && c.path === `/${IG}/media`) return json({ data: [] });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, photo(s.file("b.jpg")));
    const done = await s.jobs.waitFor(job.id, 15_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.equal(done.media_id, null);
    assert.match(JSON.stringify(s.jobs.view(done).result), /did not say which post/);
  } finally {
    s.jobs.stop();
  }
});

test("container expired before publishing → re-hosted and recreated", async () => {
  let created = 0;
  let c1Gets = 0;
  const published: string[] = [];
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: `c${++created}` });
    if (c.method === "GET" && c.path === "/c1")
      return json({ status_code: ++c1Gets === 1 ? "FINISHED" : "EXPIRED" });
    if (c.method === "GET" && c.path === "/c2") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) {
      published.push(c.params.get("creation_id")!);
      return json({ id: "m8" });
    }
    if (c.method === "GET" && c.path === "/m8")
      return json({ id: "m8", permalink: "https://i/p/8" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, photo(s.file("e.jpg")));
    const done = await s.jobs.waitFor(job.id, 25_000);
    assert.equal(done.status, "published", done.error ?? "");
    assert.deepEqual(published, ["c2"]);
    assert.equal(s.hosted.length, 2);
  } finally {
    s.jobs.stop();
  }
});

test("cancel is refused while a publish may be in flight", async () => {
  const s = await setup("instagram", () => undefined);
  const job = s.jobs.enqueue(s.row.id, photo(s.file("x.jpg")));
  s.db.run("update jobs set status = 'publishing' where id = ?", job.id);
  assert.throws(() => s.jobs.cancel(job.id), /being published/);
  const st = parseState(job.items, photo("x"));
  st.publish_attempted_at = Date.now();
  s.db.run("update jobs set status = 'queued', items = ? where id = ?", JSON.stringify(st), job.id);
  assert.throws(() => s.jobs.cancel(job.id), /being published/);
});

test("missed schedule (computer was off) is not published late; resume publishes now", async () => {
  const s = await setup("instagram", () => undefined);
  const job = s.jobs.enqueue(s.row.id, photo(s.file("m.jpg")), {
    publishAt: Date.now() + 3_600_000,
  });
  s.db.run("update jobs set publish_at = ? where id = ?", Date.now() - 3 * 3_600_000, job.id);
  s.jobs.start();
  try {
    const done = await s.jobs.waitFor(job.id, 5_000);
    assert.equal(done.status, "failed");
    assert.equal(done.error_code, "missed_schedule");
    assert.equal(s.calls.length, 0);
  } finally {
    s.jobs.stop();
  }
  const back = s.jobs.resume(job.id);
  assert.equal(back.status, "queued");
  assert.equal(back.publish_at, null);
});

test("prepared posts wait as 'ready' without holding a worker, then publish when due", async () => {
  const s = await setup("instagram", (c) => {
    if (c.method === "POST" && c.path === `/${IG}/media`) return json({ id: "c1" });
    if (c.method === "GET" && c.path === "/c1") return json({ status_code: "FINISHED" });
    if (c.method === "POST" && c.path === `/${IG}/media_publish`) return json({ id: "m3" });
    if (c.method === "GET" && c.path === "/m3")
      return json({ id: "m3", permalink: "https://i/p/3" });
    return limitOk(c);
  });
  s.jobs.start();
  try {
    const job = s.jobs.enqueue(s.row.id, photo(s.file("r.jpg")), {
      publishAt: Date.now() + 11 * 60_000,
    });
    assert.equal(job.status, "queued", "inside the 15-minute lead it starts preparing at once");
    const parked = await s.jobs.waitFor(job.id, 10_000);
    assert.equal(parked.status, "ready");
    assert.equal(parked.lease_owner, null);
    assert.equal(s.hosted.length, 1);
    assert.deepEqual(s.removed, s.hosted, "hosted copy released once Meta has the media");
    s.db.run("update jobs set publish_at = ? where id = ?", Date.now() - 1000, job.id);
    const deadline = Date.now() + 15_000;
    let cur = s.jobs.get(job.id)!;
    while (cur.status !== "published" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      cur = s.jobs.get(job.id)!;
    }
    assert.equal(cur.status, "published", cur.error ?? "");
  } finally {
    s.jobs.stop();
  }
});

test("resume after a media error releases hosted copies before forgetting them", async () => {
  const s = await setup("instagram", () => undefined);
  const file = s.file("z.jpg");
  const job = s.jobs.enqueue(s.row.id, photo(file));
  const h = await s.hosts.put(file, "image/jpeg", "z.jpg", job.id);
  const st = parseState(job.items, photo(file));
  st.items[0] = {
    status: "processing",
    local_path: file,
    public_url: h.url,
    hosted_id: h.id,
    container_id: "c1",
  };
  s.db.run(
    "update jobs set status = 'failed', error_code = 'media_error', items = ?, container_id = 'c1' where id = ?",
    JSON.stringify(st),
    job.id,
  );
  const back = s.jobs.resume(job.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.removed, [h.key]);
  const after = parseState(back.items, photo(file));
  assert.equal(after.items[0].hosted_id, undefined);
  assert.equal(after.items[0].container_id, undefined);
  assert.equal(back.container_id, null);
});
