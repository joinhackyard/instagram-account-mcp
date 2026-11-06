import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { App } from "../app.js";
import { canonicalJson, randomToken, sha256 } from "../crypto.js";
import { classifyMetaError, IgError } from "../errors.js";
import { log } from "../log.js";
import type { ProgressEvent } from "../publish/types.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function ok(data: unknown, note?: string): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text: note ? `${note}\n\n${json}` : json }],
  };
}

export function fail(err: unknown): CallToolResult {
  const e = err instanceof IgError ? err : classifyMetaError(err);
  if (!(err instanceof IgError)) log.warn("tool error", { error: String(err) });
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: e.message, code: e.code, hint: e.hint }, null, 2),
      },
    ],
  };
}

/** Wrap a handler so every failure becomes a readable tool error instead of a protocol error. */
export function safe<A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) {
  return async (args: A, extra: Extra): Promise<CallToolResult> => {
    try {
      return await fn(args, extra);
    } catch (e) {
      return fail(e);
    }
  };
}

export const accountArg = z
  .string()
  .optional()
  .describe(
    "Which connected account: @username or Instagram user ID. Omit to use the default account.",
  );

export const confirmArg = z
  .string()
  .optional()
  .describe(
    "Only after the user approved: the confirmation_token returned by the previous call with identical arguments.",
  );

export function progressReporter(extra: Extra) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let last = 0;
  return (e: ProgressEvent) => {
    if (Date.now() - last < 2000) return;
    last = Date.now();
    const pct = e.total ? Math.round((e.sent / e.total) * 100) : 0;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: e.sent,
          total: e.total || undefined,
          message: `${e.status} ${pct}%`,
        },
      })
      .catch(() => undefined);
  };
}

/**
 * Human-in-the-loop gate for actions others can see (publishing, scheduling) and destructive ones.
 * Uses MCP elicitation when the client supports it; otherwise returns a single-use token bound to the
 * exact arguments, so the agent must show the summary to the user and call again.
 */
export async function confirmGate(
  app: App,
  server: McpServer,
  action: string,
  args: Record<string, unknown>,
  summary: string,
  opts: { publicFacing: boolean; destructive?: boolean },
): Promise<CallToolResult | null> {
  const policy = app.cfg.confirmPolicy;
  if (policy === "never") return null;
  if (policy === "public" && !opts.publicFacing && !opts.destructive) return null;

  const { confirmation_token: token, ...rest } = args;
  const payloadHash = sha256(canonicalJson(rest));
  if (typeof token === "string" && token) {
    const row = app.db.get<{
      action: string;
      payload_hash: string;
      expires_at: number;
    }>("select * from confirmations where token = ?", token);
    if (!row || row.expires_at < Date.now())
      throw new IgError("invalid_request", "Confirmation token is invalid or expired.", {
        hint: "Call again without confirmation_token to get a new one.",
      });
    if (row.action !== action || row.payload_hash !== payloadHash) {
      throw new IgError("invalid_request", "The arguments changed since the user confirmed.", {
        hint: "Call again without confirmation_token, and show the user the new summary.",
      });
    }
    // Single use, atomically: only the call that actually deletes the row proceeds.
    if (app.db.run("delete from confirmations where token = ?", token).changes !== 1) {
      throw new IgError("invalid_request", "Confirmation token was already used.");
    }
    return null;
  }

  const caps = server.server.getClientCapabilities();
  if (caps?.elicitation) {
    try {
      const r = await server.server.elicitInput({
        message: `${summary}\n\nProceed?`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: "Yes, go ahead",
              description: summary.split("\n")[0],
            },
          },
          required: ["confirm"],
        },
      });
      if (r.action === "accept" && r.content?.confirm === true) return null;
      return ok(
        { cancelled: true, action },
        "The user did not approve this action. Nothing was changed.",
      );
    } catch (e) {
      log.debug("elicitation unavailable, falling back to token", {
        error: String(e),
      });
    }
  }

  app.db.run("delete from confirmations where expires_at < ?", Date.now());
  const newToken = randomToken("cf_", 12);
  app.db.run(
    "insert into confirmations(token, action, payload_hash, summary, created_at, expires_at) values (?, ?, ?, ?, ?, ?)",
    newToken,
    action,
    payloadHash,
    summary,
    Date.now(),
    Date.now() + 15 * 60_000,
  );
  return ok(
    {
      confirmation_required: true,
      action,
      summary,
      confirmation_token: newToken,
      expires_in_minutes: 15,
    },
    `CONFIRMATION REQUIRED. Nothing has happened yet. Show the user this summary and ask them to approve:\n\n${summary}\n\nOnly if they say yes, call the same tool again with identical arguments plus confirmation_token="${newToken}".`,
  );
}
