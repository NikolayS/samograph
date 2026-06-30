/**
 * LOCAL-ONLY composed LIVE-TRANSPORT server (#99) — ingest + ws-hub in ONE
 * process around a shared Hub, so a human can watch a live transcript stream
 * locally on the deterministic fake (no real Recall, no tunnel, no tokens).
 *
 * This is the live analog of `apps/app-api/dev-server.ts`: an INTEGRATION SEAM
 * that does not exist in production (where ingest and ws-hub are separate
 * processes joined by `pg_notify`/LISTEN — deferred while Bun's SQL has no LISTEN
 * consumer). It is intentionally NOT a production entrypoint:
 *
 *   - the per-region webhook secret is an obvious DEV-ONLY constant;
 *   - `POST /__dev/say {call_id, speaker, text}` injects a transcript line
 *     WITHOUT webhook auth (a human can't sign one — the ingest_secret plaintext
 *     is never stored), driving the REAL §5.4 pipeline + §98 fan-in so the line
 *     streams to every connected per-call page;
 *   - session cookies are verified with the SAME `SESSION_SECRET` as the app-api
 *     dev-server (share-token parity with app-api is out of scope for the demo).
 *
 * Ports: ws-hub (stream) :8788, ingest (webhook) :8089, dev control :8790.
 */
import { connect, setTenant } from "../../packages/shared/db/index.ts";
import { encodeSignal, type TranscriptFrame, type TranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";
import type { Keyring } from "../../packages/shared/tokens/signing.ts";
import type { AuthorizeDeps } from "../../packages/shared/auth/index.ts";
import { verifySession } from "../app-api/auth/session.ts";
import { inMemoryWebhookSecretProvider } from "../ingest/webhook.ts";
import { createTranscriptPipeline, inMemoryTranscriptMetrics } from "../ingest/transcriptPipeline.ts";
import type { ValidatedEvent } from "../ingest/webhook.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import { composeLiveStack } from "./liveBridge.ts";

// ── DEV-ONLY config + secrets (clearly marked; NEVER use in production) ────────
const WS_HUB_PORT = Number(process.env.WS_HUB_PORT ?? 8788);
const INGEST_PORT = Number(process.env.INGEST_PORT ?? 8089);
const DEV_CTRL_PORT = Number(process.env.DEV_CTRL_PORT ?? 8790);
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-only-session-secret-change-me";
const DEV_TOKEN_SECRET = process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd";
const DEV_WEBHOOK_SECRET = process.env.RECALL_WEBHOOK_SECRET ?? "dev-only-webhook-secret-change-me";

const usingDevSecrets = !process.env.SESSION_SECRET || !process.env.RECALL_WEBHOOK_SECRET;

const sql = connect();

const keyring: Keyring = { current: { kid: "dev-share", secret: DEV_TOKEN_SECRET } };

const authDeps: AuthorizeDeps = {
  keyring,
  // Verify the signed session cookie the app-api dev-server set (pure HMAC, no DB).
  lookupSession: async (cookie) => {
    const claims = verifySession(cookie, SESSION_SECRET);
    return claims ? { userId: claims.userId, tenantId: claims.tenantId } : null;
  },
  // Privileged pre-tenant call→tenant resolver (share-token + fan-in path).
  lookupCallTenant: async (callId) => {
    try {
      const r = await sql`SELECT tenant_id FROM calls WHERE id = ${callId}`;
      return r.length ? (r[0] as { tenant_id: string }).tenant_id : null;
    } catch {
      return null;
    }
  },
};

const stack = composeLiveStack({
  sql,
  authDeps,
  secretProvider: inMemoryWebhookSecretProvider(DEV_WEBHOOK_SECRET),
  wsPort: WS_HUB_PORT,
  ingestPort: INGEST_PORT,
});

/** DEV-ONLY: inject a transcript line for an existing call (no webhook auth). */
async function devSay(callId: string, speaker: string, text: string): Promise<void> {
  const tenantId = await authDeps.lookupCallTenant(callId);
  if (!tenantId) throw new Error(`unknown call_id: ${callId}`);

  const captured: TranscriptFrame[] = [];
  const capturing: TranscriptPublisher = {
    publish: (f) => {
      captured.push(f);
    },
  };
  const pipeline = createTranscriptPipeline({ publisher: capturing, metrics: inMemoryTranscriptMetrics() });
  const event: ValidatedEvent = {
    kind: "transcript.data",
    botId: "dev",
    callId,
    tenantId,
    recallEventId: `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    payload: createRecallFake({ seed: "dev-live" }).transcriptData({
      speaker,
      words: text.split(/\s+/).filter(Boolean),
    }),
  };

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    await setTenant(tx, tenantId);
    await pipeline.handleTranscriptEvent(tx, event);
  });
  // Deliver to the shared Hub after commit (same as the bridge's webhook path).
  for (const frame of captured) await stack.fanIn.deliver(encodeSignal(frame));
}

const ctrl = Bun.serve({
  port: DEV_CTRL_PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method === "POST" && url.pathname === "/__dev/say") {
      let body: { call_id?: string; speaker?: string; text?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "expected JSON {call_id, speaker, text}" }, { status: 400 });
      }
      if (!body.call_id || !body.text) {
        return Response.json({ error: "call_id and text are required" }, { status: 400 });
      }
      try {
        await devSay(body.call_id, body.speaker ?? "Speaker", body.text);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String((err as Error).message) }, { status: 404 });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `\n[live] composed ingest + ws-hub on a shared Hub (LOCAL-ONLY, fake)\n` +
    `  ws-hub stream : ${stack.wsHub.url}/calls/:id/stream  (WS) + /calls/:id/transcript (REST)\n` +
    `  ingest webhook: ${stack.ingest.url}/webhook  (signed fake webhooks)\n` +
    `  dev control   : http://localhost:${ctrl.port}/__dev/say  (POST {call_id, speaker, text})\n` +
    `  Recall: in-repo deterministic FAKE — no real bot, no tunnel\n\n` +
    `  Watch a call live:\n` +
    `    1. create a call via the app-api dev-server, copy its <call_id>\n` +
    `    2. open the per-call page (web) — its WS connects to the ws-hub above\n` +
    `    3. inject a line:\n` +
    `       curl -s http://localhost:${ctrl.port}/__dev/say \\\n` +
    `         -H 'content-type: application/json' \\\n` +
    `         -d '{"call_id":"<call_id>","speaker":"Alice","text":"hello from the live stream"}'\n`,
);
if (usingDevSecrets) {
  console.warn(
    "[live] ⚠️  DEV-ONLY secrets in use (SESSION_SECRET / RECALL_WEBHOOK_SECRET fallbacks). " +
      "NOT secret; MUST NOT be used in production.",
  );
}
