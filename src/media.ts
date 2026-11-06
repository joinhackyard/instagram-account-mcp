import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IgError } from "./errors.js";

/** Run a command and collect stdout/stderr (bounded). */
export function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-200_000);
    });
    p.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const FFMPEG_HINT =
  "Install ffmpeg (macOS: brew install ffmpeg; Ubuntu: sudo apt install ffmpeg; Windows: winget install ffmpeg).";

export async function requireFfmpeg() {
  const ok = await runCmd("ffmpeg", ["-version"])
    .then((r) => r.code === 0)
    .catch(() => false);
  if (!ok)
    throw new IgError("not_configured", "This needs ffmpeg, which isn't installed.", {
      hint: FFMPEG_HINT,
    });
}

async function ffmpeg(args: string[]) {
  const r = await runCmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.code !== 0)
    throw new IgError(
      "file_error",
      `ffmpeg failed: ${r.stderr.trim().split("\n").pop() ?? "unknown error"}`,
    );
}

export interface Probe {
  duration: number;
  width: number;
  height: number;
}

export async function probe(file: string): Promise<Probe> {
  const r = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=width,height,codec_type",
    "-of",
    "json",
    file,
  ]);
  if (r.code !== 0)
    throw new IgError("file_error", `Could not read ${file}: ${r.stderr.trim().split("\n").pop()}`);
  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  return {
    duration: Number(j.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
  };
}

/** Evenly spaced stills between 5% and 95% of the video (skips intros and end cards), 1280 px wide JPGs. */
export async function extractFrames(
  file: string,
  outDir: string,
  count: number,
  at?: number[],
): Promise<{ path: string; time: number }[]> {
  await requireFfmpeg();
  mkdirSync(outDir, { recursive: true });
  const { duration } = await probe(file);
  if (!duration) throw new IgError("file_error", "Could not read the video duration.");
  const times = at?.length
    ? at.filter((t) => t >= 0 && t < duration)
    : Array.from({ length: count }, (_, i) => duration * (0.05 + (0.9 * (i + 0.5)) / count));
  const out: { path: string; time: number }[] = [];
  for (const [i, t] of times.entries()) {
    const path = join(outDir, `frame-${String(i + 1).padStart(2, "0")}-${Math.round(t)}s.jpg`);
    await ffmpeg([
      "-ss",
      t.toFixed(2),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:-2",
      "-q:v",
      "2",
      path,
    ]);
    out.push({ path, time: Math.round(t * 10) / 10 });
  }
  return out;
}
