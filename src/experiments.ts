import type { Accounts } from "./accounts.js";
import type { AuthMode, Config } from "./config.js";
import { newId } from "./crypto.js";
import type { Db } from "./db.js";
import { IgError } from "./errors.js";
import { mediaInsights } from "./insights.js";
import { log } from "./log.js";
import type { Graph } from "./meta/graph.js";
import type { JobManager } from "./publish/jobs.js";
import type { JobRow, PostSpec, TrialGraduation } from "./publish/types.js";
import { round as roundOrNull } from "./stats.js";

const round = (x: number, d = 2): number => roundOrNull(x, d) ?? 0;

/**
 * A/B tests with trial reels. Instagram shows trial reels to non-followers first, so 2-4 versions of a reel
 * (different hook, cut, caption or cover) can be published side by side and compared on the same kind of
 * audience. Meta has no API to graduate a trial reel: the winner is shared to followers in the Instagram
 * app (or, if the user opted in at creation, republished as a normal reel by this server).
 */
export const AB_METRICS = [
  "views",
  "reach",
  "avg_watch_time",
  "shares",
  "saves",
  "engagement_rate",
] as const;
export type AbMetric = (typeof AB_METRICS)[number];

export type ExperimentStatus = "publishing" | "running" | "completed" | "stopped" | "failed";
const ACTIVE: ExperimentStatus[] = ["publishing", "running"];

