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
 * NOTE (infra): the cutover from dev-server.ts to this file (+ SAMO_ENV=prod +
 * real secrets in envFile) is done — start-prod.sh on the VM now launches this
 * file. start-preview.sh (the old dev-launcher) is superseded by samohost's
 * per-service execStart declared in .samohost.toml; it should be removed from
 * /opt/samograph/ on next hostprep.
 */
import { createAppApi } from "./app.ts";
import {
  emailSenderFromEnv,
  googleOAuthFromEnv,
  googleOAuthIsConfigured,
  googleOAuthRedirectUriOverride,
  GoogleOAuthError,
  PostgresMagicLinkStore,
  type EmailSender,
  type MagicLinkEmail,
  type AccountDeletionEmail,
  type IdentityLinkedEmail,
} from "./auth/index.ts";
import { connect } from "../../packages/shared/db/index.ts";
import {
  assertNoDevDefaultSecrets,
  perEnvBaseUrl,
  resolveMagicLinkBaseUrl,
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
import {
  getRecallClient,
  getCallRecordingControl,
  isRecallLive,
  liveRecallClient,
} from "../bot-orchestrator/recallClient.ts";
import { liveRecallBotActions } from "../bot-orchestrator/recallBotActions.ts";
import {
  startStatusPoller,
  liveBotStatusSource,
  STATUS_POLL_INTERVAL_MS,
} from "../bot-orchestrator/statusPoller.ts";
import { PgListenNotifyPublisher } from "../../packages/shared/transcript/publisher.ts";
import { MetricsRegistry } from "../../packages/shared/observe/index.ts";
import { createCachedFunnelSource } from "./metrics/funnelSource.ts";
import { resolveCalendarConfig, formatCalendarStartupLine } from "./calendar/resolve-config.ts";
export { formatCalendarStartupLine } from "./calendar/resolve-config.ts";
import { startCalendarSyncPoller } from "./calendar/poller.ts";
import { CalendarSyncService } from "./calendar/sync.ts";
import { PostgresCalendarConnectionStore } from "./calendar/pg-store.ts";
import { createCallForTenant } from "./calls/create-call.ts";
import { InMemoryRateLimiter } from "./auth/rate-limit.ts";

process.on("unhandledRejection", (reason) => {
  console.error("[app-api] unhandledRejection:", reason);
  process.exit(1);
});

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
    async sendAccountDeletion(_email: AccountDeletionEmail): Promise<void> {
      throw new Error(
        "no email transport configured in prod: set RESEND_API_KEY + MAGIC_LINK_FROM",
      );
    },
    async sendIdentityLinked(_email: IdentityLinkedEmail): Promise<void> {
      throw new Error(
        "no email transport configured in prod: set RESEND_API_KEY + MAGIC_LINK_FROM",
      );
    },
  };
}

/**
 * The LAST-RESORT public origin this entrypoint builds URLs against when an
 * environment sets neither `BASE_URL` (samohost, per-env) nor `WEB_ORIGIN`.
 *
 * Pinned as a named constant so {@link assertGoogleWebOriginConfigured} and the
 * `resolveMagicLinkBaseUrl` call below cannot drift apart, and so a change to it
 * has to appear as a deliberate line in a diff.
 */
export const APP_API_WEB_ORIGIN_FALLBACK = "https://samograph.dev";

/**
 * Refuse to boot when the Google redirect URI would derive from
 * {@link APP_API_WEB_ORIGIN_FALLBACK} rather than from real per-env config
 * (#209; restores the property #236 gave up, per finding 1 of that PR's samorev
 * review).
 *
 * #236 added `https://samograph.dev` to `GOOGLE_REGISTERED_REDIRECT_ORIGINS`
 * because the owner intends that host as prod. It is also the literal this file
 * falls back to, so the compiled-in allowlist stopped catching an environment
 * that has lost BOTH `BASE_URL` and `WEB_ORIGIN`: such an env now boots happily
 * and every user's Google click dies at Google with `redirect_uri_mismatch` —
 * later, quieter, and in Google's logs rather than ours.
 *
 * Deliberately GOOGLE-SCOPED, all three conditions required:
 *
 *  - `perEnvBaseUrl(env) ?? env.WEB_ORIGIN` is `undefined` — the SAME expression
 *    {@link resolveMagicLinkBaseUrl} evaluates before reaching its default, so
 *    this fires exactly when the origin comes from the hard-coded fallback;
 *  - Google is configured ({@link googleOAuthIsConfigured} — one shared notion,
 *    so a half-configured client still reaches `googleOAuthFromEnv`'s own throw);
 *  - `GOOGLE_OAUTH_REDIRECT_URI` is unset — an operator who pinned the URI has
 *    asserted the host, and that override skips derivation entirely.
 *
 * Blast radius is ZERO for the magic-link path (its `samograph.dev` default is
 * untouched), for any env that sets either var, and for any env with no Google
 * credentials — every branch preview, by design. It asserts nothing about WHICH
 * hosts are registered, so it survives the prod/staging remap unchanged.
 *
 * NOT needed in `dev-server.ts`: its own fallback is `http://localhost:3000`,
 * which IS a registered origin, so the trap does not exist there.
 */
