/**
 * Client-side share-token introspection (SPEC §5.7, Story 2).
 *
 * A share token is `base64url(body) "." base64url(sig)` where body is the JSON
 * payload `{kid, call_id, scopes, iat, exp, jti}` (packages/shared/tokens/
 * signing.ts). The read-only `/c/<token>` page needs the token's `call_id` to
 * build the `/calls/:id/stream|transcript` paths; the token itself is only the
 * CREDENTIAL (`?token=`), never the path id.
 *
 * Decode-only: the SERVER verifies the signature/revocation (§5.6/§5.7) — this
 * helper just reads the public payload, so it needs no key material. Browser-
 * safe (atob/TextDecoder, no Buffer); pure and DOM-free for the root typecheck.
 */

/** base64url → UTF-8 string, or null when the input is not valid base64url. */
function decodeBase64Url(segment: string): string | null {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Extract the `call_id` a share token is bound to, or `null` when the string is
 * not a decodable token (opaque id, truncated paste, wrong JSON shape). Callers
 * decide the fallback; the server still rejects any tampered/unbound token.
 */
export function callIdFromShareToken(token: string): string | null {
  const body = token.split(".")[0];
  if (!body) return null;
  const json = decodeBase64Url(body);
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  const callId = (payload as { call_id?: unknown } | null)?.call_id;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}