export interface ExperimentRow {
  id: string;
  account_row_id: string;
  status: ExperimentStatus;
  metric: AbMetric;
  hypothesis: string | null;
  decide_after_hours: number;
  auto_share_winner: number;
  winner: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface VariantRow {
  experiment_id: string;
  label: string;
  job_id: string | null;
  media_id: string | null;
  note: string | null;
  metrics: string | null;
  /** Why this version's numbers can't be read (no post ID, deleted post); it is left out of the result. */
  missing_reason: string | null;
}

export interface Snapshot {
  at: string;
  hours: number;
  values: Record<string, number>;
}

export interface VariantInput {
  label?: string;
  spec: PostSpec;
  note?: string;
}

export interface CreateInput {
  accountRowId: string;
  variants: VariantInput[];
  metric?: AbMetric;
  decideAfterHours?: number;
  graduation?: TrialGraduation;
  publishAt?: number;
  /** Minutes between variant publishes (0 = all at once). */
  staggerMinutes?: number;
  autoShareWinner?: boolean;
  hypothesis?: string;
}

export type InsightsFn = (
  graph: Graph,
  mediaId: string,
  productType: "FEED" | "REELS" | "STORY",
  mode: AuthMode,
) => Promise<Record<string, number>>;

const HOUR = 3_600_000;
export const SNAPSHOT_HOURS = [6, 24];
export const MIN_DECIDE_HOURS = 12;
export const MAX_DECIDE_HOURS = 168;
/** Minimum reach per variant before a result means anything. */
export const MIN_REACH = 100;
const CONFIDENCE = 0.9;
const LABELS = ["A", "B", "C", "D"];

// ---- statistics ---------------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** One-sided p-value that `a` is really larger than `b`, from a z statistic. */
const oneSided = (z: number) => 1 - normalCdf(z);

/**
 * Poisson rate comparison for counts collected over the same time (views, reach): conditional on the
 * total, a ~ Binomial(a+b, 1/2) under "no difference". Normal approximation with continuity correction.
 */
export function poissonCompare(a: number, b: number): { z: number; p: number } {
  const n = a + b;
  if (n <= 0) return { z: 0, p: 1 };
  const z = (Math.abs(a - b) - 1) / Math.sqrt(n);
  return { z: a >= b ? z : -z, p: oneSided(a >= b ? z : -z) };
}

/** Two-proportion z-test that rate a (xa/na) is larger than rate b (xb/nb). */
export function proportionCompare(
  xa: number,
  na: number,
  xb: number,
  nb: number,
): { z: number; p: number } {
  if (na <= 0 || nb <= 0) return { z: 0, p: 1 };
  const pa = xa / na;
  const pb = xb / nb;
  const pool = (xa + xb) / (na + nb);
  const se = Math.sqrt(pool * (1 - pool) * (1 / na + 1 / nb));
  if (!se) return { z: 0, p: pa > pb ? 0 : 1 };
  const z = (pa - pb) / se;
  return { z, p: oneSided(z) };
}

export interface VariantMetrics {
  label: string;
  views: number;
  reach: number;
  shares: number;
  saves: number;
  interactions: number;
  /** Seconds. */
  avg_watch_time: number;
}

/** Pull the numbers a test needs out of the raw insights (names as Meta returns them). */
export function toVariantMetrics(label: string, raw: Record<string, number>): VariantMetrics {
  const n = (k: string) => (Number.isFinite(raw[k]) ? raw[k] : 0);
  return {
    label,
    views: n("views") || n("plays"),
    reach: n("reach"),
    shares: n("shares"),
    saves: n("saved") || n("saves"),
    interactions: n("total_interactions") || n("likes") + n("comments") + n("shares") + n("saved"),
    avg_watch_time: round(n("ig_reels_avg_watch_time") / 1000, 2),
  };
}

export function metricValue(m: VariantMetrics, metric: AbMetric): number {
  switch (metric) {
    case "views":
      return m.views;
    case "reach":
      return m.reach;
    case "avg_watch_time":
      return m.avg_watch_time;
    case "shares":
      return m.reach ? m.shares / m.reach : 0;
    case "saves":
      return m.reach ? m.saves / m.reach : 0;
    case "engagement_rate":
      return m.reach ? m.interactions / m.reach : 0;
  }
}

export interface Analysis {
  verdict: "winner" | "likely_winner" | "inconclusive" | "too_little_data";
  winner?: string;
  leader: string;
  confidence: number | null;
  lift_vs_runner_up: number | null;
  method: string;
  variants: (VariantMetrics & { value: number })[];
  explanation: string;
}

/**
 * Compare the best variant with every other one (Bonferroni-corrected). Counts use a Poisson rate test,
 * shares/saves/engagement a two-proportion test against reach. Average watch time has no variance in
 * Meta's data, so it can only be "likely" (a clear lift with enough reach), never "significant".
 */
export function analyse(metric: AbMetric, variants: VariantMetrics[]): Analysis {
  const scored = variants
    .map((v) => ({ ...v, value: metricValue(v, metric) }))
    .sort((a, b) => b.value - a.value);
  const best = scored[0];
  const runnerUp = scored[1];
  const lift =
    runnerUp && runnerUp.value > 0 ? (best.value - runnerUp.value) / runnerUp.value : null;
  const base = {
    leader: best.label,
    lift_vs_runner_up: lift === null ? null : round(lift, 3),
    variants: scored.map((v) => ({
      ...v,
      value: metric === "views" || metric === "reach" ? v.value : round(v.value, 4),
    })),
  };
  if (scored.some((v) => v.reach < MIN_REACH))
    return {
      ...base,
      verdict: "too_little_data",
      confidence: null,
      method: "none",
      explanation: `Each version needs a reach of at least ${MIN_REACH} before the comparison means anything.`,
    };
  const others = scored.slice(1);
  const k = others.length;
  let method: string;
  let pMax = 0;
  if (metric === "avg_watch_time") {
    method = "lift threshold (Meta reports only the average, so no significance test is possible)";
    const clear = lift !== null && lift >= 0.15;
    return {
      ...base,
      verdict: clear ? "likely_winner" : "inconclusive",
      winner: clear ? best.label : undefined,
      confidence: null,
      method,
      explanation: clear
        ? `${best.label} holds attention ${Math.round(lift! * 100)}% longer than the runner-up. Treat it as directional.`
        : "The average watch times are within 15% of each other.",
    };
  }
  for (const o of others) {
    const p =
      metric === "views"
        ? poissonCompare(best.views, o.views).p
        : metric === "reach"
          ? poissonCompare(best.reach, o.reach).p
          : metric === "shares"
            ? proportionCompare(best.shares, best.reach, o.shares, o.reach).p
            : metric === "saves"
              ? proportionCompare(best.saves, best.reach, o.saves, o.reach).p
              : proportionCompare(
                  Math.min(best.interactions, best.reach),
                  best.reach,
                  Math.min(o.interactions, o.reach),
                  o.reach,
                ).p;
    pMax = Math.max(pMax, Math.min(1, p * k));
  }
  method =
    metric === "views" || metric === "reach"
      ? "Poisson rate comparison (one-sided, Bonferroni)"
      : "two-proportion z-test against reach (one-sided, Bonferroni)";
  const confidence = round(1 - pMax, 3);
  const meaningful = lift === null || lift >= 0.05;
  const win = confidence >= CONFIDENCE && meaningful;
  return {
    ...base,
    verdict: win ? "winner" : "inconclusive",
    winner: win ? best.label : undefined,
    confidence,
    method,
    explanation: win
      ? `${best.label} beats every other version on ${metric} with ${Math.round(confidence * 100)}% confidence.${metric === "views" || metric === "reach" ? " Views spread unevenly (one share can snowball), so the true uncertainty is larger than the test assumes." : ""}`
      : `No version is ahead with ${Math.round(CONFIDENCE * 100)}% confidence (best: ${best.label}, ${Math.round(confidence * 100)}%). Treat the leader as a hint, not a result.`,
  };
}

// ---- manager ------------------------------------------------------------------------------------

export function experimentView(e: ExperimentRow, variants: VariantRow[], jobs?: JobManager) {
  const result = e.result ? (JSON.parse(e.result) as Record<string, unknown>) : undefined;
  return {
    test_id: e.id,
    status: e.status,
    metric: e.metric,
    hypothesis: e.hypothesis ?? undefined,
    decide_after_hours: e.decide_after_hours,
    decides_at: e.started_at
      ? new Date(e.started_at + e.decide_after_hours * HOUR).toISOString()
      : "after all versions are published",
    share_winner_automatically: Boolean(e.auto_share_winner),
    variants: variants.map((v) => {
      const job = v.job_id ? safeJob(jobs, v.job_id) : undefined;
      const snaps = v.metrics ? (JSON.parse(v.metrics) as Snapshot[]) : [];
      return {
        label: v.label,
        note: v.note ?? undefined,
        job_id: v.job_id ?? undefined,
        job_status: job?.status,
        media_id: v.media_id ?? undefined,
        permalink: job?.permalink ?? undefined,
        latest_metrics: snaps.at(-1),
        snapshots: snaps.length,
        excluded: v.missing_reason ?? undefined,
      };
    }),
    winner: e.winner ?? undefined,
    result,
    error: e.error ?? undefined,
    created_at: new Date(e.created_at).toISOString(),
    started_at: e.started_at ? new Date(e.started_at).toISOString() : undefined,
    finished_at: e.finished_at ? new Date(e.finished_at).toISOString() : undefined,
  };
}

function safeJob(jobs: JobManager | undefined, id: string): JobRow | undefined {
  try {
    return jobs?.get(id) ?? undefined;
  } catch {
    return undefined;
  }
}

export class Experiments {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly accounts: Accounts,
    private readonly jobs: JobManager,
    private readonly insights: InsightsFn = mediaInsights,
  ) {}

