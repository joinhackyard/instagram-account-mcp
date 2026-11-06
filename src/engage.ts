import type { AccountRow } from "./accounts.js";
import { IgError } from "./errors.js";
import { compactMedia, listMedia, type MediaRow } from "./library.js";
import type { Graph } from "./meta/graph.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DM_WINDOW_MS = DAY;
export const HUMAN_AGENT_WINDOW_MS = 7 * DAY;
export const PRIVATE_REPLY_WINDOW_MS = 7 * DAY;
export const DM_MAX_BYTES = 1000;

/** The parts of an account the engagement calls need. */
export type EngageAccount = Pick<AccountRow, "ig_user_id" | "auth_mode" | "page_id" | "username">;

// ---- comments ----------------------------------------------------------------------------------------

interface RawComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
  from?: { id?: string; username?: string };
  parent_id?: string;
  replies?: { data: RawComment[] };
}

export interface CommentRow {
  id: string;
  user?: string;
  user_id?: string;
  text: string;
  at?: string;
  likes?: number;
  hidden?: boolean;
  /** True when the account itself has replied in this thread. */
  answered: boolean;
  replies: { id: string; user?: string; text: string; at?: string; hidden?: boolean }[];
  media?: Pick<MediaRow, "id" | "permalink" | "caption">;
}

const COMMENT_FIELDS =
  "id,text,timestamp,username,like_count,hidden,from{id,username},replies{id,text,timestamp,username,hidden,from{id,username}}";

const userOf = (c: RawComment) => c.from?.username ?? c.username;

export function compactComment(c: RawComment, ownUsername?: string | null): CommentRow {
  const own = (ownUsername ?? "").toLowerCase();
  const replies = (c.replies?.data ?? []).map((r) => ({
    id: r.id,
    user: userOf(r),
    text: r.text ?? "",
    at: r.timestamp,
    hidden: r.hidden,
  }));
  return {
    id: c.id,
    user: userOf(c),
    user_id: c.from?.id,
    text: c.text ?? "",
    at: c.timestamp,
    likes: c.like_count,
    hidden: c.hidden,
    answered: Boolean(own) && replies.some((r) => (r.user ?? "").toLowerCase() === own),
    replies,
  };
}

export interface CommentFilter {
  /** Only comments the account has not replied to (and that are not its own). */
  unanswered?: boolean;
  /** Only hidden comments. */
  hidden?: boolean;
  since?: string;
}

export function filterComments(rows: CommentRow[], f: CommentFilter, ownUsername?: string | null) {
  const own = (ownUsername ?? "").toLowerCase();
  const since = f.since ? Date.parse(f.since) : undefined;
  return rows.filter((c) => {
    if (f.unanswered && (c.answered || (own && (c.user ?? "").toLowerCase() === own))) return false;
    if (f.hidden !== undefined && Boolean(c.hidden) !== f.hidden) return false;
    if (since !== undefined && c.at && Date.parse(c.at) < since) return false;
    return true;
  });
}

/** Top-level comments on one post (Meta returns at most 50 per page), with their replies. */
export async function mediaComments(
  graph: Graph,
  mediaId: string,
  ownUsername: string | null | undefined,
  limit = 50,
): Promise<CommentRow[]> {
  const raw = await graph.paginate<RawComment>(
    `${mediaId}/comments`,
    { fields: COMMENT_FIELDS, limit: Math.min(limit, 50) },
    limit,
  );
  return raw.map((c) => compactComment(c, ownUsername));
}

/** Comments across the most recent posts, newest posts first. */
export async function recentComments(
  graph: Graph,
  acct: EngageAccount,
  o: { posts?: number; perPost?: number } & CommentFilter,
): Promise<CommentRow[]> {
  const media = await listMedia(graph, acct.ig_user_id, { limit: Math.min(o.posts ?? 10, 50) });
  const out: CommentRow[] = [];
  for (const m of media) {
    if (!m.comments_count) continue;
    const rows = await mediaComments(graph, m.id, acct.username, o.perPost ?? 25);
    const c = compactMedia(m, 80);
    for (const r of filterComments(rows, o, acct.username))
      out.push({ ...r, media: { id: c.id, permalink: c.permalink, caption: c.caption } });
  }
  return out;
}

