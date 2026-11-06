import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { IgError } from "../src/errors.js";
import {
  analyse,
  Experiments,
  normalCdf,
  poissonCompare,
  proportionCompare,
  toVariantMetrics,
  type VariantMetrics,
} from "../src/experiments.js";
import type { JobRow, PostSpec } from "../src/publish/types.js";

const vm = (label: string, o: Partial<VariantMetrics>): VariantMetrics => ({
  label,
  views: 0,
  reach: 1000,
  shares: 0,
  saves: 0,
  interactions: 0,
  avg_watch_time: 0,
  ...o,
});

test("statistics: normal CDF and the two tests", () => {
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 0.001);
  assert.ok(Math.abs(normalCdf(-1.645) - 0.05) < 0.001);
  assert.ok(poissonCompare(5000, 3000).p < 1e-6);
  assert.ok(poissonCompare(510, 500).p > 0.3);
  assert.ok(proportionCompare(100, 2000, 40, 2000).p < 0.001);
  assert.ok(proportionCompare(41, 2000, 40, 2000).p > 0.4);
});

test("analyse: winner, inconclusive, too little data, directional watch time", () => {
  const win = analyse("views", [vm("A", { views: 3000 }), vm("B", { views: 5000 })]);
  assert.equal(win.verdict, "winner");
  assert.equal(win.winner, "B");
  assert.ok((win.confidence ?? 0) > 0.99);
  assert.equal(win.variants[0].label, "B");

  const close = analyse("views", [vm("A", { views: 520 }), vm("B", { views: 500 })]);
  assert.equal(close.verdict, "inconclusive");
  assert.equal(close.winner, undefined);
  assert.equal(close.leader, "A");

  const thin = analyse("views", [vm("A", { views: 90, reach: 60 }), vm("B", { views: 10 })]);
  assert.equal(thin.verdict, "too_little_data");

  const shares = analyse("shares", [
    vm("A", { shares: 100, reach: 2000 }),
    vm("B", { shares: 40, reach: 2000 }),
    vm("C", { shares: 45, reach: 2000 }),
  ]);
  assert.equal(shares.winner, "A");
  assert.match(shares.method, /Bonferroni/);

  const watch = analyse("avg_watch_time", [
    vm("A", { avg_watch_time: 9 }),
    vm("B", { avg_watch_time: 6 }),
  ]);
  assert.equal(watch.verdict, "likely_winner");
  assert.equal(watch.confidence, null);
});

test("toVariantMetrics reads Meta's names", () => {
  const m = toVariantMetrics("A", {
    views: 10,
    reach: 8,
    shares: 2,
    saved: 3,
    total_interactions: 7,
    ig_reels_avg_watch_time: 4500,
  });
  assert.deepEqual(m, {
    label: "A",
    views: 10,
    reach: 8,
    shares: 2,
    saves: 3,
    interactions: 7,
    avg_watch_time: 4.5,
  });
});

/** Fake publish engine and account; real database. */
function setup(
  insightsByMedia: Record<string, Record<string, number>> = {},
  insightsError?: (mediaId: string) => Error | undefined,
) {
  const home = mkdtempSync(join(tmpdir(), "igm-ab-"));
  const cfg = loadConfig({ IG_MCP_HOME: home });
  const db = new Db(join(home, "state.db"));
  const jobs = new Map<string, JobRow>();
  let n = 0;
  let failOn = -1;
  const fakeJobs = {
    enqueue(
      accountRowId: string,
      spec: PostSpec,
      opts?: { publishAt?: number; experimentId?: string },
    ) {
      if (n === failOn) throw new Error("boom");
      const id = `job${++n}`;
      const row = {
        id,
        account_row_id: accountRowId,
        kind: spec.kind,
        status: opts?.publishAt ? "scheduled" : "queued",
        spec: JSON.stringify(spec),
        items: "[]",
        media_id: null,
        permalink: null,
        publish_at: opts?.publishAt ?? null,
        experiment_id: opts?.experimentId ?? null,
        error: null,
      } as unknown as JobRow;
      jobs.set(id, row);
      return row;
    },
    get: (id: string) => jobs.get(id),
    cancel(id: string) {
      const j = jobs.get(id);
      if (j) j.status = "cancelled";
    },
  };
  const accounts = {
    byRowId: () => ({ id: "row1", ig_user_id: "17841", auth_mode: "facebook", username: "acct" }),
    client: () => ({}),
  };
  const calls: string[] = [];
  const ex = new Experiments(db, cfg, accounts as never, fakeJobs as never, async (_g, mediaId) => {
    calls.push(mediaId);
    await new Promise((r) => setTimeout(r, 5));
    const err = insightsError?.(mediaId);
    if (err) throw err;
    return insightsByMedia[mediaId] ?? {};
  });
  /** A second process sharing the same database and publish queue. */
  const other = new Experiments(db, cfg, accounts as never, fakeJobs as never, async (_g, id) => {
    await new Promise((r) => setTimeout(r, 5));
    return insightsByMedia[id] ?? {};
  });
  const publish = async (id: string, mediaId: string) => {
    const j = jobs.get(id)!;
    j.status = "published";
    j.media_id = mediaId;
    await ex.onJobPublished(j);
  };
  const ageBy = (testId: string, hours: number) =>
    db.run(
      "update experiments set started_at = started_at - ? where id = ?",
      hours * 3_600_000,
      testId,
    );
  return {
    db,
    ex,
    other,
    jobs,
    calls,
    publish,
    ageBy,
    failAt: (i: number) => (failOn = i),
  };
}

