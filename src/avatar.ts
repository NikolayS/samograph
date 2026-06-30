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

/**
 * Default Anam brain (GPT OSS 120B) used for autonomous mode. This is a public
 * Anam model id (not a secret), used only when no llmId override is supplied.
 */
export const ANAM_DEFAULT_BRAIN_LLM_ID = "a7cf662c-2ace-4de1-a21e-ef0fbf144bb7";

/** A minted, short-lived browser session — safe to hand to the presence page. */
export interface AvatarSession {
  /** Bearer-equivalent token the browser SDK opens its stream with. */
  sessionToken: string;
  /** The persona this token was minted for (echoed for the page's convenience). */
  personaId: string;
  /** ISO-8601 expiry if the provider returns one, else null. */
  expiresAt: string | null;
  /**
   * True when minted in AUTONOMOUS mode (the persona's own LLM brain is on and
   * the avatar should listen to the meeting audio and reply on its own). False
   * for talk-only mode (agent drives every word via talk()). The page reads
   * this to decide whether to feed input audio.
   */
  autonomous: boolean;
}

/** Options controlling how a session is minted. */
export interface MintOptions {
  /** Override the persona's published voice at mint time (no re-publish). */
  voiceId?: string;
  /**
   * Autonomous mode: mint an EPHEMERAL persona with a REAL brain so the avatar
   * hears the meeting audio and replies on its own (no agent in the loop). When
   * false/omitted the persona is referenced statefully and the brain is whatever
   * it was published with — for true talk-only use the talk-only persona.
   */
  autonomous?: boolean;
  /** Brain model id for autonomous mode (defaults to ANAM_DEFAULT_BRAIN_LLM_ID). */
  llmId?: string;
  /** System prompt governing autonomous behaviour (e.g. "only speak when addressed"). */
  systemPrompt?: string;
}

/**
 * A realtime avatar provider. Kept minimal and provider-agnostic so Anam can be
 * swapped for HeyGen/Tavus/Simli behind the same seam without touching callers.
 */
export interface AvatarProvider {
  /** Stable provider identifier (e.g. "anam"). */
  readonly name: string;
  /**
   * Mint a short-lived browser session token for `personaId`. `opts.voiceId`
   * overrides the published voice; `opts.autonomous` mints an ephemeral
   * real-brain persona that listens and replies on its own.
   */
  mintSession(personaId: string, opts?: MintOptions): Promise<AvatarSession>;
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

    async mintSession(personaId: string, opts: MintOptions = {}): Promise<AvatarSession> {
      // Read the key first: if it is unset we throw before touching the network,
      // so a missing-secret deployment never makes an unauthenticated request.
      const key = anamApiKey();
      const autonomous = !!opts.autonomous;
      // personaConfig is a oneOf: STATEFUL ({personaId}, brain fixed at publish
      // time) or EPHEMERAL ({name,avatarId,avatarModel,voiceId,llmId,systemPrompt}).
      // A bare top-level { personaId } mints a LEGACY token the SDK rejects, so
      // the id must be nested. The ephemeral path is the only documented way to
      // set llmId/systemPrompt, so autonomous mode uses it.
      let personaConfig: Record<string, string>;
      if (autonomous) {
        // Pull the published persona's avatar so the ephemeral persona keeps the
        // same face; voice is overridable, brain is a real LLM (so it replies on
        // its own), and systemPrompt governs when it speaks.
        const persona = await fetchPersona(fetchFn, key, personaId);
        personaConfig = {
          name: "samograph",
          avatarId: persona.avatarId,
          avatarModel: persona.avatarModel,
          voiceId: opts.voiceId || persona.voiceId,
          llmId: opts.llmId || ANAM_DEFAULT_BRAIN_LLM_ID,
        };
        if (opts.systemPrompt) personaConfig.systemPrompt = opts.systemPrompt;
      } else {
        personaConfig = { personaId };
        if (opts.voiceId) personaConfig.voiceId = opts.voiceId;
      }
      const r = await fetchFn(`${ANAM_BASE}/auth/session-token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // silenceBeforeSessionEndSeconds:0 + silenceBeforeSkipTurnSeconds:0
        // disable Anam's silence prompts and automatic session-ending, so a
        // quiet talk-only avatar is not torn down for "inactivity". (The tier
        // max-session cap is handled separately by client-side reconnect.)
        body: JSON.stringify({
          personaConfig,
          silenceBeforeSessionEndSeconds: 0,
          silenceBeforeSkipTurnSeconds: 0,
        }),
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
      return { sessionToken, personaId, expiresAt, autonomous };
    },
  };
}

interface PersonaFace {
  avatarId: string;
  avatarModel: string;
  voiceId: string;
}

/**
 * Fetch a published persona's face (avatar + model + default voice), used to
 * build an ephemeral autonomous persona that keeps the same look.
 */
async function fetchPersona(
  fetchFn: FetchFn,
  key: string,
  personaId: string,
): Promise<PersonaFace> {
  const r = await fetchFn(`${ANAM_BASE}/personas/${encodeURIComponent(personaId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`anam persona fetch failed: ${r.status} ${body}`);
  }
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    throw new Error("anam persona fetch failed: invalid JSON response");
  }
  const d = data as {
    avatar?: { id?: unknown };
    avatarModel?: unknown;
    voice?: { id?: unknown };
  };
  const avatarId = d.avatar?.id;
  const avatarModel = d.avatarModel;
  const voiceId = d.voice?.id;
  if (typeof avatarId !== "string" || typeof avatarModel !== "string" || typeof voiceId !== "string") {
    throw new Error("anam persona fetch failed: missing avatar/voice fields");
  }
  return { avatarId, avatarModel, voiceId };
}
