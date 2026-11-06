import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { AccountRow } from "../src/accounts.js";
import { Db } from "../src/db.js";
import { IgError } from "../src/errors.js";
import {
  hashtagBudget,
  hashtagResearch,
  benchmarkCompetitor,
  outlierScore,
  publishTimeStats,
  rankOutliers,
  reserveHashtags,
  topCoHashtags,
} from "../src/growth.js";
import {
  csvCell,
  mediaInsights,
  metricsFor,
  parseAccountInsights,
  planExportPath,
  refusedMetrics,
  toCsv,
  uniquePath,
} from "../src/insights.js";
import { deleteMedia, productOf } from "../src/library.js";
import { Graph, setGraphFetchForTests } from "../src/meta/graph.js";

let db: Db;

before(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), "igm-insights-")), "state.db"));
});
after(() => db.close());
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

const graph = (host: "facebook" | "instagram" = "instagram") =>
  new Graph(host, "v27.0", async () => "TOKEN", "ig1");

const row = (mode: "facebook" | "instagram"): AccountRow => ({
  id: "row1",
  ig_user_id: "ig1",
  username: "me",
  name: "Me",
  profile_picture_url: null,
  account_type: "BUSINESS",
  followers_count: 1000,
  auth_mode: mode,
  page_id: mode === "facebook" ? "page1" : null,
  page_name: null,
  app_id: null,
  scopes: null,
  token_expires_at: null,
  status: "ok",
  status_detail: null,
  is_default: 1,
  connected_at: Date.now(),
  refreshed_at: null,
});

test("metrics are chosen per product type", () => {
  const reels = metricsFor("REELS");
  assert.ok(reels.includes("ig_reels_avg_watch_time"));
  assert.ok(reels.includes("reels_skip_rate"));
  assert.ok(!reels.includes("navigation"));
  assert.ok(!reels.includes("impressions"));
  const story = metricsFor("STORY");
  assert.ok(story.includes("navigation") && story.includes("replies"));
  assert.ok(!story.includes("saved") && !story.includes("likes"));
  const feed = metricsFor("FEED");
  assert.ok(feed.includes("profile_visits") && feed.includes("saved"));
  assert.ok(!feed.includes("ig_reels_avg_watch_time"));
  for (const m of [...reels, ...story, ...feed])
    assert.ok(!["plays", "video_views", "impressions"].includes(m));
});

test("product type falls back to media_type when media_product_type is missing", () => {
  assert.equal(productOf({ media_type: "VIDEO" }), "REELS");
  assert.equal(productOf({ media_type: "CAROUSEL_ALBUM" }), "FEED");
  assert.equal(productOf({ media_type: "IMAGE", media_product_type: "STORY" }), "STORY");
  assert.equal(productOf({ media_type: "VIDEO", media_product_type: "AD" }), "FEED");
});

