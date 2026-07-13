/**
 * Hosted Samograph services sit behind Caddy. Their application sockets must
 * never bind a wildcard or routable VM address.
 */
export const DEFAULT_LOOPBACK_HOST = "127.0.0.1";

/** Resolve an optional host override, failing closed unless it is loopback. */
export function resolveLoopbackHostname(hostname?: string): string {
  const resolved = hostname?.trim() || DEFAULT_LOOPBACK_HOST;
  if (resolved === DEFAULT_LOOPBACK_HOST) return resolved;
  throw new Error(
    `[fail-closed] refusing to bind hosted service to non-loopback host ${JSON.stringify(resolved)}`,
  );
}
