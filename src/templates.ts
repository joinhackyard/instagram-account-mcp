import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IgError } from "./errors.js";

/** Instagram caption limits (Content Publishing docs). */
export const CAPTION_LIMITS = { maxChars: 2200, maxHashtags: 30, maxMentions: 20 } as const;
/** Characters shown before "... more" in the feed (roughly; depends on the device). */
export const VISIBLE_CHARS = 125;

const hashtag = z
  .string()
  .regex(/^#?[\p{L}\p{N}_]+$/u, "Hashtags are letters, numbers and underscores only.");
const username = z.string().regex(/^@?[\w.]{1,30}$/, "Not an Instagram username.");

export const TemplateSchema = z.object({
  name: z.string().regex(/^[\w-]{1,60}$/, "Template names are letters, numbers, - and _."),
  description: z.string().default(""),
  extends: z.string().optional(),
  /** Added above the caption. */
  caption_header: z.string().optional(),
  /** Added below the caption (CTA, links in bio, credits). */
  caption_footer: z.string().optional(),
  hashtags: z.array(hashtag).optional(),
  /** Where template hashtags go (default: end of the caption). */
  hashtags_in: z.enum(["caption", "first_comment"]).optional(),
  /** @mentions added to the footer. */
  mentions: z.array(username).optional(),
  /** Posted as the first comment after publishing. */
  first_comment: z.string().optional(),
  /** Up to 3 usernames invited as collaborators. */
  collaborators: z.array(username).max(3).optional(),
  location_id: z.string().optional(),
  is_ai_generated: z.boolean().optional(),
  /** Voice and rules for AI writing tools. */
  guidance: z.string().optional(),
});
export type Template = z.infer<typeof TemplateSchema>;

/** Built in: only what is universal. Account-specific templates live as JSON files in the templates folder. */
export const BUILTIN_TEMPLATES: Template[] = [
  {
    name: "reel",
    description:
      "Neutral reel: hook in the first line, one short paragraph, a question to invite comments.",
    guidance:
      "First line is the hook and makes sense on its own (it is all most people see). One idea per reel. End with a question or a clear next step. 3 to 8 specific hashtags, no hashtag walls.",
  },
];

const norm = (h: string) => (h.startsWith("#") ? h : `#${h}`);
const at = (u: string) => (u.startsWith("@") ? u : `@${u}`);

export function countHashtags(text: string): number {
  return (text.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(text: string): number {
  return (text.match(/(^|[^\w.])@[\w.]{1,30}/g) ?? []).length;
}

/** Problems Instagram would reject the caption for. Empty array = fine. */
export function checkCaption(caption: string): string[] {
  const problems: string[] = [];
  const chars = [...caption].length;
  if (chars > CAPTION_LIMITS.maxChars)
    problems.push(`Caption is ${chars} characters (Instagram max ${CAPTION_LIMITS.maxChars}).`);
  const tags = countHashtags(caption);
  if (tags > CAPTION_LIMITS.maxHashtags)
    problems.push(`Caption has ${tags} hashtags (Instagram max ${CAPTION_LIMITS.maxHashtags}).`);
  const mentions = countMentions(caption);
  if (mentions > CAPTION_LIMITS.maxMentions)
    problems.push(
      `Caption has ${mentions} @mentions (Instagram max ${CAPTION_LIMITS.maxMentions}).`,
    );
  return problems;
}

const lower = (s: string) => s.toLowerCase();

/**
 * Merge a caption with a template into exactly what will be published: header, caption, footer with
 * mentions, and the template hashtags (in the caption or the first comment). Never duplicates what the
 * caption already contains. Throws when the result breaks Instagram's limits.
 */
export function applyCaptionTemplate(
  caption: string,
  template?: Template,
): { caption: string; first_comment?: string; warnings: string[] } {
  const warnings: string[] = [];
  const body = caption.trim();
  if (!template) {
    const problems = checkCaption(body);
    if (problems.length) throw new IgError("invalid_request", problems.join(" "));
    return { caption: body, warnings };
  }
  const has = (s: string) => lower(body).includes(lower(s.trim().split("\n")[0]));
  const parts: string[] = [];
  if (template.caption_header?.trim() && !has(template.caption_header))
    parts.push(template.caption_header.trim());
  if (body) parts.push(body);
  const footer: string[] = [];
  if (template.caption_footer?.trim() && !has(template.caption_footer))
    footer.push(template.caption_footer.trim());
  const mentions = (template.mentions ?? []).map(at).filter((m) => !lower(body).includes(lower(m)));
  if (mentions.length) footer.push(mentions.join(" "));
  if (footer.length) parts.push(footer.join("\n"));

  const existing = new Set((body.match(/#[\p{L}\p{N}_]+/gu) ?? []).map(lower));
  const tags = [...new Set((template.hashtags ?? []).map(norm))].filter(
    (h) => !existing.has(lower(h)),
  );
  let firstComment = template.first_comment?.trim() || undefined;
  if (tags.length) {
    if (template.hashtags_in === "first_comment")
      firstComment = [firstComment, tags.join(" ")].filter(Boolean).join("\n\n");
    else parts.push(tags.join(" "));
  }
  let out = parts.join("\n\n");

  // Keep within the hashtag limit by dropping template hashtags from the end.
  if (
    tags.length &&
    template.hashtags_in !== "first_comment" &&
    countHashtags(out) > CAPTION_LIMITS.maxHashtags
  ) {
    const room = Math.max(
      0,
      CAPTION_LIMITS.maxHashtags - countHashtags(parts.slice(0, -1).join("\n\n")),
    );
    const kept = tags.slice(0, room);
    parts[parts.length - 1] = kept.join(" ");
    out = parts.filter(Boolean).join("\n\n");
    warnings.push(`Dropped ${tags.length - kept.length} template hashtag(s) to stay under 30.`);
  }
  const firstLine = (out.split("\n").find((l) => l.trim()) ?? "").trim();
  if ([...firstLine].length > VISIBLE_CHARS)
    warnings.push(
      `The first line is ${[...firstLine].length} characters; about ${VISIBLE_CHARS} show before "more".`,
    );
  if (firstComment) {
    const fc = checkCaption(firstComment);
    if (fc.length) warnings.push(`First comment: ${fc.join(" ")}`);
  }
  const problems = checkCaption(out);
  if (problems.length) throw new IgError("invalid_request", problems.join(" "));
  return { caption: out, first_comment: firstComment, warnings };
}

/** Templates are JSON files (one template or an array) in the templates folder, plus the built-ins. */
export class TemplateStore {
  constructor(private readonly dir: string) {}

  private readAll(): Map<string, Template> {
    const out = new Map<string, Template>();
    for (const t of BUILTIN_TEMPLATES) out.set(t.name, t);
    if (!existsSync(this.dir)) return out;
    for (const f of readdirSync(this.dir)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as unknown;
        for (const item of Array.isArray(raw) ? raw : [raw]) {
          const t = TemplateSchema.safeParse(item);
          if (t.success) out.set(t.data.name, t.data);
        }
      } catch {
        /* unreadable file: skip */
      }
    }
    return out;
  }

  list(): Template[] {
    const all = this.readAll();
    return [...all.keys()].map((n) => this.resolve(n, all));
  }

  private resolve(name: string, all: Map<string, Template>, seen: string[] = []): Template {
    const t = all.get(name);
    if (!t)
      throw new IgError("not_found", `No template named "${name}".`, {
        hint: `Available: ${[...all.keys()].join(", ") || "none"}. Create one with save_template.`,
      });
    if (!t.extends) return t;
    if (seen.includes(name))
      throw new IgError("invalid_request", `Template "${name}" extends itself in a loop.`);
    const parent = this.resolve(t.extends, all, [...seen, name]);
    const merged: Template = { ...parent };
    for (const [k, v] of Object.entries(t) as [keyof Template, unknown][]) {
      if (v === undefined || k === "extends") continue;
      if (k === "hashtags" || k === "mentions" || k === "collaborators")
        (merged as Record<string, unknown>)[k] = [
          ...new Set([...((parent[k] as string[] | undefined) ?? []), ...(v as string[])]),
        ];
      else (merged as Record<string, unknown>)[k] = v;
    }
    if (t.guidance && parent.guidance) merged.guidance = `${parent.guidance}\n${t.guidance}`;
    merged.name = t.name;
    delete merged.extends;
    return merged;
  }

  get(name: string): Template {
    return this.resolve(name, this.readAll());
  }

  /** Save as <name>.json in the templates folder (overwrites a saved template with the same name). */
  save(input: Template): Template {
    const t = TemplateSchema.parse(input);
    const all = this.readAll();
    all.set(t.name, t);
    this.resolve(t.name, all); // validates `extends` before anything is written
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${t.name}.json`), JSON.stringify(t, null, 2) + "\n");
    return t;
  }

  /** Throws unless `name` is a saved template file this store may delete. */
  assertDeletable(name: string): string {
    const file = join(this.dir, `${name}.json`);
    if (!/^[\w-]+$/.test(name) || !existsSync(file))
      throw new IgError("not_found", `No saved template file for "${name}".`, {
        hint: "Built-in templates and templates inside multi-template files can't be deleted here.",
      });
    return file;
  }

  delete(name: string) {
    unlinkSync(this.assertDeletable(name));
  }
}
