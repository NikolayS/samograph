/**
 * LOCAL-ONLY composed dev server for the samograph.dev stack (issues #105 + #64).
 *
 * This is now a THIN wrapper over the pure {@link createAppApi} composition
 * factory: it supplies the LOCAL-ONLY dev shortcuts (dev-default secret
 * fallbacks, the Set-Cookie `Secure`-strip, and `GET /__dev/last-magic-link`)
 * and starts `Bun.serve` + the status poller — but ONLY after asserting
 * `SAMO_ENV === 'dev'`. A prod box that mistakenly launches this file
 * hard-throws before doing anything (the prod entrypoint is `server.ts`).
 *
 * It is intentionally NOT a production entrypoint:
 *   - Magic-link email defaults to the in-memory `DevEmailSender` fake; it PRINTS
 *     the sign-in URL to stdout and exposes it at `GET /__dev/last-magic-link`.
 *     Setting `RESEND_API_KEY` + `MAGIC_LINK_FROM` flips it to the real sender.
 *   - The bot-orchestrator is backed by the deterministic in-repo Recall FAKE by
 *     default; `RECALL_LIVE=1` + `RECALL_API_KEY` (#88) flips it to the real client.
 *   - Signing/session secrets fall back to obvious DEV-ONLY constants.
 *   - Set-Cookie `Secure` is stripped so the cookie stores over http://localhost.
 */
import { createAppApi } from "./app.ts";
import {
  InMemoryMagicLinkStore,
  emailSenderFromEnv,
  googleOAuthFromEnv,
  type EmailSender,
  type MagicLinkEmail,
  type AccountDeletionEmail,
  type IdentityLinkedEmail,
} from "./auth/index.ts";
import { connect } from "../../packages/shared/db/index.ts";
import {
  resolveSamoEnv,
  resolveMagicLinkBaseUrl,
  usingDevDefaultSecrets,
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
import { resolveCalendarConfig, formatCalendarStartupLine } from "./calendar/resolve-config.ts";
import { startCalendarSyncPoller } from "./calendar/poller.ts";
import { CalendarSyncService } from "./calendar/sync.ts";
import { PostgresCalendarConnectionStore } from "./calendar/pg-store.ts";
import { createCallForTenant } from "./calls/create-call.ts";
import { InMemoryRateLimiter } from "./auth/rate-limit.ts";

/**
 * DEV-ONLY guard: this file carries the local shortcuts (Secure-strip, dev
 * secrets, /__dev route), so it refuses to boot unless SAMO_ENV=dev (default
 * prod = fail-safe). A prod box that launches it hard-throws here.
 */
export function assertDevEnv(env: EnvLike = process.env): void {
  if (resolveSamoEnv(env) !== "dev") {
    throw new Error(
      "dev-server.ts is DEV-ONLY (it strips Secure cookies and uses dev-default secrets): " +
        "refusing to boot without SAMO_ENV=dev. The prod entrypoint is apps/app-api/server.ts.",
    );
  }
}

/**
 * DEV EmailSender: never sends; prints the magic-link URL and keeps the
 * most-recent link (globally + per recipient) for `GET /__dev/last-magic-link`.
 */
class DevEmailSender implements EmailSender {
  last: MagicLinkEmail | undefined;
  readonly lastByEmail = new Map<string, MagicLinkEmail>();
  constructor(private readonly port: number) {}

  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.last = email;
    this.lastByEmail.set(email.to, email);
    console.log(
      `\n──────── DEV MAGIC LINK (no email sent) ────────\n` +
        `  to:   ${email.to}\n` +
        `  link: ${email.link}\n` +
        `  (open the link in a browser, or GET http://localhost:${this.port}/__dev/last-magic-link)\n` +
        `────────────────────────────────────────────────\n`,
    );
  }

  async sendAccountDeletion(email: AccountDeletionEmail): Promise<void> {
    console.log(
      `\n──────── DEV ACCOUNT DELETED (no email sent) ────────\n` +
        `  to: ${email.to}\n` +
        `────────────────────────────────────────────────────\n`,
    );
  }

  async sendIdentityLinked(email: IdentityLinkedEmail): Promise<void> {
    console.log(
      `\n──────── DEV IDENTITY LINKED (no email sent) ────────\n` +
        `  to:       ${email.to}\n` +
        `  provider: ${email.provider}\n` +
        `────────────────────────────────────────────────────\n`,
    );
  }
}

