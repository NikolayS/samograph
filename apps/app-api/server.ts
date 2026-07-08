/**
 * PROD app-api entrypoint (SPEC §4.1; issues #105 + #64).
 *
 * The real production server: it composes the SAME auth + calls surface as the
 * dev wrapper via {@link createAppApi}, but with NO dev shortcuts — so the
 * session cookie keeps its `Secure` flag (the live prod hole where dev-server's
 * `devCookieFix` stripped `Secure` off EVERY response cannot exist here) and
 * `GET /__dev/last-magic-link` does not exist.
 *
 * Startup order is fail-closed: {@link assertNoDevDefaultSecrets} runs BEFORE
 * anything binds a port, so a prod box missing a real signing secret (or still
 * carrying a committed dev-default literal) refuses to boot (#64).
 *
 * Recall key boundary: this file NEVER reads `RECALL_API_KEY`. The orchestrator/
 * poller seam is constructed exactly as the dev-server does — through
 * `getRecallClient` / `isRecallLive` / `liveRecallClient` / `liveBotStatusSource`
 * — which own the key internally.
 *
 * NOTE (infra): repointing the VM systemd unit / start-preview.sh from
 * `dev-server.ts` to THIS file (and setting `SAMO_ENV=prod` + real secrets) is a
 * separate infra step. Until then prod keeps running `dev-server.ts` and keeps
 * stripping `Secure`.
 */
import { createAppApi } from "./app.ts";
import {
  emailSenderFromEnv,
  PostgresMagicLinkStore,
  type EmailSender,
  type MagicLinkEmail,
} from "./auth/index.ts";
import { connect } from "../../packages/shared/db/index.ts";
import {
  assertNoDevDefaultSecrets,
  APP_API_SIGNING_SECRETS,
  type EnvLike,
} from "../../packages/shared/config/env.ts";
import {
  publicWebhookBase,
  runJoinJob,
  pgCallStore,
  sanitizeFailureReason,
  type OrchestratorJob,
} from "../bot-orchestrator/index.ts";
import { getRecallClient, isRecallLive, liveRecallClient } from "../bot-orchestrator/recallClient.ts";
import { liveRecallBotActions } from "../bot-orchestrator/recallBotActions.ts";
import {
  startStatusPoller,
  liveBotStatusSource,
  STATUS_POLL_INTERVAL_MS,
} from "../bot-orchestrator/statusPoller.ts";
import { PgListenNotifyPublisher } from "../../packages/shared/transcript/publisher.ts";
import { MetricsRegistry } from "../../packages/shared/observe/index.ts";

/**
 * Prod email fallback: if `RESEND_API_KEY` is not configured there is NO dev
 * fake in prod, so a magic-link request fails LOUDLY rather than silently
 * dropping the mail.
 */
function unconfiguredEmailSender(): EmailSender {
  return {
    async sendMagicLink(_email: MagicLinkEmail): Promise<void> {
      throw new Error(
        "no email transport configured in prod: set RESEND_API_KEY + MAGIC_LINK_FROM",
      );
    },
  };
}

/**
 * Start the prod app-api server. Fail-closed FIRST, then compose + serve. Only
 * called for real when this module is the entry (`import.meta.main`); tests
 * import it to exercise the fail-closed throw without binding a port.
 */