const reel = (file: string, caption = "c"): PostSpec => ({
  kind: "reel",
  caption,
  items: [{ type: "video", source: { file_path: file } }],
});

test("lifecycle: trial reels → running → snapshots → decision", async () => {
  const s = setup({
    "17900000001": { views: 2000, reach: 1500, shares: 10, saved: 4, total_interactions: 80 },
    "17900000002": { views: 4000, reach: 3000, shares: 30, saved: 9, total_interactions: 200 },
  });
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4"), note: "question hook" }],
    decideAfterHours: 24,
  });
  assert.equal(t.status, "publishing");
  assert.deepEqual(
    t.variants.map((v) => v.label),
    ["A", "B"],
  );
  const spec = JSON.parse(s.jobs.get("job1")!.spec) as PostSpec;
  assert.deepEqual(spec.trial, { graduation: "MANUAL" });
  assert.equal(s.jobs.get("job1")!.experiment_id, t.test_id);

  await s.publish("job1", "17900000001");
  assert.equal(s.ex.get(t.test_id).status, "publishing", "waits for every version");
  await s.publish("job2", "17900000002");
  assert.equal(s.ex.get(t.test_id).status, "running");

  s.ageBy(t.test_id, 7);
  await s.ex.tick();
  assert.equal(s.ex.view(t.test_id).variants[0].snapshots, 1, "6h snapshot taken");
  await s.ex.tick();
  assert.equal(s.ex.view(t.test_id).variants[0].snapshots, 1, "not taken twice");

  s.ageBy(t.test_id, 20);
  await s.ex.tick();
  const done = s.ex.view(t.test_id);
  assert.equal(done.status, "completed");
  assert.equal(done.winner, "B");
  assert.match(String(done.result?.next_step), /Instagram app/);
  assert.equal(s.jobs.size, 2, "no republish unless opted in");
});

test("republish winner when opted in; nothing on an inconclusive result", async () => {
  const s = setup({
    "17900000001": { views: 1000, reach: 900 },
    "17900000002": { views: 3000, reach: 2500 },
    "17900000003": { views: 1000, reach: 900 },
    "17900000004": { views: 1010, reach: 900 },
  });
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
    autoShareWinner: true,
    graduation: "SS_PERFORMANCE",
  });
  await s.publish("job1", "17900000001");
  await s.publish("job2", "17900000002");
  s.ageBy(t.test_id, 13);
  await s.ex.tick();
  const r = s.ex.view(t.test_id);
  assert.equal(r.winner, "B");
  const promoted = s.jobs.get(String(r.result?.republished_job_id))!;
  const spec = JSON.parse(promoted.spec) as PostSpec;
  assert.equal(spec.trial, undefined);
  assert.equal(spec.share_to_feed, true);
  assert.equal(promoted.experiment_id, null, "the republish is not part of the test");

  const t2 = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
    autoShareWinner: true,
  });
  await s.publish("job4", "17900000003");
  await s.publish("job5", "17900000004");
  s.ageBy(t2.test_id, 13);
  await s.ex.tick();
  const r2 = s.ex.view(t2.test_id);
  assert.equal(r2.result?.verdict, "inconclusive");
  assert.equal(r2.result?.republished_job_id, undefined);
});

test("stop cancels unpublished versions; failed versions fail the test", async () => {
  const s = setup();
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }, { spec: reel("/c.mp4") }],
  });
  await s.publish("job1", "17900000001");
  const stopped = s.ex.stop(t.test_id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.cancelled_unpublished, ["B", "C"]);
  assert.equal(s.jobs.get("job1")!.status, "published");
  assert.throws(() => s.ex.stop(t.test_id), /already stopped/);

  const t2 = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
  });
  const j = s.jobs.get("job4")!;
  j.status = "failed";
  (j as { error: string | null }).error = "Video format not supported";
  await s.ex.tick();
  const f = s.ex.view(t2.test_id);
  assert.equal(f.status, "failed");
  assert.match(f.error ?? "", /Version A could not be published: Video format/);
  assert.equal(s.jobs.get("job5")!.status, "cancelled");
});