/**
 * DEV-ONLY: strip `Secure` from Set-Cookie so the session cookie stores over
 * http://localhost. Injected as `devShortcuts.stripSecureCookie` and therefore
 * ABSENT from the prod handler entirely (see `app.ts`) — never merely disabled.
 *
 * Two rules this must honour, both of which the naive `get`/`set` form broke:
 *
 *  1. **Per-header, never joined.** `Headers.get("set-cookie")` returns every
 *     cookie COMMA-JOINED into one string, and writing that back with `set()`
 *     produces a single malformed header — so a response carrying two cookies
 *     (the Google callback: new session + cleared `__Host-samo_oauth`) lost one.
 *     `getSetCookie()` + `append()` keeps each cookie its own header.
 *  2. **Never touch a `__Host-` cookie.** The prefix REQUIRES `Secure` (plus
 *     `Path=/` and no `Domain=`), so stripping it does not "help it work on
 *     localhost" — the browser DISCARDS the cookie outright, and the failure
 *     presents as "the state cookie vanished". The prefix is matched
 *     case-insensitively, as RFC 6265bis §4.1.3.2 specifies.
 */
export function devCookieFix(res: Response): Response {
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    headers.append(
      "set-cookie",
      /^__Host-/i.test(cookie.trimStart()) ? cookie : cookie.replace(/;\s*Secure/gi, ""),
    );
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Start the LOCAL-ONLY dev server. Asserts SAMO_ENV=dev FIRST (before any
 * connect/bind), so importing this module in a test does not start a server and
 * a prod launch throws immediately.
 */
export function startDevServer(env: EnvLike = process.env): ReturnType<typeof Bun.serve> {
  assertDevEnv(env);

  const PORT = Number(env.APP_API_PORT ?? 8787);
  // #190: same per-env callback base as prod — BASE_URL when set, else WEB_ORIGIN
  // (local dev sets neither, so this stays http://localhost:3000).
  const WEB_ORIGIN = resolveMagicLinkBaseUrl(env, "http://localhost:3000");
  const SESSION_SECRET = env.SESSION_SECRET ?? "dev-only-session-secret-change-me";
  const MAGIC_KID = env.MAGIC_LINK_KID ?? "dev-kid-1";
  const MAGIC_SECRET = env.MAGIC_LINK_SECRET ?? "dev-only-magic-link-secret-change-me";
  // Share tokens are minted HERE, verified by the ws-hub — same key + kid.
  const TOKEN_SECRET = env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd";

  // #64: include TOKEN_SECRET in the dev warn (it too can silently fall back to
  // its public dev default). In dev this only WARNS; prod fail-closes in server.ts.
  const devDefaults = usingDevDefaultSecrets(env, APP_API_SIGNING_SECRETS);

  const sql = connect();
  // ONE shared §5.11 registry per process (issue #108): scraped at GET /metrics.
  const registry = new MetricsRegistry();
  const devSender = new DevEmailSender(PORT);
  // REAL transactional email (Resend) when RESEND_API_KEY is set; otherwise the
  // DEV fake keeps printing links (local/test mode).
  const sender = emailSenderFromEnv(env, devSender);
  const emailIsLive = sender !== devSender;

  // §5.1 / S5-1 "Continue with Google" (issue #209). Local dev is normally OFF
  // (neither credential set) and keeps working on magic link. A developer who
  // wants the real round trip puts the `samograph-nonprod` pair in their env; the
  // derived redirect URI is then `http://localhost:3000/auth/google/callback`,
  // which is one of that client's registered URIs (docs/runbooks/google-oauth.md).
  // The `__Host-` state cookie keeps its `Secure` flag here — browsers accept
  // Secure cookies on http://localhost, and stripping it would make the browser
  // DISCARD the cookie outright (see `devCookieFix`).
  const GOOGLE_OAUTH = googleOAuthFromEnv(env, WEB_ORIGIN);
  const {
    googleCalendarOAuth: GOOGLE_CALENDAR_OAUTH,
    calendarTokenEncryption: CALENDAR_TOKEN_ENCRYPTION,
  } = resolveCalendarConfig(env, WEB_ORIGIN);
  const calendarStore = new PostgresCalendarConnectionStore(sql);
  const calendarAutoJoinRateLimiter = new InMemoryRateLimiter();
  const calendarPoller = GOOGLE_CALENDAR_OAUTH && CALENDAR_TOKEN_ENCRYPTION && GOOGLE_CALENDAR_OAUTH.apiClient
    ? startCalendarSyncPoller({
        sql,
        syncConnection: (connectionId) => new CalendarSyncService({ store: calendarStore, client: GOOGLE_CALENDAR_OAUTH.apiClient!, decryptionKeys: CALENDAR_TOKEN_ENCRYPTION.decryptionKeys }).sync(connectionId),
        autoJoinStore: { candidates: (...args) => calendarStore.autoJoinCandidates(...args) },
        createCall: (input) => createCallForTenant(input, { sql, enqueue, rateLimiter: calendarAutoJoinRateLimiter, now: Date.now }),
        metrics: registry,
        logger: { warn: (message) => console.warn(message) },
      })
    : undefined;

  // Validate PUBLIC_WEBHOOK_BASE once (fail fast on a malformed value).
  const WEBHOOK_BASE = publicWebhookBase(env);

  // Fail fast at STARTUP when the real Recall path is requested without a key (#88).
  if (isRecallLive()) liveRecallClient();

  /** DEV-ONLY: return the most recent magic link (optionally `?email=`). */
  function devLastMagicLink(url: URL): Response {
    if (emailIsLive) {
      return Response.json(
        { error: "real email sending is enabled (RESEND_API_KEY set) — check the recipient inbox" },
        { status: 404 },
      );
    }
    const q = url.searchParams.get("email");
    const rec = q ? devSender.lastByEmail.get(q.trim().toLowerCase()) : devSender.last;
    if (!rec) {
      return Response.json(
        { error: "no magic link issued yet — POST /auth/magic-link first" },
        { status: 404 },
      );
    }
    return Response.json({ to: rec.to, link: rec.link, token: rec.token });
  }

  // bot-orchestrator seam (§5.2): privileged connection, RLS-bypassing infra write.
  async function enqueue(job: OrchestratorJob): Promise<void> {
    const recall = getRecallClient({ seed: job.callId });
    try {
      const outcome = await runJoinJob(job, {
        recall,
        store: pgCallStore(sql),
        webhookBase: WEBHOOK_BASE,
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

  // Recall bot-STATUS POLLER (#118): only when live (fake has no bot to poll).
  if (isRecallLive()) {
    startStatusPoller({
      sql,
      source: liveBotStatusSource(),
      actions: liveRecallBotActions(),
      publisher: new PgListenNotifyPublisher(sql),
      metrics: registry, // §5.11 bot_join_total (issue #108/#107)
      logger: console,
    });
    console.log(
      `[status-poller] polling Recall bot status every ${STATUS_POLL_INTERVAL_MS / 1000}s ` +
        `for non-terminal calls (#118; §5.9 disclosure + live status push)`,
    );
  }

  const api = createAppApi({
    sql,
    sessionSecret: SESSION_SECRET,
    magicLinkKid: MAGIC_KID,
    magicLinkSecret: MAGIC_SECRET,
    tokenKeyring: { current: { kid: "dev-share", secret: TOKEN_SECRET } },
    emailSender: sender,
    webOrigin: WEB_ORIGIN,
    googleOAuth: GOOGLE_OAUTH,
    googleCalendarOAuth: GOOGLE_CALENDAR_OAUTH,
    calendarTokenEncryption: CALENDAR_TOKEN_ENCRYPTION,
    enqueue,
    callRateLimiter: calendarAutoJoinRateLimiter,
    // §5.14 per-call delete: force-leave a live bot + erase its Recall recording
    // (the in-repo fake locally; real acts only when RECALL_LIVE).
    recall: getCallRecordingControl(),
    linkStore: new InMemoryMagicLinkStore(),
    registry, // §5.11 GET /metrics scrape source (issue #108)
    // LOCAL-ONLY: strip Secure so cookies store over http, expose /__dev route.
    devShortcuts: { lastMagicLink: devLastMagicLink, stripSecureCookie: devCookieFix },
  });

  const server = Bun.serve({ port: PORT, fetch: api.fetch });
  const stopServer = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    calendarPoller?.stop();
    return stopServer(closeActiveConnections);
  }) as typeof server.stop;

  const recallMode = isRecallLive()
    ? `REAL (RECALL_LIVE) → bot joins; webhook base ${WEBHOOK_BASE ?? "(regional tunnel default)"}`
    : "in-repo deterministic FAKE (no real bot joins)";
  console.log(
    `\n[app-api] composed DEV server listening on http://localhost:${server.port} (SAMO_ENV=dev)\n` +
      `  routes: GET /health | POST /auth/magic-link | GET /auth/callback |\n` +
      `          POST /auth/logout | GET /auth/providers | GET /auth/google/start |\n` +
      `          GET /auth/google/callback | POST/GET /calls | GET /calls/:id |\n` +
      `          GET /__dev/last-magic-link\n` +
      `  Google sign-in: ${GOOGLE_OAUTH ? `ON → redirect_uri ${GOOGLE_OAUTH.redirectUri}` : "OFF (no credentials — magic link only)"}\n` +
      formatCalendarStartupLine({
        googleCalendarOAuth: GOOGLE_CALENDAR_OAUTH,
        calendarTokenEncryption: CALENDAR_TOKEN_ENCRYPTION,
      }) +
      `  magic-link callbacks point at ${WEB_ORIGIN} (the web app)\n` +
      `  Recall: ${recallMode}\n` +
      `  Email:  ${
        emailIsLive
          ? `REAL via Resend (RESEND_API_KEY set) from ${env.MAGIC_LINK_FROM}`
          : "in-memory FAKE (link printed above + /__dev/last-magic-link)"
      }\n`,
  );
  if (devDefaults.length > 0) {
    console.warn(
      `[app-api] ⚠️  DEV-ONLY signing secrets in use (${devDefaults.join(", ")} fallbacks). ` +
        "These are NOT secret and MUST NOT be used in production.",
    );
  }
  return server;
}

if (import.meta.main) startDevServer();
