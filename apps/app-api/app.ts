/**
 * `createAppApi` — the pure composition factory for the app-api HTTP surface
 * (SPEC §4.1; issues #105 + #64).
 *
 * This is EXACTLY the auth + calls wiring the composed dev-server used to inline
 * (AuthService → createAuthHandler, createCallsHandler, the route switch), with
 * ONE security-critical difference: the unconditional Set-Cookie `Secure`-strip
 * is gone. `buildSessionCookie` emits `Secure`, and the prod composition NEVER
 * strips it, so the live prod hole (dev-server's `devCookieFix` stripped `Secure`
 * off EVERY response) cannot exist here.
 *
 * The dev-only affordances live behind an OPTIONAL `devShortcuts`:
 *   - `stripSecureCookie` — strip `Secure` so the cookie stores over http://localhost;
 *   - `lastMagicLink`     — serve `GET /__dev/last-magic-link`.
 * When `devShortcuts` is absent, BOTH are ABSENT from the built handler (the dev
 * route falls through to 404, the response is returned verbatim) — not merely
 * disabled. The dev wrapper (`dev-server.ts`) supplies them ONLY after asserting
 * SAMO_ENV=dev; the prod entrypoint (`server.ts`) passes `devShortcuts:
 * undefined`.
 */
import {
  AuthService,
  createAuthHandler,
  SigningKeyring,
  InMemoryMagicLinkStore,
  InMemoryRateLimiter,
  PostgresUserStore,
  PostgresIdentityStore,
  GoogleAuthService,
  createGoogleAuthHandler,
  type EmailSender,
  type MagicLinkStore,
  type OAuthProvider,
} from "./auth/index.ts";
import { createCallsHandler } from "./calls/http.ts";
import { createAccountHandler } from "./account/http.ts";
import { createSettingsHandler } from "./settings/http.ts";
import type { SQL } from "bun";
import type { Keyring } from "../../packages/shared/tokens/signing.ts";
import type { OrchestratorJob } from "../bot-orchestrator/index.ts";
import type { RateLimiter } from "./auth/rate-limit.ts";
import type { CallRecordingControl } from "../bot-orchestrator/recallClient.ts";
import { metricsHttpHandler } from "../../packages/shared/observe/metrics-http.ts";
import type { MetricsRegistry } from "../../packages/shared/observe/registry.ts";
import type { FunnelSnapshot } from "../../packages/shared/observe/funnel.ts";
import type { GoogleCalendarOAuthPort } from "./calendar/google-calendar-oauth.ts";
import { CalendarService } from "./calendar/service.ts";
import { PostgresCalendarConnectionStore } from "./calendar/pg-store.ts";
import { createCalendarHandler } from "./calendar/http.ts";
import { CalendarSyncService } from "./calendar/sync.ts";

/** LOCAL-ONLY affordances injected by the dev wrapper (never in prod). */
export interface DevShortcuts {
  /** Serve `GET /__dev/last-magic-link` (returns the most-recent dev magic link). */
  lastMagicLink: (url: URL) => Response;
  /** Strip `Secure` from any Set-Cookie so the session cookie stores over http://localhost. */
  stripSecureCookie: (res: Response) => Response;
}