export const COMMENT_MAX_CHARS = 2200;

/** Comment/reply text Meta would accept. Call before asking the user to confirm. */
export function validateCommentText(message: string, what = "Comment") {
  checkText(message, COMMENT_MAX_CHARS, what);
}

/** Meta only allows replies to visible top-level comments. */
export function validateReplyTarget(c: { parent_id?: string; hidden?: boolean }) {
  if (c.parent_id)
    throw new IgError(
      "invalid_request",
      "Meta only allows replies to top-level comments, not to replies.",
      {
        hint: `Reply to the parent comment (${c.parent_id}) instead.`,
      },
    );
  if (c.hidden)
    throw new IgError(
      "invalid_request",
      "This comment is hidden; Meta does not allow replying to it.",
      {
        hint: "Unhide it first with hide_comment (hide: false) if you want to reply.",
      },
    );
}

export async function replyToComment(graph: Graph, commentId: string, message: string) {
  checkText(message, COMMENT_MAX_CHARS, "Reply");
  return graph.post<{ id: string }>(`${commentId}/replies`, { message });
}

export async function commentOnMedia(graph: Graph, mediaId: string, message: string) {
  checkText(message, COMMENT_MAX_CHARS, "Comment");
  return graph.post<{ id: string }>(`${mediaId}/comments`, { message });
}

export async function setCommentHidden(graph: Graph, commentId: string, hide: boolean) {
  return graph.post<{ success?: boolean }>(commentId, { hide });
}

export async function deleteComment(graph: Graph, commentId: string) {
  return graph.delete<{ success?: boolean }>(commentId);
}

export async function getComment(graph: Graph, commentId: string) {
  return graph.get<RawComment & { media?: { id: string } }>(commentId, {
    fields: "id,text,timestamp,username,hidden,parent_id,from{id,username},media{id}",
  });
}

