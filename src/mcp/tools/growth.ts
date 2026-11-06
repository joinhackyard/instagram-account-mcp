import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { AI_NOT_CONFIGURED_HINT, generateJson } from "../../ai/providers.js";
import {
  baseline,
  benchmarkCompetitor,
  comparePost,
  hashtagBudget,
  hashtagResearch,
  onlineFollowers,
  publishTimeStats,
  rankOutliers,
  type PostAnalysis,
} from "../../growth.js";
import { insightsForMedia } from "../../insights.js";
import { getMedia, listMedia, productOf } from "../../library.js";
import { accountArg, ok, safe } from "../helpers.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const Diagnosis = z.object({
  summary: z.string().describe("Two or three sentences: how it did and the main reason."),
  what_worked: z.array(z.string()).max(5),
  what_to_fix: z.array(z.string()).max(5),
  next_post_ideas: z.array(z.string()).max(3),
});

function diagnosisPrompt(
  a: PostAnalysis,
  caption: string | undefined,
  medians: Record<string, number>,
) {
  return [
    `Instagram ${a.product === "REELS" ? "reel" : a.product === "STORY" ? "story" : "post"} published ${a.timestamp ?? "recently"} (${a.age_hours ?? "?"} hours ago).`,
    `Caption: ${caption ? JSON.stringify(caption.slice(0, 2200)) : "(none)"}`,
    `Its lifetime metrics: ${JSON.stringify(a.metrics)}`,
    `Rates: ${JSON.stringify(a.rates)}`,
    `Account medians for the same format over ${a.baseline_posts} recent posts: ${JSON.stringify(medians)}`,
    `Ratio to median (1 = typical): ${JSON.stringify(a.vs_median)}`,
    `Verdict: ${a.verdict}`,
    a.notes.length ? `Notes: ${a.notes.join(" ")}` : "",
    "Metric meanings: views = times shown/played; reach = unique accounts; reels_skip_rate = share who swiped away in the first 3 seconds; ig_reels_avg_watch_time in ms; saves and shares signal value to Instagram's ranking.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerGrowthTools(server: McpServer, app: App) {
  const ctx = (account?: string) => {
    const row = app.accounts.resolve(account);
    return { row, graph: app.accounts.client(row) };
  };

  server.registerTool(
    "analyze_post",
    {
      title: "Analyze a post",
      description:
        "How one post, reel or story did against your own recent posts of the same format: outlier score (views vs your median), engagement rate, saves+shares per viewer, reel watch time and skip rate, and plain-language notes. With an AI provider it adds a diagnosis and next steps; without one it returns a brief so you can write it.",
      inputSchema: {
        media_id: z.string(),
        baseline_posts: z.number().int().min(5).max(60).default(30),
        diagnose: z
          .boolean()
          .default(true)
          .describe("Ask the configured AI model for a diagnosis."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const m = await getMedia(graph, args.media_id);
      const [post] = await insightsForMedia(app.db, graph, [m], row.auth_mode);
      if (post.error)
        return ok(
          { media_id: m.id, error: post.error },
          "Meta returned no insights for this media.",
        );
      const base = await baseline(app.db, graph, row, productOf(m), {
        size: args.baseline_posts,
        excludeId: m.id,
      });
      const analysis = comparePost(post, base);
      if (!args.diagnose) return ok(analysis);
      const prompt = diagnosisPrompt(analysis, m.caption, base.medians);
      const system =
        "You are a sharp Instagram growth analyst. Be specific and practical; cite the numbers. No hype, no generic advice.";
      const ai = await generateJson(app.cfg.ai, "text", {
        system,
        prompt,
        schema: Diagnosis,
        maxTokens: 4000,
      });
      if (!ai)
        return ok(
          { ...analysis, brief: { system, prompt } },
          `No AI provider is set for writing, so here is a brief: write the diagnosis yourself from it. ${AI_NOT_CONFIGURED_HINT}`,
        );
      return ok({ ...analysis, diagnosis: ai.data, model: ai.model });
    }),
  );

  server.registerTool(
    "find_outliers",
    {
      title: "Find outlier posts",
      description:
        "Your best and worst recent posts relative to your own median on one metric (views, reach, shares, saved, total_interactions, engagement_rate, save_share_rate, follows...). Shows what to repeat and what to drop.",
      inputSchema: {
        metric: z.string().default("views"),
        type: z
          .enum(["FEED", "REELS"])
          .optional()
          .describe("Compare within one format (recommended)."),
        posts: z.number().int().min(5).max(100).default(40),
        top: z.number().int().min(1).max(20).default(5),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const media = await listMedia(graph, row.ig_user_id, { limit: args.posts, type: args.type });
      const rows = (await insightsForMedia(app.db, graph, media, row.auth_mode)).filter(
        (r) => !r.error,
      );
      const r = rankOutliers(rows, args.metric, args.top);
      const slim = (x: (typeof r.best)[number]) => ({
        id: x.id,
        product: x.product,
        permalink: x.permalink,
        posted: x.timestamp,
        caption: x.caption,
        score: x.score,
        [args.metric]: x.metrics[args.metric],
      });
      return ok({
        metric: args.metric,
        posts_compared: rows.length,
        median: r.median,
        best: r.best.map(slim),
        worst: r.worst.map(slim),
      });
    }),
  );

  server.registerTool(
    "best_publish_time",
    {
      title: "Best time to publish",
      description:
        "When your own posts performed best, by weekday and 3-hour block in your time zone (each post scored against your median, so one viral post does not decide), plus when followers are online if Meta provides it.",
      inputSchema: {
        metric: z.enum(["reach", "views", "total_interactions"]).default("reach"),
        type: z.enum(["FEED", "REELS"]).optional(),
        posts: z.number().int().min(10).max(150).default(60),
        time_zone: z
          .string()
          .optional()
          .describe("IANA zone such as Asia/Kolkata. Default: this computer's zone."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const tz = args.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const media = await listMedia(graph, row.ig_user_id, { limit: args.posts, type: args.type });
      const rows = (await insightsForMedia(app.db, graph, media, row.auth_mode)).filter(
        (r) => !r.error,
      );
      const stats = publishTimeStats(
        rows.map((r) => ({ timestamp: r.timestamp, value: r.metrics[args.metric] })),
        tz,
      );
      const online = await onlineFollowers(graph, row.ig_user_id);
      return ok({
        time_zone: tz,
        metric: args.metric,
        ...stats,
        followers_online_by_hour: online ?? undefined,
        followers_online_note: online
          ? "Hours as Meta reports them for online_followers (its time zone is not documented; treat as a rough guide)."
          : undefined,
        note:
          stats.posts_used < 15
            ? "Few posts to learn from; treat this as a hint and keep testing different times."
            : undefined,
      });
    }),
  );

  server.registerTool(
    "hashtag_research",
    {
      title: "Research hashtags",
      description:
        "For each hashtag: top (or most recent) public posts, their median likes and comments, format mix, related hashtags people use with it, and example posts. Instagram allows 30 different hashtags per 7 days per account (repeats are free); the remaining budget is shown. Facebook Login accounts only.",
      inputSchema: {
        hashtags: z.array(z.string()).min(1).max(10),
        edge: z.enum(["top_media", "recent_media"]).default("top_media"),
        limit: z.number().int().min(5).max(100).default(30).describe("Posts sampled per hashtag."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      return ok(await hashtagResearch(app.db, graph, row, args.hashtags, args));
    }),
  );

  server.registerTool(
    "hashtag_budget",
    {
      title: "Hashtag search budget",
      description:
        "How many of the 30 hashtag searches per rolling 7 days are left, and which hashtags can be repeated for free.",
      inputSchema: { account: accountArg },
      annotations: READ,
    },
    safe(async (args) => {
      const { row } = ctx(args.account);
      const b = hashtagBudget(app.db, row.ig_user_id);
      return ok({
        remaining: b.remaining,
        used: b.used.map((u) => ({ hashtag: `#${u.tag}`, at: new Date(u.at).toISOString() })),
        next_slot_at: b.next_slot_at,
      });
    }),
  );

  server.registerTool(
    "benchmark_competitor",
    {
      title: "Benchmark another account",
      description:
        "Public stats of any Business or Creator account (Meta's Business Discovery): followers, posting frequency, format mix, median likes/comments/views, engagement per follower, top hashtags and top posts. Compare with your own using get_account_insights. Facebook Login accounts only.",
      inputSchema: {
        username: z.string().describe("Their @username."),
        posts: z.number().int().min(5).max(100).default(30),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const r = await benchmarkCompetitor(app.db, graph, row, args.username, args.posts);
      return ok({
        ...r,
        you: { username: `@${row.username}`, followers: row.followers_count ?? undefined },
      });
    }),
  );
}
