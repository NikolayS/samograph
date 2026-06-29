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
              { source: "/calls", destination: `${apiOrigin}/calls` },
              { source: "/calls/:id", destination: `${apiOrigin}/calls/:id` },
              { source: "/__dev/:path*", destination: `${apiOrigin}/__dev/:path*` },
            ],
          };
        },
      }
    : {}),
};

export default nextConfig;
