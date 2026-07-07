/**
 * LOCAL-ONLY composed dev server for the Sprint-1 samograph.dev stack.
 *
 * This file is an INTEGRATION SEAM that does not exist in the merged tree: the
 * shipped `apps/app-api/index.ts` only serves `/health`, and the real route
 * handlers (`auth/`, `calls/`) plus the bot-orchestrator were merged as separate,
 * independently-tested units that were never wired into one running server. This
 * wires them together behind a single `Bun.serve` on :8787 so the owner can click
 * through the flow locally. It is intentionally NOT a production entrypoint:
 *
 *   - Magic-link email defaults to the in-memory `EmailSender` fake; instead of
 *     sending, it PRINTS the sign-in URL to stdout and exposes it at
 *     `GET /__dev/last-magic-link`. Setting `RESEND_API_KEY` + `MAGIC_LINK_FROM`
 *     flips it to the REAL `ResendEmailSender` so an actual email is delivered.
 *   - The bot-orchestrator is backed by the deterministic in-repo Recall FAKE
 *     (packages/test-fakes/recall) by default — no real bot joins. Setting
 *     `RECALL_LIVE=1` + `RECALL_API_KEY` (issue #88) flips it to the REAL client so
 *     an actual bot joins; point `PUBLIC_WEBHOOK_BASE` at a public ingress for the
 *     webhook (live transcript additionally needs that tunnel — sprint-exit gate).
 *   - Signing/session secrets fall back to obvious DEV-ONLY constants.
 *   - Set-Cookie `Secure` is stripped so the cookie is stored over http://localhost.
 *
 * Real wiring (real Recall, real transactional email, secret-manager secrets, the
 * ingest/ws-hub/per-call page) is the remaining Sprint work; this is the local
 * demonstrator only.
 */
import {
  AuthService,
  createAuthHandler,
  SigningKeyring,
  InMemoryMagicLinkStore,
  InMemoryRateLimiter,
  PostgresUserStore,
  emailSenderFromEnv,
  type EmailSender,
  type MagicLinkEmail,
} from "./auth/index.ts";
import { createCallsHandler } from "./calls/http.ts";
import { connect } from "../../packages/shared/db/index.ts";
import {
  pgCallStore,
  publicWebhookBase,
  runJoinJob,
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

// ── DEV-ONLY config + secrets (clearly marked; NEVER use in production) ────────
const PORT = Number(process.env.APP_API_PORT ?? 8787);
/** Origin the magic-link callback URL is built against (the Next web app). */
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const SESSION_SECRET =
  process.env.SESSION_SECRET ?? "dev-only-session-secret-change-me";
const MAGIC_KID = process.env.MAGIC_LINK_KID ?? "dev-kid-1";
const MAGIC_SECRET =
  process.env.MAGIC_LINK_SECRET ?? "dev-only-magic-link-secret-change-me";
// Share tokens are minted HERE but verified by the ws-hub — both must use the
// same key. Match the ws-hub dev-live-server keyring (kid "dev-share" / TOKEN_SECRET),
// same env + default, so a minted share token verifies at the stream gate.
const TOKEN_SECRET =
  process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd";

const usingDevSecrets =
  !process.env.SESSION_SECRET || !process.env.MAGIC_LINK_SECRET;

/**
 * DEV EmailSender: never sends; prints the magic-link URL to stdout and keeps the
 * most-recent link (globally + per recipient) for `GET /__dev/last-magic-link`.
 */
class DevEmailSender implements EmailSender {
  last: MagicLinkEmail | undefined;
  readonly lastByEmail = new Map<string, MagicLinkEmail>();

  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.last = email;
    this.lastByEmail.set(email.to, email);
    console.log(
      `\n──────── DEV MAGIC LINK (no email sent) ────────\n` +
        `  to:   ${email.to}\n` +
        `  link: ${email.link}\n` +
        `  (open the link in a browser, or GET ${`http://localhost:${PORT}`}/__dev/last-magic-link)\n` +
        `────────────────────────────────────────────────\n`,
    );
  }
}

const sql = connect();
const devSender = new DevEmailSender();
// REAL transactional email (Resend) when RESEND_API_KEY is set — requires
// MAGIC_LINK_FROM (verified sender), fails fast at startup if it is missing.
// With no key, the DEV fake above keeps printing links (local/test mode).
const sender = emailSenderFromEnv(process.env, devSender);
const emailIsLive = sender !== devSender;

const authService = new AuthService({
  keyring: new SigningKeyring(MAGIC_KID, { [MAGIC_KID]: MAGIC_SECRET }),
  emailSender: sender,
  linkStore: new InMemoryMagicLinkStore(),
  // Real Postgres user/tenant store so the session's tenant_id is a real
  // `tenants` row — required for the FK on `calls` and for RLS to scope reads.
  userStore: new PostgresUserStore(sql),
  rateLimiter: new InMemoryRateLimiter(),
  sessionSecret: SESSION_SECRET,
  clock: () => Date.now(),
  baseUrl: WEB_ORIGIN,
});
const authHandler = createAuthHandler(authService);

// Validate PUBLIC_WEBHOOK_BASE once at startup (fail fast on a malformed value);
// undefined → the orchestrator's regional tunnel base applies (the fake default).
const WEBHOOK_BASE = publicWebhookBase();

// Fail fast at STARTUP (not silently per-call) when the real Recall path is
// requested without a key — issue #88: never silently fall back to the fake.
if (isRecallLive()) liveRecallClient();

