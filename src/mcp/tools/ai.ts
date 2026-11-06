import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { captionBrief, genericBrief, type PostFormat } from "../../ai/brief.js";
import {
  AI_NOT_CONFIGURED_HINT,
  describeAi,
  generateJson,
  parseModelRef,
  PROVIDERS,
  resolveModel,
  saveModels,
  type ImageInput,
} from "../../ai/providers.js";
import { parseCaptions, timestampedText, transcribeFile } from "../../ai/transcript.js";
import {
  carouselOutline,
  contentIdeas,
  critiqueCovers,
  draftCaptions,
  pickClips,
  suggestHashtags,
  translateCaption,
  triageComments,
} from "../../ai/writer.js";
import { AI_TASKS, PACKAGE, type AiTask } from "../../config.js";
import { mediaComments, recentComments, type CommentRow } from "../../engage.js";
import { IgError } from "../../errors.js";
import { compactMedia, listMedia, productOf } from "../../library.js";
import { extractFrames, probe, requireFfmpeg, runCmd } from "../../media.js";
import { guessType } from "../../media/prepare.js";
import { expandPath } from "../../publish/sources.js";
import { median } from "../../stats.js";
import {
  applyCaptionTemplate,
  checkCaption,
  countHashtags,
  countMentions,
  TemplateSchema,
  VISIBLE_CHARS,
  type Template,
} from "../../templates.js";
import { accountArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FORMATS = ["reel", "photo", "carousel", "story"] as const;

/** Read a local image for a vision model. Only real JPG/PNG/WebP files under 20 MB are accepted. */
export function imageInput(path: string): ImageInput {
  const full = expandPath(path);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new IgError("file_error", `Image not found: ${full}`);
  if (st.size > MAX_IMAGE_BYTES) throw new IgError("file_error", `${full} is larger than 20 MB.`);
  const data = readFileSync(full);
  const mime: ImageInput["mime"] | null =
    data[0] === 0xff && data[1] === 0xd8
      ? "image/jpeg"
      : data.toString("latin1", 1, 4) === "PNG"
        ? "image/png"
        : data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw new IgError("file_error", `${full} is not a JPG, PNG or WebP image.`);
  return { mime, data: data.toString("base64") };
}

/** Read a transcript or text file (.srt, .vtt, .sbv, .txt, .md) under 5 MB. */
export function readTextFile(path: string): string {
  const full = expandPath(path);
  if (!/\.(srt|vtt|txt|sbv|md|markdown)$/i.test(full))
    throw new IgError("file_error", "Text files must be .srt, .vtt, .sbv, .txt or .md.");
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new IgError("file_error", `File not found: ${full}`);
  if (st.size > 5 * 1024 * 1024) throw new IgError("file_error", "File is larger than 5 MB.");
  return readFileSync(full, "utf8");
}

function transcriptText(raw: string, path: string): string {
  return /\.(srt|vtt|sbv)$/i.test(path) ? timestampedText(parseCaptions(raw), 10) : raw;
}

const CTA =
  /\b(comment|save|share|follow|tag|dm|message|link in bio|tap|click|subscribe|join|sign up|book|shop|download|try|reply|let me know|tell me|what do you think)\b|\?\s*$/im;

/** Deterministic caption review: Instagram's hard limits plus craft rules. */
export function reviewCaption(caption: string) {
  const lines = caption.split("\n");
  const firstLine = (lines.find((l) => l.trim()) ?? "").trim();
  const chars = [...caption].length;
  const hashtags = countHashtags(caption);
  const mentions = countMentions(caption);
  const problems = checkCaption(caption);
  const suggestions: string[] = [];
  if (!firstLine) suggestions.push("The caption is empty.");
  if ([...firstLine].length > VISIBLE_CHARS)
    suggestions.push(
      `First line is ${[...firstLine].length} characters; only about ${VISIBLE_CHARS} show before "more". Put the hook first and keep it short.`,
    );
  if (/^#/.test(firstLine)) suggestions.push("Don't start with hashtags; start with the hook.");
  if (hashtags > 15)
    suggestions.push(`${hashtags} hashtags reads as spam; 3 to 8 relevant ones work better.`);
  if (hashtags === 0)
    suggestions.push("Add 3 to 8 specific hashtags so Instagram understands the topic.");
  if (!CTA.test(caption))
    suggestions.push(
      "No call to action: end with a question or ask people to save, share or comment.",
    );
  if (/\b(comment|type)\s+["“]?[A-Z]{2,}["”]?\b/.test(caption))
    suggestions.push(
      '"Comment WORD" prompts can be treated as engagement bait; prefer a real question.',
    );
  if ((caption.match(/\p{Extended_Pictographic}/gu) ?? []).length > 6)
    suggestions.push("Many emoji; keep a few so the text stays readable.");
  if (/\bhttps?:\/\//i.test(caption))
    suggestions.push(
      'Links in captions are not clickable on Instagram; say "link in bio" instead.',
    );
  return {
    ok: problems.length === 0,
    problems,
    suggestions,
    stats: {
      characters: chars,
      first_line_characters: [...firstLine].length,
      hashtags,
      mentions,
      lines: lines.length,
    },
  };
}

/** Cut [start, end] into a vertical 1080x1920 H.264 clip (reels allow up to 15 minutes). */
export async function cutVertical(
  file: string,
  start: number,
  end: number,
  output: string,
  layout: "crop" | "blur" | "original" = "crop",
): Promise<{ path: string; duration: number }> {
  await requireFfmpeg();
  const duration = end - start;
  if (duration <= 0) throw new IgError("invalid_request", "end must be after start.");
  if (duration < 3) throw new IgError("invalid_request", "Reels must be at least 3 seconds.");
  if (duration > 900) throw new IgError("invalid_request", "Reels can be at most 15 minutes.");
  const video =
    layout === "crop"
      ? ["-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"]
      : layout === "blur"
        ? [
            "-filter_complex",
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2",
          ]
        : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
  const r = await runCmd("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    start.toFixed(2),
    "-to",
    end.toFixed(2),
    "-i",
    file,
    ...video,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ]);
  if (r.code !== 0)
    throw new IgError("file_error", `ffmpeg failed: ${r.stderr.trim().split("\n").pop() ?? ""}`);
  const out = await stat(output).catch(() => null);
  if (!out || out.size < 1024)
    throw new IgError(
      "file_error",
      "ffmpeg produced no clip: check that start and end are inside the video.",
    );
  return { path: output, duration: Math.round(duration * 10) / 10 };
}

export function registerAiTools(server: McpServer, app: App) {
  const outDir = (kind: string) => {
    const d = join(app.cfg.home, kind);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const template = (name?: string): Template | undefined =>
    name ? app.templates.get(name) : undefined;
  const noAi = (task: AiTask = "text") => !resolveModel(app.cfg.ai, task);
  const noAiNote = (what: string) => `No AI model connected: ${what} ${AI_NOT_CONFIGURED_HINT}`;

  /** Material for writing: text, a transcript file, or a local video (transcribed when possible). */
  const material = async (a: {
    description?: string;
    transcript_path?: string;
    file_path?: string;
  }): Promise<{ text: string; images?: ImageInput[]; note?: string }> => {
    const parts: string[] = [];
    let images: ImageInput[] | undefined;
    let note: string | undefined;
    if (a.description) parts.push(a.description);
    if (a.transcript_path)
      parts.push(
        `Transcript:\n${transcriptText(readTextFile(a.transcript_path), a.transcript_path)}`,
      );
    if (a.file_path) {
      const full = expandPath(a.file_path);
      if (!existsSync(full)) throw new IgError("file_error", `File not found: ${full}`);
      const type = guessType(full);
      if (type === "image") images = [imageInput(full)];
      else if (type === "video" && !a.transcript_path) {
        if (resolveModel(app.cfg.ai, "transcribe")) {
          const segs = await transcribeFile(app.cfg, full);
          parts.push(`Transcript:\n${timestampedText(segs, 10)}`);
        } else
          note =
            "The video was not transcribed (no transcription model). Describe what happens in it, or connect one with `ai`.";
      }
    }
    if (!parts.length && !images)
      throw new IgError("invalid_request", "Pass description, transcript_path or file_path.");
    return { text: parts.join("\n\n") || "(see the attached image)", images, note };
  };

  // ---- providers ---------------------------------------------------------------------------------

  server.registerTool(
    "ai_status",
    {
      title: "AI providers and models",
      description:
        "Which AI providers are connected (Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama, custom) and which model each job uses: text (captions, analysis), vision (covers, images), image, transcribe. Keys are never shown.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok({
        ...describeAi(app.cfg.ai),
        capabilities: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.tasks])),
        setup: `Add or change providers and keys in a terminal: \`npx ${PACKAGE} ai\`. Keys never go through chat.`,
      }),
    ),
  );

  server.registerTool(
    "set_ai_models",
    {
      title: "Choose AI models",
      description:
        'Pick which connected provider and model handle each job, as "provider:model" (Azure: "azure:<deployment>"), e.g. text "anthropic:claude-opus-5-5", vision "openai:gpt-5.5", transcribe "groq:whisper-large-v3". Pass null to go back to the automatic choice.',
      inputSchema: {
        text: z.string().nullable().optional(),
        vision: z.string().nullable().optional(),
        image: z.string().nullable().optional(),
        transcribe: z.string().nullable().optional(),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Reasoning effort for Claude and OpenAI reasoning models (default medium)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const models: Partial<Record<AiTask, string | null>> = {};
      for (const t of AI_TASKS) {
        const v = args[t];
        if (v === undefined) continue;
        if (v !== null) {
          const ref = parseModelRef(v);
          if (!ref) throw new IgError("invalid_request", `"${v}" is not provider:model.`);
          if (!PROVIDERS[ref.provider].tasks.includes(t))
            throw new IgError("invalid_request", `${PROVIDERS[ref.provider].label} can't do ${t}.`);
        }
        models[t] = v;
        if (v) app.cfg.ai.models[t] = v;
        else delete app.cfg.ai.models[t];
      }
      if (args.effort) app.cfg.ai.effort = args.effort;
      saveModels(app.db, models, args.effort);
      return ok(describeAi(app.cfg.ai));
    }),
  );

  // ---- writing -----------------------------------------------------------------------------------

  server.registerTool(
    "generate_caption",
    {
      title: "Write caption options",
      description:
        "Drafts caption options (hook first line, short body, call to action, hashtags, and on-screen hook text for reels) from a description, a transcript file, or the media file itself (images are looked at; videos are transcribed when a transcription model is connected). Applies the template and checks Instagram's limits. Drafts only: nothing is published. Without an AI model it returns a brief so you write them.",
      inputSchema: {
        format: z.enum(FORMATS).default("reel"),
        description: z
          .string()
          .optional()
          .describe("What the post is about, key points, audience."),
        transcript_path: z.string().optional(),
        file_path: z.string().optional().describe("The image or video to be posted."),
        template: z.string().optional(),
        count: z.number().int().min(1).max(5).default(3),
        language: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const t = template(args.template);
      const m = await material(args);
      const useVision = Boolean(m.images?.length);
      if (noAi(useVision ? "vision" : "text"))
        return ok({
          brief: captionBrief({
            context: m.text,
            format: args.format,
            template: t,
            language: args.language,
            notes: args.notes,
            count: args.count,
          }),
          note: [m.note, noAiNote("write the captions from this brief.")].filter(Boolean).join(" "),
        });
      if (useVision) {
        const look = await generateJson(app.cfg.ai, "vision", {
          system:
            "Describe images for a social media copywriter: subject, setting, mood, any text, what stands out.",
          prompt: "Describe this image in 3 to 6 sentences.",
          schema: z.object({ description: z.string() }),
          images: m.images,
        });
        if (look) m.text = `${m.text}\n\nWhat the image shows: ${look.data.description}`;
      }
      const r = await draftCaptions(app.cfg.ai, {
        context: m.text,
        format: args.format as PostFormat,
        template: t,
        language: args.language,
        notes: args.notes,
        count: args.count,
      });
      return ok({
        ...r,
        note: m.note,
        next: "Show the options to the user. Check edits with caption_check, then publish with the matching publish_* tool.",
      });
    }),
  );

  server.registerTool(
    "generate_hashtags",
    {
      title: "Suggest hashtags",
      description:
        "Suggests a hashtag set for a post: a mix of broad, niche, community, branded and location tags with reasons, the 5-10 to actually use, and tags to avoid. AI-based; for live data on how active a hashtag is use hashtag_research (Facebook Login only, 30 hashtags per 7 days).",
      inputSchema: {
        topic: z.string(),
        caption: z.string().optional(),
        count: z.number().int().min(5).max(30).default(20),
        template: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const t = template(args.template);
      if (noAi())
        return ok({
          brief: genericBrief(
            `Suggest up to ${args.count} Instagram hashtags for this post.`,
            [
              "Mix tiers: a few broad, mostly niche and community tags, branded and location tags if relevant.",
              "Pick the 5 to 10 to actually use. Avoid banned or engagement-bait tags (#followforfollow, #like4like).",
              "Instagram allows at most 30 hashtags per caption.",
            ],
            {
              hashtags: [{ tag: "#...", tier: "niche", why: "..." }],
              recommended_set: [],
              avoid: [],
            },
            { topic: args.topic, caption: args.caption },
            t,
          ),
          note: noAiNote("pick the hashtags from this brief."),
        });
      const r = await suggestHashtags(app.cfg.ai, {
        topic: args.topic,
        caption: args.caption,
        count: args.count,
        template: t,
      });
      return ok({ model: r.model, ...r.data });
    }),
  );

  server.registerTool(
    "suggest_carousel",
    {
      title: "Plan a carousel",
      description:
        "Turns text, an article, notes or a transcript into a carousel outline: slide-by-slide headline, body and visual (up to 20 slides), plus caption and hashtags. Design the slides from it, then publish with publish_carousel.",
      inputSchema: {
        text: z.string().optional(),
        source_path: z.string().optional().describe(".txt, .md, .srt or .vtt file"),
        slides: z.number().int().min(3).max(20).default(8),
        audience: z.string().optional(),
        template: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const source = [
        args.text,
        args.source_path ? transcriptText(readTextFile(args.source_path), args.source_path) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!source) throw new IgError("invalid_request", "Pass text or source_path.");
      const t = template(args.template);
      if (noAi())
        return ok({
          brief: genericBrief(
            `Turn this material into an Instagram carousel of ${args.slides} slides (max 20).`,
            [
              "Slide 1 is a headline hook that makes people swipe (max 10 words). One point per slide; body max 30 words.",
              "The last slide pays off and asks for a save or share.",
              "Then a caption (hook first line under 125 characters) and 3 to 8 hashtags.",
            ],
            {
              title: "",
              slides: [{ n: 1, headline: "", body: "", visual: "" }],
              caption: "",
              hashtags: [],
            },
            { material: source.slice(0, 60_000), audience: args.audience },
            t,
          ),
          note: noAiNote("write the outline from this brief."),
        });
      const r = await carouselOutline(app.cfg.ai, {
        source,
        slides: args.slides,
        template: t,
        audience: args.audience,
      });
      return ok({ model: r.model, ...r.data });
    }),
  );

  server.registerTool(
    "critique_cover",
    {
      title: "Judge and rank covers",
      description:
        "Scores 1-4 cover images (or 4 frames taken from a video) the way people see them: full screen in the reels feed and as a small grid tile. Ranks them and lists fixes. Needs a vision model (Claude, OpenAI, Gemini, Azure).",
      inputSchema: {
        image_paths: z.array(z.string()).max(4).optional(),
        video_path: z
          .string()
          .optional()
          .describe("Take candidate frames from this video instead."),
        context: z.string().describe("What the post is about."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      let paths = args.image_paths ?? [];
      let frames: { path: string; time: number }[] | undefined;
      if (!paths.length) {
        if (!args.video_path)
          throw new IgError("invalid_request", "Pass image_paths or video_path.");
        const v = expandPath(args.video_path);
        frames = await extractFrames(v, join(outDir("frames"), basename(v, extname(v))), 4);
        paths = frames.map((f) => f.path);
      }
      if (noAi("vision"))
        return ok({
          candidates: paths.map((p, i) => ({
            index: i,
            path: expandPath(p),
            time: frames?.[i]?.time,
          })),
          note: noAiNote("look at these images yourself and pick the cover."),
        });
      const r = await critiqueCovers(app.cfg.ai, paths.map(imageInput), args.context);
      return ok({
        model: r.model,
        ...r.data,
        files: paths.map((p, i) => ({ index: i, path: expandPath(p), time: frames?.[i]?.time })),
        next: "Use the best one as cover_path (reels) or thumb_offset_ms (frame time × 1000).",
      });
    }),
  );

  server.registerTool(
    "translate_caption",
    {
      title: "Translate a caption",
      description:
        "Drafts the caption in other languages, keeping the hook, @mentions, #hashtags and links. Drafts only.",
      inputSchema: {
        caption: z.string(),
        languages: z.array(z.string()).min(1).max(20).describe('BCP-47 codes, e.g. ["hi", "es"]'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ caption, languages }) => {
      if (noAi())
        return ok({
          caption,
          languages,
          note: noAiNote("translate it yourself; keep @mentions, #hashtags and links unchanged."),
        });
      const r = await translateCaption(app.cfg.ai, caption, languages);
      return ok({
        model: r.model,
        translations: r.data.translations.map((t) => ({ ...t, problems: checkCaption(t.caption) })),
      });
    }),
  );

  server.registerTool(
    "caption_check",
    {
      title: "Check a caption",
      description:
        'Checks a caption against Instagram\'s limits (2,200 characters, 30 hashtags, 20 @mentions) and craft rules (hook length before "more", call to action, hashtag count, links, engagement bait), and previews it with a template applied exactly as it will be published.',
      inputSchema: { caption: z.string(), template: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ caption, template: name }) => {
      const t = template(name);
      let preview: ReturnType<typeof applyCaptionTemplate> | { error: string } | undefined;
      if (t)
        try {
          preview = applyCaptionTemplate(caption, t);
        } catch (e) {
          preview = { error: (e as Error).message };
        }
      const final = preview && "caption" in preview ? preview.caption : caption;
      return ok({ ...reviewCaption(final), with_template: preview });
    }),
  );

  // ---- video -------------------------------------------------------------------------------------

  server.registerTool(
    "repurpose_video",
    {
      title: "Cut reels from a long video",
      description:
        "Finds the best standalone moments in a long local video (transcribed, or from a transcript file) and cuts them into vertical 1080x1920 reels with a hook, on-screen text and caption for each. Or pass clips with start/end seconds to cut exactly those. layout crop fills the frame from the centre; blur fits the whole frame over a blurred fill. Returns file paths ready for publish_reel. Needs ffmpeg.",
      inputSchema: {
        file_path: z.string(),
        transcript_path: z.string().optional(),
        clips: z
          .array(z.object({ start: z.number().min(0), end: z.number().positive() }))
          .max(10)
          .optional(),
        count: z.number().int().min(1).max(5).default(3),
        min_seconds: z.number().int().min(3).max(600).default(15),
        max_seconds: z.number().int().min(5).max(900).default(60),
        layout: z.enum(["crop", "blur", "original"]).default("crop"),
        cut: z.boolean().default(true).describe("false: only suggest clips, don't render them."),
        template: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      const file = expandPath(args.file_path);
      if (!existsSync(file)) throw new IgError("file_error", `File not found: ${file}`);
      let picks: {
        start: number;
        end: number;
        hook?: string;
        on_screen_text?: string;
        caption?: string;
        why?: string;
        score?: number;
      }[] = args.clips ?? [];
      let model: string | undefined;
      if (!picks.length) {
        let text: string;
        if (args.transcript_path)
          text = transcriptText(readTextFile(args.transcript_path), args.transcript_path);
        else text = timestampedText(await transcribeFile(app.cfg, file), 10);
        if (noAi())
          return ok({
            transcript: text,
            note: noAiNote(
              `pick ${args.count} clips (${args.min_seconds}-${args.max_seconds} s, strong first line) from the transcript, then call repurpose_video again with clips.`,
            ),
          });
        const r = await pickClips(
          app.cfg.ai,
          text,
          args.count,
          args.min_seconds,
          args.max_seconds,
          template(args.template),
        );
        model = r.model;
        picks = r.data.clips.sort((a, b) => b.score - a.score).slice(0, args.count);
      }
      if (!args.cut) return ok({ model, clips: picks });
      const { duration } = await probe(file);
      const dir = outDir("reels");
      const results = [];
      for (const c of picks) {
        const start = Math.max(0, c.start);
        const end = Math.min(c.end, duration || c.end);
        const out = join(
          dir,
          `${basename(file, extname(file))}-${Math.round(start)}-${Math.round(end)}.mp4`,
        );
        try {
          results.push({ ...c, ...(await cutVertical(file, start, end, out, args.layout)) });
        } catch (e) {
          results.push({ ...c, error: (e as Error).message });
        }
      }
      return ok({
        model,
        clips: results,
        next: "Review the clips, then publish_reel(file_path, caption) or create_ab_test to compare hooks.",
      });
    }),
  );

  // ---- account-aware -----------------------------------------------------------------------------

  server.registerTool(
    "content_ideas",
    {
      title: "What to post next",
      description:
        "Next post ideas grounded in this account's recent performance: which formats and topics over- and under-performed (likes and comments vs the account's median), optionally focused on a topic. With an AI model it returns ideas with format, hook, angle, evidence and confidence; otherwise the data for you to reason from.",
      inputSchema: {
        count: z.number().int().min(3).max(20).default(8),
        focus: z.string().optional().describe("A theme, product or audience to focus on."),
        posts: z.number().int().min(10).max(100).default(40),
        template: z.string().optional(),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row = app.accounts.resolve(args.account);
      const graph = app.accounts.client(row);
      const media = await listMedia(graph, row.ig_user_id, { limit: args.posts });
      const scored = media.map((m) => ({
        ...compactMedia(m, 200),
        product: productOf(m),
        engagement: (m.like_count ?? 0) + 2 * (m.comments_count ?? 0),
      }));
      const med = median(scored.map((s) => s.engagement)) || 1;
      const ranked = scored
        .map((s) => ({ ...s, vs_median: Math.round((s.engagement / med) * 100) / 100 }))
        .sort((a, b) => b.vs_median - a.vs_median);
      const byFormat: Record<string, { posts: number; median_vs_account: number }> = {};
      for (const f of new Set(ranked.map((r) => r.product))) {
        const xs = ranked.filter((r) => r.product === f).map((r) => r.vs_median);
        byFormat[f] = { posts: xs.length, median_vs_account: Math.round(median(xs) * 100) / 100 };
      }
      const pick = (r: (typeof ranked)[number]) => ({
        caption: r.caption,
        format: r.product,
        vs_median: r.vs_median,
        likes: r.likes,
        comments: r.comments,
        date: r.timestamp?.slice(0, 10),
      });
      const facts = {
        focus: args.focus,
        account: `@${row.username}`,
        followers: row.followers_count ?? undefined,
        posts_analysed: ranked.length,
        by_format: byFormat,
        outperformers: ranked.slice(0, 8).map(pick),
        underperformers: ranked.slice(-5).reverse().map(pick),
        note: "vs_median = (likes + 2 x comments) relative to this account's median post.",
      };
      if (noAi())
        return ok({ facts, note: noAiNote(`suggest ${args.count} ideas from these facts.`) });
      const r = await contentIdeas(app.cfg.ai, facts, args.count, template(args.template));
      return ok({ model: r.model, ...r.data, based_on: facts });
    }),
  );

  server.registerTool(
    "triage_comments",
    {
      title: "Sort comments and draft replies",
      description:
        "Reads recent comments (one post, or the latest posts) and sorts them: questions, praise, feedback, complaints, leads, spam, abuse. Each gets a priority, a suggested action (reply, private reply, hide, delete) and a draft reply, plus post ideas the audience is asking for. Drafts only: nothing is sent. Without an AI model it returns the comments for you to triage.",
      inputSchema: {
        media_id: z.string().optional(),
        posts: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(10)
          .describe("Latest posts to read when no media_id."),
        unanswered_only: z.boolean().default(true),
        max_comments: z.number().int().min(5).max(300).default(100),
        template: z.string().optional().describe("Template whose voice the replies should follow."),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row = app.accounts.resolve(args.account);
      const graph = app.accounts.client(row);
      let rows: CommentRow[];
      if (args.media_id) {
        rows = await mediaComments(graph, args.media_id, row.username, args.max_comments);
        if (args.unanswered_only) {
          const own = (row.username ?? "").toLowerCase();
          rows = rows.filter((c) => !c.answered && (c.user ?? "").toLowerCase() !== own);
        }
      } else
        rows = await recentComments(graph, row, {
          posts: args.posts,
          perPost: 25,
          unanswered: args.unanswered_only,
        });
      const sample = rows.slice(0, args.max_comments).map((c) => ({
        id: c.id,
        text: c.text.slice(0, 600),
        username: c.user,
        likes: c.likes,
        post: c.media?.caption?.slice(0, 80),
      }));
      if (!sample.length) return ok({ comments: 0, note: "No comments to triage." });
      if (noAi()) return ok({ comments: sample, note: noAiNote("triage these yourself.") });
      const r = await triageComments(app.cfg.ai, sample, template(args.template)?.guidance);
      return ok({
        analysed: sample.length,
        model: r.model,
        ...r.data,
        next: "Send replies with reply_to_comment or private_reply, and hide spam with hide_comment; each asks the user first.",
      });
    }),
  );

  // ---- templates ---------------------------------------------------------------------------------

  server.registerTool(
    "list_templates",
    {
      title: "List caption templates",
      description:
        "Caption templates: header/footer, hashtags (in the caption or first comment), mentions, first comment, collaborators, location and the account voice used by the writing tools. Saved as JSON in the templates folder.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => ok({ folder: app.cfg.templatesDir, templates: app.templates.list() })),
  );

  server.registerTool(
    "save_template",
    {
      title: "Save a caption template",
      description:
        "Creates or replaces a caption template. Use extends to build on another template (hashtags, mentions and collaborators are merged; guidance is appended).",
      inputSchema: TemplateSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (args) => {
      const saved = app.templates.save(args as Template);
      return ok({ saved, resolved: app.templates.get(saved.name) });
    }),
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a caption template",
      description: "Deletes a saved template file. Asks the user first.",
      inputSchema: { name: z.string(), confirmation_token: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async (args) => {
      app.templates.assertDeletable(args.name);
      const gate = await confirmGate(
        app,
        server,
        "delete_template",
        args,
        `Delete the template "${args.name}".`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      app.templates.delete(args.name);
      return ok({ deleted: args.name });
    }),
  );
}
