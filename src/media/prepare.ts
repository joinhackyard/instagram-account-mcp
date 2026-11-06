import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { newId } from "../crypto.js";
import { IgError } from "../errors.js";
import { requireFfmpeg, runCmd } from "../media.js";
import type { ItemType, PostKind } from "../publish/types.js";

/** Instagram's published limits (Content Publishing docs). */
export const SPECS = {
  image: {
    maxBytes: 8 * 1024 ** 2,
    minRatio: 4 / 5,
    maxRatio: 1.91,
    maxWidth: 1440,
    minWidth: 320,
  },
  storyImage: { maxBytes: 8 * 1024 ** 2 },
  reel: { minSec: 3, maxSec: 15 * 60, maxBytes: 300 * 1024 ** 2, maxFps: 60, maxWidth: 1920 },
  story: { minSec: 3, maxSec: 60, maxBytes: 100 * 1024 ** 2 },
  carouselVideo: {
    minSec: 3,
    maxSec: 60,
    maxBytes: 100 * 1024 ** 2,
    minRatio: 4 / 5,
    maxRatio: 1.91,
  },
  caption: { maxChars: 2200, maxHashtags: 30, maxMentions: 20 },
  carousel: { min: 2, max: 20 },
  altText: { maxChars: 1000 },
} as const;

export interface MediaInfo {
  kind: ItemType;
  container?: string;
  width: number;
  height: number;
  ratio: number;
  duration?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioRate?: number;
  pixFmt?: string;
  bytes: number;
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

export function guessType(pathOrUrl: string): ItemType | undefined {
  const e = extname(pathOrUrl.split("?")[0]).toLowerCase();
  if (VIDEO_EXT.has(e)) return "video";
  if (IMAGE_EXT.has(e)) return "image";
  return undefined;
}

export function contentTypeFor(path: string): string {
  const e = extname(path).toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".png") return "image/png";
  if (e === ".mp4" || e === ".m4v") return "video/mp4";
  if (e === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

const fraction = (s?: string) => {
  if (!s) return undefined;
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : a;
};

export async function inspect(file: string): Promise<MediaInfo> {
  const r = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,pix_fmt:stream_tags=rotate:stream_side_data=rotation",
    "-of",
    "json",
    file,
  ]).catch(() => null);
  if (!r)
    throw new IgError("not_configured", "ffprobe (part of ffmpeg) is needed to check media.", {
      hint: "Install ffmpeg (macOS: brew install ffmpeg; Ubuntu: sudo apt install ffmpeg; Windows: winget install ffmpeg).",
    });
  if (r.code !== 0)
    throw new IgError("file_error", `Could not read ${file}: ${r.stderr.trim().split("\n").pop()}`);
  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      sample_rate?: string;
      pix_fmt?: string;
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const { size } = await stat(file);
  const duration = Number(j.format?.duration ?? 0);
  const imageCodecs = new Set([
    "mjpeg",
    "png",
    "webp",
    "bmp",
    "tiff",
    "gif",
    "heif",
    "hevc_image",
    "jpegls",
  ]);
  const isImage =
    !!v &&
    (imageCodecs.has(v.codec_name ?? "") ||
      /image2|png_pipe|jpeg_pipe|webp_pipe/.test(j.format?.format_name ?? "")) &&
    !(duration > 0.5 && v.codec_name === "gif");
  let w = v?.width ?? 0;
  let h = v?.height ?? 0;
  const rot = Math.abs(
    Number(
      v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
    ),
  );
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return {
    kind: isImage ? "image" : "video",
    container: j.format?.format_name,
    width: w,
    height: h,
    ratio: h ? w / h : 0,
    duration: isImage ? undefined : duration,
    fps: isImage ? undefined : fraction(v?.avg_frame_rate) || fraction(v?.r_frame_rate),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    audioRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
    pixFmt: v?.pix_fmt,
    bytes: size,
  };
}

export interface Check {
  ok: boolean;
  problems: string[];
  /** Problems prepare can fix by converting. */
  fixable: boolean;
  warnings: string[];
}

