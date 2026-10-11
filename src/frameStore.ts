import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { samographDir } from "./config.ts";

export interface VideoFrameMetadata {
  event?: string;
  call_id?: string | null;
  source_key?: string;
  type?: string | null;
  participant?: {
    id?: string | number | null;
    name?: string | null;
    is_host?: boolean | null;
  };
  timestamp?: { absolute?: string } | null;
  updated_at?: string;
  raw_bytes?: number;
  visual_status?: string;
  archive_file?: string;
  archived_at?: string;
  age_seconds?: number;
}

export interface DecodedVideoFrame {
  raw: Uint8Array;
  metadata: VideoFrameMetadata;
}

export interface FrameInventory {
  frames: VideoFrameMetadata[];
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveVideoFrameDir(frameDir?: string | null, create = true): string {
  const dir = frameDir ? expandUser(frameDir) : join(samographDir(), "frames");
  if (create) {
    const dirExisted = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirExisted || !frameDir) {
      chmodSync(dir, 0o700);
    }
  }
  return dir;
}

export function resolveVideoFrameFile(frameDir?: string | null, create = true): string {
  return join(resolveVideoFrameDir(frameDir, create), "latest.png");
}

export function resolveFrameOutput(
  out: string | null | undefined,
  state: Record<string, unknown>,
): string {
  if (out) return expandUser(out);
  const stateFile = state.video_frame_file;
  if (typeof stateFile === "string" && stateFile) return expandUser(stateFile);
  return resolveVideoFrameFile();
}

export function safeFilenamePart(value: unknown, fallback = "unknown"): string {
  const raw = String(value || fallback);
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return safe || fallback;
}

export function frameMetadataPath(framePath: string): string {
  const ext = extname(framePath);
  return ext
    ? framePath.slice(0, -ext.length) + ".json"
    : framePath + ".json";
}

export function frameTimestampForFilename(timestamp?: { absolute?: string } | null): string {
  const absolute = timestamp?.absolute;
  const dt = absolute ? new Date(absolute) : new Date();
  const valid = Number.isNaN(dt.getTime()) ? new Date() : dt;
  return valid
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, ".$1000Z");
}

export function archivedFramePath(frameDir: string, metadata: VideoFrameMetadata): string {
  const participant = metadata.participant ?? {};
  const callPart = safeFilenamePart(metadata.call_id, "no-call");
  const timestampPart = frameTimestampForFilename(metadata.timestamp);
  const sourceType = safeFilenamePart(metadata.type, "frame");
  const participantId = safeFilenamePart(participant.id, "unknown");
  return join(frameDir, `${callPart}_${timestampPart}_${sourceType}_${participantId}.png`);
}

/**
 * Recall's video_separate_png sends `type: "webcam" | "screenshare"`.
 * Older code (and tests) assumed "screen_share"; accept every spelling and
 * normalize to "screenshare".
 */
export function normalizeFrameType(type?: string | null): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t === "screenshare" || t === "screen_share" || t === "screen") return "screenshare";
  return t;
}

/**
 * Frames are keyed by (participant, type). A participant who shares a screen
 * sends BOTH a webcam stream and a screenshare stream with the same
 * participant id, so keying by participant alone makes them overwrite each
 * other.
 */
export function frameSourceKey(metadata: VideoFrameMetadata): string {
  const type = normalizeFrameType(metadata.type);
  const participantId = metadata.participant?.id;
  if (participantId !== undefined && participantId !== null && String(participantId) !== "") {
    return `participant:${participantId}:${type ?? "unknown"}`;
  }
  if (type) return `type:${type}`;
  return "latest";
}

export function normalizeFrameSource(source?: string | null): string | null {
  if (!source || source === "latest") return null;
  const s = source.trim();
  if (s === "screen" || s === "screen_share" || s === "screenshare") return "type:screenshare";
  if (s === "webcam") return "type:webcam";
  if (s.startsWith("type:")) return `type:${normalizeFrameType(s.slice(5))}`;
  if (s.startsWith("participant:")) {
    const rest = s.slice("participant:".length);
    const m = rest.match(/^(.*):(webcam|screenshare|screen_share|screen)$/);
    return m ? `participant:${m[1]}:${normalizeFrameType(m[2])}` : `participant:${rest}`;
  }
  return `participant:${s}`;
}

export interface StoredFrame {
  raw: Uint8Array;
  metadata: VideoFrameMetadata;
  /** Server receive time, ms since epoch. */
  receivedAt: number;
}

/** A screenshare newer than this wins the default (no --source) selection. */
export const SCREENSHARE_PREFER_MS = 10_000;

function newest(frames: StoredFrame[]): StoredFrame | null {
  let best: StoredFrame | null = null;
  for (const f of frames) if (!best || f.receivedAt > best.receivedAt) best = f;
  return best;
}