  list(status?: string): ExperimentRow[] {
    return status
      ? this.db.all<ExperimentRow>(
          "select * from experiments where status = ? order by created_at desc",
          status,
        )
      : this.db.all<ExperimentRow>("select * from experiments order by created_at desc limit 200");
  }

  get(id: string): ExperimentRow {
    const e = this.db.get<ExperimentRow>("select * from experiments where id = ?", id);
    if (!e) throw new IgError("not_found", `No A/B test with id ${id}.`);
    return e;
  }

  variants(id: string): VariantRow[] {
    return this.db.all<VariantRow>(
      "select * from experiment_variants where experiment_id = ? order by label",
      id,
    );
  }

  view(id: string) {
    return experimentView(this.get(id), this.variants(id), this.jobs);
  }

  /** Validate and enqueue every variant as a trial reel. All-or-nothing. */
  create(input: CreateInput) {
    const n = input.variants.length;
    if (n < 2 || n > 4)
      throw new IgError("invalid_request", "An A/B test needs 2 to 4 versions of the reel.");
    const metric = input.metric ?? "views";
    if (!AB_METRICS.includes(metric))
      throw new IgError("invalid_request", `metric must be one of ${AB_METRICS.join(", ")}.`);
    const hours = input.decideAfterHours ?? 48;
    if (hours < MIN_DECIDE_HOURS || hours > MAX_DECIDE_HOURS)
      throw new IgError(
        "invalid_request",
        `decide_after_hours must be between ${MIN_DECIDE_HOURS} and ${MAX_DECIDE_HOURS}.`,
      );
    const labels = input.variants.map((v, i) => (v.label?.trim() || LABELS[i]).slice(0, 20));
    if (new Set(labels).size !== n)
      throw new IgError("invalid_request", "Each version needs a different label.");
    for (const v of input.variants)
      if (v.spec.kind !== "reel")
        throw new IgError("invalid_request", "A/B tests compare reels (trial reels).");
    const graduation = input.graduation ?? "MANUAL";
    const id = newId();
    const now = Date.now();
    const stagger = Math.max(0, Math.min(60, input.staggerMinutes ?? 0)) * 60_000;
    this.db.run(
      `insert into experiments(id, account_row_id, status, metric, hypothesis, decide_after_hours, auto_share_winner, created_at, updated_at)
       values (?, ?, 'publishing', ?, ?, ?, ?, ?, ?)`,
      id,
      input.accountRowId,
      metric,
      input.hypothesis ?? null,
      hours,
      input.autoShareWinner ? 1 : 0,
      now,
      now,
    );
    const created: string[] = [];
    try {
      input.variants.forEach((v, i) => {
        const spec: PostSpec = { ...v.spec, kind: "reel", trial: { graduation } };
        const at = input.publishAt
          ? input.publishAt + i * stagger
          : stagger && i
            ? now + i * stagger
            : undefined;
        const job = this.jobs.enqueue(input.accountRowId, spec, {
          publishAt: at,
          experimentId: id,
        });
        created.push(job.id);
        this.db.run(
          "insert into experiment_variants(experiment_id, label, job_id, note) values (?, ?, ?, ?)",
          id,
          labels[i],
          job.id,
          v.note ?? null,
        );
      });
    } catch (e) {
      for (const j of created)
        try {
          this.jobs.cancel(j);
        } catch {
          /* already gone */
        }
      this.db.run("delete from experiments where id = ?", id);
      throw e;
    }
    this.db.audit("ab_test.created", { variants: n, metric, hours }, undefined, undefined);
    return this.view(id);
  }