/** Everything the composed app-api needs; the caller (dev/prod entrypoint) resolves env. */
export interface AppApiConfig {
  /** Privileged connection (login role able to `SET ROLE samograph_app`). */
  sql: SQL;
  /** HMAC secret the session cookie is signed/verified with (§5.1). */
  sessionSecret: string;
  /** Magic-link signing key id + secret (§5.1). */
  magicLinkKid: string;
  magicLinkSecret: string;
  /** Capability-token keyring used by the `/calls/:id/share` routes (§5.7). */
  tokenKeyring: Keyring;
  /** Magic-link email transport (real Resend in prod, dev fake locally, §5.1). */
  emailSender: EmailSender;
  /** Origin the magic-link callback URL is built against (the web app). */
  webOrigin: string;
  /**
   * The composed Google OAuth client, or ABSENT when this deployment has no
   * Google credentials (issue #209 / SPEC amendment S5-1).
   *
   * Resolved by the CALLER — `googleOAuthFromEnv(env, webOrigin)` in the two
   * entrypoints — because this factory reads no environment. Its presence IS the
   * on/off switch: `GET /auth/providers` reports it verbatim, and there is no
   * second "enabled" flag that could disagree with whether a client exists.
   * Absent is the DESIGNED state of every branch preview (Google exact-matches
   * redirect URIs with no wildcards, so an unbounded set of preview hostnames can
   * never be registered) — those environments sign in with magic link, which
   * stays enabled everywhere Google is enabled.
   */
  googleOAuth?: OAuthProvider;
  googleCalendarOAuth?: GoogleCalendarOAuthPort;
  calendarTokenEncryption?: { activeKey: Buffer; activeKeyVersion: number; decryptionKeys: Map<number, Buffer> };
  /** The bot-orchestrator seam: enqueue a join job for a new call (§5.2). */
  enqueue: (job: OrchestratorJob) => void | Promise<void>;
  /** Shared bot-creation cost limiter; callers may share it with calendar auto-join. */
  callRateLimiter?: RateLimiter;
  /**
   * Recall control for the §5.14 per-call delete (`DELETE /calls/:id`): force-leave
   * a live bot + erase its recording. Wired from `getCallRecordingControl` (real
   * when RECALL_LIVE, else the in-repo fake). Absent ⇒ DB erasure only.
   */
  recall?: CallRecordingControl;
  /** Epoch-ms clock; defaults to the wall clock. */
  clock?: () => number;
  /** Override the magic-link store; defaults to a fresh in-memory store. */
  linkStore?: MagicLinkStore;
  /** LOCAL-ONLY dev shortcuts. Absent ⇒ no Secure-strip and no /__dev route exist. */
  devShortcuts?: DevShortcuts;
  /**
   * Shared §5.11 registry exposed at `GET /metrics` (issue #108). The prod
   * entrypoint injects the SAME instance it hands the bot-join producer (poller +
   * runJoinJob), so `bot_join_total` / `pickup_latency_ms` are scrapeable here.
   * Omitted ⇒ /metrics 404s (no scrape source).
   */
  registry?: MetricsRegistry;
  /** Activation-funnel snapshot thunk folded into /metrics (§9; the #16 feed plugs in here). */
  funnel?: () => FunnelSnapshot;
}

/** The composed app-api: a single `fetch(req)` over the auth + calls surface. */
export interface AppApi {
  fetch: (req: Request) => Promise<Response>;
}