function preferFreshScreenshare(frames: StoredFrame[], now: number): StoredFrame | null {
  const screen = newest(frames.filter((f) => normalizeFrameType(f.metadata.type) === "screenshare"));
  if (screen && now - screen.receivedAt <= SCREENSHARE_PREFER_MS) return screen;
  return newest(frames);
}

/**
 * Pick a frame for a requested source.
 * - none/latest: a fresh screenshare if someone is sharing, else newest frame.
 * - screen / type:screenshare: newest screenshare frame (any participant).
 * - participant:<id>:<type>: exact.
 * - participant:<id>: that participant's fresh screenshare, else newest.
 */
export function selectFrame(
  frames: Iterable<StoredFrame>,
  source?: string | null,
  now = Date.now(),
): StoredFrame | null {
  const all = [...frames];
  const key = normalizeFrameSource(source);
  if (!key) return preferFreshScreenshare(all, now);
  if (key.startsWith("type:")) {
    const type = key.slice(5);
    return newest(all.filter((f) => normalizeFrameType(f.metadata.type) === type));
  }
  const exact = all.find((f) => f.metadata.source_key === key);
  if (exact) return exact;
  const pid = key.slice("participant:".length);
  const mine = all.filter((f) => String(f.metadata.participant?.id ?? "") === pid);
  return mine.length ? preferFreshScreenshare(mine, now) : null;
}

export function frameAgeSeconds(frame: StoredFrame, now = Date.now()): number {
  return Math.max(0, Math.round((now - frame.receivedAt) / 100) / 10);
}

export function frameVisualStatus(raw: Uint8Array): string {
  if (raw.byteLength === 0) return "empty";
  if (raw.byteLength < 2048) return "tiny_or_placeholder";
  return "unknown";
}

export function writeFrameFiles(
  out: string,
  raw: Uint8Array,
  metadata?: VideoFrameMetadata,
): void {
  const dir = dirname(out);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!dirExisted) {
    chmodSync(dir, 0o700);
  }
  writeFileSync(out, raw, { mode: 0o600 });
  chmodSync(out, 0o600);
  if (metadata !== undefined) {
    const metadataFile = frameMetadataPath(out);
    writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    chmodSync(metadataFile, 0o600);
  }
}

export function archiveFrameBytes(
  frameDir: string,
  raw: Uint8Array,
  metadata: VideoFrameMetadata,
): string {
  const archiveFile = archivedFramePath(frameDir, metadata);
  const archived = {
    ...metadata,
    archive_file: archiveFile,
    archived_at: new Date().toISOString(),
  };
  writeFrameFiles(archiveFile, raw, archived);
  return archiveFile;
}

export function archiveExistingFrame(latestFile: string): string {
  const metadataFile = frameMetadataPath(latestFile);
  const metadata = existsSync(metadataFile)
    ? (JSON.parse(readFileSync(metadataFile, "utf-8")) as VideoFrameMetadata)
    : {};
  const archiveFile = archivedFramePath(dirname(latestFile), metadata);
  const archiveDir = dirname(archiveFile);
  const dirExisted = existsSync(archiveDir);
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  if (!dirExisted) {
    chmodSync(archiveDir, 0o700);
  }
  copyFileSync(latestFile, archiveFile);
  chmodSync(archiveFile, 0o600);
  writeFileSync(
    frameMetadataPath(archiveFile),
    JSON.stringify(
      {
        ...metadata,
        archive_file: archiveFile,
        archived_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(frameMetadataPath(archiveFile), 0o600);
  return archiveFile;
}

export function decodeVideoSeparatePng(
  payload: unknown,
  callId?: string | null,
): DecodedVideoFrame | null {
  const p = (payload ?? {}) as {
    event?: string;
    data?: {
      data?: {
        buffer?: string;
        type?: string | null;
        participant?: {
          id?: string | number | null;
          name?: string | null;
          is_host?: boolean | null;
        };
        timestamp?: { absolute?: string } | null;
      };
    };
  };
  if (p.event !== "video_separate_png.data") return null;
  const inner = p.data?.data ?? {};
  if (!inner.buffer) return null;
  const raw = new Uint8Array(Buffer.from(inner.buffer, "base64"));
  const participant = inner.participant ?? {};
  const metadata: VideoFrameMetadata = {
    event: p.event,
    call_id: callId ?? null,
    type: inner.type ?? null,
    participant: {
      id: participant.id ?? null,
      name: participant.name ?? null,
      is_host: participant.is_host ?? null,
    },
    timestamp: inner.timestamp ?? null,
    updated_at: new Date().toISOString(),
    raw_bytes: raw.byteLength,
    visual_status: frameVisualStatus(raw),
  };
  metadata.source_key = frameSourceKey(metadata);
  return {
    raw,
    metadata,
  };
}
