import { appendFileSync } from "node:fs";
import { formatTranscriptLine } from "./transcript.ts";

/**
 * Process a webhook payload, appending a formatted transcript line to the
 * transcript file when the payload is a transcript.data event with words.
 */
export async function handleWebhook(
  payload: unknown,
  transcriptPath: string,
): Promise<void> {
  const line = formatTranscriptLine(payload);
  if (line !== null) {
    appendFileSync(transcriptPath, line + "\n");
  }
}

/**
 * Run the webhook server. Replaces the Python Flask server.
 * POST /webhook -> handleWebhook, returns {ok:true}.
 */
export function serve(port: number, transcriptPath: string) {
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/webhook") {
        let payload: unknown = {};
        try {
          payload = await req.json();
        } catch {
          payload = {};
        }
        await handleWebhook(payload, transcriptPath);
        return Response.json({ ok: true });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}