  /** Called by the publish engine when any job publishes. */
  async onJobPublished(job: JobRow): Promise<void> {
    if (!job.experiment_id) return;
    const usable = isMediaId(job.media_id);
    this.db.run(
      "update experiment_variants set media_id = ?, missing_reason = ? where experiment_id = ? and job_id = ? and media_id is null and missing_reason is null",
      usable ? job.media_id : null,
      usable
        ? null
        : "Published, but Instagram did not return the post ID, so its numbers can't be read.",
      job.experiment_id,
      job.id,
    );
    this.maybeStart(job.experiment_id);
  }

  /** Every version settled → start the clock, or fail when fewer than 2 can be measured. */
  private maybeStart(id: string) {
    this.db.tx(() => {
      const e = this.db.get<ExperimentRow>("select * from experiments where id = ?", id);
      if (!e || e.status !== "publishing") return;
      const vs = this.variants(id);
      if (!vs.every((v) => v.media_id || v.missing_reason)) return;
      const now = Date.now();
      if (vs.filter((v) => v.media_id).length < 2) {
        this.fail(id, `Fewer than 2 versions can be measured. ${missingSummary(vs)}`);
        return;
      }
      this.db.run(
        "update experiments set status = 'running', started_at = ?, updated_at = ? where id = ? and status = 'publishing'",
        now,
        now,
        id,
      );
    });
  }

