/**
 * HTTP adapter for the three Google sign-in routes (issue #209, SPEC amendment
 * S5-1; §5.16 codes 006–010).
 *
 *   GET /auth/providers          → 200 `{"google": boolean}` — the SOLE gate on
 *                                  rendering the "Continue with Google" button.
 *   GET /auth/google/start       → 302 to Google + the `__Host-samo_oauth` cookie.
 *   GET /auth/google/callback    → 302 to the returnTo + the session cookie,
 *                                  and ALWAYS the cleared state cookie.
 *
 * A thin, framework-free mapping over {@link GoogleAuthService}, exactly as
 * `http.ts` is over `AuthService`. Three things are decided here rather than in
 * the service, because they are properties of the HTTP delivery:
 *
 *  - **Every failure is a 302, not a status code with a body.** These failures
 *    happen while the browser is mid-redirect between us and Google: there is no
 *    fetch to answer with JSON and no page of ours rendering yet. The code rides
 *    the query string and the sign-in page renders it from the shared code→copy
 *    map (`apps/web/lib/authErrors.ts`).
 *  - **Every `Location` is a RELATIVE PATH.** app-api is reached through the web
 *    origin's proxy (`APP_API_ORIGIN`), so a relative target lands on the right
 *    host by construction — and a `Location` that is never a URL cannot be an
 *    open redirect, whatever the input was.
 *  - **The state cookie is cleared on EVERY callback response**, success or
 *    failure, so a completed or abandoned flow never leaves a live verifier in
 *    the browser. On success that means TWO `Set-Cookie` headers on one response
 *    (the new session + the cleared state), which is precisely the case that
 *    forced #214's `getSetCookie()`/`append()` fix in the dev wrapper — the
 *    naive `get`/`set` form comma-joined them into one malformed header and lost
 *    one of the two.
 */
import type { AuthErrorCode } from "./types.ts";
import { buildClearedOAuthStateCookie, readOAuthStateCookie } from "./oauth-state.ts";
import { clientIp } from "./http.ts";
import type { GoogleAuthService } from "./google-service.ts";

/** Where a failed sign-in lands: the sign-in page, carrying the §5.16 code. */
export const AUTH_ERROR_REDIRECT_PATH = "/auth";

/**
 * `302 → /auth?error=<CODE>`.
 *
 * ALWAYS 302, never `AUTH_ERRORS[code].httpStatus`. For the five Google codes
 * those agree (S5-1 records them AS 302, because a redirect is the only way they
 * are ever delivered), but `SAMO-AUTH-004` is reused here from the magic-link
 * path, where it is a 429 with a JSON body and a `Retry-After`. Emitting 429 on
 * this leg would produce a response carrying a `Location` the browser never
 * follows — a dead end on a route the user reached by clicking a link. The code
 * still travels, in the query string, and the sign-in page renders it.
 *
 * The `code` argument is typed {@link AuthErrorCode} — the union `AUTH_ERRORS` is
 * keyed by — so an invented code cannot reach the redirect. That type alone does
 * NOT guarantee the web can render what arrives: `apps/web/lib/authErrors.ts`
 * declared its own union, and `SAMO-AUTH-500` reached this redirect for a
 * release with no copy row on the other side (#219). The web's union is now
 * DERIVED from {@link AuthErrorCode} minus an explicit server-internal list, so
 * a code added here without copy is a compile error in `apps/web` — but the
 * guarantee lives in that derivation, not in this signature.
 */
function errorRedirect(code: AuthErrorCode, extraCookies: string[] = []): Response {
  const headers = new Headers({
    location: `${AUTH_ERROR_REDIRECT_PATH}?error=${code}`,
    // Never let an intermediary cache a sign-in outcome.
    "cache-control": "no-store",
  });
  for (const cookie of extraCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** Build the Request→Response handler for the three Google sign-in routes. */
export function createGoogleAuthHandler(
  service: GoogleAuthService,
  googleCalendarConfigured?: boolean,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // ── GET /auth/providers ────────────────────────────────────────────────
    // Answers on EVERY environment, configured or not — that is the point. A
    // branch preview composes this same handler and honestly reports `false`,
    // and `no-store` keeps a proxy from pinning a stale `true` (which would
    // render a button that can only fail) or a stale `false` (which would hide a
    // working one).
    if (req.method === "GET" && url.pathname === "/auth/providers") {
      return Response.json(
        googleCalendarConfigured === undefined
          ? { google: service.configured }
          : { google: service.configured, google_calendar: googleCalendarConfigured },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    // ── GET /auth/google/start ─────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/auth/google/start") {
      const result = await service.start({
        returnTo: url.searchParams.get("returnTo"),
        ip: clientIp(req),
      });
      if (!result.ok) return errorRedirect(result.code);
      return new Response(null, {
        status: 302,
        headers: {
          location: result.location,
          "set-cookie": result.setCookie,
          "cache-control": "no-store",
        },
      });
    }

    // ── GET /auth/google/callback ──────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/auth/google/callback") {
      const cleared = buildClearedOAuthStateCookie();
      const result = await service.callback({
        stateCookie: readOAuthStateCookie(req),
        params: url.searchParams,
        ip: clientIp(req),
      });
      // Failure: clear the state cookie too, so an abandoned flow leaves nothing
      // behind that a later request could be tricked into completing.
      if (!result.ok) return errorRedirect(result.code, [cleared]);

      const headers = new Headers({
        location: result.location,
        "cache-control": "no-store",
      });
      // TWO Set-Cookie headers, appended individually — never joined (#214).
      headers.append("set-cookie", result.setCookie);
      headers.append("set-cookie", cleared);
      return new Response(null, { status: 302, headers });
    }

    return new Response("not found", { status: 404 });
  };
}