export function startAppApiServer(env: EnvLike = process.env): ReturnType<typeof Bun.serve> {
  // ── #64 fail-closed: hard-error BEFORE anything binds a port. app-api uses
  // all three signing secrets (magic links + sessions + share/capability tokens).
  assertNoDevDefaultSecrets(env, APP_API_SIGNING_SECRETS);

  const port = Number(env.APP_API_PORT ?? 8787);
  const webOrigin = env.WEB_ORIGIN ?? "https://samograph.dev";
  // Guaranteed non-dev-default + present by the fail-closed assert above.
  const sessionSecret = env.SESSION_SECRET as string;
  const magicLinkSecret = env.MAGIC_LINK_SECRET as string;
  const tokenSecret = env.TOKEN_SECRET as string;
  const magicLinkKid = env.MAGIC_LINK_KID ?? "prod-kid-1";
  // Share tokens are minted here but VERIFIED by the ws-hub — both sides must use
  // the SAME kid to select the key. Keep parity with the ws-hub keyring's kid.
  const tokenKid = env.TOKEN_KID ?? "dev-share";

  const sql = connect();
  // ONE shared §5.11 registry per process (issue #108): the bot-join producer
  // (poller + runJoinJob) increments it and it is scraped at GET /metrics.
  const registry = new MetricsRegistry();
  // REAL transactional email (Resend) when RESEND_API_KEY is set; otherwise the
  // prod fallback throws on send (no silent drop, no dev fake in prod).
  const sender = emailSenderFromEnv(env, unconfiguredEmailSender());

  // Validate PUBLIC_WEBHOOK_BASE once (fail fast on a malformed value).
  const webhookBase = publicWebhookBase(env);

  // Fail fast at STARTUP when the real Recall path is requested without a key
  // (#88) — never silently fall back to the fake. NEVER reads the key here.
  if (isRecallLive()) liveRecallClient();

  // bot-orchestrator seam (§5.2): privileged connection, RLS-bypassing infra write.
  async function enqueue(job: OrchestratorJob): Promise<void> {
    const recall = getRecallClient({ seed: job.callId });
    try {
      const outcome = await runJoinJob(job, {
        recall,
        store: pgCallStore(sql),
        webhookBase,
        metrics: registry, // §5.11 bot_join_total{could_not_join} (issue #108/#107)
        logger: { info: (event, fields) => console.log(`[orchestrator] ${event}`, fields ?? {}) },
      });
      if (outcome.status === "COULD_NOT_JOIN") {
        console.error(`[orchestrator] call ${outcome.callId} → COULD_NOT_JOIN (${outcome.reason})`);
        return;
      }
      console.log(
        `[orchestrator] call ${outcome.callId} → ${outcome.status} ` +
          `(bot ${outcome.recallBotId}, region ${outcome.region})`,
      );
    } catch (err) {
      console.error(
        `[orchestrator] join failed for call ${job.callId} and the failure could not ` +
          `be persisted: ${sanitizeFailureReason(err)}`,
      );
    }
  }

  // Recall bot-STATUS POLLER (#118): with real Recall the call status would
  // stick at JOINING forever without this privileged cross-tenant poll. Fake
  // mode has no live bot to poll, so it starts only when live — same as dev.
  if (isRecallLive()) {
    startStatusPoller({
      sql,
      source: liveBotStatusSource(),
      actions: liveRecallBotActions(),
      publisher: new PgListenNotifyPublisher(sql),
      metrics: registry, // §5.11 bot_join_total{in_call|could_not_join|could_not_record} (#108/#107)
      logger: console,
    });
    console.log(
      `[status-poller] polling Recall bot status every ${STATUS_POLL_INTERVAL_MS / 1000}s ` +
        `for non-terminal calls (#118; §5.9 disclosure + live status push)`,
    );
  }

  const api = createAppApi({
    sql,
    sessionSecret,
    magicLinkKid,
    magicLinkSecret,
    tokenKeyring: { current: { kid: tokenKid, secret: tokenSecret } },
    emailSender: sender,
    webOrigin,
    enqueue,
    registry, // §5.11 GET /metrics scrape source (issue #108)
    // PROD: restart/replica-safe magic-link store (issue #62). Migration 0007
    // MUST be applied before this server boots. dev-server keeps the in-memory
    // store. Auth is a privileged pre-tenant path, so `sql` is the privileged
    // connection and `magic_links` carries no RLS / no samograph_app grant.
    linkStore: new PostgresMagicLinkStore(sql),
    // PROD: no dev shortcuts — Secure is never stripped; no /__dev route exists.
    devShortcuts: undefined,
  });

  const server = Bun.serve({ port, fetch: api.fetch });
  console.log(
    `\n[app-api] PROD server listening on http://localhost:${server.port} (SAMO_ENV=prod)\n` +
      `  routes: GET /health | POST /auth/magic-link | GET /auth/callback |\n` +
      `          POST /auth/logout | POST/GET /calls | share routes\n` +
      `  magic-link callbacks point at ${webOrigin}\n` +
      `  Recall: ${isRecallLive() ? `REAL → webhook base ${webhookBase ?? "(regional default)"}` : "FAKE"}\n` +
      `  Email:  ${env.RESEND_API_KEY ? `REAL via Resend from ${env.MAGIC_LINK_FROM}` : "UNCONFIGURED (magic-link send will error)"}\n` +
      `  Cookies: Secure ENFORCED (never stripped)\n`,
  );
  return server;
}

if (import.meta.main) startAppApiServer();
