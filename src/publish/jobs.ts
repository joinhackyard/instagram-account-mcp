import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountRow, Accounts } from "../accounts.js";
import type { Config } from "../config.js";
import { newId } from "../crypto.js";
import type { Db } from "../db.js";
import { classifyMetaError, IgError, type ErrorCode } from "../errors.js";
import { log } from "../log.js";
import type { MediaHosts } from "../media/hosts/index.js";
import { contentTypeFor, prepareMedia, SPECS } from "../media/prepare.js";
import type { Graph } from "../meta/graph.js";
import { applyCaptionTemplate, checkCaption, type TemplateStore } from "../templates.js";
import {
  containerParams,
  containerStatus,
  createContainer,
  publishContainer,
  publishingLimit,
  readPublished,
  waitFinished,
  type ContainerRole,
} from "./containers.js";
import { ruploadFile, uploadedBytes } from "./resumable.js";
import { downloadUrl, expandPath, extensionFor, inspectLocalFile } from "./sources.js";
import {
  type ItemSpec,
  type ItemState,
  type JobRow,
  type JobStatus,
  type JobView,
  type MediaSource,
  type PostSpec,
  type ProgressEvent,
} from "./types.js";

const LEASE_MS = 90_000;
/** Scheduled posts start preparing this long before publish_at, so containers are ready on time. */
export const LEAD_MS = 15 * 60_000;
/** Videos take longer (download, convert, upload, Meta processing). */
export const VIDEO_LEAD_MS = 35 * 60_000;
/** A scheduled post picked up this long after its time (computer was off) is not published silently. */
export const MISSED_AFTER_MS = 2 * 3_600_000;

let settleDelayMs = 10_000;
/** Tests shorten the wait between status checks after an unclear media_publish failure. */
export function setSettleDelayForTests(ms?: number) {
  settleDelayMs = ms ?? 10_000;
}

export function leadFor(spec: PostSpec): number {
  return spec.items.some((i) => i.type === "video") ? VIDEO_LEAD_MS : LEAD_MS;
}
/** SQL twin of leadFor, evaluated on the stored spec JSON. */
const LEAD_SQL = `(case when spec like '%"type":"video"%' then ${VIDEO_LEAD_MS} else ${LEAD_MS} end)`;
const MAX_ATTEMPTS = 8;
const MAX_REHOSTS = 2;
const WINDOW_MS = 24 * 3_600_000;
const RUNNING: JobStatus[] = ["preparing", "uploading", "processing", "publishing"];
const PAUSED_CODES: ErrorCode[] = ["auth_expired", "not_connected"];

/** Progress persisted in jobs.items. */
export interface JobState {
  items: ItemState[];
  cover?: ItemState;
  warnings: string[];
  actions: string[];
  rehosts: number;
  /** Set right before media_publish; cleared only once the container is confirmed not published. */
  publish_attempted_at?: number;
  /** Confirmed published (even when Instagram did not say which media it became). */
  published_at?: number;
  first_comment?: { ok: boolean; id?: string; error?: string };
}

export function parseState(raw: string, spec: PostSpec): JobState {
  let s: Partial<JobState> = {};
  try {
    s = JSON.parse(raw) as Partial<JobState>;
  } catch {
    /* fresh */
  }
  return {
    items: s.items ?? spec.items.map(() => ({ status: "pending" })),
    cover: s.cover,
    warnings: s.warnings ?? [],
    actions: s.actions ?? [],
    rehosts: s.rehosts ?? 0,
    publish_attempted_at: s.publish_attempted_at,
    published_at: s.published_at,
    first_comment: s.first_comment,
  };
}

const bad = (m: string, hint?: string) => new IgError("invalid_request", m, { hint });