/** What Instagram would reject for this placement. */
export function checkMedia(info: MediaInfo, kind: PostKind, inCarousel = false): Check {
  const problems: string[] = [];
  const warnings: string[] = [];
  let fixable = true;
  const r = info.ratio;
  if (info.kind === "image") {
    if (!/jpeg|mjpeg/.test(`${info.videoCodec}`) && !/jpe?g/.test(info.container ?? ""))
      problems.push("Instagram only accepts JPEG images.");
    if (info.bytes > SPECS.image.maxBytes) problems.push("Image is over 8 MB.");
    if (kind !== "story" && (r < SPECS.image.minRatio - 0.01 || r > SPECS.image.maxRatio + 0.01))
      problems.push(`Aspect ratio ${r.toFixed(2)} is outside 4:5 to 1.91:1 for feed posts.`);
    if (info.width > SPECS.image.maxWidth)
      warnings.push("Wider than 1440 px; Instagram scales it down.");
    if (info.width < SPECS.image.minWidth) problems.push("Image is narrower than 320 px.");
    if (kind === "reel") {
      problems.push("A reel needs a video, not an image.");
      fixable = false;
    }
  } else {
    const d = info.duration ?? 0;
    const lim = kind === "story" ? SPECS.story : inCarousel ? SPECS.carouselVideo : SPECS.reel;
    if (d < lim.minSec) {
      problems.push(`Video is ${d.toFixed(1)}s; the minimum is ${lim.minSec}s.`);
      fixable = false;
    }
    if (d > lim.maxSec)
      problems.push(
        `Video is ${Math.round(d)}s; the maximum here is ${lim.maxSec}s (it will be trimmed).`,
      );
    if (info.bytes > lim.maxBytes)
      problems.push(
        `Video is ${(info.bytes / 1024 ** 2).toFixed(0)} MB; the limit is ${lim.maxBytes / 1024 ** 2} MB.`,
      );
    if (info.videoCodec && !["h264", "hevc"].includes(info.videoCodec))
      problems.push(`Video codec ${info.videoCodec} must be H.264 or HEVC.`);
    if (info.audioCodec && info.audioCodec !== "aac")
      problems.push(`Audio codec ${info.audioCodec} must be AAC.`);
    if (info.audioRate && info.audioRate > 48_000)
      problems.push("Audio sample rate must be 48 kHz or less.");
    if (info.fps && info.fps > 60) problems.push(`${info.fps.toFixed(0)} fps; the maximum is 60.`);
    if (info.pixFmt && !/yuv420p/.test(info.pixFmt))
      problems.push(`Pixel format ${info.pixFmt} should be yuv420p.`);
    if (!/mp4|mov/.test(info.container ?? "")) problems.push("Container must be MP4 or MOV.");
    if ((kind === "reel" || kind === "story") && Math.abs(r - 9 / 16) > 0.02)
      warnings.push(
        `Aspect ratio ${r.toFixed(2)}; reels and stories fill the screen at 9:16. Set fit to "crop" or "blur" to reframe.`,
      );
    if (
      inCarousel &&
      (r < SPECS.carouselVideo.minRatio - 0.01 || r > SPECS.carouselVideo.maxRatio + 0.01)
    )
      problems.push(`Aspect ratio ${r.toFixed(2)} is outside 4:5 to 1.91:1 for carousel videos.`);
  }
  return { ok: problems.length === 0, problems, fixable, warnings };
}

export type Fit = "keep" | "crop" | "blur";

export interface PrepareOptions {
  kind: PostKind;
  inCarousel?: boolean;
  /** How to reach the target shape: keep (only clamp into the allowed range), crop (fill), blur (fit over a blurred fill). */
  fit?: Fit;
  /** Target aspect ratio (width/height); default by placement. */
  aspect?: number;
  outDir: string;
}

function targetSize(info: MediaInfo, o: PrepareOptions): { w: number; h: number } | null {
  const placementDefault = o.kind === "reel" || o.kind === "story" ? 9 / 16 : undefined;
  let aspect = o.aspect ?? (o.fit && o.fit !== "keep" ? placementDefault : undefined);
  if (!aspect) {
    if (o.kind === "story" || o.kind === "reel") return null; // any ratio accepted; keep
    // Feed: clamp into 4:5 .. 1.91:1.
    if (info.ratio < SPECS.image.minRatio) aspect = SPECS.image.minRatio;
    else if (info.ratio > SPECS.image.maxRatio) aspect = SPECS.image.maxRatio;
    else return null;
  }
  const w =
    info.kind === "image" ? Math.min(1440, Math.max(320, info.width)) : aspect < 1 ? 1080 : 1920;
  const h = Math.round(w / aspect / 2) * 2;
  return { w: Math.round(w / 2) * 2, h };
}

function reframe(size: { w: number; h: number } | null, fit: Fit): string[] {
  if (!size) return [];
  const { w, h } = size;
  if (fit === "blur")
    return [
      "-filter_complex",
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg];[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p`,
    ];
  return ["-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`];
}

