import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { IgError } from "../../errors.js";
import { checkMedia, guessType, inspect, prepareMedia } from "../../media/prepare.js";
import { validateSpec } from "../../publish/jobs.js";
import { expandPath, inspectLocalFile } from "../../publish/sources.js";
import type {
  ItemSpec,
  ItemType,
  JobRow,
  JobStatus,
  PostKind,
  PostSpec,
} from "../../publish/types.js";
import { applyCaptionTemplate } from "../../templates.js";
import {
  accountArg,
  confirmArg,
  confirmGate,
  ok,
  progressReporter,
  safe,
  type Extra,
} from "../helpers.js";

const MIN_AHEAD_MS = 10 * 60_000;
const MAX_AHEAD_MS = 75 * 86_400_000;

const filePath = z
  .string()
  .optional()
  .describe("Path to the file on this computer, e.g. ~/Pictures/launch.jpg.");
const url = z
  .string()
  .url()
  .optional()
  .describe("Public http(s) URL of the file instead of a local path.");
const userTags = z
  .array(
    z.object({
      username: z.string().describe("Instagram username to tag (public accounts only)."),
      x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Images: 0 (left) to 1 (right). Default 0.5."),
      y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Images: 0 (top) to 1 (bottom). Default 0.5."),
    }),
  )
  .max(20)
  .optional()
  .describe("People to tag in the media.");

const feedShape = {
  caption: z
    .string()
    .max(2200)
    .optional()
    .describe(
      "Caption (max 2,200 characters, 30 hashtags, 20 @mentions). The first ~125 characters show before 'more'. Captions can't be edited through the API after publishing.",
    ),
  template: z
    .string()
    .optional()
    .describe(
      "Template from list_templates: adds header/footer, hashtags, first comment, collaborators.",
    ),
  first_comment: z
    .string()
    .max(2200)
    .optional()
    .describe("Posted as the first comment right after publishing (hashtags, credits, links)."),
  collaborators: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("Up to 3 usernames invited as collaborators (they must accept in the app)."),
  location_id: z.string().optional().describe("Facebook Page ID of a place (see find_location)."),
  is_ai_generated: z
    .boolean()
    .optional()
    .describe("Self-disclose that the content was made or edited with AI (shows an AI label)."),
};

const runShape = {
  publish_at: z
    .string()
    .optional()
    .describe(
      "Schedule: ISO 8601 date-time with timezone, at least 10 minutes and at most 75 days ahead. Instagram has no API scheduling, so this computer (or the background service) publishes it then; if the computer is off and the time passes by more than 2 hours, it is not published late (reschedule or resume_publish).",
    ),
  prepare: z
    .boolean()
    .default(true)
    .describe(
      "Convert to Instagram's specs with ffmpeg first (JPEG, H.264/AAC MP4, allowed aspect ratio and length). Default true.",
    ),
  fit: z
    .enum(["keep", "crop", "blur"])
    .optional()
    .describe(
      "Reframing when converting: keep (only clamp into the allowed range), crop (fill the frame from the centre) or blur (whole frame over a blurred fill). Reels/stories target 9:16.",
    ),
  account: accountArg,
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(110)
    .default(50)
    .describe("Wait this long for publishing before returning; then follow get_publish_status."),
  confirmation_token: confirmArg,
};

function parsePublishAt(v?: string): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t))
    throw new IgError("invalid_request", `publish_at "${v}" is not a valid ISO 8601 date-time.`);
  if (t < Date.now() + MIN_AHEAD_MS)
    throw new IgError("invalid_request", "publish_at must be at least 10 minutes from now.", {
      hint: "Leave publish_at out to publish right away.",
    });
  if (t > Date.now() + MAX_AHEAD_MS)
    throw new IgError("invalid_request", "publish_at can be at most 75 days ahead.");
  return t;
}

export function whenText(t?: number | null): string {
  if (!t) return "now";
  const local = new Date(t).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  });
  return `${new Date(t).toISOString()} (${local} on this computer)`;
}