/** Build the composed app-api handler from resolved config. Pure — no env reads, no `Bun.serve`. */
export function createAppApi(config: AppApiConfig): AppApi {
  const clock = config.clock ?? (() => Date.now());

  // ONE PostgresUserStore for both credential paths: the magic-link callback and
  // the Google callback must provision through the same code, or "sign in with
  // Google, then with a link" could end up as two accounts.
  const userStore = new PostgresUserStore(config.sql);

  const authService = new AuthService({
    keyring: new SigningKeyring(config.magicLinkKid, {
      [config.magicLinkKid]: config.magicLinkSecret,
    }),
    emailSender: config.emailSender,
    linkStore: config.linkStore ?? new InMemoryMagicLinkStore(),
    // Real Postgres user/tenant store so the session's tenant_id is a real
    // `tenants` row — required for the FK on `calls` and for RLS to scope reads.
    userStore,
    rateLimiter: new InMemoryRateLimiter(),
    sessionSecret: config.sessionSecret,
    clock,
    baseUrl: config.webOrigin,
  });
  const authHandler = createAuthHandler(authService);

  const callsHandler = createCallsHandler({
    sql: config.sql,
    sessionSecret: config.sessionSecret,
    enqueue: config.enqueue,
    keyring: config.tokenKeyring,
    recall: config.recall,
    rateLimiter: config.callRateLimiter,
  });

  // §5.14 whole-account GDPR erasure (`DELETE /account`). Reuses the SAME Recall
  // control + EmailSender the rest of the surface is wired with.
  const accountHandler = createAccountHandler({
    sql: config.sql,
    sessionSecret: config.sessionSecret,
    emailSender: config.emailSender,
    recall: config.recall,
    calendarOAuth: config.googleCalendarOAuth,
    calendarTokenDecryptionKeys: config.calendarTokenEncryption?.decryptionKeys,
    now: clock,
  });

  // §5.12 hosted Settings surface (owner-only, RLS-scoped).
  const settingsHandler = createSettingsHandler({
    sql: config.sql,
    sessionSecret: config.sessionSecret,
    now: clock,
  });

  // §5.1 / S5-1 "Continue with Google" (issue #209). Composed UNCONDITIONALLY:
  // an environment with no credentials still serves `GET /auth/providers`
  // (reporting `{"google":false}`) and still answers `/auth/google/*` with the
  // SAMO-AUTH-010 stub, rather than 404-ing and looking like a broken deploy.
  // `user_identities` is privileged and un-RLS'd (migration 0011), so it rides
  // the same privileged connection the user store does.
  if (config.googleCalendarOAuth && !config.calendarTokenEncryption) {
    throw new Error("Calendar OAuth requires token-encryption configuration");
  }
  // Unconfigured deployments still expose status/disconnect as fail-closed
  // routes; this unreachable placeholder is never used to encrypt a token.
  const calendarKeys = config.calendarTokenEncryption ?? { activeKey: Buffer.alloc(32), activeKeyVersion: 1, decryptionKeys: new Map([[1, Buffer.alloc(32)]]) };
  const calendarStore = new PostgresCalendarConnectionStore(config.sql);
  const calendarSync = config.googleCalendarOAuth?.apiClient ? new CalendarSyncService({ store: calendarStore, client: config.googleCalendarOAuth.apiClient, decryptionKeys: calendarKeys.decryptionKeys, clock }) : undefined;
  const calendarService = new CalendarService({
    provider: config.googleCalendarOAuth,
    store: calendarStore,
    rateLimiter: new InMemoryRateLimiter(), sessionSecret: config.sessionSecret, clock,
    ...calendarKeys,
    immediateSync: calendarSync ? (connectionId) => calendarSync.sync(connectionId) : undefined,
  });
  const calendarHandler = createCalendarHandler(calendarService, config.sessionSecret, clock, config.registry);
  const googleHandler = createGoogleAuthHandler(
    new GoogleAuthService({
      provider: config.googleOAuth,
      identityStore: new PostgresIdentityStore(config.sql),
      userStore,
      emailSender: config.emailSender,
      // Its own limiter instance: the Google buckets are keyed apart from the
      // magic-link ones (see google-service.ts), and sharing the object would
      // only couple two independent budgets' storage for no benefit.
      rateLimiter: new InMemoryRateLimiter(),
      sessionSecret: config.sessionSecret,
      clock,
      // The SAME registry `/metrics` renders (S5-1 item 7, issue #222), so
      // auth_google_start_total / auth_google_callback_total{result} /
      // auth_identity_linked_total are scrapeable from the composed app.
      metrics: config.registry,
    }), calendarService.configured,
  );

  const dev = config.devShortcuts;
  // §5.11 `/metrics` scrape endpoint over the SHARED registry (issue #108).
  const metrics = config.registry ? metricsHttpHandler(config.registry, config.funnel) : undefined;

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      let res: Response;
      if (path === "/health") {
        res = new Response("ok", { status: 200 });
      } else if (metrics && req.method === "GET" && path === "/metrics") {
        res = metrics(req);
      } else if (dev && req.method === "GET" && path === "/__dev/last-magic-link") {
        // DEV-ONLY: absent from the prod handler entirely (falls through to 404).
        res = dev.lastMagicLink(url);
      } else if (
        path === "/auth/magic-link" ||
        path === "/auth/callback" ||
        path === "/auth/logout"
      ) {
        res = await authHandler(req);
      } else if (path === "/auth/providers" || path.startsWith("/auth/google/")) {
        res = await googleHandler(req);
      } else if (path.startsWith("/calendar/")) {
        res = await calendarHandler(req);
      } else if (path === "/calls" || path.startsWith("/calls/")) {
        res = await callsHandler(req);
      } else if (path === "/account") {
        res = await accountHandler(req);
      } else if (path === "/settings") {
        res = await settingsHandler(req);
      } else {
        res = new Response("not found", { status: 404 });
      }
      // PROD: return verbatim — buildSessionCookie's `Secure` is preserved.
      // DEV: strip `Secure` so the cookie stores over http://localhost.
      return dev ? dev.stripSecureCookie(res) : res;
    },
  };
}
