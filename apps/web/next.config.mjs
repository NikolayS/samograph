/**
 * Next.js (App Router) config for the samograph.dev marketing site + app shell
 * (SPEC §4.1). JavaScript (`.mjs`) on purpose so the repo-wide `tsc --noEmit`
 * (which globs `apps/**\/*.ts`) never tries to typecheck it with Bun-only libs.
 *
 * LOCAL DEV PROXY (inert unless `APP_API_ORIGIN` is set): the merged
 * `AppApiClient` talks to app-api over SAME-ORIGIN relative paths with
 * `credentials: "same-origin"`. To keep the session cookie working without CORS,
 * we proxy the API endpoints from the web origin to the app-api dev server
 * (default http://localhost:8787) instead of pointing the client cross-origin.
 *
 * The one collision is `/auth/callback`, which is BOTH a page (where the magic
 * link lands) and the client's verify fetch. We disambiguate on `Sec-Fetch-Dest`:
 * a document navigation renders the page; the client's `fetch` (dest `empty`) is
 * proxied to the API. This is dev-only sugar; production routes these by host.
 *
 * @type {import("next").NextConfig}
 */
const apiOrigin = process.env.APP_API_ORIGIN;

const nextConfig = {
  reactStrictMode: true,
  ...(apiOrigin
    ? {
        async rewrites() {
          return {
            beforeFiles: [
              { source: "/auth/magic-link", destination: `${apiOrigin}/auth/magic-link` },
              {
                // Only the client's verify fetch (not the page navigation).
                source: "/auth/callback",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/auth/callback`,
              },
              {
                // Logout is a client `fetch` only (there is no /auth/logout page),
                // so gate it on dest `empty` just like /auth/callback — a stray
                // document navigation to this path never proxies to the API.
                source: "/auth/logout",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/auth/logout`,
              },
              {
                // `GET /auth/providers` — the `{google:boolean}` probe that gates
                // the "Continue with Google" button (#209). Client `fetch` only
                // (there is no /auth/providers page), so gate it on dest `empty`
                // exactly like /auth/logout above.
                source: "/auth/providers",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/auth/providers`,
              },
              // Google OAuth (#209) — DELIBERATELY UNGATED, unlike every rule
              // around them. Both legs are top-level DOCUMENT navigations: the
              // user clicks a link to /auth/google/start (which 302s to Google),
              // and Google redirects the browser back to /auth/google/callback.
              // Sec-Fetch-Dest is therefore `document`, not `empty`. Copying the
              // `has: sec-fetch-dest=empty` gate from /auth/callback onto these
              // would make the proxy miss and land the whole sign-in on a Next
              // 404. There is no page at either path, so nothing to disambiguate.
              { source: "/auth/google/start", destination: `${apiOrigin}/auth/google/start` },
              {
                source: "/auth/google/callback",
                destination: `${apiOrigin}/auth/google/callback`,
              },
              {
                source: "/calendar/connect/start",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calendar/connect/start`,
              },
              {
                source: "/calendar/connect/callback",
                destination: `${apiOrigin}/calendar/connect/callback`,
              },
              {
                source: "/calendar/status",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calendar/status`,
              },
              {
                source: "/calendar/meetings",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calendar/meetings`,
              },
              {
                source: "/calendar/meetings/:id",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calendar/meetings/:id`,
              },
              {
                source: "/calendar/connection",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calendar/connection`,
              },
              { source: "/calls", destination: `${apiOrigin}/calls` },
              {
                // ShareModal's mint/get/revoke fetches (§5.7, Story 2). Client
                // `fetch` only (dest `empty`) — there is no /calls/:id/share
                // page, but the gate keeps a stray document navigation out of
                // the API, same as /calls/:id below.
                source: "/calls/:id/share",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calls/:id/share`,
              },
              {
                // ShareModal's rotate fetch — new token, old one revoked (§5.7).
                source: "/calls/:id/share/rotate",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calls/:id/share/rotate`,
              },
              {
                // Only the client's fetchCallDetail (dest `empty`), NOT the page
                // navigation (dest `document`) — same collision as /auth/callback
                // above. Without this, opening /calls/:id in the browser is proxied
                // to the app-api and returns raw JSON instead of rendering the page.
                source: "/calls/:id",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calls/:id`,
              },
              {
                // Only the client's settings fetch (not the /settings page navigation).
                source: "/settings",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/settings`,
              },
              {
                // Account deletion is a client fetch; there is no /account page.
                source: "/account",
                destination: `${apiOrigin}/account`,
              },
              { source: "/__dev/:path*", destination: `${apiOrigin}/__dev/:path*` },
            ],
          };
        },
      }
    : {}),
};

export default nextConfig;
