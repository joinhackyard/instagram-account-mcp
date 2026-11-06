import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import {
  accountInsights,
  accountPreset,
  ACCOUNT_METRICS,
  audience,
  exportInsights,
  insightsForMedia,
  planExportPath,
} from "../../insights.js";
import { getMedia, listMedia } from "../../library.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerInsightsTools(server: McpServer, app: App) {
  const ctx = (account?: string) => {
    const row = app.accounts.resolve(account);
    return { row, graph: app.accounts.client(row) };
  };

  server.registerTool(
    "get_media_insights",
    {
      title: "Post insights",
      description:
        "Lifetime numbers for posts, reels or stories: views, reach, likes, comments, saves, shares, total interactions, follows, profile visits; reels add average watch time (ms), total watch time and skip rate; stories add navigation and replies. Give media_ids, or omit them for the latest posts. Story insights vanish after 24 hours and need 5+ viewers.",
      inputSchema: {
        media_ids: z.array(z.string()).max(50).optional(),
        latest: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Without media_ids: how many recent posts."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const media = args.media_ids?.length
        ? await Promise.all(args.media_ids.map((id) => getMedia(graph, id)))
        : await listMedia(graph, row.ig_user_id, { limit: args.latest });
      const rows = await insightsForMedia(app.db, graph, media, row.auth_mode);
      return ok({ count: rows.length, media: rows });
    }),
  );

  server.registerTool(
    "get_account_insights",
    {
      title: "Account insights",
      description: [
        "Account-level numbers. Presets: overview (last N days totals: reach, views, accounts engaged, interactions, likes, comments, saves, shares, follows/unfollows, link taps),",
        "daily (reach per day), reach_breakdown (by reels/posts/stories and followers vs non-followers), follows (follows vs unfollows).",
        `Or set metrics yourself (${ACCOUNT_METRICS.join(", ")}) with period, metric_type, breakdown and since/until (max 30 days).`,
      ].join(" "),
      inputSchema: {
        preset: z.enum(["overview", "daily", "reach_breakdown", "follows"]).optional(),
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(28)
          .describe("For presets: how many days back."),
        metrics: z
          .array(z.string())
          .optional()
          .describe("Custom metrics (ignored when preset is set)."),
        period: z.enum(["day", "week", "days_28", "lifetime"]).default("day"),
        metric_type: z.enum(["total_value", "time_series"]).default("total_value"),
        breakdown: z
          .string()
          .optional()
          .describe("e.g. media_product_type, follow_type, follower_type, contact_button_type"),
        since: z.string().optional().describe("YYYY-MM-DD"),
        until: z.string().optional().describe("YYYY-MM-DD"),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      if (args.preset || !args.metrics?.length)
        return ok({
          account: `@${row.username}`,
          preset: args.preset ?? "overview",
          ...(await accountPreset(graph, row.ig_user_id, args.preset ?? "overview", args.days)),
        });
      const until = args.until ?? new Date().toISOString().slice(0, 10);
      const since =
        args.since ??
        new Date(Date.parse(until) - args.days * 86_400_000).toISOString().slice(0, 10);
      return ok({
        account: `@${row.username}`,
        range: { since, until },
        metrics: await accountInsights(graph, row.ig_user_id, {
          metrics: args.metrics,
          period: args.period,
          metric_type: args.metric_type,
          breakdown: args.breakdown,
          since,
          until,
        }),
      });
    }),
  );

  server.registerTool(
    "get_audience",
    {
      title: "Audience demographics",
      description:
        "Who your followers (or the people who engaged) are: age, gender, country and city, with shares in %. Needs at least 100 followers; Meta returns the top 45 values per breakdown.",
      inputSchema: {
        who: z.enum(["followers", "engaged"]).default("followers"),
        breakdowns: z
          .array(z.enum(["age", "gender", "country", "city"]))
          .min(1)
          .default(["age", "gender", "country", "city"]),
        timeframe: z.enum(["this_week", "this_month"]).default("this_month"),
        top: z.number().int().min(1).max(45).default(10),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      return ok({
        account: `@${row.username}`,
        who: args.who,
        timeframe: args.timeframe,
        breakdowns: await audience(graph, row.ig_user_id, args),
      });
    }),
  );

  server.registerTool(
    "export_insights",
    {
      title: "Export post insights to CSV",
      description:
        "Writes a CSV (one row per post: date, type, link, caption, views, reach, likes, comments, saves, shares, interactions, follows, profile visits, reel watch time, skip rate) for spreadsheets. Saved in the data folder's exports/ (a bare file name goes there too). Writing anywhere else needs the user's approval. Never overwrites a file: a -1, -2... suffix is added.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50).describe("How many recent posts."),
        since: z.string().optional(),
        until: z.string().optional(),
        path: z
          .string()
          .optional()
          .describe("File name (saved in exports/), or an absolute / ~/ path (needs approval)."),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const plan = planExportPath(app.cfg.home, args.path);
      if (!plan.insideExports) {
        const gate = await confirmGate(
          app,
          server,
          "export_insights",
          args,
          `Write a CSV of @${row.username}'s post insights to ${plan.path} (outside the app's exports folder).`,
          { publicFacing: false, destructive: true },
        );
        if (gate) return gate;
      }
      const r = await exportInsights(app.db, graph, row.ig_user_id, row.auth_mode, {
        path: plan.path,
        limit: args.limit,
        since: args.since,
        until: args.until,
      });
      return ok(
        r,
        `Saved ${r.rows} posts to ${r.path}${r.failed ? ` (${r.failed} without insights)` : ""}.`,
      );
    }),
  );
}
