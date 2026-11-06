/** Shared shapes for publishing jobs. Stored as JSON in jobs.spec / jobs.items. */

export type PostKind = "photo" | "reel" | "story" | "carousel";
export type ItemType = "image" | "video";

/** Where a file comes from: a path on this computer, or a URL Meta can fetch (or that we download first). */
export interface MediaSource {
  file_path?: string;
  url?: string;
}

export interface UserTag {
  username: string;
  /** 0..1 from the left / top. Required for images, ignored for reels. */
  x?: number;
  y?: number;
}

export interface ItemSpec {
  source: MediaSource;
  type: ItemType;
  alt_text?: string;
  user_tags?: UserTag[];
}

export type TrialGraduation = "MANUAL" | "SS_PERFORMANCE";

export interface PostSpec {
  kind: PostKind;
  caption?: string;
  /** 1 item for photo/reel/story, 2-20 for carousel. */
  items: ItemSpec[];
  /** Up to 3 usernames invited as collaborators (feed posts and reels). */
  collaborators?: string[];
  /** A Facebook Page ID that represents a location (search with find_location). */
  location_id?: string;
  /** Reels: custom cover image. */
  cover?: MediaSource;
  /** Reels: frame used as the cover when no cover image is given, in milliseconds. */
  thumb_offset_ms?: number;
  /** Reels: also show in the main feed grid (default true). */
  share_to_feed?: boolean;
  /** Reels: rename the original audio. */
  audio_name?: string;
  /** Self-disclose AI-generated content. */
  is_ai_generated?: boolean;
  /** Reels: publish as a trial reel (shown to non-followers first). */
  trial?: { graduation: TrialGraduation };
  /** Posted as the first comment right after publishing (hashtags, links, credits). */
  first_comment?: string;
  /** Convert media to Instagram's specs with ffmpeg before uploading (default true). */
  prepare?: boolean;
  /** How prepare reaches the target shape: keep (only clamp into the allowed range), crop or blur. */
  fit?: "keep" | "crop" | "blur";
  /** Template applied to the caption (see list_templates). */
  template?: string;
}

export type ItemStatus =
  "pending" | "prepared" | "hosted" | "uploading" | "processing" | "ready" | "failed";

/** Per-item progress, persisted so a restart resumes where it stopped. */
export interface ItemState {
  status: ItemStatus;
  /** Local file to upload (after download / preparation). */
  local_path?: string;
  /** File we created (prepared copy, download) and should delete when the job ends. */
  temp_paths?: string[];
  size?: number;
  mtime?: number;
  content_type?: string;
  /** Public URL handed to Meta (media host or the source URL). */
  public_url?: string;
  /** hosted_media.id, for cleanup. */
  hosted_id?: string;
  container_id?: string;
  /** Resumable upload (rupload) progress. */
  upload_uri?: string;
  bytes_sent?: number;
  error?: string;
}

export type JobStatus =
  | "scheduled" // waiting for publish_at
  | "queued" // ready to be worked on
  | "preparing" // download / ffmpeg / validation
  | "uploading" // media host or resumable upload
  | "processing" // Meta is processing containers
  | "ready" // containers finished; waiting for publish_at (holds no worker)
  | "publishing" // media_publish call in flight
  | "waiting_limit" // daily publishing limit reached; retries when the window frees up
  | "published"
  | "failed"
  | "cancelled";

export const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "uploading",
  "processing",
  "publishing",
  "waiting_limit",
];

export interface JobRow {
  id: string;
  account_row_id: string;
  kind: PostKind;
  status: JobStatus;
  spec: string;
  items: string;
  container_id: string | null;
  media_id: string | null;
  permalink: string | null;
  publish_at: number | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  next_attempt_at: number | null;
  lease_owner: string | null;
  lease_until: number | null;
  result: string | null;
  experiment_id: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface ProgressEvent {
  jobId: string;
  status: JobStatus;
  sent: number;
  total: number;
  message?: string;
}

/** What tools see. */
export interface JobView {
  job_id: string;
  account: string;
  kind: PostKind;
  /** Set for trial reels: MANUAL or SS_PERFORMANCE graduation. */
  trial_reel?: TrialGraduation;
  status: JobStatus;
  publish_at?: string;
  caption?: string;
  items: {
    type: ItemType;
    status: ItemStatus;
    source: string;
    error?: string;
    progress?: string;
  }[];
  media_id?: string;
  permalink?: string;
  error?: string;
  error_code?: string;
  next_attempt_at?: string;
  attempts: number;
  warnings?: string[];
  experiment_id?: string;
  created_at: string;
  finished_at?: string;
  result?: unknown;
}