test("mediaInsights parses values and total_value", async () => {
  const calls = fakeNetwork(() =>
    json({
      data: [
        { name: "views", period: "lifetime", values: [{ value: 1200 }] },
        { name: "reach", total_value: { value: 900 } },
        { name: "ig_reels_avg_watch_time", values: [{ value: 5300 }] },
      ],
    }),
  );
  const m = await mediaInsights(graph(), "m1", "REELS", "instagram");
  assert.deepEqual(m, { views: 1200, reach: 900, ig_reels_avg_watch_time: 5300 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v27.0/m1/insights");
  assert.equal(calls[0].url.hostname, "graph.instagram.com");
  assert.equal(calls[0].url.searchParams.get("metric"), metricsFor("REELS").join(","));
});

test("unsupported metrics are dropped and retried once", async () => {
  let n = 0;
  const calls = fakeNetwork(() => {
    n++;
    if (n === 1)
      return json(
        {
          error: {
            code: 100,
            type: "OAuthException",
            message:
              "(#100) metric[10] must be one of the following values: views, reach, likes, comments, saved, shares, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate",
          },
        },
        400,
      );
    return json({ data: [{ name: "views", values: [{ value: 10 }] }] });
  });
  const m = await mediaInsights(graph(), "m1", "REELS", "instagram");
  assert.equal(m.views, 10);
  assert.equal(calls.length, 2);
  const retried = calls[1].url.searchParams.get("metric")!.split(",");
  assert.ok(!retried.includes("reposts"));
  assert.ok(retried.includes("views"));
});

test("a second refusal is not retried again", async () => {
  const calls = fakeNetwork(() =>
    json({ error: { code: 100, message: "(#100) Invalid parameter" } }, 400),
  );
  await assert.rejects(mediaInsights(graph(), "m1", "FEED", "instagram"), IgError);
  assert.equal(calls.length, 2);
});

test("refusedMetrics reads the valid list, names, or falls back to optional ones", () => {
  assert.deepEqual(
    refusedMetrics(
      "must be one of the following values: views, reach",
      ["views", "reach", "foo"],
      [],
    ),
    ["foo"],
  );
  assert.deepEqual(
    refusedMetrics("The metric reposts is not supported", ["views", "reposts"], []),
    ["reposts"],
  );
  assert.deepEqual(refusedMetrics("Invalid parameter", ["views", "reposts"], ["reposts"]), [
    "reposts",
  ]);
});

test("account insights: totals, breakdowns and series", () => {
  const out = parseAccountInsights([
    { name: "reach", total_value: { value: 500 } },
    {
      name: "follows_and_unfollows",
      total_value: {
        breakdowns: [
          {
            dimension_keys: ["follow_type"],
            results: [
              { dimension_values: ["UNFOLLOWER"], value: 3 },
              { dimension_values: ["FOLLOWER"], value: 40 },
            ],
          },
        ],
      },
    },
    {
      name: "reach",
      values: [
        { value: 10, end_time: "2026-11-01T07:00:00+0000" },
        { value: 12, end_time: "2026-11-02T07:00:00+0000" },
      ],
    },
  ]);
  assert.equal(out[0].total, 500);
  assert.deepEqual(out[1].breakdown?.[0], { key: "FOLLOWER", value: 40 });
  assert.deepEqual(out[2].series, [
    { date: "2026-11-01", value: 10 },
    { date: "2026-11-02", value: 12 },
  ]);
});

test("outlier math: ratio to median, needs 3+ baseline posts", () => {
  assert.equal(outlierScore(20, [10, 5, 15, 10, 10]), 2);
  assert.equal(outlierScore(5, [10, 10, 10]), 0.5);
  assert.equal(outlierScore(5, [10, 10]), undefined);
  assert.equal(outlierScore(undefined, [1, 2, 3]), undefined);
  const posts = [100, 200, 300, 1000, 50].map((v, i) => ({
    id: `m${i}`,
    product: "REELS" as const,
    type: "VIDEO",
    metrics: { views: v },
  }));
  const r = rankOutliers(posts, "views", 2);
  assert.equal(r.median, 200);
  assert.deepEqual(
    r.best.map((x) => [x.id, x.score]),
    [
      ["m3", 5],
      ["m2", 1.5],
    ],
  );
  assert.deepEqual(
    r.worst.map((x) => x.id),
    ["m4", "m0"],
  );
});

test("publish time groups posts by weekday and 3-hour block", () => {
  // 2026-11-02 is a Monday.
  const posts = [
    { timestamp: "2026-11-02T18:10:00Z", value: 300 },
    { timestamp: "2026-11-09T19:40:00Z", value: 280 },
    { timestamp: "2026-11-04T09:00:00Z", value: 100 },
    { timestamp: "2026-11-11T10:00:00Z", value: 90 },
    { timestamp: "2026-11-05T09:00:00Z", value: 120 },
  ];
  const s = publishTimeStats(posts, "UTC");
  assert.equal(s.posts_used, 5);
  assert.equal(s.by_weekday[0].slot, "Mon");
  assert.equal(s.best_slots[0].slot, "Mon 18:00-21:00");
  assert.ok(s.best_slots[0].lift > 2);
});

test("hashtag budget: 30 unique per 7 days, repeats free", () => {
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  const tags = Array.from({ length: 29 }, (_, i) => `tag${i}`);
  reserveHashtags(db, "igB", tags, t0);
  assert.equal(hashtagBudget(db, "igB", t0).remaining, 1);
  reserveHashtags(db, "igB", ["#Tag0", "tag1"], t0); // repeats cost nothing
  assert.equal(hashtagBudget(db, "igB", t0).remaining, 1);
  assert.throws(() => reserveHashtags(db, "igB", ["new1", "new2"], t0), /30 different hashtags/);
  reserveHashtags(db, "igB", ["new1"], t0);
  assert.equal(hashtagBudget(db, "igB", t0).remaining, 0);
  // A week later the slots are free again.
  assert.equal(hashtagBudget(db, "igB", t0 + 7 * 86_400_000 + 1).remaining, 30);
});

test("Facebook-only features refuse Instagram Login accounts before calling Meta", async () => {
  const calls = fakeNetwork(() => json({}));
  await assert.rejects(hashtagResearch(db, graph(), row("instagram"), ["build"]), (e: IgError) => {
    assert.equal(e.code, "forbidden");
    return true;
  });
  await assert.rejects(
    benchmarkCompetitor(db, graph(), row("instagram"), "someone"),
    /Facebook Login/,
  );
  await assert.rejects(deleteMedia(graph(), row("instagram"), "m1"), /Facebook Login/);
  assert.equal(calls.length, 0);
});

test("co-hashtags are counted case-insensitively without the searched tag", () => {
  const top = topCoHashtags(["#Build #AI #ai", "#build #startups", "#AI"], ["build"]);
  assert.deepEqual(top[0], { tag: "#ai", posts: 3 });
  assert.ok(!top.some((t) => t.tag === "#build"));
});

test("CSV export escapes commas, quotes and newlines", () => {
  const csv = toCsv([
    {
      id: "1",
      product: "FEED",
      type: "IMAGE",
      caption: 'Hello, "world"\nbye',
      metrics: { views: 5, reach: 4 },
    },
  ]);
  const [head, line] = csv.split("\n");
  assert.ok(head.startsWith("id,timestamp,product,type,permalink,caption,views,reach"));
  assert.ok(csv.includes('"Hello, ""world""\nbye"'));
  assert.ok(line.startsWith("1,,FEED,IMAGE,,"));
});

test("CSV cells that look like formulas are neutralised; numbers are untouched", () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell("+1 call me"), "'+1 call me");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell("@everyone"), "'@everyone");
  assert.equal(csvCell("\tcmd"), "'\tcmd");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(Number.NaN), "");
  assert.equal(csvCell("plain"), "plain");
  const csv = toCsv([{ id: "1", product: "FEED", type: "IMAGE", caption: "=1+1", metrics: {} }]);
  assert.ok(csv.includes(",'=1+1,"));
});

