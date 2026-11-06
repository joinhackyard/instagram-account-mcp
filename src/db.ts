import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, SQLInputValue>;

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  create table accounts(
    id text primary key,
    ig_user_id text not null unique,
    username text,
    name text,
    profile_picture_url text,
    account_type text,
    followers_count integer,
    auth_mode text not null,
    page_id text,
    page_name text,
    app_id text,
    scopes text,
    token_expires_at integer,
    status text not null default 'ok',
    status_detail text,
    is_default integer not null default 0,
    connected_at integer not null,
    refreshed_at integer
  );
  create table jobs(
    id text primary key,
    account_row_id text not null,
    kind text not null,
    status text not null,
    spec text not null,
    items text not null,
    container_id text,
    media_id text,
    permalink text,
    publish_at integer,
    error text,
    error_code text,
    attempts integer not null default 0,
    next_attempt_at integer,
    lease_owner text,
    lease_until integer,
    result text,
    experiment_id text,
    created_at integer not null,
    updated_at integer not null,
    finished_at integer
  );
  create index jobs_status on jobs(status, publish_at, created_at);
  create table publish_log(
    id integer primary key autoincrement,
    account_row_id text not null,
    media_id text,
    at integer not null
  );
  create index publish_log_account on publish_log(account_row_id, at);
  create table hosted_media(
    id text primary key,
    host text not null,
    key text not null,
    url text not null,
    job_id text,
    created_at integer not null,
    expires_at integer not null,
    removed_at integer
  );
  create index hosted_media_open on hosted_media(removed_at, expires_at);
  create table confirmations(
    token text primary key,
    action text not null,
    payload_hash text not null,
    summary text not null,
    created_at integer not null,
    expires_at integer not null
  );
  create table settings(key text primary key, value text not null);
  create table cache(key text primary key, value text not null, fetched_at integer not null);
  create table audit(
    id integer primary key autoincrement,
    at integer not null,
    action text not null,
    account_id text,
    media_id text,
    detail text
  );
  create table experiments(
    id text primary key,
    account_row_id text not null,
    status text not null,
    metric text not null,
    hypothesis text,
    decide_after_hours integer not null,
    auto_share_winner integer not null default 0,
    winner text,
    result text,
    error text,
    created_at integer not null,
    updated_at integer not null,
    started_at integer,
    finished_at integer
  );
  create index experiments_status on experiments(status);
  create table experiment_variants(
    experiment_id text not null references experiments(id) on delete cascade,
    label text not null,
    job_id text,
    media_id text,
    note text,
    metrics text,
    primary key(experiment_id, label)
  );
  `,
  // 2: A/B variants whose numbers cannot be read (no post ID, deleted post)
  `alter table experiment_variants add column missing_reason text;`,
];

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(
      "pragma journal_mode = wal; pragma busy_timeout = 8000; pragma foreign_keys = on;",
    );
    this.migrate();
  }

  private migrate() {
    this.raw.exec("create table if not exists schema_version(version integer not null)");
    const row = this.raw.prepare("select version from schema_version").get() as
      { version: number } | undefined;
    let v = row?.version ?? 0;
    if (!row) this.raw.prepare("insert into schema_version(version) values (0)").run();
    for (; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.prepare("update schema_version set version = ?").run(v + 1);
      });
    }
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("begin immediate");
    try {
      const out = fn();
      this.raw.exec("commit");
      return out;
    } catch (e) {
      this.raw.exec("rollback");
      throw e;
    }
  }

  setting(key: string): string | undefined {
    return this.get<{ value: string }>("select value from settings where key = ?", key)?.value;
  }

  setSetting(key: string, value: string) {
    this.run(
      "insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      key,
      value,
    );
  }

  audit(
    action: string,
    detail: Record<string, unknown> = {},
    accountId?: string,
    mediaId?: string,
  ) {
    this.run(
      "insert into audit(at, action, account_id, media_id, detail) values (?, ?, ?, ?, ?)",
      Date.now(),
      action,
      accountId ?? null,
      mediaId ?? null,
      JSON.stringify(detail),
    );
  }

  /** Small TTL cache for read-heavy API calls (insights, hashtag ids). */
  cached<T>(key: string, maxAgeMs: number): T | undefined {
    const row = this.get<{ value: string; fetched_at: number }>(
      "select value, fetched_at from cache where key = ?",
      key,
    );
    if (!row || Date.now() - row.fetched_at > maxAgeMs) return undefined;
    return JSON.parse(row.value) as T;
  }

  putCache(key: string, value: unknown) {
    this.run(
      "insert into cache(key, value, fetched_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, fetched_at = excluded.fetched_at",
      key,
      JSON.stringify(value),
      Date.now(),
    );
  }

  close() {
    this.raw.close();
  }
}

export const now = () => Date.now();