function typeOf(
  src: { file_path?: string; url?: string },
  kind: PostKind,
  given?: ItemType,
): ItemType {
  if (given) return given;
  if (kind === "photo") return "image";
  if (kind === "reel") return "video";
  const g = guessType(src.file_path ?? src.url ?? "");
  if (!g)
    throw new IgError(
      "invalid_request",
      `Can't tell if ${src.file_path ?? src.url} is an image or a video.`,
      {
        hint: 'Pass type: "image" or "video".',
      },
    );
  return g;
}

function source(a: { file_path?: string; url?: string }, what = "Media") {
  if (!a.file_path === !a.url)
    throw new IgError("invalid_request", `${what}: give exactly one of file_path or url.`);
  return a.file_path ? { file_path: expandPath(a.file_path) } : { url: a.url! };
}

const preview = (s?: string, n = 120) => {
  if (!s) return "(no caption)";
  const c = [...s.replace(/\s+/g, " ").trim()];
  return c.length > n ? `${c.slice(0, n - 1).join("")}…` : c.join("");
};

const LABEL: Record<PostKind, string> = {
  photo: "photo post",
  reel: "reel",
  story: "story",
  carousel: "carousel",
};

function note(app: App, j: JobRow): string {
  switch (j.status) {
    case "published":
      return `Published: ${j.permalink ?? j.media_id}`;
    case "scheduled":
      return `Scheduled for ${whenText(j.publish_at)}. The background service or any open AI app with this server publishes it then (see list_scheduled).`;
    case "ready":
      return `Prepared and checked; publishes at ${whenText(j.publish_at)} (the container is re-checked right before).`;
    case "failed":
      return j.error_code === "missed_schedule" ? `${j.error}` : `Publishing failed: ${j.error}`;
    case "cancelled":
      return "Cancelled.";
    case "waiting_limit":
      return `Waiting for Instagram's publishing limit to free up; it publishes automatically (next try ${whenText(j.next_attempt_at)}).`;
    default:
      if (j.status === "queued" && j.error_code === "auth_expired")
        return `Paused: ${j.error} It continues after connect_account.`;
      return `Working in the background (${j.status}${j.error ? `; last error: ${j.error}` : ""}). Follow it with get_publish_status job_id "${j.id}". It keeps going while this server runs and resumes after restarts.`;
  }
}

/** Shared flow: check files, show exactly what will go out, ask, queue, wait. */
async function submit(
  server: McpServer,
  app: App,
  action: string,
  args: Record<string, unknown> & { account?: string; publish_at?: string; wait_seconds: number },
  spec: PostSpec,
  extra: Extra,
) {
  const row = app.accounts.resolve(args.account);
  const publishAt = parsePublishAt(args.publish_at);
  for (const it of spec.items)
    if (it.source.file_path) await inspectLocalFile(it.source.file_path, app.cfg.maxUploadBytes);
  if (spec.cover?.file_path) await inspectLocalFile(spec.cover.file_path, app.cfg.maxUploadBytes);

  // Preview what enqueue will publish (template applied), and validate before asking anyone.
  const shown: PostSpec = { ...spec };
  const warnings: string[] = [];
  if (spec.template && spec.kind !== "story") {
    const t = app.templates.get(spec.template);
    const r = applyCaptionTemplate(spec.caption ?? "", t);
    shown.caption = r.caption || undefined;
    shown.first_comment ??= r.first_comment;
    shown.collaborators ??= t.collaborators;
    warnings.push(...r.warnings);
  }
  validateSpec(shown);
  if (app.hosts.activeKind() === "tunnel" && publishAt)
    warnings.push(
      "Media host is the tunnel: this computer must be on and online at the scheduled time (install the background service with `service install`).",
    );

  const summary = [
    `Publish a PUBLIC Instagram ${spec.trial ? `trial reel (${spec.trial.graduation} graduation, shown to non-followers first)` : LABEL[spec.kind]} on @${row.username}`,
    `When: ${whenText(publishAt)}`,
    `Media: ${spec.items.length} item${spec.items.length > 1 ? "s" : ""} (${spec.items.map((i) => i.source.file_path ?? i.source.url).join(", ")})`,
    spec.kind !== "story" ? `Caption: ${preview(shown.caption)}` : "",
    shown.first_comment ? `First comment: ${preview(shown.first_comment, 80)}` : "",
    shown.collaborators?.length ? `Collaborators: ${shown.collaborators.join(", ")}` : "",
    spec.template ? `Template: ${spec.template}` : "",
    spec.is_ai_generated ? "Labelled as AI-generated" : "",
  ]
    .filter(Boolean)
    .join("\n");
  const gate = await confirmGate(app, server, action, args, summary, { publicFacing: true });
  if (gate) return gate;

  const job = app.jobs.enqueue(row.id, spec, { publishAt });
  const after = await app.jobs.waitFor(job.id, args.wait_seconds * 1000, progressReporter(extra));
  const view = app.jobs.view(after);
  if (warnings.length) view.warnings = [...new Set([...(view.warnings ?? []), ...warnings])];
  return ok(view, note(app, after));
}

