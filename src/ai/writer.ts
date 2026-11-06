import { z } from "zod";
import type { AiSettings } from "../config.js";
import { IgError } from "../errors.js";
import { applyCaptionTemplate, checkCaption, type Template } from "../templates.js";
import type { PostFormat } from "./brief.js";
import { AI_NOT_CONFIGURED_HINT, generateJson, type ImageInput } from "./providers.js";

/** Shared voice for everything the server writes. Specific and honest beats clickbait. */
const CRAFT = `You are an expert Instagram strategist and copywriter who has grown many creator and brand accounts.
Principles:
- The first frame and the first line decide everything: people scroll in under 2 seconds.
- Hooks are specific: a result, a surprising fact, a tension, a question the viewer already has. Never promise what the post doesn't deliver.
- Reels: hook text on screen in the first 2 seconds, one idea, a payoff, a loop or a reason to rewatch. Shares and saves matter more than likes.
- Carousels: slide 1 is a headline that makes people swipe; one point per slide; the last slide pays off and asks for a save or share.
- Captions: hook line under 125 characters, short lines, one call to action. 3 to 8 relevant hashtags beat 30 generic ones.
- No fake urgency, no engagement bait ("comment YES"), no ALL CAPS, at most 2 emoji unless the account voice says otherwise.
- Write in the language of the material unless told otherwise.`;

function voice(template?: Template) {
  return template?.guidance ? `\nAccount voice (must follow): ${template.guidance}` : "";
}

async function run<T>(
  ai: AiSettings,
  task: "text" | "vision",
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  images?: ImageInput[],
) {
  const r = await generateJson(ai, task, { system, prompt, schema, images });
  if (!r)
    throw new IgError(
      "not_configured",
      `No AI ${task === "vision" ? "vision" : "writing"} model is configured.`,
      { hint: AI_NOT_CONFIGURED_HINT },
    );
  return r;
}

// ---- captions -------------------------------------------------------------------------------------

const CaptionDraft = z.object({
  options: z
    .array(
      z.object({
        hook: z.string().describe("The first line, under 125 characters"),
        caption: z.string().describe("Full caption without the template footer or hashtags"),
        hashtags: z.array(z.string()).describe("3 to 8, each starting with #"),
        cta: z.string().describe("The call to action used"),
        on_screen_hook: z.string().describe("Reels: max 8 words of on-screen text; else empty"),
        angle: z.string().describe("Why this version works"),
      }),
    )
    .describe("Distinct options, not rewordings"),
  recommended: z.number().describe("0-based index of the best option"),
});