function checkSource(s: MediaSource | undefined, what: string) {
  if (!s || !s.file_path === !s.url) throw bad(`${what}: give exactly one of file_path or url.`);
  if (s.url && !/^https?:\/\//i.test(s.url)) throw bad(`${what}: url must be http(s).`);
}

/** Everything Instagram would reject about a post, checked before anything is queued. */
export function validateSpec(spec: PostSpec): void {
  const n = spec.items?.length ?? 0;
  if (spec.kind === "carousel") {
    if (n < SPECS.carousel.min || n > SPECS.carousel.max)
      throw bad(
        `A carousel needs ${SPECS.carousel.min} to ${SPECS.carousel.max} items (got ${n}).`,
      );
  } else if (n !== 1) throw bad(`A ${spec.kind} has exactly one image or video (got ${n}).`);
  spec.items.forEach((it, i) => {
    const what = spec.kind === "carousel" ? `Item ${i + 1}` : "Media";
    checkSource(it.source, what);
    if (spec.kind === "photo" && it.type !== "image")
      throw bad("A photo post needs an image. Use publish_reel for videos.");
    if (spec.kind === "reel" && it.type !== "video") throw bad("A reel needs a video.");
    if (it.alt_text !== undefined) {
      if (it.type !== "image" || spec.kind === "story")
        throw bad(`${what}: alt text is only supported on feed and carousel images.`);
      if ([...it.alt_text].length > SPECS.altText.maxChars)
        throw bad(`${what}: alt text is limited to ${SPECS.altText.maxChars} characters.`);
    }
    if (it.user_tags?.length) {
      if (it.user_tags.length > 20) throw bad(`${what}: at most 20 user tags.`);
      for (const t of it.user_tags) {
        if (!/^@?[\w.]{1,30}$/.test(t.username)) throw bad(`"${t.username}" is not a username.`);
        for (const v of [t.x, t.y])
          if (v !== undefined && (v < 0 || v > 1))
            throw bad("User tag x and y are fractions from 0 to 1 (0,0 = top left).");
      }
    }
  });
  if (spec.kind === "story") {
    if (spec.caption?.trim()) throw bad("Stories have no caption.");
    if (spec.collaborators?.length) throw bad("Stories can't have collaborators.");
    if (spec.first_comment) throw bad("Stories can't have comments.");
    if (spec.location_id) throw bad("Stories published through the API can't have a location.");
  }
  if (spec.caption) {
    const p = checkCaption(spec.caption);
    if (p.length) throw bad(p.join(" "));
  }
  if (spec.first_comment && [...spec.first_comment].length > SPECS.caption.maxChars)
    throw bad("The first comment is limited to 2,200 characters.");
  if (spec.collaborators && spec.collaborators.length > 3) throw bad("At most 3 collaborators.");
  for (const c of spec.collaborators ?? [])
    if (!/^@?[\w.]{1,30}$/.test(c)) throw bad(`"${c}" is not a username.`);
  if (spec.kind !== "reel") {
    if (spec.trial) throw bad("Only reels can be trial reels.");
    if (
      spec.cover ||
      spec.thumb_offset_ms !== undefined ||
      spec.audio_name ||
      spec.share_to_feed !== undefined
    )
      throw bad("cover, thumb_offset_ms, audio_name and share_to_feed are reel options.");
  }
  if (spec.cover) checkSource(spec.cover, "Cover");
  if (spec.thumb_offset_ms !== undefined && spec.thumb_offset_ms < 0)
    throw bad("thumb_offset_ms must be 0 or more.");
  if (spec.trial && !["MANUAL", "SS_PERFORMANCE"].includes(spec.trial.graduation))
    throw bad("Trial graduation must be MANUAL or SS_PERFORMANCE.");
}

const isNotConfigured = (e: unknown) => e instanceof IgError && e.code === "not_configured";

/**
 * Persistent publishing queue. Jobs live in SQLite, so a post survives the AI app closing: the next process
 * (any MCP client, or the background service) continues from the last finished step. Per-job leases make it
 * safe for several processes to share one data folder; nothing is ever published twice on purpose.
 */
export class JobManager {
  private readonly owner = `${process.pid}-${newId()}`;
  private readonly running = new Map<string, AbortController>();
  private readonly events = new EventEmitter();
  private readonly bytes = new Map<string, { sent: number; total: number }>();
  private timer?: NodeJS.Timeout;
  private stopped = true;
  onPublished?: (job: JobRow) => void | Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly accounts: Accounts,
    private readonly hosts: MediaHosts,
    private readonly templates: TemplateStore,
    private readonly concurrency = 2,
  ) {
    this.events.setMaxListeners(200);
  }

  start() {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => {
      this.heartbeat();
      this.tick();
    }, 5_000);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.running.values()) c.abort();
  }

  // ---------------------------------------------------------------- queue API

  enqueue(
    accountRowId: string,
    input: PostSpec,
    opts: { publishAt?: number; experimentId?: string } = {},
  ): JobRow {
    const row = this.accounts.byRowId(accountRowId);
    if (!row) throw new IgError("not_connected", "That account is not connected.");
    const spec: PostSpec = {
      ...input,
      items: input.items.map((it) => ({
        ...it,
        source: it.source.file_path
          ? { file_path: expandPath(it.source.file_path) }
          : { url: it.source.url },
      })),
      cover: input.cover?.file_path
        ? { file_path: expandPath(input.cover.file_path) }
        : input.cover,
    };
    const warnings: string[] = [];
    if (spec.template && spec.kind !== "story") {
      const t = this.templates.get(spec.template);
      const r = applyCaptionTemplate(spec.caption ?? "", t);
      spec.caption = r.caption || undefined;
      spec.first_comment ??= r.first_comment;
      spec.collaborators ??= t.collaborators;
      spec.location_id ??= t.location_id;
      spec.is_ai_generated ??= t.is_ai_generated;
      warnings.push(...r.warnings);
    }
    validateSpec(spec);
    const id = `pub_${newId()}`;
    const t = Date.now();
    const status: JobStatus =
      opts.publishAt && opts.publishAt - t > leadFor(spec) ? "scheduled" : "queued";
    const state: JobState = {
      items: spec.items.map(() => ({ status: "pending" })),
      warnings,
      actions: [],
      rehosts: 0,
    };
    this.db.run(
      `insert into jobs(id, account_row_id, kind, status, spec, items, publish_at, experiment_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      accountRowId,
      spec.kind,
      status,
      JSON.stringify(spec),
      JSON.stringify(state),
      opts.publishAt ?? null,
      opts.experimentId ?? null,
      t,
      t,
    );
    this.db.audit(
      "publish.queued",
      { job: id, kind: spec.kind, publish_at: opts.publishAt ?? null, items: spec.items.length },
      row.ig_user_id,
    );
    if (!this.stopped) setImmediate(() => this.tick());
    return this.get(id)!;
  }

  get(id: string): JobRow | undefined {
    return this.db.get<JobRow>("select * from jobs where id = ?", id);
  }

  private mustGet(id: string): JobRow {
    const j = this.get(id);
    if (!j)
      throw new IgError("not_found", `No publishing job ${id}.`, {
        hint: "list_scheduled shows recent jobs.",
      });
    return j;
  }

  list(opts: { status?: JobStatus[]; limit?: number; accountRowId?: string } = {}): JobRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status?.length) {
      where.push(`status in (${opts.status.map(() => "?").join(",")})`);
      params.push(...opts.status);
    }
    if (opts.accountRowId) {
      where.push("account_row_id = ?");
      params.push(opts.accountRowId);
    }
    return this.db.all<JobRow>(
      `select * from jobs ${where.length ? `where ${where.join(" and ")}` : ""}
       order by coalesce(publish_at, created_at) desc limit ?`,
      ...params,
      opts.limit ?? 50,
    );
  }

  view(j: JobRow): JobView {
    const spec = JSON.parse(j.spec) as PostSpec;
    const st = parseState(j.items, spec);
    const acct = this.accounts.byRowId(j.account_row_id);
    const b = this.bytes.get(j.id);
    const result = j.result ? (JSON.parse(j.result) as unknown) : undefined;
    return {
      job_id: j.id,
      account: acct?.username ? `@${acct.username}` : j.account_row_id,
      kind: j.kind,
      trial_reel: spec.trial?.graduation,
      status: j.status,
      publish_at: j.publish_at ? new Date(j.publish_at).toISOString() : undefined,
      caption: spec.caption ? truncate(spec.caption, 160) : undefined,
      items: spec.items.map((it, i) => {
        const s = st.items[i] ?? { status: "pending" as const };
        return {
          type: it.type,
          status: s.status,
          source: it.source.file_path ?? it.source.url ?? "",
          error: s.error,
          progress:
            s.status === "uploading" && s.size
              ? `${Math.min(100, Math.round(((b?.sent ?? s.bytes_sent ?? 0) / s.size) * 100))}%`
              : undefined,
        };
      }),
      media_id: j.media_id ?? undefined,
      permalink: j.permalink ?? undefined,
      error: j.error ?? undefined,
      error_code: j.error_code ?? undefined,
      next_attempt_at: j.next_attempt_at ? new Date(j.next_attempt_at).toISOString() : undefined,
      attempts: j.attempts,
      experiment_id: j.experiment_id ?? undefined,
      warnings: st.warnings.length ? st.warnings : undefined,
      created_at: new Date(j.created_at).toISOString(),
      finished_at: j.finished_at ? new Date(j.finished_at).toISOString() : undefined,
      result,
    };
  }

  /** Throws when cancelling would be refused (so tools can check before asking the user). */
  assertCancellable(job: JobRow) {
    if (job.status === "published")
      throw new IgError("invalid_request", "This post is already published.", {
        hint: "delete_media removes it (Facebook Login accounts only), or delete it in the Instagram app.",
      });
    const st = parseState(job.items, JSON.parse(job.spec) as PostSpec);
    if (job.status === "publishing" || st.publish_attempted_at || st.published_at)
      throw new IgError(
        "invalid_request",
        "This post is being published (or may already be live), so it can't be cancelled.",
        { hint: "Check get_publish_status in a minute; delete it in the Instagram app if needed." },
      );
  }

  cancel(id: string): JobRow {
    const job = this.mustGet(id);
    if (job.status === "cancelled" || job.status === "failed") return job;
    this.assertCancellable(job);
    this.running.get(id)?.abort();
    this.db.run(
      "update jobs set status = 'cancelled', lease_owner = null, finished_at = ?, updated_at = ? where id = ?",
      Date.now(),
      Date.now(),
      id,
    );
    this.db.audit("publish.cancelled", { job: id });
    void this.finishCleanup(id);
    this.emitProgress(id);
    return this.get(id)!;
  }

  assertResumable(job: JobRow) {
    if (job.status === "published")
      throw new IgError("invalid_request", "This post is already published.");
    if (RUNNING.includes(job.status) && job.lease_until && job.lease_until > Date.now())
      throw new IgError("invalid_request", `The job is ${job.status} right now.`, {
        hint: "Follow it with get_publish_status.",
      });
    if (job.status === "scheduled" || job.status === "ready")
      throw new IgError("invalid_request", `The post is ${job.status}; nothing to resume.`);
  }

  /**
   * Retry a failed, cancelled, paused or limit-waiting job. A missed schedule publishes now. If a publish
   * may already have happened, containers are kept so the next run can check and adopt it.
   */
  resume(id: string): JobRow {
    const job = this.mustGet(id);
    this.assertResumable(job);
    const spec = JSON.parse(job.spec) as PostSpec;
    const st = parseState(job.items, spec);
    let containerId = job.container_id;
    if (
      !st.publish_attempted_at &&
      (job.error_code === "media_error" || job.error_code === "media_unreachable")
    ) {
      // Release first (resetContainers forgets the hosted ids).
      for (const h of [...st.items, st.cover]) void this.hosts.release(h?.hosted_id);
      resetContainers(st, true);
      containerId = null;
    }
    const publishAt = job.error_code === "missed_schedule" ? null : job.publish_at;
    const status: JobStatus =
      publishAt && publishAt - Date.now() > leadFor(spec) ? "scheduled" : "queued";
    this.db.run(
      `update jobs set status = ?, error = null, error_code = null, attempts = 0, next_attempt_at = null,
         lease_owner = null, finished_at = null, container_id = ?, items = ?, publish_at = ?, updated_at = ? where id = ?`,
      status,
      containerId,
      JSON.stringify(st),
      publishAt,
      Date.now(),
      id,
    );
    if (!this.stopped) setImmediate(() => this.tick());
    return this.get(id)!;
  }

  assertReschedulable(job: JobRow) {
    const missed = job.status === "failed" && job.error_code === "missed_schedule";
    if (
      !missed &&
      !["scheduled", "ready", "queued", "waiting_limit", ...RUNNING].includes(job.status)
    )
      throw new IgError("invalid_request", `A ${job.status} post can't be rescheduled.`);
    const st = parseState(job.items, JSON.parse(job.spec) as PostSpec);
    if (job.status === "publishing" || st.publish_attempted_at)
      throw new IgError("invalid_request", "It is being published right now.");
  }

  reschedule(id: string, publishAt: number): JobRow {
    const job = this.mustGet(id);
    this.assertReschedulable(job);
    const spec = JSON.parse(job.spec) as PostSpec;
    const far = publishAt - Date.now() > leadFor(spec);
    // ready keeps its finished containers (re-checked before publishing); others restart the countdown.
    const missed = job.status === "failed";
    const status: JobStatus =
      job.status === "ready"
        ? "ready"
        : far
          ? "scheduled"
          : job.status === "scheduled" || missed
            ? "queued"
            : job.status;
    if (far && RUNNING.includes(job.status)) this.running.get(id)?.abort();
    this.db.run(
      `update jobs set publish_at = ?, status = ?, lease_owner = case when ? in ('scheduled', 'ready') then null else lease_owner end,
         error = case when ? then null else error end, error_code = case when ? then null else error_code end,
         finished_at = case when ? then null else finished_at end, updated_at = ? where id = ?`,
      publishAt,
      status,
      status,
      missed ? 1 : 0,
      missed ? 1 : 0,
      missed ? 1 : 0,
      Date.now(),
      id,
    );
    this.db.audit("publish.rescheduled", { job: id, publish_at: publishAt });
    if (!this.stopped) setImmediate(() => this.tick());
    return this.get(id)!;
  }

  /** After an account reconnects, continue its posts that paused on the expired sign-in. */
  requeueForAccount(rowId: string): number {
    const n = this.db.run(
      `update jobs set error = null, error_code = null, next_attempt_at = null, updated_at = ?
       where account_row_id = ? and status = 'queued' and error_code in ('auth_expired', 'not_connected')`,
      Date.now(),
      rowId,
    ).changes;
    if (n && !this.stopped) setImmediate(() => this.tick());
    return n;
  }

  subscribe(jobId: string, fn: (e: ProgressEvent) => void): () => void {
    const key = `progress:${jobId}`;
    this.events.on(key, fn);
    return () => this.events.off(key, fn);
  }

  /** Is the job done moving for now (finished, waiting for a time, or paused)? */
  static settled(j: JobRow): boolean {
    return (
      ["published", "failed", "cancelled", "scheduled", "ready", "waiting_limit"].includes(
        j.status,
      ) ||
      (j.status === "queued" && PAUSED_CODES.includes(j.error_code as ErrorCode))
    );
  }

  /** Resolve when the job settles or after `ms`, reporting progress meanwhile. */
  async waitFor(id: string, ms: number, onProgress?: (e: ProgressEvent) => void): Promise<JobRow> {
    const first = this.mustGet(id);
    if (ms <= 0 || JobManager.settled(first)) return first;
    return new Promise((resolve) => {
      let unsub = () => {};
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        unsub();
        resolve(this.mustGet(id));
      };
      unsub = this.subscribe(id, (e) => {
        onProgress?.(e);
        if (
          ["published", "failed", "cancelled", "scheduled", "ready", "waiting_limit"].includes(
            e.status,
          )
        )
          done();
      });
      // Another process may own the job: watch the database too.
      const poll = setInterval(() => {
        const j = this.get(id);
        if (!j || JobManager.settled(j)) done();
      }, 2_000);
      const timer = setTimeout(done, ms);
    });
  }

  /** How many API posts are left in Instagram's rolling window. */
  async budget(row: AccountRow): Promise<{
    used: number;
    total: number;
    window_hours: number;
    remaining: number;
    source: "api" | "local";
  }> {
    try {
      const l = await publishingLimit(this.accounts.client(row), row.ig_user_id);
      return { ...l, remaining: Math.max(0, l.total - l.used), source: "api" };
    } catch (e) {
      if (e instanceof IgError && e.code === "auth_expired") throw e;
      const used =
        this.db.get<{ n: number }>(
          "select count(*) as n from publish_log where account_row_id = ? and at > ?",
          row.id,
          Date.now() - WINDOW_MS,
        )?.n ?? 0;
      const total = this.cfg.publishLimit;
      return {
        used,
        total,
        window_hours: 24,
        remaining: Math.max(0, total - used),
        source: "local",
      };
    }
  }

  // ---------------------------------------------------------------- worker

  private emitProgress(id: string, message?: string) {
    const j = this.get(id);
    if (!j) return;
    const b = this.bytes.get(id);
    let sent = b?.sent ?? 0;
    let total = b?.total ?? 0;
    if (!b) {
      const spec = JSON.parse(j.spec) as PostSpec;
      const st = parseState(j.items, spec);
      total = st.items.length;
      sent = st.items.filter((i) => i.status === "ready").length;
    }
    this.events.emit(`progress:${id}`, {
      jobId: id,
      status: j.status,
      sent,
      total,
      message,
    } satisfies ProgressEvent);
  }

  /** Renew leases; stop local runs whose lease was taken over or whose job was cancelled elsewhere. */
  private heartbeat() {
    for (const [id, ctl] of this.running) {
      const n = this.db.run(
        `update jobs set lease_until = ? where id = ? and lease_owner = ? and status in (${RUNNING.map(() => "?").join(",")})`,
        Date.now() + LEASE_MS,
        id,
        this.owner,
        ...RUNNING,
      ).changes;
      if (n === 0 && !ctl.signal.aborted) {
        log.warn("publish lease lost or job changed elsewhere; stopping local run", { job: id });
        ctl.abort();
      }
    }
  }

  private claim(): JobRow | undefined {
    const missed: string[] = [];
    const out = this.db.tx(() => {
      for (let i = 0; i < 50; i++) {
        const t = Date.now();
        const row = this.db.get<JobRow>(
          `select * from jobs where
              (status = 'scheduled' and publish_at - ${LEAD_SQL} <= ?)
           or (status = 'ready' and publish_at <= ?)
           or (status in ('queued', 'waiting_limit') and coalesce(next_attempt_at, 0) <= ?
               and coalesce(error_code, '') not in ('auth_expired', 'not_connected'))
           or (status in (${RUNNING.map(() => "?").join(",")}) and (lease_until is null or lease_until < ?))
           order by coalesce(publish_at, created_at) limit 1`,
          t,
          t,
          t,
          ...RUNNING,
          t,
        );
        if (!row) return undefined;
        // The computer was off at the scheduled time: don't publish hours late without asking.
        if (
          (row.status === "scheduled" || row.status === "ready") &&
          row.publish_at &&
          t - row.publish_at > MISSED_AFTER_MS
        ) {
          this.db.run(
            `update jobs set status = 'failed', error_code = 'missed_schedule', error = ?, finished_at = ?,
               lease_owner = null, updated_at = ? where id = ?`,
            `Missed the scheduled time ${new Date(row.publish_at).toISOString()} (this computer was off or offline), so it was not published late. Use reschedule for a new time, or resume_publish to publish it now.`,
            t,
            t,
            row.id,
          );
          missed.push(row.id);
          continue;
        }
        this.db.run(
          `update jobs set lease_owner = ?, lease_until = ?, updated_at = ?,
             status = case when status in ('scheduled', 'queued', 'waiting_limit', 'ready') then 'preparing' else status end
           where id = ?`,
          this.owner,
          t + LEASE_MS,
          t,
          row.id,
        );
        return this.get(row.id);
      }
      return undefined;
    });
    for (const id of missed) {
      this.db.audit("publish.missed_schedule", { job: id });
      void this.finishCleanup(id);
      this.emitProgress(id);
    }
    return out;
  }

  private tick() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency) {
      let job: JobRow | undefined;
      try {
        job = this.claim();
      } catch (e) {
        log.warn("job claim failed", { error: String(e) });
        return;
      }
      if (!job) return;
      const ctl = new AbortController();
      const id = job.id;
      this.running.set(id, ctl);
      void this.run(job, ctl.signal).finally(() => {
        this.running.delete(id);
        this.bytes.delete(id);
        if (!this.stopped) setImmediate(() => this.tick());
      });
    }
  }

  /** Update fields only while this process holds the lease. */
  private update(id: string, fields: Partial<Record<keyof JobRow, string | number | null>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const n = this.db.run(
      `update jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ? and lease_owner = ?`,
      ...keys.map((k) => fields[k as keyof JobRow] as string | number | null),
      Date.now(),
      id,
      this.owner,
    ).changes;
    if (n === 0) this.running.get(id)?.abort();
    this.emitProgress(id);
  }

  private assertOwned(id: string, signal: AbortSignal) {
    const j = this.get(id);
    if (signal.aborted || !j || j.lease_owner !== this.owner || !RUNNING.includes(j.status)) {
      this.running.get(id)?.abort();
      throw new IgError("cancelled", "This process no longer owns the job.");
    }
  }

  private async run(job: JobRow, signal: AbortSignal) {
    const spec = JSON.parse(job.spec) as PostSpec;
    const st = parseState(job.items, spec);
    const save = () => this.update(job.id, { items: JSON.stringify(st) });
    const work = join(this.cfg.home, "work", job.id);
    try {
      const row = this.accounts.byRowId(job.account_row_id);
      if (!row)
        throw new IgError("not_connected", "The account for this post is no longer connected.", {
          hint: "Reconnect it with connect_account; the post continues afterwards.",
        });
      if (row.status === "needs_reconnect")
        throw new IgError("auth_expired", `The sign-in for @${row.username} expired.`, {
          hint: "Call connect_account; the post continues on its own afterwards.",
        });
      const graph = this.accounts.client(row);
      const ig = row.ig_user_id;
      let mediaId = job.media_id ?? undefined;
      let containerId = job.container_id ?? undefined;
      let published = Boolean(mediaId || st.published_at);

      // A previous run called media_publish and did not see the answer: find out what happened first.
      if (!published && st.publish_attempted_at) {
        if (!containerId) st.publish_attempted_at = undefined;
        else {
          const r = await this.resolveAttempt(graph, ig, spec, st, containerId);
          if (r.published) {
            published = true;
            mediaId = r.mediaId;
            this.recordPublished(job.id, row, spec, mediaId, st);
          } else if (r.known) {
            st.publish_attempted_at = undefined;
            save();
          } else
            throw new IgError("network", "Could not check whether the last publish went through.", {
              retryable: true,
            });
        }
      }

      if (!published) {
        // 1. Prepare every item (download, inspect, convert).
        this.update(job.id, { status: "preparing" });
        for (let i = 0; i < spec.items.length; i++) {
          await this.prepareItem(st, i, spec, work, signal);
          save();
        }
        // 2. Upload / host, and create item containers.
        this.update(job.id, { status: "uploading" });
        const role: ContainerRole = spec.kind === "carousel" ? "child" : "single";
        for (let i = 0; i < spec.items.length; i++) {
          await this.deliver(graph, row, spec, st, i, role, work, job.id, save, signal);
          save();
        }
        // 3. Wait until Meta has fetched and processed everything.
        this.update(job.id, { status: "processing" });
        for (const [i, it] of st.items.entries()) {
          if (it.status === "ready") continue;
          await waitFinished(graph, it.container_id!, {
            timeoutMs: spec.items[i].type === "video" ? 30 * 60_000 : 10 * 60_000,
            signal,
          });
          it.status = "ready";
          save();
        }
        if (spec.kind === "carousel") {
          if (!containerId) {
            const parent = await createContainer(
              graph,
              ig,
              containerParams(spec, "parent", null, {
                children: st.items.map((i) => i.container_id!),
              }),
            );
            containerId = parent.id;
            this.update(job.id, { container_id: containerId });
          }
        } else if (!containerId) {
          containerId = st.items[0].container_id!;
          this.update(job.id, { container_id: containerId });
        }
        // Media fetched: hosted copies are no longer needed.
        for (const h of [...st.items, st.cover]) await this.hosts.release(h?.hosted_id);

        // 4. Not due yet: park the job without holding a worker; it is claimed again at publish_at.
        const due = this.get(job.id)?.publish_at;
        if (due && due > Date.now() + 5_000) {
          this.update(job.id, { status: "ready", lease_owner: null, items: JSON.stringify(st) });
          return;
        }

        // 5. Right before publishing, the container must still be FINISHED (they expire after 24 h,
        // e.g. after waiting for the publishing limit or a reschedule).
        const cs = await waitFinished(graph, containerId, { timeoutMs: 10 * 60_000, signal });
        if (cs === "PUBLISHED") {
          // Published by an earlier attempt we lost track of: adopt it, never publish again.
          published = true;
          mediaId = await this.findRecent(graph, ig, spec, job.created_at);
          this.recordPublished(job.id, row, spec, mediaId, st);
        }
      }

      if (!published) {
        // 6. Publishing limit.
        const b = await this.budget(row);
        if (b.remaining <= 0)
          throw new IgError(
            "publish_limit_reached",
            `Instagram's publishing limit is reached (${b.used}/${b.total} in ${b.window_hours} hours).`,
            { hint: "The post waits and publishes automatically when the window frees up." },
          );

        // 7. Publish exactly once; an unclear failure is resolved by asking for the container status.
        this.assertOwned(job.id, signal);
        this.update(job.id, { status: "publishing" });
        st.publish_attempted_at = Date.now();
        save();
        try {
          mediaId = await publishContainer(graph, ig, containerId!);
        } catch (e) {
          const r = await this.resolveAttempt(graph, ig, spec, st, containerId!, true);
          if (!r.published) {
            if (r.known) {
              st.publish_attempted_at = undefined;
              save();
            }
            throw e;
          }
          mediaId = r.mediaId;
        }
        published = true;
        this.recordPublished(job.id, row, spec, mediaId, st);
      }

      // 8. After publishing.
      let info: { permalink?: string; media_product_type?: string } = {};
      if (mediaId) info = await readPublished(graph, mediaId).catch(() => ({}));
      else if (!st.warnings.some((w) => w.startsWith("Published, but")))
        st.warnings.push(
          "Published, but Instagram did not say which post it became. Check the profile.",
        );
      if (spec.first_comment && mediaId && !st.first_comment?.ok) {
        try {
          const c = await graph.post<{ id?: string }>(`${mediaId}/comments`, {
            message: spec.first_comment,
          });
          st.first_comment = { ok: true, id: c.id };
        } catch (e) {
          const y = classifyMetaError(e);
          st.first_comment = { ok: false, error: y.message };
          st.warnings.push(`The first comment was not posted: ${y.message}`);
        }
        save();
      }
      const permalink = info.permalink ?? null;
      this.update(job.id, {
        status: "published",
        media_id: mediaId ?? null,
        permalink,
        finished_at: Date.now(),
        error: null,
        error_code: null,
        next_attempt_at: null,
        lease_owner: null,
        items: JSON.stringify(st),
        result: JSON.stringify({
          media_id: mediaId ?? null,
          permalink: permalink ?? undefined,
          media_product_type: info.media_product_type,
          first_comment: st.first_comment,
          warnings: st.warnings,
          actions: st.actions,
        }),
      });
      log.info("published", { job: job.id, media: mediaId });
      await this.finishCleanup(job.id, st);
      const done = this.get(job.id);
      if (done && this.onPublished)
        await Promise.resolve(this.onPublished(done)).catch((e) =>
          log.warn("after-publish hook failed", { job: job.id, error: String(e) }),
        );
    } catch (err) {
      await this.handleError(job, st, err, signal);
    }
  }

  /** Persist "it is live": state first (survives a crash), then media id, log and audit. */
  private recordPublished(
    jobId: string,
    row: AccountRow,
    spec: PostSpec,
    mediaId: string | undefined,
    st: JobState,
  ) {
    st.published_at ??= Date.now();
    this.update(jobId, { items: JSON.stringify(st), media_id: mediaId ?? null });
    this.db.run(
      "insert into publish_log(account_row_id, media_id, at) values (?, ?, ?)",
      row.id,
      mediaId ?? null,
      Date.now(),
    );
    this.db.audit("publish.published", { job: jobId, kind: spec.kind }, row.ig_user_id, mediaId);
  }

  /**
   * Did an earlier media_publish go through? known=false when the status itself could not be read
   * (then nothing may be reset). `settle` waits and re-checks, since Meta may update the status late.
   */
  private async resolveAttempt(
    graph: Graph,
    ig: string,
    spec: PostSpec,
    st: JobState,
    containerId: string,
    settle = false,
  ): Promise<{ published: boolean; known: boolean; mediaId?: string }> {
    const since = st.publish_attempted_at ?? Date.now();
    for (let i = 0; i < (settle ? 3 : 1); i++) {
      if (i) await new Promise((r) => setTimeout(r, settleDelayMs * i));
      const s = await containerStatus(graph, containerId).catch(() => null);
      if (!s) return { published: false, known: false };
      if (s.status_code === "PUBLISHED")
        return {
          published: true,
          known: true,
          mediaId: await this.findRecent(graph, ig, spec, since),
        };
    }
    return { published: false, known: true };
  }

  private async handleError(job: JobRow, st: JobState, err: unknown, signal: AbortSignal) {
    const e = err instanceof IgError ? err : classifyMetaError(err, "publish");
    if (e.code === "cancelled" || signal.aborted) return;
    const cur = this.get(job.id);
    if (!cur || cur.lease_owner !== this.owner) return;
    const msg = e.hint ? `${e.message} ${e.hint}` : e.message;
    const t = Date.now();
    log.warn("publish step failed", { job: job.id, code: e.code, error: e.message });

    if (e.code === "publish_limit_reached") {
      this.update(job.id, {
        status: "waiting_limit",
        error: msg,
        error_code: e.code,
        next_attempt_at: this.limitRetryAt(cur.account_row_id),
        lease_owner: null,
      });
      return;
    }
    if (PAUSED_CODES.includes(e.code)) {
      this.update(job.id, {
        status: "queued",
        error: msg,
        error_code: e.code,
        next_attempt_at: null,
        lease_owner: null,
        items: JSON.stringify(st),
      });
      return;
    }
    // media_publish may have gone through: never reset or re-create anything. Retry; every run checks
    // the container first. After many tries, stop and ask the user to look at the profile.
    if (st.publish_attempted_at && !st.published_at) {
      if (cur.attempts + 1 < MAX_ATTEMPTS * 2) {
        this.update(job.id, {
          status: "queued",
          attempts: cur.attempts + 1,
          error: msg,
          error_code: e.code,
          next_attempt_at: t + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(cur.attempts, 7)),
          lease_owner: null,
          items: JSON.stringify(st),
        });
        return;
      }
      this.update(job.id, {
        status: "failed",
        error: `${msg} It is unclear whether Instagram published it: check the profile before retrying (resume_publish checks first and never publishes twice).`,
        error_code: e.code,
        finished_at: t,
        lease_owner: null,
        items: JSON.stringify(st),
      });
      return;
    }
    const expired = e.opts.reason === "expired";
    if ((e.code === "media_unreachable" || expired) && st.rehosts < MAX_REHOSTS) {
      st.rehosts++;
      for (const h of [...st.items, st.cover]) await this.hosts.release(h?.hosted_id);
      resetContainers(st, true);
      this.update(job.id, {
        status: "queued",
        container_id: null,
        items: JSON.stringify(st),
        error: msg,
        error_code: e.code,
        next_attempt_at: t + 5_000,
        lease_owner: null,
      });
      return;
    }
    if (e.retryable && cur.attempts + 1 < MAX_ATTEMPTS) {
      const wait = e.opts.retryAfterMs ?? Math.min(30 * 60_000, 30_000 * 2 ** cur.attempts);
      this.update(job.id, {
        status: "queued",
        attempts: cur.attempts + 1,
        error: msg,
        error_code: e.code,
        next_attempt_at: t + wait,
        lease_owner: null,
        items: JSON.stringify(st),
      });
      return;
    }
    this.update(job.id, {
      status: "failed",
      error: msg,
      error_code: e.code,
      finished_at: t,
      lease_owner: null,
      items: JSON.stringify(st),
    });
    this.db.audit("publish.failed", { job: job.id, code: e.code, error: e.message });
    await this.finishCleanup(job.id, st);
  }

  /** When the oldest post leaves the rolling 24-hour window (+1 minute), or in an hour. */
  private limitRetryAt(accountRowId: string): number {
    const oldest = this.db.get<{ at: number }>(
      "select min(at) as at from publish_log where account_row_id = ? and at > ?",
      accountRowId,
      Date.now() - WINDOW_MS,
    )?.at;
    return oldest
      ? Math.max(Date.now() + 60_000, oldest + WINDOW_MS + 60_000)
      : Date.now() + 3_600_000;
  }

  private async findRecent(
    graph: Graph,
    ig: string,
    spec: PostSpec,
    since: number,
  ): Promise<string | undefined> {
    try {
      const r = await graph.get<{ data?: { id: string; timestamp?: string }[] }>(
        `${ig}/${spec.kind === "story" ? "stories" : "media"}`,
        { fields: "id,timestamp", limit: 5 },
      );
      return r.data?.find((m) => m.timestamp && Date.parse(m.timestamp) >= since - 120_000)?.id;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- steps

  private async localCopy(
    src: MediaSource,
    name: string,
    work: string,
    temp: string[],
    signal: AbortSignal,
  ): Promise<string> {
    if (src.file_path) return (await inspectLocalFile(src.file_path, this.cfg.maxUploadBytes)).path;
    mkdirSync(work, { recursive: true });
    const tmp = join(work, `${name}.download`);
    const d = await downloadUrl(src.url!, tmp, this.cfg.maxUploadBytes, signal);
    const dest = join(work, `${name}${extensionFor(d.filename, d.contentType)}`);
    renameSync(tmp, dest);
    temp.push(dest);
    return dest;
  }

  private async prepareItem(
    st: JobState,
    idx: number,
    spec: PostSpec,
    work: string,
    signal: AbortSignal,
  ) {
    const it = st.items[idx];
    const item = spec.items[idx];
    // Released hosted copies are never reused.
    if (it.status !== "ready" && it.hosted_id && !this.hosts.stillServes(it.hosted_id)) {
      it.hosted_id = undefined;
      it.public_url = undefined;
      it.container_id = undefined;
      if (it.status !== "uploading") it.status = it.local_path ? "prepared" : "pending";
    }
    // The local copy is gone (e.g. the job was resumed after cleanup): start again from the source.
    if (
      it.status !== "ready" &&
      it.status !== "pending" &&
      it.local_path &&
      !existsSync(it.local_path)
    ) {
      forgetLocal(it);
      it.container_id = undefined;
      it.upload_uri = undefined;
      it.bytes_sent = 0;
      if (!it.public_url) it.status = "pending";
    }
    if (it.status !== "pending") return;
    const temp = (it.temp_paths ??= []);
    const label = spec.items.length > 1 ? `Item ${idx + 1}: ` : "";
    if (item.source.url && spec.prepare === false) {
      it.public_url = item.source.url;
      it.status = "prepared";
      return;
    }
    const local = await this.localCopy(item.source, `item-${idx + 1}`, work, temp, signal);
    let path = local;
    if (spec.prepare !== false) {
      try {
        const p = await prepareMedia(local, {
          kind: spec.kind,
          inCarousel: spec.kind === "carousel",
          fit: spec.fit,
          outDir: work,
        });
        if (p.info.kind !== item.type)
          throw bad(
            `${label}expected ${item.type === "image" ? "an image" : "a video"}, got ${p.info.kind === "image" ? "an image" : "a video"}.`,
          );
        if (p.converted) {
          temp.push(p.path);
          path = p.path;
          st.actions.push(`${label}${p.actions.join(", ")}`);
        } else if (item.source.url?.startsWith("https://")) it.public_url = item.source.url;
        for (const w of p.warnings) st.warnings.push(`${label}${w}`);
      } catch (e) {
        if (!isNotConfigured(e)) throw e;
        st.warnings.push(
          `${label}ffmpeg is not installed, so the file was sent as-is (Instagram checks it).`,
        );
        if (item.source.url?.startsWith("https://")) it.public_url = item.source.url;
      }
    }
    it.local_path = path;
    it.size = statSync(path).size;
    it.content_type = contentTypeFor(path);
    it.status = "prepared";
  }

  private async ensureCover(
    spec: PostSpec,
    st: JobState,
    work: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!spec.cover) return undefined;
    const c = (st.cover ??= { status: "pending" });
    if (c.public_url && (!c.hosted_id || this.hosts.stillServes(c.hosted_id))) return c.public_url;
    if (spec.cover.url && spec.prepare === false) {
      c.public_url = spec.cover.url;
      return c.public_url;
    }
    if (c.local_path && !existsSync(c.local_path)) forgetLocal(c);
    if (!c.local_path) {
      const temp = (c.temp_paths ??= []);
      const local = await this.localCopy(spec.cover, "cover", work, temp, signal);
      let path = local;
      try {
        const p = await prepareMedia(local, { kind: "story", outDir: work });
        if (p.info.kind !== "image") throw bad("The cover must be an image.");
        if (p.converted) {
          temp.push(p.path);
          path = p.path;
        }
      } catch (e) {
        if (!isNotConfigured(e)) throw e;
      }
      c.local_path = path;
      c.size = statSync(path).size;
      c.content_type = contentTypeFor(path);
    }
    const h = await this.hosts.put(
      c.local_path,
      c.content_type ?? "image/jpeg",
      "cover.jpg",
      jobId,
    );
    c.public_url = h.url;
    c.hosted_id = h.id;
    c.status = "hosted";
    return c.public_url;
  }

  private async deliver(
    graph: Graph,
    row: AccountRow,
    spec: PostSpec,
    st: JobState,
    idx: number,
    role: ContainerRole,
    work: string,
    jobId: string,
    save: () => void,
    signal: AbortSignal,
  ) {
    const it = st.items[idx];
    const item = spec.items[idx];
    if (it.status === "ready") return;
    // A hosted file this process can no longer serve (tunnel from a process that exited): host again.
    if (
      it.container_id &&
      it.hosted_id &&
      it.status !== "uploading" &&
      !this.hosts.stillServes(it.hosted_id)
    ) {
      await this.hosts.release(it.hosted_id);
      it.container_id = undefined;
      it.public_url = undefined;
      it.hosted_id = undefined;
      it.status = "prepared";
    }
    const isVideo = item.type === "video";
    if (it.container_id) {
      if (it.status === "uploading" && it.upload_uri) {
        const offset = await uploadedBytes(graph, it.container_id);
        await this.upload(row, it, jobId, offset, save, signal);
        it.status = "processing";
      }
      return;
    }
    const coverUrl =
      spec.kind === "reel" ? await this.ensureCover(spec, st, work, jobId, signal) : undefined;
    const resumable =
      row.auth_mode === "facebook" && isVideo && !it.public_url && Boolean(it.local_path);
    if (resumable) {
      const c = await createContainer(
        graph,
        row.ig_user_id,
        containerParams(spec, role, { resumable: true, isVideo }, { item, coverUrl }),
      );
      if (!c.uri)
        throw new IgError("server_error", "Meta returned no upload address for the video.", {
          retryable: true,
        });
      it.container_id = c.id;
      it.upload_uri = c.uri;
      it.bytes_sent = 0;
      it.status = "uploading";
      save();
      await this.upload(row, it, jobId, 0, save, signal);
      it.status = "processing";
      return;
    }
    if (!it.public_url) {
      if (!it.local_path) throw new IgError("file_error", "Nothing to upload for this item.");
      const ext =
        it.content_type === "image/jpeg"
          ? ".jpg"
          : it.content_type === "video/quicktime"
            ? ".mov"
            : isVideo
              ? ".mp4"
              : ".jpg";
      const h = await this.hosts.put(
        it.local_path,
        it.content_type ?? "application/octet-stream",
        `media-${idx + 1}${ext}`,
        jobId,
      );
      it.public_url = h.url;
      it.hosted_id = h.id;
      it.status = "hosted";
      save();
    }
    const c = await createContainer(
      graph,
      row.ig_user_id,
      containerParams(spec, role, { url: it.public_url, isVideo }, { item, coverUrl }),
    );
    it.container_id = c.id;
    it.status = "processing";
  }

  private async upload(
    row: AccountRow,
    it: ItemState,
    jobId: string,
    offset: number,
    save: () => void,
    signal: AbortSignal,
  ) {
    const size = it.size ?? statSync(it.local_path!).size;
    let last = 0;
    this.bytes.set(jobId, { sent: offset, total: size });
    await ruploadFile({
      uri: it.upload_uri!,
      token: await this.accounts.accessToken(row.id),
      filePath: it.local_path!,
      fileSize: size,
      contentType: it.content_type,
      offset,
      signal,
      onProgress: (sent) => {
        this.bytes.set(jobId, { sent, total: size });
        if (Date.now() - last > 1500 || sent === size) {
          last = Date.now();
          it.bytes_sent = sent;
          save();
        }
      },
    });
    it.bytes_sent = size;
    this.bytes.delete(jobId);
    save();
  }

  /** Release hosted media and delete the job's work folder. */
  private async finishCleanup(id: string, st?: JobState) {
    let state = st;
    if (!state) {
      const j = this.get(id);
      if (j) state = parseState(j.items, JSON.parse(j.spec) as PostSpec);
    }
    for (const h of [...(state?.items ?? []), state?.cover]) await this.hosts.release(h?.hosted_id);
    try {
      rmSync(join(this.cfg.home, "work", id), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

/** Forget containers (and, with rehost, hosted URLs) so the next run creates them again. */
export function resetContainers(st: JobState, rehost: boolean) {
  for (const it of [...st.items, ...(st.cover ? [st.cover] : [])]) {
    it.container_id = undefined;
    it.upload_uri = undefined;
    it.bytes_sent = 0;
    if (rehost && it.hosted_id) {
      it.hosted_id = undefined;
      it.public_url = undefined;
    } else if (rehost && it.public_url && it.local_path) it.public_url = undefined;
    if (it.local_path && !existsSync(it.local_path)) forgetLocal(it);
    it.status = it.local_path || it.public_url ? "prepared" : "pending";
    it.error = undefined;
  }
}

/** The local copy is gone (work folder cleaned): start this item again from its source. */
function forgetLocal(it: ItemState) {
  it.local_path = undefined;
  it.temp_paths = undefined;
  it.size = undefined;
  it.content_type = undefined;
  if (it.hosted_id) {
    it.hosted_id = undefined;
    it.public_url = undefined;
  }
}

function truncate(s: string, n: number) {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : s;
}
