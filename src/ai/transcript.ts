import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { AI_NOT_CONFIGURED_HINT, resolveModel, transcribeAudio } from "./providers.js";
import { IgError } from "../errors.js";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

const ts = (t: string) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t.trim());
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000
  );
};

/** Parse SRT or WebVTT into segments. Plain text becomes one segment. */
export function parseCaptions(text: string): Segment[] {
  const out: Segment[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, z] = lines[i].split("-->");
    const body = lines
      .slice(i + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (body) out.push({ start: ts(a), end: ts(z), text: body });
  }
  if (!out.length && text.trim()) out.push({ start: 0, end: 0, text: text.trim() });
  return out;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Condense segments into ~`every`-second lines prefixed with timestamps, for writing chapters. */
export function timestampedText(segs: Segment[], every = 20, maxChars = 120_000): string {
  if (segs.length === 1 && segs[0].end === 0) return segs[0].text.slice(0, maxChars);
  const lines: string[] = [];
  let bucketStart = -1;
  let buf: string[] = [];
  for (const s of segs) {
    if (bucketStart < 0) bucketStart = s.start;
    buf.push(s.text);
    if (s.end - bucketStart >= every) {
      lines.push(`[${clock(bucketStart)}] ${buf.join(" ")}`);
      bucketStart = -1;
      buf = [];
    }
  }
  if (buf.length) lines.push(`[${clock(bucketStart)}] ${buf.join(" ")}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n[transcript truncated]";
  return out;
}

export function toSrt(segs: Segment[]): string {
  const f = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return segs.map((s, i) => `${i + 1}\n${f(s.start)} --> ${f(s.end)}\n${s.text}\n`).join("\n");
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    return (await run("ffmpeg", ["-version"])).code === 0;
  } catch {
    return false;
  }
}

const SEGMENT_SECONDS = 1200; // 20 min of 32 kbps mono MP3 ≈ 4.8 MB, well under the 25 MB API limit.

/**
 * Transcribe a local video with the configured transcription model (OpenAI or Azure Whisper,
 * Groq, Gemini, or any OpenAI-compatible server). Needs ffmpeg on PATH.
 */
export async function transcribeFile(
  cfg: Config,
  videoPath: string,
  language?: string,
): Promise<Segment[]> {
  if (!resolveModel(cfg.ai, "transcribe")) {
    throw new IgError("not_configured", "Transcription is not configured.", {
      hint: `${AI_NOT_CONFIGURED_HINT} Or pass an existing transcript or .srt instead.`,
    });
  }
  if (!(await hasFfmpeg())) {
    throw new IgError("not_configured", "ffmpeg is needed to extract audio for transcription.", {
      hint: "Install it (macOS: brew install ffmpeg; Ubuntu: sudo apt install ffmpeg; Windows: winget install ffmpeg).",
    });
  }
  const dir = await mkdtemp(join(tmpdir(), "igm-audio-"));
  try {
    const r = await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      "-f",
      "segment",
      "-segment_time",
      String(SEGMENT_SECONDS),
      "-reset_timestamps",
      "1",
      join(dir, "part%03d.mp3"),
    ]);
    if (r.code !== 0)
      throw new IgError(
        "file_error",
        `ffmpeg could not read the audio: ${r.stderr.trim().split("\n").pop()}`,
      );
    const parts = (await readdir(dir)).filter((f) => f.endsWith(".mp3")).sort();
    const all: Segment[] = [];
    for (const [i, part] of parts.entries()) {
      const data = (await transcribeAudio(cfg.ai, join(dir, part), language))!;
      const offset = i * SEGMENT_SECONDS;
      if (data.segments?.length) {
        for (const s of data.segments)
          all.push({
            start: s.start + offset,
            end: s.end + offset,
            text: s.text.trim(),
          });
      } else if (data.text) {
        all.push({
          start: offset,
          end: offset + SEGMENT_SECONDS,
          text: data.text.trim(),
        });
      }
    }
    return all;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function saveSrt(path: string, segs: Segment[]) {
  await writeFile(path, toSrt(segs), "utf8");
}