  stop(id: string) {
    const e = this.get(id);
    if (!ACTIVE.includes(e.status))
      throw new IgError("invalid_request", `This test is already ${e.status}.`);
    const now = Date.now();
    // Claim first, so a decision running in another process cannot complete it afterwards.
    const claimed = this.db.run(
      "update experiments set status = 'stopped', updated_at = ?, finished_at = ? where id = ? and status in ('publishing', 'running')",
      now,
      now,
      id,
    ).changes;
    if (claimed !== 1)
      throw new IgError("invalid_request", `This test is already ${this.get(id).status}.`);
    const cancelled: string[] = [];
    for (const v of this.variants(id)) {
      if (!v.job_id || v.media_id) continue;
      const j = safeJob(this.jobs, v.job_id);
      if (j && !["published", "failed", "cancelled"].includes(j.status)) {
        try {
          this.jobs.cancel(v.job_id);
          cancelled.push(v.label);
        } catch (err) {
          log.warn("could not cancel variant job", { error: String(err) });
        }
      }
    }
    return { ...this.view(id), cancelled_unpublished: cancelled };
  }

  /** Only active tests can fail; a stopped or decided test keeps its state. */
  private fail(id: string, error: string) {
    const now = Date.now();
    this.db.run(
      "update experiments set status = 'failed', error = ?, updated_at = ?, finished_at = ? where id = ? and status in ('publishing', 'running')",
      error,
      now,
      now,
      id,
    );
  }

  private markMissing(id: string, label: string, reason: string) {
    this.db.run(
      "update experiment_variants set missing_reason = ? where experiment_id = ? and label = ?",
      reason,
      id,
      label,
    );
  }

  /**
   * Read the current metrics of every measurable version and append a snapshot. A version whose post is
   * gone (or has no usable ID) is marked missing instead of failing the whole run again and again.
   */
  private async snapshot(e: ExperimentRow, label?: string): Promise<VariantMetrics[]> {
    const row = this.accounts.byRowId(e.account_row_id);
    if (!row)
      throw new IgError("not_connected", "The account for this test is no longer connected.");
    const graph = this.accounts.client(row);
    const hours = e.started_at ? round((Date.now() - e.started_at) / HOUR, 1) : 0;
    const out: VariantMetrics[] = [];
    for (const v of this.variants(e.id)) {
      if (v.missing_reason) continue;
      if (!isMediaId(v.media_id)) {
        this.markMissing(e.id, v.label, "No Instagram post ID was recorded for this version.");
        continue;
      }
      let raw: Record<string, number>;
      try {
        raw = await this.insights(graph, v.media_id!, "REELS", row.auth_mode);
      } catch (err) {
        if (
          err instanceof IgError &&
          (err.code === "not_found" || err.code === "invalid_request")
        ) {
          this.markMissing(e.id, v.label, `Instagram has no numbers for this post: ${err.message}`);
          continue;
        }
        throw err; // network, rate limit, auth: try again next tick
      }
      const snaps = v.metrics ? (JSON.parse(v.metrics) as Snapshot[]) : [];
      snaps.push({ at: label ?? new Date().toISOString(), hours, values: raw });
      this.db.run(
        "update experiment_variants set metrics = ? where experiment_id = ? and label = ?",
        JSON.stringify(snaps.slice(-20)),
        e.id,
        v.label,
      );
      out.push(toVariantMetrics(v.label, raw));
    }
    return out;
  }

  /** Latest metrics without waiting for the decision (get_ab_test with refresh). */
  async refresh(id: string) {
    const e = this.get(id);
    if (e.status === "running") await this.snapshot(e);
    return this.view(id);
  }

