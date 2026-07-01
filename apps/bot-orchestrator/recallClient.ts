/**
 * Real-Recall flag seam (SPEC §4.4, §5.2, §5.9, §6.1; issue #88).
 *
 * One factory chooses which Recall client the call-creation flow uses:
 *   - DEFAULT (the flag is off, the CI/local baseline): the deterministic in-repo
 *     fake (`packages/test-fakes/recall`) — no key, no network, byte-stable (§6.1).
 *   - LIVE (`RECALL_LIVE` — or its `RECALL_AI` alias — truthy AND `RECALL_API_KEY`
 *     set): the REAL `src/recall.ts` client (`makeRecallClient`, fetch-injectable),
 *     so the owner can watch an ACTUAL bot join a Zoom/Meet call.
 *
 * The shared Recall key boundary (§4.4) is honored: the key is read here in the
 * orchestrator process only, and the live path is REFUSED (a clear startup error,
 * never a silent fallback) when the flag is set without a key.
 *
 * Live transcript ingest is a SEPARATE concern (it additionally needs a public
 * webhook tunnel — the sprint-exit gate): this seam only gets a real bot INTO the
 * call and registers a real-time Deepgram webhook against `PUBLIC_WEBHOOK_BASE`.
 */
import {
  makeRecallClient,
  type RecallClient as SrcRecallClient,
  type FetchFn,
} from "../../src/recall.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";
import type { RecallClient, CreateBotRequest, CreatedBot } from "./index.ts";

/** Injectable seams for the factory; all default to the production environment. */
export interface RecallClientDeps {
  /** Environment to read the flag + key from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Fetch for the REAL client (a stub in tests, real `fetch` in prod). */
  fetch?: FetchFn;
  /** Per-call seed for the deterministic fake (the call id); ignored when live. */
  seed?: string;
}

/** Values of `RECALL_LIVE` / `RECALL_AI` that enable the real Recall path. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Is the real-Recall path enabled? True iff `RECALL_LIVE` (canonical) or its
 * `RECALL_AI` alias is a recognized truthy value. Off by default so CI/local stay
 * on the fake with no key.
 */
export function isRecallLive(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.RECALL_LIVE ?? env.RECALL_AI ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/**
 * The REAL `src/recall.ts` client (`createBot`/`sendChat`/`leaveCall`/…), wired to
 * the injected (or global) fetch. This is the client the bot-orchestrator's
 * createBot path AND the bot-worker's `sendChat`/`leaveCall` (§5.8/§5.9) route
 * through when live. Throws a clear error — NEVER a silent fallback — if the flag
 * is set but `RECALL_API_KEY` is missing.
 */
export function liveRecallClient(deps: RecallClientDeps = {}): SrcRecallClient {
  const env = deps.env ?? process.env;
  const key = (env.RECALL_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "real Recall is enabled (RECALL_LIVE) but RECALL_API_KEY is missing — refusing " +
        "to start the real Recall path. Set RECALL_API_KEY, or unset RECALL_LIVE to use " +
        "the deterministic fake.",
    );
  }
  return makeRecallClient(deps.fetch ?? fetch);
}

/**
 * Build the real Recall `POST /bot/` payload from the orchestrator's per-call
 * {@link CreateBotRequest}, mirroring the proven CLI shape (`src/commands/join.ts`):
 *   - `bot_name` = `samograph (recording)` (§5.9, the non-customizable v1 identity);
 *   - real-time transcription via Deepgram (`recording_config.transcript.provider`);
 *   - one real-time `webhook` endpoint at the public ingress carrying the per-call
 *     ingest secret (`?t=`), subscribed to transcript + status events.
 *
 * Recall assigns `recall_bot_id` only in the createBot RESPONSE, so the endpoint
 * URL we register at creation cannot embed `?bot=<id>`; Recall echoes the bot id in
 * every event body (the CLI's pattern), and the orchestrator records the canonical
 * `?bot=<id>&t=<secret>` form (§5.3) once the id is known (see {@link getRecallClient}).
 */
export function buildRealCreateBotPayload(req: CreateBotRequest): Record<string, unknown> {
  // `buildWebhookUrl(id)` → `<base>/webhook?bot=<id>&t=<secret>`. Recover the base
  // origin+path and the ingest secret from a bot-less sample, then register the
  // realtime endpoint carrying only `?t=` (the bot id is unknown until the response).
  const sample = new URL(req.buildWebhookUrl(""));
  const ingestSecret = sample.searchParams.get("t") ?? "";
  const webhookUrl = `${sample.origin}${sample.pathname}?t=${encodeURIComponent(ingestSecret)}`;

  return {
    meeting_url: req.meetingUrl,
    bot_name: req.botName,
    recording_config: {
      transcript: {
        provider: {
          deepgram_streaming: { model: "nova-3", language: "multi", mip_opt_out: true },
        },
        diarization: { use_separate_streams_when_available: true },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: webhookUrl,
          events: ["transcript.data", "bot.status_change"],
        },
      ],
    },
  };
}

/**
 * The Recall client the call-creation flow (`enqueue` → `orchestrateJoin` →
 * `createBot`) uses. Live → the real client driven by {@link buildRealCreateBotPayload}
 * (returning the Recall-assigned id + the canonical §5.3 webhook URL for records);
 * otherwise → the deterministic fake seeded by `deps.seed` (byte-stable, no network).
 */
export function getRecallClient(deps: RecallClientDeps = {}): RecallClient {
  const env = deps.env ?? process.env;

  if (isRecallLive(env)) {
    const real = liveRecallClient(deps); // throws (no fallback) if the key is missing
    return {
      async createBot(req: CreateBotRequest): Promise<CreatedBot> {
        const created = (await real.createBot(buildRealCreateBotPayload(req))) as {
          id?: unknown;
        };
        const id = typeof created?.id === "string" && created.id ? created.id : null;
        if (!id) throw new Error("Recall createBot returned no bot id");
        return { id, webhookUrl: req.buildWebhookUrl(id) };
      },
    };
  }

  const seed = deps.seed ?? "samograph-fake";
  return {
    async createBot(req: CreateBotRequest): Promise<CreatedBot> {
      const { id } = createRecallFake({ seed }).createBot();
      return { id, webhookUrl: req.buildWebhookUrl(id) };
    },
  };
}
