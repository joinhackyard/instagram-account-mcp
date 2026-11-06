import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import {
  compactMedia,
  deleteMedia,
  getMedia,
  listMedia,
  listStories,
  listTagged,
  setCommentsEnabled,
} from "../../library.js";
import { requireCapability } from "../../meta/oauth.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerLibraryTools(server: McpServer, app: App) {
  const ctx = (account?: string) => {
    const row = app.accounts.resolve(account);
    return { row, graph: app.accounts.client(row) };
  };

  server.registerTool(
    "list_media",
    {
      title: "List posts and reels",
      description:
        "The account's published posts, reels and carousels, newest first: id, type, caption (shortened), link, time, likes and comments. Use get_media for one post in full and get_media_insights for its numbers.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25),
        type: z
          .enum(["FEED", "REELS", "CAROUSEL_ALBUM", "IMAGE", "VIDEO"])
          .optional()
          .describe("FEED = photos and carousels, REELS = reels; or a media type."),
        since: z
          .string()
          .optional()
          .describe("Only posts on or after this date (YYYY-MM-DD or ISO)."),
        until: z.string().optional().describe("Only posts on or before this date."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const media = await listMedia(graph, row.ig_user_id, args);
      return ok({
        account: `@${row.username}`,
        count: media.length,
        media: media.map((m) => {
          const c = compactMedia(m);
          delete c.media_url;
          delete c.thumbnail_url;
          return c;
        }),
      });
    }),
  );

  server.registerTool(
    "get_media",
    {
      title: "Get one post",
      description:
        "Full details of one post, reel or carousel: caption, media and thumbnail URLs, link, counts, whether comments are on, and carousel items.",
      inputSchema: { media_id: z.string(), account: accountArg },
      annotations: READ,
    },
    safe(async (args) => {
      const { graph } = ctx(args.account);
      const m = await getMedia(graph, args.media_id);
      return ok({
        ...compactMedia(m, 2200),
        comments_enabled: m.comment_enabled,
        items: m.children?.data?.map((c) => ({
          id: c.id,
          type: c.media_type,
          url: c.media_url ?? c.thumbnail_url,
        })),
      });
    }),
  );

  server.registerTool(
    "list_stories",
    {
      title: "List live stories",
      description:
        "Stories currently live (the last 24 hours). Story insights also disappear after 24 hours.",
      inputSchema: { account: accountArg },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const s = await listStories(graph, row.ig_user_id);
      return ok({ count: s.length, stories: s.map((m) => compactMedia(m)) });
    }),
  );

  server.registerTool(
    "list_tagged",
    {
      title: "Posts that tagged you",
      description: "Media where other accounts tagged this account (photo tags), newest first.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(25), account: accountArg },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const t = await listTagged(graph, row.ig_user_id, args.limit);
      return ok({ count: t.length, tagged: t.map((m) => compactMedia(m)) });
    }),
  );

  server.registerTool(
    "toggle_comments",
    {
      title: "Turn comments on or off",
      description:
        "Enable or disable comments on one of your posts. Visible to everyone, so the user confirms first. (Captions cannot be edited through Meta's API.)",
      inputSchema: {
        media_id: z.string(),
        enabled: z.boolean(),
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
      // Fails here (not after approval) if the post does not exist or is not this account's.
      const m = await getMedia(graph, args.media_id);
      if (m.comment_enabled === args.enabled)
        return ok({ media_id: args.media_id, comments_enabled: args.enabled, unchanged: true });
      const gate = await confirmGate(
        app,
        server,
        "toggle_comments",
        args,
        `${args.enabled ? "Turn ON" : "Turn OFF"} comments on post ${args.media_id} (@${row.username}).`,
        { publicFacing: true },
      );
      if (gate) return gate;
      await setCommentsEnabled(graph, args.media_id, args.enabled);
      app.db.audit("media.comments", { enabled: args.enabled }, row.ig_user_id, args.media_id);
      return ok({ media_id: args.media_id, comments_enabled: args.enabled });
    }),
  );

  server.registerTool(
    "delete_media",
    {
      title: "Delete a post",
      description:
        "Permanently delete a post, reel, story or whole carousel (single carousel items cannot be deleted). Only for accounts connected with Facebook Login (Meta's rule). Cannot be undone; the user confirms first.",
      inputSchema: { media_id: z.string(), account: accountArg, confirmation_token: confirmArg },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      // Check before asking the user to approve something Meta would refuse.
      requireCapability(row.auth_mode, "deleteMedia", "Deleting posts");
      const m = await getMedia(graph, args.media_id).catch(() => null);
      const what = m
        ? `${compactMedia(m).type} ${m.permalink ?? args.media_id}${m.caption ? ` ("${m.caption.slice(0, 60)}")` : ""}`
        : args.media_id;
      const gate = await confirmGate(
        app,
        server,
        "delete_media",
        args,
        `PERMANENTLY DELETE ${what} from @${row.username}. This cannot be undone.`,
        { publicFacing: true, destructive: true },
      );
      if (gate) return gate;
      const r = await deleteMedia(graph, row, args.media_id);
      app.db.audit("media.deleted", {}, row.ig_user_id, args.media_id);
      return ok(r);
    }),
  );
}