export function assertGoogleWebOriginConfigured(env: EnvLike): void {
  const configuredWebOrigin = perEnvBaseUrl(env) ?? env.WEB_ORIGIN;
  if (configuredWebOrigin !== undefined) return;
  if (!googleOAuthIsConfigured(env)) return;
  if (googleOAuthRedirectUriOverride(env) !== undefined) return;
  // Names both fixes, echoes NO credential value (not the client id, not the
  // secret, not a fragment of either) — same rule as every other throw on this
  // path in google-oauth.ts.
  throw new GoogleOAuthError(
    "Google sign-in is configured but this environment sets neither BASE_URL nor " +
      "WEB_ORIGIN, so the Google redirect URI would silently derive from the " +
      `hard-coded ${APP_API_WEB_ORIGIN_FALLBACK} fallback in apps/app-api/server.ts ` +
      "and every sign-in would die at Google with redirect_uri_mismatch — set " +
      "BASE_URL (or WEB_ORIGIN) to THIS environment's own public origin, or set " +
      "GOOGLE_OAUTH_REDIRECT_URI explicitly to the URI registered for this host",
  );
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
  // #190: build the magic-link callback against THIS env's own public host —
  // BASE_URL when samohost set it (previews), else WEB_ORIGIN (prod). Trusted env
  // value only, never the request Host header.
  const webOrigin = resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK);
  // #209: the hard-coded fallback above must never SILENTLY become the Google
  // redirect origin. Runs before `connect()` and before anything binds a port.
  assertGoogleWebOriginConfigured(env);
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
  // §9 activation-funnel feed (issue #16): read-only, counts-only aggregate over
  // the privileged connection, cached + background-refreshed so the synchronous
  // /metrics scrape stays fast. Folded into /metrics as the samograph_funnel_*
  // gauges — THE v1 success metric.
  const funnelSource = createCachedFunnelSource(sql, {
    logger: { error: (msg) => console.error(msg) },
    // The same periodic read republishes samograph_magic_link_status (#222).
    registry,
  });
  funnelSource.start();
  // REAL transactional email (Resend) when RESEND_API_KEY is set; otherwise the
  // prod fallback throws on send (no silent drop, no dev fake in prod).
  const sender = emailSenderFromEnv(env, unconfiguredEmailSender());

  // §5.1 / S5-1 "Continue with Google" (issue #209). Resolved HERE, inside the
  // start function — never at module top level, so a repo with no Google config
  // stays importable under `bun test`. Returns `undefined` when NEITHER
  // credential is set (Google sign-in is simply off, which is the designed state
  // of every branch preview); THROWS at boot when exactly one is set or the
  // redirect URI cannot be derived, rather than letting every user's click die
  // at Google with `redirect_uri_mismatch`. See docs/runbooks/google-oauth.md.
  const googleOAuth = googleOAuthFromEnv(env, webOrigin);
  const { googleCalendarOAuth, calendarTokenEncryption } = resolveCalendarConfig(env, webOrigin);
  const calendarStore = new PostgresCalendarConnectionStore(sql);
  const calendarAutoJoinRateLimiter = new InMemoryRateLimiter();
  const calendarPoller = googleCalendarOAuth && calendarTokenEncryption && googleCalendarOAuth.apiClient
    ? startCalendarSyncPoller({
        sql,
        syncConnection: (connectionId) => new CalendarSyncService({ store: calendarStore, client: googleCalendarOAuth.apiClient!, decryptionKeys: calendarTokenEncryption.decryptionKeys }).sync(connectionId),
        autoJoinStore: { candidates: (...args) => calendarStore.autoJoinCandidates(...args) },
        createCall: (input) => createCallForTenant(input, { sql, enqueue, rateLimiter: calendarAutoJoinRateLimiter, now: Date.now }),
        metrics: registry,
        logger: { warn: (message) => console.warn(message) },
      })
    : undefined;

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
    googleOAuth,
    googleCalendarOAuth,
    calendarTokenEncryption,
    enqueue,
    callRateLimiter: calendarAutoJoinRateLimiter,
    // §5.14 per-call delete: force-leave a live bot + erase its Recall recording.
    // Real acts when RECALL_LIVE, else the in-repo fake (no key, no network).
    recall: getCallRecordingControl(),
    registry, // §5.11 GET /metrics scrape source (issue #108)
    funnel: funnelSource.thunk, // §9 activation-funnel gauges at /metrics (issue #16)
    // PROD: restart/replica-safe magic-link store (issue #62). Migration 0007
    // MUST be applied before this server boots. dev-server keeps the in-memory
    // store. Auth is a privileged pre-tenant path, so `sql` is the privileged
    // connection and `magic_links` carries no RLS / no samograph_app grant.
    linkStore: new PostgresMagicLinkStore(sql),
    // PROD: no dev shortcuts — Secure is never stripped; no /__dev route exists.
    devShortcuts: undefined,
  });

  const server = Bun.serve({ port, fetch: api.fetch });
  const stopServer = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    calendarPoller?.stop();
    return stopServer(closeActiveConnections);
  }) as typeof server.stop;
  console.log(
    `\n[app-api] PROD server listening on http://localhost:${server.port} (SAMO_ENV=prod)\n` +
      `  routes: GET /health | POST /auth/magic-link | GET /auth/callback |\n` +
      `          POST /auth/logout | GET /auth/providers | GET /auth/google/start |\n` +
      `          GET /auth/google/callback | POST/GET /calls | share routes\n` +
      `  Google sign-in: ${googleOAuth ? `ON → redirect_uri ${googleOAuth.redirectUri}` : "OFF (no credentials — magic link only)"}\n` +
      formatCalendarStartupLine({ googleCalendarOAuth, calendarTokenEncryption }) +
      `  magic-link callbacks point at ${webOrigin}\n` +
      `  Recall: ${isRecallLive() ? `REAL → webhook base ${webhookBase ?? "(regional default)"}` : "FAKE"}\n` +
      `  Email:  ${env.RESEND_API_KEY ? `REAL via Resend from ${env.MAGIC_LINK_FROM}` : "UNCONFIGURED (magic-link send will error)"}\n` +
      `  Cookies: Secure ENFORCED (never stripped)\n`,
  );
  return server;
}

if (import.meta.main) startAppApiServer();
