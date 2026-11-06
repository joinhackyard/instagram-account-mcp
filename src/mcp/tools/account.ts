import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccountRow } from "../../accounts.js";
import { describeAccount } from "../../accounts.js";
import type { App } from "../../app.js";
import { describeAi } from "../../ai/providers.js";
import { PACKAGE, VERSION } from "../../config.js";
import { openBrowser } from "../../connect.js";
import { peakUsage, usageFor } from "../../meta/graph.js";
import { redirectUriFor } from "../../meta/oauth.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const KNOWN_LIMITS = [
  "Only Business and Creator (professional) accounts work; personal accounts must switch first (free, in the Instagram app).",
  "Meta's API cannot add licensed music, filters, story stickers or link stickers, shopping tags, or edit a caption after publishing.",
  "Instagram limits each account to a fixed number of API-published posts per rolling 24 hours (read live via publish_budget).",
  "Trial reels cannot be shared to followers through the API: the user does that in the Instagram app (or picks automatic graduation).",
];

export function registerAccountTools(server: McpServer, app: App) {
  server.registerTool(
    "auth_status",
    {
      title: "Connection status",
      description:
        "Show whether the Meta app is configured, which Instagram accounts are connected (and whether their sign-in is healthy), the default account, the login type, the media host, AI providers and Meta API usage. Call this first in a new conversation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const accounts = app.accounts.list();
      const configured = Boolean(app.cfg.meta.appId && app.cfg.meta.appSecret);
      const next: string[] = [];
      if (!configured)
        next.push(
          `The Meta app is not set up. Ask the user to run \`npx ${PACKAGE} setup\` in a terminal.`,
        );
      else if (!accounts.length) next.push("No account connected. Call connect_account.");
      for (const a of accounts)
        if (a.status !== "ok")
          next.push(`@${a.username} needs to be reconnected: call connect_account.`);
      return ok({
        version: VERSION,
        meta_app_configured: configured,
        login_type: app.cfg.meta.authMode === "facebook" ? "Facebook Login" : "Instagram Login",
        graph_api_version: app.cfg.meta.graphVersion,
        redirect_uri: redirectUriFor(app.cfg),
        token_storage: app.vault.kind,
        accounts: accounts.map((a) => ({
          ...describeAccount(a),
          api_usage_percent: Math.round(peakUsage(usageFor(a.ig_user_id))) || undefined,
        })),
        media_host: app.hosts.activeKind(),
        confirm_policy: app.cfg.confirmPolicy,
        ai: describeAi(app.cfg.ai),
        known_limits: KNOWN_LIMITS,
        next_steps: next,
      });
    }),
  );

  server.registerTool(
    "connect_account",
    {
      title: "Connect an Instagram account",
      description:
        "Start the Meta sign-in to connect (or reconnect) Instagram professional accounts. Opens the browser on this computer and returns the sign-in link. With Facebook Login the user selects the Facebook Page(s) their Instagram account is linked to; every linked account is connected. Waits up to wait_seconds for them to finish. If the browser lands on a page that does not load, ask the user to copy that page's full address and call complete_connect with it.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(90)
          .describe("How long to wait for the sign-in to finish before returning."),
        open_browser: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ wait_seconds, open_browser }) => {
      const { url, done, reused, listening, redirectUri } = await app.connector.start();
      const opened = open_browser && !reused ? openBrowser(url) : false;
      const result = await waitFor(done, wait_seconds);
      if (result && "rows" in result)
        return ok(
          { connected: result.rows.map(describeAccount) },
          `Connected ${result.rows.map((r) => `@${r.username}`).join(", ")}. Posts that were waiting on this sign-in continue automatically.`,
        );
      if (result && "error" in result) throw result.error;
      return ok(
        { pending: true, sign_in_url: url, browser_opened: opened, redirect_uri: redirectUri },
        [
          `Waiting for the user to finish the sign-in. ${opened ? "A browser tab was opened." : "Give the user this link to open on this computer:"} ${url}`,
          listening
            ? "After they finish, call auth_status (or connect_account again to keep waiting)."
            : `The redirect (${redirectUri}) cannot be caught automatically: after signing in, the user copies the full address of the page they land on (it may not load; that is fine) and you call complete_connect with it.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "complete_connect",
    {
      title: "Finish a sign-in with the callback URL",
      description:
        "Finish a connect_account sign-in by giving the full URL the browser landed on after approving (it contains ?code=...&state=...). Use when the callback page did not load or the sign-in was done on another device.",
      inputSchema: {
        callback_url: z
          .string()
          .describe("The full address-bar URL after approving, starting with http."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ callback_url }) => {
      const rows = await app.connector.complete(callback_url);
      return ok(
        { connected: rows.map(describeAccount) },
        `Connected ${rows.map((r) => `@${r.username}`).join(", ")}.`,
      );
    }),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List connected accounts",
      description: "List the Instagram accounts connected to this server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => ok({ accounts: app.accounts.list().map(describeAccount) })),
  );

  server.registerTool(
    "get_profile",
    {
      title: "Account profile",
      description:
        "Live profile of a connected account: username, name, biography, website, followers, following, media count, profile picture.",
      inputSchema: { account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ account }) => {
      const row = app.accounts.resolve(account);
      const fields = [
        "id",
        "username",
        "name",
        "biography",
        "website",
        "followers_count",
        "follows_count",
        "media_count",
        "profile_picture_url",
      ];
      if (row.auth_mode === "instagram") fields.push("account_type");
      const p = await app.accounts.client(row).get(row.ig_user_id, { fields: fields.join(",") });
      await app.accounts.refreshProfile(row).catch(() => undefined);
      return ok({ ...p, url: `https://www.instagram.com/${String(p.username ?? row.username)}/` });
    }),
  );

  server.registerTool(
    "set_default_account",
    {
      title: "Set the default account",
      description: "Choose which connected account is used when a tool call does not name one.",
      inputSchema: { account: z.string().describe("@username or Instagram user ID.") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ account }) => {
      const row = app.accounts.resolve(account);
      app.accounts.setDefault(row.id);
      return ok({ default: describeAccount(app.accounts.byRowId(row.id)!) });
    }),
  );

  server.registerTool(
    "disconnect_account",
    {
      title: "Disconnect an account",
      description:
        "Remove a connected account from this server and delete its stored token. With revoke=true (Facebook Login) it also removes this app's permissions from the Facebook user. Scheduled posts for it stop. Needs the user's confirmation.",
      inputSchema: {
        account: accountArg,
        revoke: z.boolean().default(false),
        confirmation_token: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row: AccountRow =
        app.accounts
          .list()
          .find(
            (a) =>
              args.account && [a.username, `@${a.username}`, a.ig_user_id].includes(args.account),
          ) ?? app.accounts.resolve(args.account);
      const scheduled = app.jobs.list({
        accountRowId: row.id,
        status: ["scheduled", "ready", "queued"],
      }).length;
      const gate = await confirmGate(
        app,
        server,
        "disconnect_account",
        args,
        `Disconnect @${row.username}${args.revoke ? " and revoke the app's permissions" : ""}.${scheduled ? ` ${scheduled} scheduled/queued post(s) will be cancelled.` : ""}`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      for (const j of app.jobs.list({
        accountRowId: row.id,
        status: ["scheduled", "ready", "queued"],
      }))
        try {
          app.jobs.cancel(j.id);
        } catch {
          /* already publishing: leave it to finish */
        }
      await app.accounts.disconnect(row.id, args.revoke);
      return ok({ disconnected: `@${row.username}` });
    }),
  );
}

async function waitFor<T>(done: Promise<T[]>, seconds: number) {
  return Promise.race([
    done.then((rows) => ({ rows })),
    done.catch((e: Error) => ({ error: e })),
    new Promise<null>((r) => setTimeout(() => r(null), seconds * 1000).unref()),
  ]);
}