// Recall bot-STATUS POLLER (issue #118): realtime endpoints carry transcript
// events only (`bot.status_change` is rejected — see recallClient.ts), so with
// real Recall the call status would stick at JOINING forever. Poll every ~10 s
// on this process's PRIVILEGED connection (an infra sweep across tenants, like
// the orchestrator's own `UPDATE calls` — bypasses RLS, never a tenant role).
// Fake mode has no live bot to poll, so the poller starts only when live.
//   - actions (#117): the REAL Recall act adapter, so the first
//     `in_call_recording` pickup posts the §5.9 disclosure chat exactly once
//     and an aged `in_call_not_recording` makes the bot leave cleanly.
//   - publisher (#106): each applied transition NOTIFYs a `{type:"status"}`
//     control frame on the SAME per-call `transcript:<call_id>` channel the
//     transcript path uses, for the ws-hub fan-in to push to open WS clients.
if (isRecallLive()) {
  startStatusPoller({
    sql,
    source: liveBotStatusSource(),
    actions: liveRecallBotActions(),
    publisher: new PgListenNotifyPublisher(sql),
    logger: console,
  });
  console.log(
    `[status-poller] polling Recall bot status every ${STATUS_POLL_INTERVAL_MS / 1000}s ` +
      `for non-terminal calls (issue #118; §5.9 disclosure + live status push)`,
  );
}

/**
 * bot-orchestrator seam (§5.2): drive each new call through the createBot path,
 * persisting region + ingest-secret hash and flipping the row PENDING→JOINING. The
 * Recall client is flag-selected (`getRecallClient`, issue #88): the deterministic
 * fake by default; the REAL client when `RECALL_LIVE` + `RECALL_API_KEY` are set, so
 * a real bot joins. Runs on the privileged (superuser) connection so the
 * orchestrator's `UPDATE calls` bypasses RLS (no tenant ctx).
 */
async function enqueue(job: OrchestratorJob): Promise<void> {
  const recall = getRecallClient({ seed: job.callId });
  try {
    // runJoinJob converts a createBot/join FAILURE into a persisted terminal
    // state (COULD_NOT_JOIN + sanitized `status_reason`, §5.2/§5.16, Story 4)
    // instead of the old silent console.error that left the call PENDING
    // forever. The UPDATE runs on this privileged connection (infra write —
    // bypasses RLS, like the orchestrator's other `UPDATE calls`).
    const outcome = await runJoinJob(job, {
      recall,
      store: pgCallStore(sql),
      webhookBase: WEBHOOK_BASE,
      logger: { info: (event, fields) => console.log(`[orchestrator] ${event}`, fields ?? {}) },
    });
    if (outcome.status === "COULD_NOT_JOIN") {
      // The reason is already sanitized (key redacted) by runJoinJob.
      console.error(
        `[orchestrator] call ${outcome.callId} → COULD_NOT_JOIN (${outcome.reason})`,
      );
      return;
    }
    console.log(
      `[orchestrator] call ${outcome.callId} → ${outcome.status} ` +
        `(bot ${outcome.recallBotId}, region ${outcome.region})`,
    );
  } catch (err) {
    // Even persisting the failure failed (e.g. the DB is down) — log the
    // SANITIZED reason only; the raw error could echo credential material.
    console.error(
      `[orchestrator] join failed for call ${job.callId} and the failure could not ` +
        `be persisted: ${sanitizeFailureReason(err)}`,
    );
  }
}

const callsHandler = createCallsHandler({
  sql,
  sessionSecret: SESSION_SECRET,
  enqueue,
  keyring: { current: { kid: "dev-share", secret: TOKEN_SECRET } },
});

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

/** Strip `Secure` from Set-Cookie so the session cookie stores over http://localhost (DEV). */
function devCookieFix(res: Response): Response {
  const sc = res.headers.get("set-cookie");
  if (!sc) return res;
  const headers = new Headers(res.headers);
  headers.set("set-cookie", sc.replace(/;\s*Secure/gi, ""));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    let res: Response;
    if (path === "/health") {
      res = new Response("ok", { status: 200 });
    } else if (req.method === "GET" && path === "/__dev/last-magic-link") {
      res = devLastMagicLink(url);
    } else if (
      path === "/auth/magic-link" ||
      path === "/auth/callback" ||
      path === "/auth/logout"
    ) {
      res = await authHandler(req);
    } else if (path === "/calls" || path.startsWith("/calls/")) {
      res = await callsHandler(req);
    } else {
      res = new Response("not found", { status: 404 });
    }
    return devCookieFix(res);
  },
});

const recallMode = isRecallLive()
  ? `REAL (RECALL_LIVE) → bot joins; webhook base ${WEBHOOK_BASE ?? "(regional tunnel default)"}`
  : "in-repo deterministic FAKE (no real bot joins)";
console.log(
  `\n[app-api] composed dev server listening on http://localhost:${server.port}\n` +
    `  routes: GET /health | POST /auth/magic-link | GET /auth/callback |\n` +
    `          POST /auth/logout | POST/GET /calls | GET /calls/:id | GET /__dev/last-magic-link\n` +
    `  magic-link callbacks point at ${WEB_ORIGIN} (the web app)\n` +
    `  Recall: ${recallMode}\n` +
    `  Email:  ${
      emailIsLive
        ? `REAL via Resend (RESEND_API_KEY set) from ${process.env.MAGIC_LINK_FROM}`
        : "in-memory FAKE (link printed above + /__dev/last-magic-link)"
    }\n`,
);
if (usingDevSecrets) {
  console.warn(
    "[app-api] ⚠️  DEV-ONLY signing secrets in use (SESSION_SECRET / MAGIC_LINK_SECRET " +
      "fallbacks). These are NOT secret and MUST NOT be used in production.",
  );
}
