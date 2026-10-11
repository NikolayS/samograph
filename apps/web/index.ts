/**
 * @samograph/web — marketing site + Next.js (App Router) app shell (SPEC §4.1).
 *
 * The App Router lives under `app/` (landing, magic-link request/callback,
 * dashboard shell, the owner per-call page at `/calls/[id]`, and the read-only
 * shared transcript at `/c/[token]`); reusable view components are in
 * `components/` and the pure, DOM-free logic + typed client seams are in `lib/`.
 */
export const SERVICE_NAME = "web";
