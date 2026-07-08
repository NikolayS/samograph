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
  type EmailSender,
  type MagicLinkEmail,
} from "./auth/index.ts";
import { connect } from "../../packages/shared/db/index.ts";
import {
  resolveSamoEnv,
  usingDevDefaultSecrets,
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
}

/** Strip `Secure` from Set-Cookie so the session cookie stores over http://localhost (DEV). */
function devCookieFix(res: Response): Response {
  const sc = res.headers.get("set-cookie");
  if (!sc) return res;
  const headers = new Headers(res.headers);
  headers.set("set-cookie", sc.replace(/;\s*Secure/gi, ""));
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
  const WEB_ORIGIN = env.WEB_ORIGIN ?? "http://localhost:3000";
  const SESSION_SECRET = env.SESSION_SECRET ?? "dev-only-session-secret-change-me";
  const MAGIC_KID = env.MAGIC_LINK_KID ?? "dev-kid-1";
  const MAGIC_SECRET = env.MAGIC_LINK_SECRET ?? "dev-only-magic-link-secret-change-me";
  // Share tokens are minted HERE, verified by the ws-hub — same key + kid.
  const TOKEN_SECRET = env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd";

  // #64: include TOKEN_SECRET in the dev warn (it too can silently fall back to
  // its public dev default). In dev this only WARNS; prod fail-closes in server.ts.
  const devDefaults = usingDevDefaultSecrets(env);

  const sql = connect();
  const devSender = new DevEmailSender(PORT);
  // REAL transactional email (Resend) when RESEND_API_KEY is set; otherwise the
  // DEV fake keeps printing links (local/test mode).
  const sender = emailSenderFromEnv(env, devSender);
  const emailIsLive = sender !== devSender;

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
    enqueue,
    linkStore: new InMemoryMagicLinkStore(),
    // LOCAL-ONLY: strip Secure so cookies store over http, expose /__dev route.
    devShortcuts: { lastMagicLink: devLastMagicLink, stripSecureCookie: devCookieFix },
  });

  const server = Bun.serve({ port: PORT, fetch: api.fetch });

  const recallMode = isRecallLive()
    ? `REAL (RECALL_LIVE) → bot joins; webhook base ${WEBHOOK_BASE ?? "(regional tunnel default)"}`
    : "in-repo deterministic FAKE (no real bot joins)";
  console.log(
    `\n[app-api] composed DEV server listening on http://localhost:${server.port} (SAMO_ENV=dev)\n` +
      `  routes: GET /health | POST /auth/magic-link | GET /auth/callback |\n` +
      `          POST /auth/logout | POST/GET /calls | GET /calls/:id | GET /__dev/last-magic-link\n` +
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
