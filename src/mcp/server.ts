import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../app.js";
import { APP, VERSION } from "../config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAiTools } from "./tools/ai.js";
import { registerEngageTools } from "./tools/engage.js";
import { registerExperimentTools } from "./tools/experiments.js";
import { registerGrowthTools } from "./tools/growth.js";
import { registerInsightsTools } from "./tools/insights.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerPublishTools } from "./tools/publish.js";

const INSTRUCTIONS = `Manage an Instagram professional account (Business or Creator) through Meta's official Instagram API.

Start with auth_status. If no account is connected, call connect_account (it opens the Meta sign-in in the browser). If the browser lands on a page that does not load, ask the user for that page's address and call complete_connect with it.

What you can do:
- Publish: publish_photo, publish_reel, publish_carousel (2-20 images/videos), publish_story, publish_trial_reel (shown to non-followers first). Give file_path (this computer) or url. Media is converted to Instagram's specs automatically (prepare_media to check first). Add publish_at to schedule; Instagram has no native scheduling, so this server (or its background service) publishes it. Follow get_publish_status until "published". list_scheduled, reschedule, cancel_scheduled, resume_publish, publish_budget, media_host_status, find_location.
- Library: list_media, get_media, list_stories, list_tagged, toggle_comments, delete_media.
- Engage: list_comments, reply_to_comment, comment_on_media, hide_comment, delete_comment, private_reply (DM someone who commented, within 7 days), list_mentions, list_conversations, get_conversation, send_dm (only within 24 hours of their last message), triage_comments.
- Insights: get_media_insights, get_account_insights, get_audience (demographics), export_insights (CSV).
- Grow: analyze_post, find_outliers, best_publish_time, hashtag_research and hashtag_budget (30 unique hashtags per 7 days), benchmark_competitor (any public business/creator account), content_ideas, caption_check.
- A/B test: create_ab_test publishes 2-4 trial reel variants (different video, hook, caption or cover) to non-followers and compares them after a set time. Meta's API cannot share a trial reel to followers: the user does that in the Instagram app, or the winner can be republished as a normal reel. get_ab_test, list_ab_tests, stop_ab_test.
- Create: generate_caption, generate_hashtags, suggest_carousel, critique_cover, translate_caption, repurpose_video (cut vertical reels from a long video). Templates: list_templates, save_template, delete_template.
- AI providers (Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama): see ai_status and set_ai_models. Without one, these tools return the data and a brief so you write the result yourself. They never publish; show drafts to the user.

Facebook Login vs Instagram Login (see auth_status): delete_media, hashtag_research and benchmark_competitor need Facebook Login.
Not possible through Meta's API: adding licensed music, filters, story stickers or links, shopping tags, editing a published caption, and posting from personal accounts.

Safety: anything others can see (publishing, scheduling, replies, DMs, hiding comments) or destructive needs the user's approval. If a tool returns CONFIRMATION REQUIRED, show the summary to the user and only call again with the confirmation_token after they say yes. Never invent approval.`;

export function buildServer(app: App): McpServer {
  const server = new McpServer(
    { name: APP, title: "Instagram Account Manager", version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerAccountTools(server, app);
  registerPublishTools(server, app);
  registerLibraryTools(server, app);
  registerEngageTools(server, app);
  registerInsightsTools(server, app);
  registerGrowthTools(server, app);
  registerExperimentTools(server, app);
  registerAiTools(server, app);

  server.registerPrompt(
    "publish_post",
    {
      title: "Publish to Instagram",
      description:
        "Guided flow: look at the media → caption and hashtags → preview → publish or schedule.",
      argsSchema: {
        file_path: z.string().describe("Path to the image or video on this computer"),
        template: z.string().optional().describe("Template name (see list_templates)"),
        when: z.string().optional().describe('"now" or a date-time to schedule'),
      },
    },
    ({ file_path, template, when }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Publish ${file_path} to my Instagram.`,
              template
                ? `Use the "${template}" template.`
                : "Check list_templates and use one if it fits.",
              `When: ${when ?? "ask me"}.`,
              "Steps: auth_status; prepare_media to check the file; generate_caption (and generate_hashtags) and show me 2-3 caption options; best_publish_time if I did not give a time; then the right publish_* tool, and follow get_publish_status until it is published. Ask before anything goes public.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  return server;
}