export function registerPublishTools(server: McpServer, app: App) {
  server.registerTool(
    "publish_photo",
    {
      title: "Publish a photo post",
      description:
        "Publish (or schedule) a single-image feed post. Images are converted to JPEG and fitted into Instagram's 4:5 to 1.91:1 range automatically. Needs the user's confirmation. Runs in the background; follow get_publish_status.",
      inputSchema: {
        file_path: filePath,
        url,
        alt_text: z
          .string()
          .max(1000)
          .optional()
          .describe("Accessibility description (max 1,000 characters)."),
        user_tags: userTags,
        ...feedShape,
        ...runShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) => {
      const spec: PostSpec = {
        kind: "photo",
        items: [
          {
            source: source(args),
            type: "image",
            alt_text: args.alt_text,
            user_tags: args.user_tags,
          },
        ],
        caption: args.caption,
        template: args.template,
        first_comment: args.first_comment,
        collaborators: args.collaborators,
        location_id: args.location_id,
        is_ai_generated: args.is_ai_generated,
        prepare: args.prepare,
        fit: args.fit,
      };
      return submit(server, app, "publish_photo", args, spec, extra);
    }),
  );

  const reelShape = {
    file_path: filePath,
    url,
    cover_file: z
      .string()
      .optional()
      .describe("Custom cover image for the reels tab and grid (9:16 looks best)."),
    cover_url: z.string().url().optional().describe("Cover image URL instead of cover_file."),
    thumb_offset_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Use the frame at this time (ms) as the cover when no cover image is given."),
    share_to_feed: z
      .boolean()
      .optional()
      .describe("Also show the reel in the profile grid and feed (Instagram's default is yes)."),
    audio_name: z.string().max(100).optional().describe("Name for the reel's original audio."),
    user_tags: z
      .array(z.object({ username: z.string() }))
      .max(20)
      .optional()
      .describe("People to tag in the reel."),
    ...feedShape,
    ...runShape,
  };

  type ReelArgs = {
    file_path?: string;
    url?: string;
    cover_file?: string;
    cover_url?: string;
    thumb_offset_ms?: number;
    share_to_feed?: boolean;
    audio_name?: string;
    user_tags?: { username: string }[];
    caption?: string;
    template?: string;
    first_comment?: string;
    collaborators?: string[];
    location_id?: string;
    is_ai_generated?: boolean;
    prepare: boolean;
    fit?: "keep" | "crop" | "blur";
  };
  const reelSpec = (args: ReelArgs, trial?: PostSpec["trial"]): PostSpec => {
    if (args.cover_file && args.cover_url)
      throw new IgError("invalid_request", "Give cover_file or cover_url, not both.");
    return {
      kind: "reel",
      items: [{ source: source(args), type: "video", user_tags: args.user_tags }],
      caption: args.caption,
      template: args.template,
      first_comment: args.first_comment,
      collaborators: args.collaborators,
      location_id: args.location_id,
      is_ai_generated: args.is_ai_generated,
      cover: args.cover_file
        ? { file_path: expandPath(args.cover_file) }
        : args.cover_url
          ? { url: args.cover_url }
          : undefined,
      thumb_offset_ms: args.thumb_offset_ms,
      share_to_feed: args.share_to_feed,
      audio_name: args.audio_name,
      prepare: args.prepare,
      fit: args.fit,
      trial,
    };
  };

  server.registerTool(
    "publish_reel",
    {
      title: "Publish a reel",
      description:
        "Publish (or schedule) a reel: 3 seconds to 15 minutes, up to 300 MB, 9:16 fills the screen (fit: crop or blur reframes other shapes). Converted to H.264/AAC MP4 when needed. Licensed music can't be added through the API. Needs the user's confirmation; runs in the background.",
      inputSchema: reelShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) => submit(server, app, "publish_reel", args, reelSpec(args), extra)),
  );

  server.registerTool(
    "publish_trial_reel",
    {
      title: "Publish a trial reel",
      description:
        "Publish a trial reel: Instagram shows it to non-followers first, so you can test an idea without your followers seeing it. graduation SS_PERFORMANCE lets Instagram share it with followers automatically if it performs well; MANUAL keeps it trial-only until you share it yourself in the Instagram app (the API has no call to graduate a trial reel). For comparing several versions, use create_ab_test. Needs confirmation.",
      inputSchema: {
        ...reelShape,
        graduation: z
          .enum(["MANUAL", "SS_PERFORMANCE"])
          .default("MANUAL")
          .describe(
            "MANUAL: you decide in the app. SS_PERFORMANCE: Instagram shares it to followers if it does well.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) =>
      submit(
        server,
        app,
        "publish_trial_reel",
        args,
        reelSpec(args, { graduation: args.graduation }),
        extra,
      ),
    ),
  );

  server.registerTool(
    "publish_carousel",
    {
      title: "Publish a carousel",
      description:
        "Publish (or schedule) a carousel of 2 to 20 images and/or videos (videos 3-60 s). Instagram crops every item to the first item's shape; use fit to control reframing. Alt text and user tags per image. Needs the user's confirmation; runs in the background.",
      inputSchema: {
        items: z
          .array(
            z.object({
              file_path: filePath,
              url,
              type: z
                .enum(["image", "video"])
                .optional()
                .describe("Only needed when the file name does not tell."),
              alt_text: z.string().max(1000).optional(),
              user_tags: userTags,
            }),
          )
          .min(2)
          .max(20)
          .describe("The slides, in order."),
        ...feedShape,
        ...runShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) => {
      const items: ItemSpec[] = args.items.map((it, i) => {
        const src = source(it, `Item ${i + 1}`);
        return {
          source: src,
          type: typeOf(src, "carousel", it.type),
          alt_text: it.alt_text,
          user_tags: it.user_tags,
        };
      });
      const spec: PostSpec = {
        kind: "carousel",
        items,
        caption: args.caption,
        template: args.template,
        first_comment: args.first_comment,
        collaborators: args.collaborators,
        location_id: args.location_id,
        is_ai_generated: args.is_ai_generated,
        prepare: args.prepare,
        fit: args.fit,
      };
      return submit(server, app, "publish_carousel", args, spec, extra);
    }),
  );

  server.registerTool(
    "publish_story",
    {
      title: "Publish a story",
      description:
        "Publish (or schedule) a story from an image or a video (3-60 s, up to 100 MB). Stories last 24 hours. Stickers, links, polls and music can't be added through the API. Needs the user's confirmation.",
      inputSchema: {
        file_path: filePath,
        url,
        type: z
          .enum(["image", "video"])
          .optional()
          .describe("Only needed when the file name does not tell."),
        user_tags: userTags,
        ...runShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) => {
      const src = source(args);
      const spec: PostSpec = {
        kind: "story",
        items: [{ source: src, type: typeOf(src, "story", args.type), user_tags: args.user_tags }],
        prepare: args.prepare,
        fit: args.fit,
      };
      return submit(server, app, "publish_story", args, spec, extra);
    }),
  );

  server.registerTool(
    "get_publish_status",
    {
      title: "Publishing status",
      description:
        "Status of a publishing job: each item's progress (preparing, uploading %, processing), errors with fixes, and the permalink once published. Can wait for changes.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(0)
          .describe("Wait up to this long for it to finish."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ job_id, wait_seconds }, extra) => {
      const j = await app.jobs.waitFor(job_id, wait_seconds * 1000, progressReporter(extra));
      return ok(app.jobs.view(j), note(app, j));
    }),
  );

  server.registerTool(
    "list_scheduled",
    {
      title: "Scheduled and recent posts",
      description:
        "Upcoming scheduled posts (soonest first), posts being published or waiting, and recent results from this computer.",
      inputSchema: {
        account: accountArg,
        recent: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(10)
          .describe("How many finished jobs to include."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ account, recent }) => {
      const accountRowId = account ? app.accounts.resolve(account).id : undefined;
      const active: JobStatus[] = [
        "queued",
        "preparing",
        "uploading",
        "processing",
        "publishing",
        "waiting_limit",
      ];
      const upcoming = app.jobs
        .list({ status: ["scheduled", "ready"], accountRowId, limit: 200 })
        .sort((a, b) => (a.publish_at ?? 0) - (b.publish_at ?? 0))
        .map((j) => app.jobs.view(j));
      const inProgress = app.jobs
        .list({ status: active, accountRowId, limit: 100 })
        .map((j) => app.jobs.view(j));
      const done = recent
        ? app.db
            .all<JobRow>(
              `select * from jobs where status in ('published', 'failed', 'cancelled') ${accountRowId ? "and account_row_id = ?" : ""}
               order by coalesce(finished_at, updated_at) desc limit ?`,
              ...(accountRowId ? [accountRowId] : []),
              recent,
            )
            .map((j) => ({ ...app.jobs.view(j), result: undefined }))
        : [];
      return ok({
        media_host: app.hosts.activeKind(),
        scheduled: upcoming,
        in_progress: inProgress,
        recent: done,
      });
    }),
  );

  server.registerTool(
    "reschedule",
    {
      title: "Reschedule a post",
      description:
        "Move a scheduled, waiting or missed (computer was off) post to a new time. Needs the user's confirmation.",
      inputSchema: {
        job_id: z.string(),
        publish_at: z
          .string()
          .describe("New ISO 8601 date-time with timezone (10 minutes to 75 days ahead)."),
        confirmation_token: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (args) => {
      const j = app.jobs.get(args.job_id);
      if (!j) throw new IgError("not_found", `No publishing job ${args.job_id}.`);
      const t = parsePublishAt(args.publish_at)!;
      app.jobs.assertReschedulable(j);
      const acct = app.accounts.byRowId(j.account_row_id);
      const summary = `Reschedule the ${LABEL[j.kind]} on @${acct?.username} from ${whenText(j.publish_at)} to ${whenText(t)}. It will be PUBLIC then.`;
      const gate = await confirmGate(app, server, "reschedule", args, summary, {
        publicFacing: true,
      });
      if (gate) return gate;
      const after = app.jobs.reschedule(args.job_id, t);
      return ok(app.jobs.view(after), note(app, after));
    }),
  );

  server.registerTool(
    "cancel_scheduled",
    {
      title: "Cancel a scheduled or unfinished post",
      description:
        "Stop a post that has not been published yet (scheduled, waiting or in progress). Hosted copies are removed. Can be undone with resume_publish. Needs the user's confirmation.",
      inputSchema: { job_id: z.string(), confirmation_token: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async (args) => {
      const j = app.jobs.get(args.job_id);
      if (!j) throw new IgError("not_found", `No publishing job ${args.job_id}.`);
      if (j.status === "cancelled" || j.status === "failed")
        return ok(app.jobs.view(j), `Nothing to cancel: the post is ${j.status}.`);
      app.jobs.assertCancellable(j);
      const acct = app.accounts.byRowId(j.account_row_id);
      const spec = JSON.parse(j.spec) as PostSpec;
      const summary = `Cancel the ${LABEL[j.kind]} on @${acct?.username} (${j.status}${j.publish_at ? `, planned for ${whenText(j.publish_at)}` : ""}). Caption: ${preview(spec.caption)}`;
      const gate = await confirmGate(app, server, "cancel_scheduled", args, summary, {
        publicFacing: false,
        destructive: true,
      });
      if (gate) return gate;
      const after = app.jobs.cancel(args.job_id);
      return ok(app.jobs.view(after), note(app, after));
    }),
  );

  server.registerTool(
    "resume_publish",
    {
      title: "Retry or resume a post",
      description:
        "Retry a failed post, continue one paused on an expired sign-in, re-check one waiting for the publishing limit, restore a cancelled one, or publish one that missed its scheduled time (computer was off) right now. Cancelled and missed posts need the user's confirmation again. If a publish may already have gone through, it checks Instagram first and never publishes twice.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z.number().int().min(0).max(110).default(30),
        confirmation_token: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args, extra) => {
      const j = app.jobs.get(args.job_id);
      if (!j) throw new IgError("not_found", `No publishing job ${args.job_id}.`);
      app.jobs.assertResumable(j);
      if (j.error_code === "missed_schedule") {
        const acct = app.accounts.byRowId(j.account_row_id);
        const spec = JSON.parse(j.spec) as PostSpec;
        const summary = `Publish the ${LABEL[j.kind]} on @${acct?.username} PUBLICLY NOW (it missed its time ${whenText(j.publish_at)}). Caption: ${preview(spec.caption)}`;
        const gate = await confirmGate(app, server, "resume_publish", args, summary, {
          publicFacing: true,
        });
        if (gate) return gate;
      } else if (j.status === "cancelled") {
        const acct = app.accounts.byRowId(j.account_row_id);
        const spec = JSON.parse(j.spec) as PostSpec;
        const summary = `Restore the cancelled ${LABEL[j.kind]} on @${acct?.username} and publish it PUBLICLY ${j.publish_at && j.publish_at > Date.now() ? `at ${whenText(j.publish_at)}` : "now"}. Caption: ${preview(spec.caption)}`;
        const gate = await confirmGate(app, server, "resume_publish", args, summary, {
          publicFacing: true,
        });
        if (gate) return gate;
      }
      app.jobs.resume(args.job_id);
      const after = await app.jobs.waitFor(
        args.job_id,
        args.wait_seconds * 1000,
        progressReporter(extra),
      );
      return ok(app.jobs.view(after), note(app, after));
    }),
  );

  server.registerTool(
    "prepare_media",
    {
      title: "Check (and convert) media for Instagram",
      description:
        "Inspect an image or video and list what Instagram would reject for a placement (format, codec, aspect ratio, length, size). With convert=true, writes a fixed copy (JPEG / H.264+AAC MP4, reframed with fit) and returns its path. Publishing tools do this automatically. Needs ffmpeg.",
      inputSchema: {
        file_path: z.string().describe("Image or video on this computer."),
        kind: z.enum(["photo", "reel", "story", "carousel"]).describe("Where it will be posted."),
        fit: z.enum(["keep", "crop", "blur"]).optional(),
        convert: z.boolean().default(false).describe("Write a converted copy when needed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (args) => {
      const f = await inspectLocalFile(args.file_path, app.cfg.maxUploadBytes);
      const info = await inspect(f.path);
      const inCarousel = args.kind === "carousel";
      const check = checkMedia(info, args.kind, inCarousel);
      const out: Record<string, unknown> = {
        file: f.path,
        media: {
          type: info.kind,
          width: info.width,
          height: info.height,
          aspect_ratio: Math.round(info.ratio * 1000) / 1000,
          duration_seconds:
            info.duration !== undefined ? Math.round(info.duration * 10) / 10 : undefined,
          fps: info.fps ? Math.round(info.fps * 100) / 100 : undefined,
          video_codec: info.kind === "video" ? info.videoCodec : undefined,
          audio_codec: info.audioCodec,
          megabytes: Math.round((info.bytes / 1024 ** 2) * 10) / 10,
        },
        ok: check.ok,
        problems: check.problems,
        warnings: check.warnings,
        fixable_by_converting: check.ok ? undefined : check.fixable,
      };
      if (args.convert) {
        const dir = join(app.cfg.home, "prepared");
        mkdirSync(dir, { recursive: true });
        const p = await prepareMedia(f.path, {
          kind: args.kind,
          inCarousel,
          fit: args.fit,
          outDir: dir,
        });
        out.converted = p.converted
          ? { path: p.path, actions: p.actions, remaining_problems: p.warnings }
          : false;
      }
      return ok(out, check.ok ? "Ready for Instagram." : undefined);
    }),
  );

  server.registerTool(
    "publish_budget",
    {
      title: "Publishing limit",
      description:
        "How many API posts are left in Instagram's rolling 24-hour window (Meta's limit; carousels count once), plus posts scheduled for the next 24 hours.",
      inputSchema: { account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account }) => {
      const row = app.accounts.resolve(account);
      const b = await app.jobs.budget(row);
      const soon =
        app.db.get<{ n: number }>(
          `select count(*) as n from jobs where account_row_id = ? and status in ('scheduled', 'queued', 'preparing', 'uploading', 'processing', 'waiting_limit')
           and coalesce(publish_at, 0) <= ?`,
          row.id,
          Date.now() + 86_400_000,
        )?.n ?? 0;
      return ok({ account: `@${row.username}`, ...b, queued_or_scheduled_next_24h: soon });
    }),
  );

  server.registerTool(
    "media_host_status",
    {
      title: "Media host status",
      description:
        "How local files reach Instagram, and whether it works: tunnel (Cloudflare quick tunnel from this computer), s3 (S3/R2/B2 bucket) or azure (Blob Storage). Facebook-Login accounts upload videos straight to Meta; images always go through the host.",
      inputSchema: {
        host: z
          .enum(["tunnel", "s3", "azure"])
          .optional()
          .describe("Check a specific host instead of the active one."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ host }) => {
      const c = await app.hosts.check(host);
      return ok({
        active: app.hosts.activeKind(),
        checked: c.kind,
        ok: c.ok,
        detail: c.detail,
        fix: c.fix,
        how_media_travels: {
          facebook_login: "Videos: direct resumable upload to Meta. Images: media host URL.",
          instagram_login: "Every file: media host URL (Meta fetches it).",
          urls: "Public https URLs that already meet Instagram's specs are passed to Meta as they are.",
        },
      });
    }),
  );

  server.registerTool(
    "find_location",
    {
      title: "Find a location ID",
      description:
        "Instagram location tags use the Facebook Page ID of a place. Pass a Facebook Page URL or ID to check it (Facebook Login accounts), or a search query (needs Meta's Page Public Metadata Access, which most apps don't have; then look the place up on facebook.com and pass its Page URL).",
      inputSchema: {
        page: z
          .string()
          .optional()
          .describe("Facebook Page URL, username or numeric ID of the place."),
        query: z.string().optional().describe("Place name to search for."),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ page, query, account }) => {
      if (!page === !query) throw new IgError("invalid_request", "Give page or query.");
      const row = app.accounts.resolve(account);
      const howTo =
        "Open the place's Facebook Page, copy its URL (or the numeric Page ID from About → Page transparency) and pass it as page.";
      if (row.auth_mode !== "facebook")
        return ok(
          { checked: false, location_id: page && /^\d+$/.test(page) ? page : undefined },
          `Instagram Login accounts can't look up Facebook Pages. ${howTo} A numeric Page ID can be used as location_id directly; Instagram rejects it if it is not a place.`,
        );
      const g = app.accounts.client(row);
      if (page) {
        const ref = /^\d+$/.test(page)
          ? page
          : (/facebook\.com\/(?:profile\.php\?id=(\d+)|(?:pages\/[^/]+\/)?(\d+)|([\w.-]+))/i
              .exec(page)
              ?.slice(1)
              .find(Boolean) ?? page.replace(/^@/, ""));
        try {
          const p = await g.get<{
            id: string;
            name?: string;
            location?: Record<string, unknown>;
            link?: string;
          }>(ref, {
            fields: "id,name,location,link",
          });
          return ok(
            { location_id: p.id, name: p.name, location: p.location, link: p.link },
            p.location
              ? "Use location_id in a publish tool."
              : "This Page has no address, so Instagram may not accept it as a location.",
          );
        } catch (e) {
          if (/^\d+$/.test(ref))
            return ok(
              { location_id: ref, checked: false },
              `Could not read the Page (${(e as Error).message}); the ID can still be tried as location_id.`,
            );
          throw new IgError("not_found", `Could not read the Facebook Page "${ref}".`, {
            hint: howTo,
          });
        }
      }
      try {
        const r = await g.get<{
          data?: { id: string; name?: string; location?: Record<string, unknown>; link?: string }[];
        }>("pages/search", { q: query, fields: "id,name,location,link", limit: 10 });
        return ok({
          results: (r.data ?? []).map((p) => ({
            location_id: p.id,
            name: p.name,
            location: p.location,
            link: p.link,
          })),
        });
      } catch {
        return ok(
          { results: [] },
          `Meta did not allow Page search for this app (it needs Page Public Metadata Access). ${howTo}`,
        );
      }
    }),
  );
}

/** Exported for other tool modules (e.g. A/B tests) that want the same status wording. */
export const publishNote = note;
