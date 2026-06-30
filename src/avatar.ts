// Realtime talking-head avatar provider.
//
// samograph renders a presence web page into the bot's camera (Recall output
// media). This module is the *server-side* half of swapping that page's static
// avatar for a realtime, lip-synced talking head: it mints the short-lived
// session token a provider's browser SDK needs to open its WebRTC stream.
//
// The provider is talk-only (agent-driven): samograph's agent loop decides every
// word and pushes text to the avatar; the provider supplies the face and voice,
// not the intelligence. The browser-side connect/say wiring lands in a later
// change — this module deliberately stops at session minting.
//
// The API key never reaches the page: only the minted session token is sent to
// the browser, so the secret stays server-side.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Anam REST base. The auth/session-token endpoint mints browser session tokens. */
export const ANAM_BASE = "https://api.anam.ai/v1";

/** A minted, short-lived browser session — safe to hand to the presence page. */
export interface AvatarSession {
  /** Bearer-equivalent token the browser SDK opens its stream with. */
  sessionToken: string;
  /** The persona this token was minted for (echoed for the page's convenience). */
  personaId: string;
  /** ISO-8601 expiry if the provider returns one, else null. */
  expiresAt: string | null;
}

/**
 * A realtime avatar provider. Kept minimal and provider-agnostic so Anam can be
 * swapped for HeyGen/Tavus/Simli behind the same seam without touching callers.
 */
export interface AvatarProvider {
  /** Stable provider identifier (e.g. "anam"). */
  readonly name: string;
  /**
   * Mint a short-lived browser session token for `personaId`. An optional
   * `voiceId` overrides the persona's published voice at mint time (so the
   * voice can be changed without re-publishing the persona).
   */
  mintSession(personaId: string, voiceId?: string): Promise<AvatarSession>;
}

/**
 * The Anam API key, read from the environment. Throws a plain Error (NOT a
 * process-exiting ExitError) when unset, so a server endpoint can catch it and
 * gracefully fall back to the static presence avatar rather than crash.
 */
export function anamApiKey(): string {
  const k = process.env.ANAM_API_KEY ?? "";
  if (!k) {
    throw new Error("ANAM_API_KEY not set");
  }
  return k;
}

/**
 * Build an Anam-backed AvatarProvider. `fetchFn` is injectable so tests exercise
 * the URL/method/header/body contract with no network and no real key.
 */
export function makeAnamAvatarProvider(fetchFn: FetchFn = fetch): AvatarProvider {
  return {
    name: "anam",

    async mintSession(personaId: string, voiceId?: string): Promise<AvatarSession> {
      // Read the key first: if it is unset we throw before touching the network,
      // so a missing-secret deployment never makes an unauthenticated request.
      const key = anamApiKey();
      // A published/saved ("stateful") persona is referenced by id nested under
      // personaConfig. A bare top-level { personaId } mints a LEGACY token that
      // the current SDK rejects ("Legacy session tokens are no longer
      // supported"), so it must be nested. An optional voiceId overrides the
      // persona's published voice without re-publishing it.
      const personaConfig: { personaId: string; voiceId?: string } = { personaId };
      if (voiceId) personaConfig.voiceId = voiceId;
      const r = await fetchFn(`${ANAM_BASE}/auth/session-token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ personaConfig }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`anam session-token failed: ${r.status} ${body}`);
      }
      let data: unknown;
      try {
        data = await r.json();
      } catch {
        throw new Error("anam session-token failed: invalid JSON response");
      }
      const sessionToken = (data as { sessionToken?: unknown }).sessionToken;
      if (typeof sessionToken !== "string" || !sessionToken) {
        throw new Error("anam session-token failed: missing sessionToken in response");
      }
      const expiresRaw = (data as { expiresAt?: unknown }).expiresAt;
      const expiresAt = typeof expiresRaw === "string" ? expiresRaw : null;
      return { sessionToken, personaId, expiresAt };
    },
  };
}
