import type { Db } from "./db.js";
import { newId } from "./crypto.js";
import { log } from "./log.js";

const LEASE_KEY = "scheduler_lease";
const LEASE_MS = 3 * 60_000;
const EVERY_MS = 5 * 60_000;

export interface PeriodicTask {
  name: string;
  /** `renew` re-takes the lease; returns false if another process took over (stop then). */
  run(renew: () => boolean): Promise<void>;
  /** Minimum gap between runs (default: every tick, 5 minutes). */
  everyMs?: number;
}

/**
 * Background work that is not tied to a tool call (A/B decisions, token refresh, media cleanup). Several
 * processes may share one data folder (Claude Desktop, Claude Code, Hermes, the `daemon` service): a lease
 * in the database makes sure only one of them acts at a time. Publishing jobs have their own per-job leases.
 */
export class Scheduler {
  private readonly owner = `${process.pid}-${newId()}`;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly tasks: PeriodicTask[],
  ) {}

  start(keepAlive = false) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    if (!keepAlive) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.busy) return; // the running tick keeps its lease until it expires
    try {
      this.db.run(
        "delete from settings where key = ? and value like ?",
        LEASE_KEY,
        `${this.owner}|%`,
      );
    } catch {
      /* database already closed */
    }
  }

  /** Take or renew the lease; true when this process may run the tick. */
  private acquire(): boolean {
    return this.db.tx(() => {
      const cur = this.db.setting(LEASE_KEY);
      const [owner, until] = (cur ?? "|0").split("|");
      if (cur && owner !== this.owner && Number(until) > Date.now()) return false;
      this.db.setSetting(LEASE_KEY, `${this.owner}|${Date.now() + LEASE_MS}`);
      return true;
    });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.acquire()) return;
      for (const t of this.tasks) {
        const key = `scheduler_last:${t.name}`;
        const last = Number(this.db.setting(key) ?? 0);
        if (t.everyMs && Date.now() - last < t.everyMs) continue;
        if (!this.acquire()) return;
        try {
          await t.run(() => this.acquire());
          this.db.setSetting(key, String(Date.now()));
        } catch (e) {
          log.warn("scheduled task failed", { task: t.name, error: String(e) });
        }
      }
    } catch (e) {
      log.warn("scheduler tick failed", { error: String(e) });
    } finally {
      this.busy = false;
    }
  }
}