export async function draftCaptions(
  ai: AiSettings,
  input: {
    context: string;
    format: PostFormat;
    template?: Template;
    language?: string;
    notes?: string;
    count: number;
  },
) {
  const prompt = [
    `Write ${input.count} Instagram caption options for this ${input.format}.`,
    input.template?.caption_footer
      ? "The template appends a footer with the call to action and links; don't repeat it."
      : "",
    input.template?.hashtags?.length
      ? `The template adds these hashtags automatically; don't repeat them: ${input.template.hashtags.join(" ")}`
      : "",
    input.language ? `Write in: ${input.language}.` : "",
    input.notes ? `Notes from the creator: ${input.notes}` : "",
    `\nMaterial:\n${input.context}`,
  ]
    .filter(Boolean)
    .join("\n");
  const { data, model } = await run(
    ai,
    "text",
    CRAFT + voice(input.template),
    prompt,
    CaptionDraft,
  );
  const options = data.options.map((o) => {
    const raw = [
      o.caption.trim(),
      o.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");
    let ready: ReturnType<typeof applyCaptionTemplate> | null = null;
    let problems: string[] = [];
    try {
      ready = applyCaptionTemplate(raw, input.template);
    } catch (e) {
      problems = [(e as Error).message];
    }
    return {
      ...o,
      ready_to_use: ready
        ? { caption: ready.caption, first_comment: ready.first_comment }
        : undefined,
      warnings: ready?.warnings ?? [],
      problems: problems.length ? problems : checkCaption(ready?.caption ?? raw),
    };
  });
  const recommended = Math.min(Math.max(0, Math.round(data.recommended)), options.length - 1);
  return { model, options, recommended };
}

// ---- hashtags -------------------------------------------------------------------------------------

const HashtagPlan = z.object({
  hashtags: z.array(
    z.object({
      tag: z.string().describe("Starts with #"),
      tier: z.enum(["broad", "niche", "community", "branded", "location"]),
      why: z.string(),
    }),
  ),
  recommended_set: z.array(z.string()).describe("The 5 to 10 to actually use, in order"),
  avoid: z.array(z.string()).describe("Banned, spammy or irrelevant tags to avoid"),
});

export async function suggestHashtags(
  ai: AiSettings,
  input: {
    topic: string;
    caption?: string;
    count: number;
    evidence?: unknown;
    template?: Template;
  },
) {
  return run(
    ai,
    "text",
    `${CRAFT}\nHashtags help Instagram understand the topic; relevance beats volume. Mix a few broad tags with specific niche and community tags. Never suggest banned or engagement-bait tags (#followforfollow, #like4like).`,
    [
      `Suggest up to ${input.count} hashtags for this post.`,
      `Topic: ${input.topic}`,
      input.caption ? `Caption:\n${input.caption}` : "",
      input.template?.hashtags?.length
        ? `Branded tags already added by the template: ${input.template.hashtags.join(" ")}`
        : "",
      input.evidence
        ? `Data from Instagram hashtag search (use it to judge which tags are active):\n${JSON.stringify(input.evidence).slice(0, 20_000)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    HashtagPlan,
  );
}

// ---- carousel -------------------------------------------------------------------------------------

const CarouselPlan = z.object({
  title: z.string(),
  slides: z.array(
    z.object({
      n: z.number(),
      headline: z.string().describe("Large text, max 10 words"),
      body: z.string().describe("Supporting text, max 30 words; empty for pure headline slides"),
      visual: z.string().describe("What is on the slide: photo, diagram, screenshot, chart"),
    }),
  ),
  caption: z.string(),
  hashtags: z.array(z.string()),
  design_notes: z.string(),
});

export async function carouselOutline(
  ai: AiSettings,
  input: { source: string; slides: number; template?: Template; audience?: string },
) {
  return run(
    ai,
    "text",
    CRAFT + voice(input.template),
    `Turn this material into an Instagram carousel of ${input.slides} slides (max 20). Slide 1 is the hook; the last slide pays off and asks for a save or share.${input.audience ? ` Audience: ${input.audience}.` : ""}\n\nMaterial:\n${input.source.slice(0, 60_000)}`,
    CarouselPlan,
  );
}

// ---- covers ---------------------------------------------------------------------------------------

const CoverCritique = z.object({
  ranking: z.array(
    z.object({
      index: z.number().describe("0-based position of the image as given"),
      score: z.number().describe("1 to 10"),
      stops_the_scroll: z.number().describe("1 to 10"),
      readable_in_grid: z.number().describe("1 to 10, as a small 3:4 grid tile"),
      subject_clarity: z.number().describe("1 to 10"),
      fits_the_post: z.number().describe("1 to 10"),
      strengths: z.array(z.string()),
      fixes: z.array(z.string()),
    }),
  ),
  best_index: z.number(),
  summary: z.string(),
});

export async function critiqueCovers(ai: AiSettings, images: ImageInput[], context: string) {
  return run(
    ai,
    "vision",
    `${CRAFT}\nJudge covers as people see them: full screen in the Reels feed (9:16) and as a small 3:4 tile in the profile grid. Text must stay inside the centre 3:4 area. Scores 1 to 10.`,
    `Post: ${context}\nRate each of the ${images.length} images (in order, index from 0), then pick the best cover.`,
    CoverCritique,
    images,
  );
}

// ---- translation ----------------------------------------------------------------------------------

const Translations = z.object({
  translations: z.array(z.object({ language: z.string(), caption: z.string() })),
});

export async function translateCaption(ai: AiSettings, caption: string, languages: string[]) {
  return run(
    ai,
    "text",
    "You localise Instagram captions. Keep meaning, tone and the hook; adapt idioms; keep links, @mentions and #hashtags unchanged; stay under 2200 characters.",
    `Languages (BCP-47): ${languages.join(", ")}\n\nCaption:\n${caption}`,
    Translations,
  );
}

// ---- reels from long videos -----------------------------------------------------------------------

const ClipPlan = z.object({
  clips: z.array(
    z.object({
      start: z.number().describe("seconds"),
      end: z.number().describe("seconds"),
      hook: z.string().describe("The first line viewers hear or read"),
      on_screen_text: z.string().describe("Max 8 words for the first 2 seconds"),
      caption: z.string(),
      why: z.string(),
      score: z.number().describe("1 to 10 potential"),
    }),
  ),
});

export async function pickClips(
  ai: AiSettings,
  transcript: string,
  count: number,
  minSeconds: number,
  maxSeconds: number,
  template?: Template,
) {
  return run(
    ai,
    "text",
    `${CRAFT}${voice(template)}\nYou find the moments in long videos that work as standalone reels: a strong first line within 2 seconds, one clear idea, a payoff, no missing context.`,
    `Pick the ${count} best reel clips (each ${minSeconds} to ${maxSeconds} seconds; start and end on sentence boundaries). Transcript with timestamps:\n${transcript}`,
    ClipPlan,
  );
}

// ---- ideas ----------------------------------------------------------------------------------------

const Ideas = z.object({
  ideas: z.array(
    z.object({
      idea: z.string(),
      format: z.enum(["reel", "carousel", "photo", "story", "series"]),
      hook: z.string(),
      angle: z.string(),
      why_now: z.string().describe("Evidence from the data: what over-performed, comments, topic"),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

export async function contentIdeas(
  ai: AiSettings,
  facts: unknown,
  count: number,
  template?: Template,
) {
  return run(
    ai,
    "text",
    CRAFT + voice(template),
    `Suggest ${count} next posts for this account, grounded in the data below. Prefer formats and topics that already over-performed (shares and saves per reach weigh most), answer audience questions, or extend a series.\n\n${JSON.stringify(facts, null, 1)}`,
    Ideas,
  );
}

// ---- comments -------------------------------------------------------------------------------------

const CommentTriage = z.object({
  summary: z.string(),
  sentiment: z
    .object({ positive: z.number(), neutral: z.number(), negative: z.number() })
    .describe("Shares that add up to 1"),
  comments: z.array(
    z.object({
      comment_id: z.string(),
      category: z.enum([
        "question",
        "praise",
        "feedback",
        "complaint",
        "lead",
        "spam",
        "abuse",
        "other",
      ]),
      priority: z.enum(["high", "medium", "low"]),
      suggested_reply: z.string().describe("Empty when no reply is needed"),
      action: z.enum(["reply", "private_reply", "hide", "delete", "none"]),
    }),
  ),
  content_ideas: z
    .array(z.object({ idea: z.string(), evidence: z.string() }))
    .describe("Posts the audience is asking for"),
});

export async function triageComments(
  ai: AiSettings,
  comments: { id: string; text: string; username?: string; likes?: number; post?: string }[],
  accountVoice?: string,
) {
  return run(
    ai,
    "text",
    `You manage community for an Instagram account. Replies are warm, brief and specific; never argue; never invent facts. Leads (people asking about buying, hiring, partnering) get a private_reply suggestion. Spam and scams get hide.${accountVoice ? `\nAccount voice: ${accountVoice}` : ""}`,
    `Triage these comments. Use the given ids exactly.\n${JSON.stringify(comments)}`,
    CommentTriage,
  );
}
