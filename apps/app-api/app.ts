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
  type EmailSender,
  type MagicLinkStore,
} from "./auth/index.ts";
import { createCallsHandler } from "./calls/http.ts";
import type { SQL } from "bun";
import type { Keyring } from "../../packages/shared/tokens/signing.ts";
import type { OrchestratorJob } from "../bot-orchestrator/index.ts";
import type { CallRecordingControl } from "../bot-orchestrator/recallClient.ts";
import { metricsHttpHandler } from "../../packages/shared/observe/metrics-http.ts";
import type { MetricsRegistry } from "../../packages/shared/observe/registry.ts";
import type { FunnelSnapshot } from "../../packages/shared/observe/funnel.ts";

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
  /** The bot-orchestrator seam: enqueue a join job for a new call (§5.2). */
  enqueue: (job: OrchestratorJob) => void | Promise<void>;
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

  const authService = new AuthService({
    keyring: new SigningKeyring(config.magicLinkKid, {
      [config.magicLinkKid]: config.magicLinkSecret,
    }),
    emailSender: config.emailSender,
    linkStore: config.linkStore ?? new InMemoryMagicLinkStore(),
    // Real Postgres user/tenant store so the session's tenant_id is a real
    // `tenants` row — required for the FK on `calls` and for RLS to scope reads.
    userStore: new PostgresUserStore(config.sql),
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
  });

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
      } else if (path === "/calls" || path.startsWith("/calls/")) {
        res = await callsHandler(req);
      } else {
        res = new Response("not found", { status: 404 });
      }
      // PROD: return verbatim — buildSessionCookie's `Secure` is preserved.
      // DEV: strip `Secure` so the cookie stores over http://localhost.
      return dev ? dev.stripSecureCookie(res) : res;
    },
  };
}
