import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { IgError } from "../../errors.js";
import { AB_METRICS, MAX_DECIDE_HOURS, MIN_DECIDE_HOURS } from "../../experiments.js";
import { validateSpec } from "../../publish/jobs.js";
import { inspectLocalFile } from "../../publish/sources.js";
import type { PostSpec } from "../../publish/types.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const Variant = z.object({
  label: z
    .string()
    .max(20)
    .optional()
    .describe('Short name, e.g. "A", "question hook". Default A-D.'),
  file_path: z.string().optional().describe("The reel video on this computer."),
  url: z.string().optional().describe("Or a public video URL."),
  caption: z.string().optional(),
  cover_path: z.string().optional().describe("Optional cover image on this computer."),
  cover_url: z.string().optional(),
  thumb_offset_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Frame used as cover when no cover image is given."),
  note: z
    .string()
    .optional()
    .describe('What differs in this version, e.g. "hook asks a question".'),
});

const MIN_AHEAD_MS = 10 * 60_000;
const MAX_AHEAD_MS = 75 * 86_400_000;

/** Same rules as the publish tools: 10 minutes to 75 days ahead. */
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

export function registerExperimentTools(server: McpServer, app: App) {
  server.registerTool(
    "create_ab_test",
    {
      title: "A/B test reels with trial reels",
      description: `Publishes 2-4 versions of a reel (different hook, cut, caption or cover) as trial reels at the same time. Instagram shows trial reels to non-followers first, so each version gets a comparable audience without spamming followers. After decide_after_hours (default 48, ${MIN_DECIDE_HOURS}-${MAX_DECIDE_HOURS}) the background service compares them on the chosen metric with a significance test and reports a winner or "inconclusive". Meta's API cannot graduate trial reels: you share the winner to followers in the Instagram app; with share_winner: "republish" this server instead republishes the winning version as a normal reel. Versions should differ in one thing. Each version counts toward the publishing limit. Asks the user first.`,
      inputSchema: {
        variants: z.array(Variant).min(2).max(4),
        metric: z
          .enum(AB_METRICS)
          .default("views")
          .describe(
            "views or reach (Poisson test), shares / saves / engagement_rate (per reach, two-proportion test), avg_watch_time (directional only).",
          ),
        decide_after_hours: z
          .number()
          .int()
          .min(MIN_DECIDE_HOURS)
          .max(MAX_DECIDE_HOURS)
          .default(48),
        graduation: z
          .enum(["MANUAL", "SS_PERFORMANCE"])
          .default("MANUAL")
          .describe(
            "MANUAL: you decide in the app. SS_PERFORMANCE: Instagram may share a well-performing version to followers by itself.",
          ),
        share_winner: z
          .enum(["in_app", "republish"])
          .default("in_app")
          .describe("republish: post a clear winner again as a normal reel automatically."),
        publish_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 date-time with timezone to publish all versions, 10 minutes to 75 days ahead (default now).",
          ),
        stagger_minutes: z.number().int().min(0).max(60).default(0),
        hypothesis: z.string().optional(),
        template: z.string().optional().describe("Caption template applied to every version."),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      // Validate everything before asking the user, so an approval is never spent on a bad request.
      const row = app.accounts.resolve(args.account);
      if (args.template) app.templates.get(args.template);
      const publishAt = parsePublishAt(args.publish_at);
      const labels = args.variants.map((v, i) => v.label?.trim() || "ABCD"[i]);
      if (new Set(labels).size !== labels.length)
        throw new IgError("invalid_request", "Each version needs a different label.");
      const variants = [];
      for (const [i, v] of args.variants.entries()) {
        const what = `Version ${labels[i]}`;
        if (!v.file_path === !v.url)
          throw new IgError("invalid_request", `${what}: give exactly one of file_path or url.`);
        if (v.cover_path && v.cover_url)
          throw new IgError("invalid_request", `${what}: give cover_path or cover_url, not both.`);
        const spec: PostSpec = {
          kind: "reel",
          caption: v.caption,
          items: [
            { type: "video", source: v.file_path ? { file_path: v.file_path } : { url: v.url } },
          ],
          cover: v.cover_path
            ? { file_path: v.cover_path }
            : v.cover_url
              ? { url: v.cover_url }
              : undefined,
          thumb_offset_ms: v.thumb_offset_ms,
          template: args.template,
          trial: { graduation: args.graduation },
        };
        try {
          validateSpec(spec);
          if (v.file_path) await inspectLocalFile(v.file_path, app.cfg.maxUploadBytes);
          if (v.cover_path) await inspectLocalFile(v.cover_path, app.cfg.maxUploadBytes);
        } catch (e) {
          if (e instanceof IgError)
            throw new IgError(e.code, `${what}: ${e.message}`, { ...e.opts });
          throw e;
        }
        variants.push({ label: labels[i], spec, note: v.note });
      }
      const summary = [
        `A/B test on @${row.username}: publish ${args.variants.length} trial reels ${publishAt ? `at ${new Date(publishAt).toISOString()}` : "now"} (shown to non-followers first).`,
        ...args.variants.map(
          (v, i) =>
            `  ${labels[i]}: ${v.file_path ?? v.url}${v.note ? ` · ${v.note}` : ""}${v.caption ? ` · "${v.caption.split("\n")[0].slice(0, 80)}"` : ""}`,
        ),
        `Decide on ${args.metric} after ${args.decide_after_hours} hours.`,
        args.share_winner === "republish"
          ? "A clear winner will be republished to followers as a normal reel automatically."
          : "You share the winner to followers in the Instagram app.",
      ].join("\n");
      const gate = await confirmGate(app, server, "create_ab_test", args, summary, {
        publicFacing: true,
      });
      if (gate) return gate;
      const test = app.experiments.create({
        accountRowId: row.id,
        variants,
        metric: args.metric,
        decideAfterHours: args.decide_after_hours,
        graduation: args.graduation,
        publishAt,
        staggerMinutes: args.stagger_minutes,
        autoShareWinner: args.share_winner === "republish",
        hypothesis: args.hypothesis,
      });
      return ok(
        test,
        "A/B test created. Follow publishing with get_publish_status (job ids below) or get_ab_test. The background service (`service install`) makes the decision on time even when no AI app is open.",
      );
    }),
  );

  server.registerTool(
    "get_ab_test",
    {
      title: "A/B test status and results",
      description:
        "Shows an A/B test: each version's publishing status, link and latest metrics, the decision time, and (when finished) the verdict with confidence and next step. refresh: true pulls current numbers from Instagram before the decision.",
      inputSchema: {
        test_id: z.string(),
        refresh: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ test_id, refresh }) =>
      ok(refresh ? await app.experiments.refresh(test_id) : app.experiments.view(test_id)),
    ),
  );

  server.registerTool(
    "list_ab_tests",
    {
      title: "List A/B tests",
      description: "All A/B tests, newest first, optionally filtered by status.",
      inputSchema: {
        status: z.enum(["publishing", "running", "completed", "stopped", "failed"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ status }) =>
      ok(
        app.experiments.list(status).map((e) => ({
          test_id: e.id,
          status: e.status,
          metric: e.metric,
          winner: e.winner ?? undefined,
          hypothesis: e.hypothesis ?? undefined,
          created_at: new Date(e.created_at).toISOString(),
          finished_at: e.finished_at ? new Date(e.finished_at).toISOString() : undefined,
        })),
      ),
    ),
  );

  server.registerTool(
    "stop_ab_test",
    {
      title: "Stop an A/B test",
      description:
        "Stops a test: versions not yet published are cancelled and no decision is made. Trial reels already published stay up (delete them with delete_media or in the app).",
      inputSchema: { test_id: z.string(), confirmation_token: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async (args) => {
      const e = app.experiments.get(args.test_id);
      if (e.status !== "publishing" && e.status !== "running")
        throw new IgError("invalid_request", `This test is already ${e.status}.`);
      const gate = await confirmGate(
        app,
        server,
        "stop_ab_test",
        args,
        `Stop A/B test ${e.id} (${e.status}); unpublished versions are cancelled.`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      return ok(app.experiments.stop(args.test_id));
    }),
  );
}