  private async decide(e: ExperimentRow) {
    const metrics = await this.snapshot(e, "decision");
    const vs = this.variants(e.id);
    if (metrics.length < 2) {
      this.fail(e.id, `Fewer than 2 versions could be measured. ${missingSummary(vs)}`);
      return;
    }
    const analysis = analyse(e.metric, metrics);
    const missing = vs.filter((v) => v.missing_reason);
    const result: Record<string, unknown> = {
      ...analysis,
      excluded: missing.length
        ? missing.map((v) => ({ label: v.label, reason: v.missing_reason }))
        : undefined,
      next_step:
        analysis.verdict === "winner" || analysis.verdict === "likely_winner"
          ? `Share version ${analysis.winner} to your followers in the Instagram app: open the reel → "Share to followers" (or Professional dashboard → Trial reels). Meta's API cannot graduate trial reels.`
          : "No clear winner. Keep the leader if you like it, or run a new test with a bigger difference between versions (a different hook beats a different caption).",
    };
    const winner: string | null = analysis.winner ?? null;
    const now = Date.now();
    // Claim the decision atomically: only a still-running test is completed, and only by one process.
    const claimed = this.db.tx(
      () =>
        this.db.run(
          "update experiments set status = 'completed', winner = ?, result = ?, updated_at = ?, finished_at = ? where id = ? and status = 'running'",
          winner,
          JSON.stringify(result),
          now,
          now,
          e.id,
        ).changes === 1,
    );
    if (!claimed) return;
    this.db.audit("ab_test.decided", { verdict: analysis.verdict, winner });
    if (!(e.auto_share_winner && analysis.verdict === "winner" && winner)) return;
    const v = vs.find((x) => x.label === winner);
    const job = v?.job_id ? safeJob(this.jobs, v.job_id) : undefined;
    if (!job) return;
    try {
      const spec = JSON.parse(job.spec) as PostSpec;
      delete spec.trial;
      const promoted = this.jobs.enqueue(e.account_row_id, {
        ...spec,
        kind: "reel",
        share_to_feed: true,
      });
      result.republished_job_id = promoted.id;
      result.next_step = `Version ${winner} is being republished to followers as a normal reel (job ${promoted.id}). The trial reel stays visible to non-followers; delete it in the app if you don't want both.`;
    } catch (err) {
      result.republish_error = (err as Error).message;
    }
    this.db.run("update experiments set result = ? where id = ?", JSON.stringify(result), e.id);
  }

  /** Scheduler: start clocks, take snapshots, decide. `renew` keeps the lease; stop when it fails. */
  async tick(renew: () => boolean = () => true): Promise<void> {
    for (const listed of this.db.all<{ id: string }>(
      "select id from experiments where status in ('publishing', 'running') order by created_at",
    )) {
      if (!renew()) return;
      // Re-read: a tool call (stop) or another process may have changed it since the list was taken.
      const e = this.db.get<ExperimentRow>("select * from experiments where id = ?", listed.id);
      if (!e || !ACTIVE.includes(e.status)) continue;
      try {
        if (e.status === "publishing") {
          for (const v of this.variants(e.id)) {
            if (v.media_id || v.missing_reason || !v.job_id) continue;
            const j = safeJob(this.jobs, v.job_id);
            if (!j || j.status === "failed" || j.status === "cancelled") {
              this.fail(
                e.id,
                `Version ${v.label} could not be published${j?.error ? `: ${j.error}` : ""}.`,
              );
              for (const other of this.variants(e.id))
                if (other.job_id && !other.media_id && other.job_id !== v.job_id)
                  try {
                    this.jobs.cancel(other.job_id);
                  } catch {
                    /* ignore */
                  }
              break;
            }
            if (j.status === "published") await this.onJobPublished(j);
          }
          continue;
        }
        const started = e.started_at ?? e.created_at;
        const age = (Date.now() - started) / HOUR;
        if (age >= e.decide_after_hours) {
          await this.decide(e);
          continue;
        }
        const taken = Math.max(
          0,
          ...this.variants(e.id)
            .filter((v) => !v.missing_reason && v.metrics)
            .map(
              (v) =>
                (JSON.parse(v.metrics!) as Snapshot[]).filter((s) => s.at !== "decision").length,
            ),
        );
        const due = SNAPSHOT_HOURS.filter((h) => h < e.decide_after_hours && age >= h).length;
        if (due > taken) await this.snapshot(e, `${SNAPSHOT_HOURS[due - 1]}h`);
      } catch (err) {
        const y = err instanceof IgError ? err : null;
        log.warn("A/B test tick failed", { test: e.id, error: String(err) });
        if (y && y.code === "not_connected") this.fail(e.id, y.message);
      }
    }
  }
}

/** Real Instagram media IDs are long numbers; anything else ("unknown", "") cannot be measured. */
export function isMediaId(id: string | null | undefined): boolean {
  return typeof id === "string" && /^\d{5,}$/.test(id);
}

function missingSummary(vs: VariantRow[]): string {
  return vs
    .filter((v) => v.missing_reason)
    .map((v) => `${v.label}: ${v.missing_reason}`)
    .join(" ");
}