test("create validates and rolls back on failure", () => {
  const s = setup();
  assert.throws(
    () => s.ex.create({ accountRowId: "row1", variants: [{ spec: reel("/a.mp4") }] }),
    /2 to 4/,
  );
  assert.throws(
    () =>
      s.ex.create({
        accountRowId: "row1",
        variants: [{ spec: reel("/a.mp4") }, { spec: { ...reel("/b.mp4"), kind: "photo" } }],
      }),
    /reels/,
  );
  assert.throws(
    () =>
      s.ex.create({
        accountRowId: "row1",
        variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
        decideAfterHours: 2,
      }),
    /between 12 and 168/,
  );
  assert.throws(
    () =>
      s.ex.create({
        accountRowId: "row1",
        variants: [
          { label: "X", spec: reel("/a.mp4") },
          { label: "X", spec: reel("/b.mp4") },
        ],
      }),
    /different label/,
  );
  s.failAt(1);
  assert.throws(
    () =>
      s.ex.create({
        accountRowId: "row1",
        variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
      }),
    /boom/,
  );
  assert.equal(s.ex.list().length, 0, "experiment row removed");
  assert.equal(s.jobs.get("job1")!.status, "cancelled", "earlier variant job cancelled");
});

test("decide: only running tests, once, even with two processes ticking", async () => {
  const data = {
    "17900000001": { views: 1000, reach: 900 },
    "17900000002": { views: 3000, reach: 2500 },
  };
  const s = setup(data);
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
    autoShareWinner: true,
  });
  await s.publish("job1", "17900000001");
  await s.publish("job2", "17900000002");
  s.ageBy(t.test_id, 13);
  await Promise.all([s.ex.tick(), s.other.tick()]);
  const republished = [...s.jobs.values()].filter((j) => !JSON.parse(j.spec).trial);
  assert.equal(republished.length, 1, "the winner is republished exactly once");
  assert.equal(s.ex.view(t.test_id).status, "completed");

  // A stopped test is never decided or republished afterwards.
  const t2 = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
    autoShareWinner: true,
  });
  await s.publish("job4", "17900000001");
  await s.publish("job5", "17900000002");
  s.ageBy(t2.test_id, 13);
  s.ex.stop(t2.test_id);
  await s.ex.tick();
  const v = s.ex.view(t2.test_id);
  assert.equal(v.status, "stopped");
  assert.equal(v.result, undefined);
  assert.equal(s.jobs.size, 5, "no republish after stop");
});

test("versions without a usable post ID are excluded, never queried", async () => {
  const s = setup({
    "17900000002": { views: 3000, reach: 2500 },
    "17900000003": { views: 1000, reach: 900 },
  });
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }, { spec: reel("/c.mp4") }],
    decideAfterHours: 12,
  });
  await s.publish("job1", "unknown");
  await s.publish("job2", "17900000002");
  await s.publish("job3", "17900000003");
  assert.equal(s.ex.get(t.test_id).status, "running", "two measurable versions are enough");
  s.ageBy(t.test_id, 13);
  await s.ex.tick();
  assert.ok(!s.calls.includes("unknown"), "never asks Meta about a placeholder ID");
  const v = s.ex.view(t.test_id);
  assert.equal(v.status, "completed");
  assert.equal(v.winner, "B");
  assert.match(JSON.stringify(v.result?.excluded), /did not return the post ID/);
  assert.match(String(v.variants[0].excluded), /post ID/);

  // Only one measurable version: the test fails with a clear reason instead of waiting forever.
  const t2 = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
  });
  await s.publish("job4", "unknown");
  await s.publish("job5", "17900000002");
  const f = s.ex.view(t2.test_id);
  assert.equal(f.status, "failed");
  assert.match(f.error ?? "", /Fewer than 2 versions can be measured\. A: Published/);
});

test("a deleted post is marked missing at decision time; the test fails clearly", async () => {
  const s = setup({ "17900000001": { views: 1000, reach: 900 } }, (id) =>
    id === "17900000002" ? new IgError("not_found", "Object does not exist") : undefined,
  );
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
  });
  await s.publish("job1", "17900000001");
  await s.publish("job2", "17900000002");
  s.ageBy(t.test_id, 13);
  await s.ex.tick();
  const v = s.ex.view(t.test_id);
  assert.equal(v.status, "failed");
  assert.match(v.error ?? "", /B: Instagram has no numbers for this post: Object does not exist/);
  await s.ex.tick();
  assert.equal(s.calls.filter((c) => c === "17900000002").length, 1, "not retried forever");
});

test("network errors keep the test running for the next tick", async () => {
  let down = true;
  const s = setup(
    { "17900000001": { views: 1000, reach: 900 }, "17900000002": { views: 3000, reach: 2500 } },
    () =>
      down ? new IgError("network", "Network error: fetch failed", { retryable: true }) : undefined,
  );
  const t = s.ex.create({
    accountRowId: "row1",
    variants: [{ spec: reel("/a.mp4") }, { spec: reel("/b.mp4") }],
    decideAfterHours: 12,
  });
  await s.publish("job1", "17900000001");
  await s.publish("job2", "17900000002");
  s.ageBy(t.test_id, 13);
  await s.ex.tick();
  assert.equal(s.ex.get(t.test_id).status, "running");
  down = false;
  await s.ex.tick();
  assert.equal(s.ex.get(t.test_id).status, "completed");
});
