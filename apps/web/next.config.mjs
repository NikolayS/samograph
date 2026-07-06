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
              { source: "/calls", destination: `${apiOrigin}/calls` },
              {
                // Only the client's fetchCallDetail (dest `empty`), NOT the page
                // navigation (dest `document`) — same collision as /auth/callback
                // above. Without this, opening /calls/:id in the browser is proxied
                // to the app-api and returns raw JSON instead of rendering the page.
                source: "/calls/:id",
                has: [{ type: "header", key: "sec-fetch-dest", value: "empty" }],
                destination: `${apiOrigin}/calls/:id`,
              },
              { source: "/__dev/:path*", destination: `${apiOrigin}/__dev/:path*` },
            ],
          };
        },
      }
    : {}),
};

export default nextConfig;
