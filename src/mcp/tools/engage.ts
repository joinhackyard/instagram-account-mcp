import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import {
  checkDmText,
  checkDmWindow,
  commentOnMedia,
  deleteComment,
  filterComments,
  getComment,
  getConversation,
  listConversations,
  mediaComments,
  messagesPath,
  mentionedComment,
  mentionedMedia,
  privateReply,
  PRIVATE_REPLY_WINDOW_MS,
  recentComments,
  replyToComment,
  sendDm,
  setCommentHidden,
  validateCommentText,
  validateReplyTarget,
} from "../../engage.js";
import { IgError } from "../../errors.js";
import { compactMedia, getMedia, listTagged } from "../../library.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const quote = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`;
};

export function registerEngageTools(server: McpServer, app: App) {
  const ctx = (account?: string) => {
    const row = app.accounts.resolve(account);
    return { row, graph: app.accounts.client(row) };
  };

  // ---- comments --------------------------------------------------------------------------------------

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "Comments with their replies, for one post (media_id) or across the most recent posts. Each comment says whether you already answered. Use unanswered: true to build a reply queue; triage_comments sorts them by priority.",
      inputSchema: {
        media_id: z.string().optional().describe("One post. Omit to scan recent posts."),
        posts: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("How many recent posts to scan (no media_id)."),
        per_post: z.number().int().min(1).max(200).default(25),
        unanswered: z.boolean().default(false).describe("Only comments you have not replied to."),
        hidden: z
          .boolean()
          .optional()
          .describe("true = only hidden comments, false = only visible ones."),
        since: z.string().optional().describe("Only comments on or after this date."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const filter = { unanswered: args.unanswered, hidden: args.hidden, since: args.since };
      const rows = args.media_id
        ? filterComments(
            await mediaComments(graph, args.media_id, row.username, args.per_post),
            filter,
            row.username,
          )
        : await recentComments(graph, row, {
            posts: args.posts,
            perPost: args.per_post,
            ...filter,
          });
      return ok({ count: rows.length, comments: rows });
    }),
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to a comment",
      description:
        "Public reply under a top-level comment (Meta does not allow replying to replies or to hidden comments). The user confirms first.",
      inputSchema: {
        comment_id: z.string(),
        message: z.string().min(1).max(2200),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      // Every check Meta would make, before the user is asked to approve.
      validateCommentText(args.message, "Reply");
      const c = await getComment(graph, args.comment_id);
      validateReplyTarget(c);
      const gate = await confirmGate(
        app,
        server,
        "reply_to_comment",
        args,
        `Reply publicly as @${row.username} to @${c.from?.username ?? c.username} (${quote(c.text ?? "", 80)}):\n${quote(args.message, 600)}`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const r = await replyToComment(graph, args.comment_id, args.message);
      app.db.audit("comment.reply", { comment_id: args.comment_id }, row.ig_user_id);
      return ok({ reply_id: r.id });
    }),
  );

  server.registerTool(
    "comment_on_media",
    {
      title: "Comment on a post",
      description:
        "Add a new top-level comment on one of your posts (e.g. a pinned-style note or first comment). Public; the user confirms first.",
      inputSchema: {
        media_id: z.string(),
        message: z.string().min(1).max(2200),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      validateCommentText(args.message);
      const m = await getMedia(graph, args.media_id);
      if (m.comment_enabled === false)
        throw new IgError("invalid_request", "Comments are turned off on this post.", {
          hint: "Turn them on with toggle_comments first.",
        });
      const gate = await confirmGate(
        app,
        server,
        "comment_on_media",
        args,
        `Comment as @${row.username} on post ${args.media_id}:\n${quote(args.message, 600)}`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const r = await commentOnMedia(graph, args.media_id, args.message);
      app.db.audit("comment.create", {}, row.ig_user_id, args.media_id);
      return ok({ comment_id: r.id });
    }),
  );

  server.registerTool(
    "hide_comment",
    {
      title: "Hide or unhide a comment",
      description:
        "Hide a comment from everyone except its author (or show it again with hide: false). The user confirms first.",
      inputSchema: {
        comment_id: z.string(),
        hide: z.boolean().default(true),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const c = await getComment(graph, args.comment_id);
      if (c.hidden !== undefined && Boolean(c.hidden) === args.hide)
        return ok({ comment_id: args.comment_id, hidden: args.hide, unchanged: true });
      const gate = await confirmGate(
        app,
        server,
        "hide_comment",
        args,
        `${args.hide ? "Hide" : "Unhide"} the comment by @${c.from?.username ?? c.username}: ${quote(c.text ?? "")}.`,
        { publicFacing: true },
      );
      if (gate) return gate;
      await setCommentHidden(graph, args.comment_id, args.hide);
      app.db.audit(
        "comment.hide",
        { hide: args.hide, comment_id: args.comment_id },
        row.ig_user_id,
      );
      return ok({ comment_id: args.comment_id, hidden: args.hide });
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment",
      description:
        "Permanently delete a comment on your post (yours or someone else's). Prefer hide_comment unless it must go. Cannot be undone; the user confirms first.",
      inputSchema: { comment_id: z.string(), account: accountArg, confirmation_token: confirmArg },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const c = await getComment(graph, args.comment_id);
      const gate = await confirmGate(
        app,
        server,
        "delete_comment",
        args,
        `PERMANENTLY DELETE the comment by @${c.from?.username ?? c.username}: ${quote(c.text ?? "")}.`,
        { publicFacing: true, destructive: true },
      );
      if (gate) return gate;
      await deleteComment(graph, args.comment_id);
      app.db.audit("comment.delete", { comment_id: args.comment_id }, row.ig_user_id);
      return ok({ deleted: args.comment_id });
    }),
  );

  server.registerTool(
    "private_reply",
    {
      title: "DM someone who commented",
      description:
        "Send one private Direct message to the person who wrote a comment (e.g. the link they asked for). One message per comment, within 7 days of it. The user confirms first.",
      inputSchema: {
        comment_id: z.string(),
        message: z.string().min(1).max(1000),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      checkDmText(args.message);
      messagesPath(row); // Facebook Login accounts need their Page on record
      const c = await getComment(graph, args.comment_id);
      if (c.timestamp && Date.now() - Date.parse(c.timestamp) > PRIVATE_REPLY_WINDOW_MS)
        throw new IgError(
          "invalid_request",
          "That comment is more than 7 days old; private replies are no longer allowed.",
          {
            hint: "Reply publicly with reply_to_comment instead.",
          },
        );
      const gate = await confirmGate(
        app,
        server,
        "private_reply",
        args,
        `Send a private DM as @${row.username} to @${c.from?.username ?? c.username} (who commented ${quote(c.text ?? "", 80)}):\n${quote(args.message, 600)}`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const r = await privateReply(graph, row, args.comment_id, args.message, c.timestamp);
      app.db.audit("dm.private_reply", { comment_id: args.comment_id }, row.ig_user_id);
      return ok({ sent: true, message_id: r.message_id });
    }),
  );

  // ---- mentions --------------------------------------------------------------------------------------

  server.registerTool(
    "list_mentions",
    {
      title: "Mentions and tags",
      description:
        "Where others mention this account: posts that tagged it, newest first. With comment_id or media_id (from a mention notification) it returns that specific @mention.",
      inputSchema: {
        comment_id: z.string().optional().describe("A comment that @mentioned you."),
        media_id: z.string().optional().describe("A post whose caption @mentioned you."),
        limit: z.number().int().min(1).max(100).default(25),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      if (args.comment_id)
        return ok({
          mentioned_comment: await mentionedComment(graph, row.ig_user_id, args.comment_id),
        });
      if (args.media_id)
        return ok({ mentioned_media: await mentionedMedia(graph, row.ig_user_id, args.media_id) });
      const tagged = await listTagged(graph, row.ig_user_id, args.limit);
      return ok(
        { count: tagged.length, tagged: tagged.map((m) => compactMedia(m)) },
        "Caption and comment @mentions arrive as notifications/webhooks with an id; pass it as media_id or comment_id to read one.",
      );
    }),
  );

  // ---- direct messages --------------------------------------------------------------------------------

  server.registerTool(
    "list_conversations",
    {
      title: "List Direct conversations",
      description:
        "Recent Instagram Direct conversations: who, their last message, and whether you can still reply (Instagram allows replies for 24 hours after their last message).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        user_id: z
          .string()
          .optional()
          .describe("Only the conversation with this Instagram-scoped user ID."),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      const convs = await listConversations(graph, row, {
        limit: args.limit,
        userId: args.user_id,
      });
      return ok({ count: convs.length, conversations: convs });
    }),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Read a conversation",
      description:
        "Messages in one Direct conversation, newest first (Meta returns details for the 20 most recent).",
      inputSchema: {
        conversation_id: z.string(),
        limit: z.number().int().min(1).max(20).default(20),
        account: accountArg,
      },
      annotations: READ,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      return ok(await getConversation(graph, row, args.conversation_id, args.limit));
    }),
  );

  server.registerTool(
    "send_dm",
    {
      title: "Send a Direct message",
      description:
        "Reply in Instagram Direct to someone who messaged this account. Allowed only within 24 hours of their last message (7 days with human_agent if your Meta app has the Human Agent feature). Text up to 1000 bytes. The user confirms first.",
      inputSchema: {
        recipient_id: z
          .string()
          .describe("Their Instagram-scoped ID (with_id from list_conversations)."),
        message: z.string().min(1).max(1000),
        human_agent: z
          .boolean()
          .default(false)
          .describe("Use the HUMAN_AGENT tag (needs Meta approval of the Human Agent feature)."),
        account: accountArg,
        confirmation_token: confirmArg,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const { row, graph } = ctx(args.account);
      // Check the window before asking the user, so approval is never wasted.
      checkDmText(args.message);
      messagesPath(row);
      const w = await checkDmWindow(graph, row, args.recipient_id, args.human_agent);
      if (!w.allowed)
        throw new IgError("forbidden", `Cannot message this person now. ${w.reason}`, {
          hint: "Wait for them to write again.",
        });
      const gate = await confirmGate(
        app,
        server,
        "send_dm",
        args,
        `Send a Direct message as @${row.username} to ${args.recipient_id}:\n${quote(args.message, 600)}`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const r = await sendDm(graph, row, args.recipient_id, args.message, {
        humanAgent: args.human_agent,
        skipWindowCheck: true,
      });
      app.db.audit("dm.send", { recipient: args.recipient_id }, row.ig_user_id);
      return ok({ sent: true, message_id: r.message_id });
    }),
  );
}