async function ffmpeg(args: string[]) {
  const r = await runCmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.code !== 0)
    throw new IgError(
      "file_error",
      `ffmpeg failed: ${r.stderr.trim().split("\n").pop() ?? "unknown error"}`,
    );
}

export interface Prepared {
  path: string;
  info: MediaInfo;
  converted: boolean;
  actions: string[];
  warnings: string[];
}

/**
 * Make a file acceptable for the placement: JPEG sRGB images inside the allowed ratio and 8 MB;
 * H.264/AAC MP4 (yuv420p, ≤60 fps, ≤48 kHz, faststart) trimmed to the length limit. Leaves good files alone.
 */
export async function prepareMedia(file: string, o: PrepareOptions): Promise<Prepared> {
  const info = await inspect(file);
  const c = checkMedia(info, o.kind, o.inCarousel);
  const fit = o.fit ?? "keep";
  const size = targetSize(info, o);
  const needsReframe =
    Boolean(size) && (fit !== "keep" || c.problems.some((p) => /ratio/i.test(p)));
  if (c.ok && !needsReframe)
    return { path: file, info, converted: false, actions: [], warnings: c.warnings };
  if (!c.fixable) throw new IgError("invalid_request", c.problems.join(" "));
  await requireFfmpeg();
  mkdirSync(o.outDir, { recursive: true });
  const actions: string[] = [];
  if (info.kind === "image") {
    const out = join(o.outDir, `${newId()}.jpg`);
    const vf = needsReframe
      ? reframe(size, fit === "keep" ? "crop" : fit)
      : info.width > 1440
        ? ["-vf", "scale=1440:-2"]
        : [];
    if (needsReframe)
      actions.push(
        `reframed to ${size!.w}x${size!.h} (${fit === "blur" ? "blurred fill" : "centre crop"})`,
      );
    for (const q of [2, 3, 5, 8, 12]) {
      await ffmpeg([
        "-i",
        file,
        ...vf,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        String(q),
        out,
      ]);
      if ((await stat(out)).size <= SPECS.image.maxBytes) break;
    }
    actions.push("converted to JPEG");
    const outInfo = await inspect(out);
    return {
      path: out,
      info: outInfo,
      converted: true,
      actions,
      warnings: checkMedia(outInfo, o.kind, o.inCarousel).problems,
    };
  }
  const lim = o.kind === "story" ? SPECS.story : o.inCarousel ? SPECS.carouselVideo : SPECS.reel;
  const out = join(o.outDir, `${newId()}.mp4`);
  const trim = (info.duration ?? 0) > lim.maxSec ? ["-t", String(lim.maxSec)] : [];
  if (trim.length) actions.push(`trimmed to ${lim.maxSec}s`);
  const fps =
    info.fps && info.fps > 60 ? ["-r", "60"] : info.fps && info.fps < 23 ? ["-r", "30"] : [];
  const vf = needsReframe
    ? reframe(size, fit === "keep" ? "crop" : fit)
    : info.width > 1920 || info.height > 1920
      ? ["-vf", "scale='min(1920,iw)':-2"]
      : [];
  if (needsReframe)
    actions.push(
      `reframed to ${size!.w}x${size!.h} (${fit === "blur" ? "blurred fill" : "centre crop"})`,
    );
  // Aim under the size limit: bitrate cap from duration.
  const dur = Math.min(info.duration ?? lim.maxSec, lim.maxSec);
  const maxKbps = Math.max(
    1500,
    Math.min(25_000, Math.floor((lim.maxBytes * 0.9 * 8) / 1000 / Math.max(dur, 1) - 160)),
  );
  await ffmpeg([
    "-i",
    file,
    ...trim,
    ...vf,
    ...fps,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-maxrate",
    `${maxKbps}k`,
    "-bufsize",
    `${maxKbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    out,
  ]);
  actions.push("re-encoded to H.264/AAC MP4");
  const outInfo = await inspect(out);
  return {
    path: out,
    info: outInfo,
    converted: true,
    actions,
    warnings: checkMedia(outInfo, o.kind, o.inCarousel).problems,
  };
}

/** A JPEG still from a video at `atSec` (reel covers, previews). */
export async function frameAt(file: string, atSec: number, outDir: string): Promise<string> {
  await requireFfmpeg();
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${newId()}.jpg`);
  await ffmpeg(["-ss", atSec.toFixed(2), "-i", file, "-frames:v", "1", "-q:v", "2", out]);
  return out;
}