function checkText(s: string, max: number, what: string) {
  if (!s.trim()) throw new IgError("invalid_request", `${what} is empty.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
    throw new IgError("invalid_request", `${what} contains control characters.`);
  if (s.length > max) throw new IgError("invalid_request", `${what} is over ${max} characters.`);
}

// ---- messaging ---------------------------------------------------------------------------------------

/**
 * Send endpoint per login type. Instagram Login: graph.instagram.com/<IG_ID>/messages.
 * Facebook Login: graph.facebook.com/<PAGE_ID>/messages with the Page token.
 */
export function messagesPath(a: EngageAccount): string {
  if (a.auth_mode === "facebook") {
    if (!a.page_id)
      throw new IgError("not_configured", "This account has no linked Facebook Page on record.", {
        hint: "Reconnect it with connect_account.",
      });
    return `${a.page_id}/messages`;
  }
  return `${a.ig_user_id}/messages`;
}

export function conversationsPath(a: EngageAccount): string {
  if (a.auth_mode === "facebook") {
    if (!a.page_id)
      throw new IgError("not_configured", "This account has no linked Facebook Page on record.", {
        hint: "Reconnect it with connect_account.",
      });
    return `${a.page_id}/conversations`;
  }
  return "me/conversations";
}

/** One private DM to someone who commented, within 7 days of the comment. */
export async function privateReply(
  graph: Graph,
  a: EngageAccount,
  commentId: string,
  text: string,
  commentTimestamp?: string,
  now = Date.now(),
) {
  checkDmText(text);
  if (commentTimestamp && now - Date.parse(commentTimestamp) > PRIVATE_REPLY_WINDOW_MS)
    throw new IgError(
      "invalid_request",
      "Private replies are only possible within 7 days of the comment.",
      {
        hint: "Reply publicly with reply_to_comment instead.",
      },
    );
  return graph.post<{ recipient_id?: string; message_id?: string }>(messagesPath(a), {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

interface RawMessage {
  id: string;
  created_time?: string;
  message?: string;
  from?: { id?: string; username?: string };
  to?: { data?: { id?: string; username?: string }[] };
}

interface RawConversation {
  id: string;
  updated_time?: string;
  participants?: { data?: { id?: string; username?: string }[] };
  messages?: { data?: RawMessage[] };
}

export interface MessageRow {
  id: string;
  at?: string;
  from?: string;
  from_id?: string;
  text: string;
  inbound: boolean;
}

export interface ConversationRow {
  id: string;
  updated?: string;
  with?: string;
  with_id?: string;
  last?: MessageRow;
  /** When their last message was, and whether a normal reply is still allowed. */
  can_reply_until?: string;
  can_reply: boolean;
}

function isOwn(a: EngageAccount, who?: { id?: string; username?: string }) {
  if (!who) return false;
  if (who.id && (who.id === a.ig_user_id || who.id === a.page_id)) return true;
  return Boolean(
    who.username && a.username && who.username.toLowerCase() === a.username.toLowerCase(),
  );
}

export function compactMessage(a: EngageAccount, m: RawMessage): MessageRow {
  return {
    id: m.id,
    at: m.created_time,
    from: m.from?.username,
    from_id: m.from?.id,
    text: m.message ?? "",
    inbound: !isOwn(a, m.from),
  };
}

/** Last time the other person wrote; normal replies are allowed for 24 hours after it. */
export function lastInbound(messages: MessageRow[]): number | undefined {
  const t = messages
    .filter((m) => m.inbound && m.at)
    .map((m) => Date.parse(m.at!))
    .filter(Number.isFinite);
  return t.length ? Math.max(...t) : undefined;
}

export function compactConversation(a: EngageAccount, c: RawConversation, now = Date.now()) {
  const other = (c.participants?.data ?? []).find((p) => !isOwn(a, p));
  const msgs = (c.messages?.data ?? []).map((m) => compactMessage(a, m));
  const inbound = lastInbound(msgs);
  const row: ConversationRow = {
    id: c.id,
    updated: c.updated_time,
    with: other?.username,
    with_id: other?.id,
    last: msgs[0],
    can_reply: inbound !== undefined && now - inbound < DM_WINDOW_MS,
  };
  if (inbound !== undefined) row.can_reply_until = new Date(inbound + DM_WINDOW_MS).toISOString();
  return row;
}

const MSG_FIELDS = "id,created_time,from,to,message";

export async function listConversations(
  graph: Graph,
  a: EngageAccount,
  o: { limit?: number; userId?: string } = {},
): Promise<ConversationRow[]> {
  const params: Record<string, unknown> = {
    platform: "instagram",
    fields: `id,updated_time,participants,messages.limit(5){${MSG_FIELDS}}`,
    limit: Math.min(o.limit ?? 20, 50),
  };
  if (o.userId) params.user_id = o.userId;
  const raw = await graph.paginate<RawConversation>(
    conversationsPath(a),
    params,
    Math.min(o.limit ?? 20, 200),
  );
  return raw.map((c) => compactConversation(a, c));
}

/** Messages of one conversation, newest first (Meta details only the 20 most recent). */
export async function getConversation(
  graph: Graph,
  a: EngageAccount,
  conversationId: string,
  limit = 20,
): Promise<{ id: string; messages: MessageRow[] }> {
  const r = await graph.get<RawConversation>(conversationId, {
    fields: `id,messages.limit(${Math.min(limit, 20)}){${MSG_FIELDS}}`,
  });
  return { id: r.id, messages: (r.messages?.data ?? []).map((m) => compactMessage(a, m)) };
}

/** DM text Meta would accept (non-empty, at most 1000 bytes). Call before asking the user to confirm. */
export function checkDmText(text: string) {
  if (!text.trim()) throw new IgError("invalid_request", "The message is empty.");
  if (Buffer.byteLength(text, "utf8") > DM_MAX_BYTES)
    throw new IgError("invalid_request", `Messages can be at most ${DM_MAX_BYTES} bytes.`, {
      hint: "Shorten it or split it into two messages.",
    });
}

export interface DmWindow {
  allowed: boolean;
  last_inbound?: string;
  window_hours: number;
  reason?: string;
}

/** May we message this person now? Normal: 24 h after their last message. Human agent tag: 7 days. */
export function dmWindow(
  lastInboundMs: number | undefined,
  humanAgent: boolean,
  now = Date.now(),
): DmWindow {
  const ms = humanAgent ? HUMAN_AGENT_WINDOW_MS : DM_WINDOW_MS;
  const window_hours = ms / HOUR;
  if (lastInboundMs === undefined)
    return {
      allowed: false,
      window_hours,
      reason:
        "They have not messaged this account. Instagram only lets businesses reply to people who wrote first.",
    };
  const allowed = now - lastInboundMs < ms;
  return {
    allowed,
    last_inbound: new Date(lastInboundMs).toISOString(),
    window_hours,
    reason: allowed
      ? undefined
      : `Their last message was ${Math.round((now - lastInboundMs) / HOUR)} hours ago; the reply window is ${window_hours} hours.`,
  };
}

/** Find the conversation with this person and check the reply window. */
export async function checkDmWindow(
  graph: Graph,
  a: EngageAccount,
  recipientId: string,
  humanAgent = false,
  now = Date.now(),
): Promise<DmWindow & { conversation_id?: string }> {
  const convs = await listConversations(graph, a, { userId: recipientId, limit: 5 });
  const conv = convs.find((c) => c.with_id === recipientId) ?? convs[0];
  if (!conv) return dmWindow(undefined, humanAgent, now);
  const full = await getConversation(graph, a, conv.id, 20);
  const fromThem = full.messages.filter(
    (m) => m.inbound && (!m.from_id || m.from_id === recipientId),
  );
  return { ...dmWindow(lastInbound(fromThem), humanAgent, now), conversation_id: conv.id };
}

export async function sendDm(
  graph: Graph,
  a: EngageAccount,
  recipientId: string,
  text: string,
  o: { humanAgent?: boolean; skipWindowCheck?: boolean; now?: number } = {},
) {
  checkDmText(text);
  if (!o.skipWindowCheck) {
    const w = await checkDmWindow(graph, a, recipientId, o.humanAgent, o.now);
    if (!w.allowed)
      throw new IgError("forbidden", `Cannot message this person now. ${w.reason}`, {
        hint: o.humanAgent
          ? "Nothing more can be sent until they write again."
          : "Wait for them to write again. If your app has Meta's Human Agent feature approved, human_agent: true allows replies for 7 days.",
      });
  }
  const params: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };
  if (o.humanAgent) {
    params.messaging_type = "MESSAGE_TAG";
    params.tag = "HUMAN_AGENT";
  }
  return graph.post<{ recipient_id?: string; message_id?: string }>(messagesPath(a), params);
}

// ---- mentions ----------------------------------------------------------------------------------------

/** A comment that @mentioned the account (comment id from a webhook or notification). */
export async function mentionedComment(graph: Graph, igId: string, commentId: string) {
  const r = await graph.get<{
    mentioned_comment?: {
      id: string;
      text?: string;
      timestamp?: string;
      like_count?: number;
      media?: { id: string; permalink?: string; username?: string };
    };
  }>(igId, {
    fields: `mentioned_comment.comment_id(${commentId}){id,text,timestamp,like_count,media{id,permalink,username}}`,
  });
  if (!r.mentioned_comment) throw new IgError("not_found", "No mention found for that comment ID.");
  return r.mentioned_comment;
}

/** A post whose caption @mentioned the account. */
export async function mentionedMedia(graph: Graph, igId: string, mediaId: string) {
  const r = await graph.get<{
    mentioned_media?: {
      id: string;
      caption?: string;
      media_type?: string;
      permalink?: string;
      timestamp?: string;
      like_count?: number;
      comments_count?: number;
      username?: string;
    };
  }>(igId, {
    fields: `mentioned_media.media_id(${mediaId}){id,caption,media_type,permalink,timestamp,like_count,comments_count,username}`,
  });
  if (!r.mentioned_media) throw new IgError("not_found", "No mention found for that media ID.");
  return r.mentioned_media;
}
