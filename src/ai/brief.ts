import { CAPTION_LIMITS, VISIBLE_CHARS, type Template } from "../templates.js";

/**
 * The connected agent (Claude, Hermes, ...) is already a strong writer, so when no AI provider is
 * configured the tools return a tight brief instead: the material, the template, Instagram's hard
 * limits and a checklist. The agent writes the result itself.
 */
export interface Brief {
  instructions: string[];
  output_shape: unknown;
  template?: {
    name: string;
    added_automatically: {
      header?: string;
      footer?: string;
      hashtags?: string[];
      hashtags_in?: string;
      mentions?: string[];
      first_comment?: string;
    };
    guidance?: string;
  };
  [k: string]: unknown;
}

export function templateSummary(t?: Template): Brief["template"] {
  if (!t) return undefined;
  return {
    name: t.name,
    added_automatically: {
      header: t.caption_header,
      footer: t.caption_footer,
      hashtags: t.hashtags,
      hashtags_in: t.hashtags_in,
      mentions: t.mentions,
      first_comment: t.first_comment,
    },
    guidance: t.guidance,
  };
}

const LIMITS = `Instagram limits: caption at most ${CAPTION_LIMITS.maxChars} characters, ${CAPTION_LIMITS.maxHashtags} hashtags and ${CAPTION_LIMITS.maxMentions} @mentions. About ${VISIBLE_CHARS} characters show before "more".`;

export type PostFormat = "reel" | "photo" | "carousel" | "story";

export function captionBrief(input: {
  context: string;
  format: PostFormat;
  template?: Template;
  language?: string;
  notes?: string;
  count: number;
}): Brief {
  return {
    instructions: [
      `Write ${input.count} different Instagram caption options for this ${input.format}, then show them to the user. Publishing tools apply the template automatically, so do not repeat its footer or hashtags.`,
      `First line is the hook: under ${VISIBLE_CHARS} characters, makes sense alone, makes people tap "more" or keep watching. No clickbait that the post doesn't deliver.`,
      "Then 1 to 4 short lines of value or story, line breaks between ideas, and one clear call to action (comment, save, share, or follow) at the end.",
      "3 to 8 specific hashtags (mix niche and broad); no hashtag walls. At most 2 emoji unless the voice says otherwise.",
      input.format === "reel"
        ? "For reels, also give an on-screen hook text (max 8 words) for the first 2 seconds."
        : "",
      input.format === "carousel"
        ? "For carousels, the caption should make people swipe: promise what the last slide delivers."
        : "",
      LIMITS,
      input.template?.guidance ? `Account voice (must follow): ${input.template.guidance}` : "",
      input.language ? `Write in: ${input.language}.` : "Write in the language of the material.",
      input.notes ? `Notes from the user: ${input.notes}` : "",
      "Check the chosen caption with caption_check before publishing.",
    ].filter(Boolean),
    output_shape: {
      options: [
        {
          hook: "first line",
          caption: "full caption without the template footer",
          hashtags: ["#..."],
          cta: "the call to action used",
          on_screen_hook: "reels only",
        },
      ],
      recommended: 0,
    },
    template: templateSummary(input.template),
    material: input.context,
  };
}

export function genericBrief(
  task: string,
  instructions: string[],
  output_shape: unknown,
  material: Record<string, unknown>,
  template?: Template,
): Brief {
  return {
    instructions: [
      task,
      ...instructions,
      template?.guidance ? `Account voice (must follow): ${template.guidance}` : "",
    ].filter(Boolean),
    output_shape,
    template: templateSummary(template),
    ...material,
  };
}