test("export paths: default and bare names stay in exports/, others need approval", () => {
  const home = mkdtempSync(join(tmpdir(), "igm-export-"));
  const now = new Date("2026-11-06T10:00:00Z");
  const d = planExportPath(home, undefined, now);
  assert.equal(d.path, join(home, "exports", "insights-2026-11-06.csv"));
  assert.equal(d.insideExports, true);
  const bare = planExportPath(home, "march", now);
  assert.equal(bare.path, join(home, "exports", "march.csv"));
  assert.equal(bare.insideExports, true);
  const escape = planExportPath(home, "../state.db", now);
  assert.equal(escape.insideExports, false);
  assert.ok(escape.path.endsWith("state.db.csv"));
  const abs = planExportPath(home, "/tmp/somewhere/report.csv", now);
  assert.equal(abs.insideExports, false);
  const tilde = planExportPath(home, "~/Desktop/r.csv", now);
  assert.equal(tilde.path, join(homedir(), "Desktop", "r.csv"));
  assert.equal(tilde.insideExports, false);
  assert.throws(() => planExportPath(home, "~root/r.csv", now), /~user/);
  assert.throws(() => planExportPath(home, "~", now), IgError);
});

test("exports never overwrite: a numeric suffix is added", () => {
  const dir = mkdtempSync(join(tmpdir(), "igm-unique-"));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "r.csv");
  assert.equal(uniquePath(p), p);
  writeFileSync(p, "x");
  assert.equal(uniquePath(p), join(dir, "r-1.csv"));
  writeFileSync(join(dir, "r-1.csv"), "x");
  assert.equal(uniquePath(p), join(dir, "r-2.csv"));
  const home = mkdtempSync(join(tmpdir(), "igm-export2-"));
  mkdirSync(join(home, "exports"));
  writeFileSync(join(home, "exports", "a.csv"), "keep me");
  assert.equal(planExportPath(home, "a.csv").path, join(home, "exports", "a-1.csv"));
});
