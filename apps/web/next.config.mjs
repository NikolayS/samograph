/**
 * Next.js (App Router) config for the samograph.dev marketing site + app shell
 * (SPEC §4.1). JavaScript (`.mjs`) on purpose so the repo-wide `tsc --noEmit`
 * (which globs `apps/**\/*.ts`) never tries to typecheck it with Bun-only libs.
 *
 * @type {import("next").NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
