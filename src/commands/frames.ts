import { ExitError } from "../config.ts";
import { loadState } from "../state.ts";
import type { VideoFrameMetadata } from "../frameStore.ts";

export interface FramesDeps {
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function cmdFrames(deps: FramesDeps = {}): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const state = loadState();
  const metadataUrl = state.local_frame_metadata_url;
  if (typeof metadataUrl !== "string" || !metadataUrl) {
    process.stderr.write("FRAMES_UNAVAILABLE: WebSocket frame capture is not active.\n");
    throw new ExitError(1);
  }
  const framesUrl = metadataUrl.replace(/\/frame\.json(?:\?.*)?$/, "/frames.json");
  const headers: Record<string, string> = {};
  if (typeof state.frame_token === "string" && state.frame_token) {
    headers["X-Samograph-Frame-Token"] = state.frame_token;
  }
  let resp: Response;
  try {
    resp = await fetchFn(framesUrl, { headers });
  } catch (e) {
    process.stderr.write(
      `FRAMES_UNAVAILABLE: local WebSocket frame server is not reachable: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    throw new ExitError(1);
  }
  if (!resp.ok) {
    process.stderr.write(`FRAMES_UNAVAILABLE: local frame inventory returned ${resp.status}.\n`);
    throw new ExitError(1);
  }
  const data = (await resp.json()) as { frames?: VideoFrameMetadata[] };
  const frames = data.frames ?? [];
  if (frames.length === 0) {
    process.stdout.write("No WebSocket frames received yet.\n");
    return;
  }
  for (const frame of frames) {
    const source = frame.source_key ?? "?";
    const type = frame.type ?? "?";
    const participant = frame.participant?.name ?? frame.participant?.id ?? "?";
    const at = frame.timestamp?.absolute ?? frame.updated_at ?? "?";
    const bytes = frame.raw_bytes === undefined ? "?" : String(frame.raw_bytes);
    const visual = frame.visual_status ?? "unknown";
    process.stdout.write(`${source}\t${type}\t${participant}\t${at}\t${bytes} bytes\t${visual}\n`);
  }
}
