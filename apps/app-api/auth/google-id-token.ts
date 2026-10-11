/**
 * Google ID-token verification — RS256 over a cached JWKS (issue #209).
 *
 * We verify LOCALLY and COMPLETELY rather than taking the OIDC Core 3.1.3.7
 * direct-channel exemption. The exemption is only sound while nobody moves the
 * token exchange, inserts a caching proxy, or introduces a fake-IdP seam — and
 * this feature introduces exactly that seam. Verifying makes the in-repo fake a
 * real RSA signer, so every downstream test drives THIS code instead of a
 * bypass.
 *
 * Bun's built-in `node:crypto` only, no third-party deps (SPEC §6.2 #6).
 *
 * ORDER IS THE SECURITY PROPERTY, cheapest-and-most-rejecting first:
 *
 *   1. structural bounds (size, segment count)  — before ANY crypto or network
 *   2. `header.alg === "RS256"` by STRING EQUALITY — before ANY key lookup
 *   3. `kid` → JWKS key, filtered for RSA/sig/RS256/≥2048-bit
 *   4. RSASSA-PKCS1-v1_5 verify over the EXACT received `header.payload` bytes
 *   5. only then parse and check the claims
 *
 * Step 2 is the one that matters most. The algorithm is NEVER read out of the
 * token to SELECT a verification routine — the routine is fixed at
 * `RSA-SHA256`, and a header that says anything else is rejected outright. That
 * single ordering kills the whole confusion family at once:
 *   - `alg:"none"` (no signature at all),
 *   - `alg:"HS256"` HMAC'd with the RSA PUBLIC modulus (public data used as a
 *     shared secret, because a naive verifier hands "the key" to an HMAC),
 *   - `alg:"HS256"` HMAC'd with our own OAuth client secret,
 *   - a silent downgrade to a weaker RSA hash.
 * Doing the alg check BEFORE the key lookup also means a forged token never
 * reaches the network at all.
 *
 * Step 5 runs strictly after step 4 so no claim is ever read out of an
 * unauthenticated token (the same discipline `token.ts` applies to `exp`).
 *
 * UNIT TRAP: JWT `exp`/`iat` are epoch **SECONDS**; everything else in this repo
 * — `SessionClaims.iat`, `Clock`, `nowMs` here — is epoch **MILLISECONDS**. The
 * conversion happens exactly once, at the point of use, and the converted values
 * are named `expMs`/`iatMs` so a milliseconds-vs-seconds mix-up is visible in
 * the identifier itself. Get this wrong in the lenient direction and every
 * expired token is accepted for ~56 years.
 */
import { createPublicKey, createVerify, type JsonWebKeyInput } from "node:crypto";
import { constantTimeEqual } from "./crypto.ts";

/**
 * Google's JWKS endpoint, a COMPILE-TIME LITERAL. There is deliberately no
 * runtime `.well-known/openid-configuration` discovery and no env override: it
 * is a pure SSRF / endpoint-hijack surface for zero benefit, since Google's
 * endpoints have not moved in a decade and if they ever do, that is a reviewed
 * code change. Tests reach this URL through an injected `fetch`, never the net.
 */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * The two spellings Google uses for `iss`. Membership is EXACT — never
 * `startsWith`/`endsWith`/`includes`, which would accept
 * `https://accounts.google.com.evil.tld` (suffix on a lookalike domain) or
 * `https://evil.tld/https://accounts.google.com` (prefix inside a path).
 */
export const GOOGLE_ID_TOKEN_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

/** Structural cap: a real Google ID token is ~1KB. Anything huge is an attack. */
export const GOOGLE_ID_TOKEN_MAX_BYTES = 8 * 1024;
/** Tolerated clock skew on `exp`. */
export const ID_TOKEN_CLOCK_SKEW_MS = 60_000;
/** A token must have been MINTED recently — caps the replay window. */
export const ID_TOKEN_MAX_IAT_AGE_MS = 5 * 60_000;
/** `sub` is stored in `user_identities.provider_subject`; bound it. */
export const GOOGLE_ID_TOKEN_MAX_SUBJECT_LENGTH = 255;

/** JWKS fetch timeout — a stuck transport must never hang a sign-in. */
export const JWKS_TIMEOUT_MS = 5_000;
/** Hard cap on the JWKS response body. */
export const JWKS_MAX_BYTES = 128 * 1024;
/** Hard cap on the number of keys in one JWKS document. */
export const JWKS_MAX_KEYS = 20;
/** Floor on the cache lifetime, whatever `Cache-Control` says. */
export const JWKS_MIN_CACHE_MS = 5 * 60_000;
/** Ceiling on the cache lifetime, whatever `Cache-Control` says. */
export const JWKS_MAX_CACHE_MS = 24 * 60 * 60_000;
/**
 * An unknown `kid` against an otherwise-fresh cache forces ONE refresh, then
 * nothing for this long. Without it, spraying random `kid`s at the login
 * endpoint amplifies 1:1 into googleapis.com until Google throttles us — which
 * is a login outage triggered by unauthenticated traffic.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 5 * 60_000;
/** After a FAILED fetch, wait this long before trying the network again. */
export const JWKS_FAILURE_RETRY_MS = 30_000;
/** Reject RSA keys below 2048 bits (256 bytes of modulus). */
export const JWKS_MIN_MODULUS_BYTES = 256;

/** A verified Google identity. `emailVerified` is REPORTED, never enforced here. */
export interface GoogleIdentity {
  provider: "google";
  subject: string;
  email: string;
  /**
   * `email_verified === true`, boolean-strict. This module only REPORTS it; the
   * service layer is the single enforcement point, so there is exactly one place
   * to audit for the account-takeover gate.
   */
  emailVerified: boolean;
}

/** Why a token was rejected. Every value is a HARD reject — none is a warning. */
export type GoogleIdTokenRejection =
  | "token_too_large"
  | "malformed_token"
  | "bad_header"
  | "alg_not_rs256"
  | "missing_kid"
  | "unknown_kid"
  | "key_unusable"
  | "bad_signature"
  | "bad_payload"
  | "iss_not_allowed"
  | "aud_mismatch"
  | "azp_mismatch"
  | "expired"
  | "iat_not_fresh"
  | "nonce_missing"
  | "nonce_mismatch"
  | "sub_invalid"
  | "email_missing";

/**
 * `code` is the string literal `"SAMO-AUTH-008"` rather than the `AuthErrorCode`
 * union from `types.ts`: the §5.16 codes 006–010 land with the routes (issue
 * #209 PR 5), and pinning to the literal here keeps this module compiling
 * standalone and out of that PR's diff. The literal is assignable to the union
 * once it exists.
 */
export type VerifyGoogleIdTokenResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; code: "SAMO-AUTH-008"; reason: GoogleIdTokenRejection };

/** The JWKS seam, so the service can be handed a cache it controls. */
export interface JwksKeySource {
  /** The JWK published under `kid`, or undefined if we have none. */
  getKey(kid: string, nowMs: number): Promise<Record<string, unknown> | undefined>;
}

export interface GoogleJwksOptions {
  /** Injected transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Fetch timeout; defaults to {@link JWKS_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Parse `Cache-Control: max-age=N`, clamped to [floor, ceiling]. */
function cacheLifetimeMs(header: string | null): number {
  if (header === null) return JWKS_MIN_CACHE_MS;
  // The leading `(?:^|[,\s])` stops `s-maxage` and friends from matching.
  const matched = /(?:^|[,\s])max-age\s*=\s*(\d+)/i.exec(header);
  if (matched === null) return JWKS_MIN_CACHE_MS;
  const seconds = Number(matched[1]);
  if (!Number.isFinite(seconds)) return JWKS_MIN_CACHE_MS;
  return Math.min(Math.max(seconds * 1000, JWKS_MIN_CACHE_MS), JWKS_MAX_CACHE_MS);
}

/**
 * Read a response body with a hard byte budget, so a hostile or broken endpoint
 * cannot make us buffer an unbounded amount. Returns null when the cap is
 * exceeded (or the declared length already blows it), which the caller treats
 * as "no usable JWKS" and falls back to the cached keys.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > maxBytes) return null;
  }
  const stream = res.body;
  if (stream === null) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Google's signing keys, cached by `kid`.
 *
 * Refresh policy, in one place because each rule exists for a different reason:
 *  - a fresh cache hit never touches the network;
 *  - an EXPIRED cache refreshes on demand;
 *  - an unknown `kid` against a FRESH cache (Google rotated early, or someone is
 *    spraying) forces at most one refresh per {@link JWKS_REFRESH_COOLDOWN_MS};
 *  - concurrent misses share ONE in-flight fetch (single-flight), so a cold
 *    start under load is one request, not one per sign-in;
 *  - a FAILED fetch backs off for {@link JWKS_FAILURE_RETRY_MS} and the previous
 *    keys are SERVED STALE. Staleness is not a security downgrade — forging
 *    against a retired Google key still needs Google's private key — whereas
 *    failing closed would turn a transient googleapis.com blip into a total
 *    login outage.
 */
export class GoogleJwks implements JwksKeySource {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #keys: Map<string, Record<string, unknown>> = new Map();
  #expiresAtMs = 0;
  #lastForcedRefreshMs = Number.NEGATIVE_INFINITY;
  #retryNotBeforeMs = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<void> | null = null;

  constructor(opts: GoogleJwksOptions = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? JWKS_TIMEOUT_MS;
  }

  async getKey(
    kid: string,
    nowMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    const cached = this.#keys.get(kid);
    if (cached !== undefined && nowMs < this.#expiresAtMs) return cached;

    if (nowMs >= this.#retryNotBeforeMs) {
      if (this.#keys.size === 0 || nowMs >= this.#expiresAtMs) {
        // Cold or aged-out cache: a normal, uncounted refresh.
        await this.#refresh(nowMs);
      } else if (nowMs - this.#lastForcedRefreshMs >= JWKS_REFRESH_COOLDOWN_MS) {
        // Fresh cache that lacks this kid. Charge the cooldown BEFORE awaiting,
        // so a burst of unknown kids cannot each slip through the gate.
        this.#lastForcedRefreshMs = nowMs;
        await this.#refresh(nowMs);
      }
    }
    // Serve stale on cooldown / backoff / failure.
    return this.#keys.get(kid);
  }

  /** Single-flight: concurrent callers await the one in-flight load. */
  #refresh(nowMs: number): Promise<void> {
    const existing = this.#inFlight;
    if (existing !== null) return existing;
    const started = this.#load(nowMs).finally(() => {
      if (this.#inFlight === started) this.#inFlight = null;
    });
    this.#inFlight = started;
    return started;
  }

  /** Never rejects: a failed load leaves the previous keys in place. */
  async #load(nowMs: number): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(GOOGLE_JWKS_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      this.#retryNotBeforeMs = nowMs + JWKS_FAILURE_RETRY_MS;
      return;
    }

    const parsed = await this.#parse(res);
    if (parsed === null) {
      this.#retryNotBeforeMs = nowMs + JWKS_FAILURE_RETRY_MS;
      return;
    }
    this.#keys = parsed;
    this.#expiresAtMs = nowMs + cacheLifetimeMs(res.headers.get("cache-control"));
    this.#retryNotBeforeMs = Number.NEGATIVE_INFINITY;
  }

  /** Validate a JWKS response wholesale; null means "unusable, keep the old". */
  async #parse(res: Response): Promise<Map<string, Record<string, unknown>> | null> {
    if (!res.ok) return null;
    let body: string | null;
    try {
      body = await readCappedText(res, JWKS_MAX_BYTES);
    } catch {
      return null;
    }
    if (body === null) return null;

    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      return null;
    }
    if (typeof doc !== "object" || doc === null) return null;
    const keys = (doc as { keys?: unknown }).keys;
    // A document over the cap is rejected WHOLESALE rather than truncated: a
    // partial accept would let an oversized response quietly evict real keys.
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > JWKS_MAX_KEYS) {
      return null;
    }

    const next = new Map<string, Record<string, unknown>>();
    for (const entry of keys) {
      if (typeof entry !== "object" || entry === null) continue;
      const jwk = entry as Record<string, unknown>;
      const kid = jwk.kid;
      if (typeof kid !== "string" || kid.length === 0) continue;
      // First writer wins, so a duplicate kid later in the document cannot
      // shadow the key we already accepted.
      if (!next.has(kid)) next.set(kid, jwk);
    }
    return next.size === 0 ? null : next;
  }
}

/**
 * Is this JWK usable to verify an RS256 Google ID token?
 *
 * Deliberately strict, and applied at SELECTION rather than at cache-fill so an
 * unusable key gives the precise `key_unusable` reason instead of masquerading
 * as an unknown kid.
 */
function isUsableRs256Key(jwk: Record<string, unknown>): boolean {
  if (jwk.kty !== "RSA") return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return false;
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;
  // ≥ 2048-bit. A 1024-bit RSA key is factorable by a motivated attacker, and
  // accepting one would let a compromised/legacy key sign a valid-looking token.
  return Buffer.from(jwk.n, "base64url").length >= JWKS_MIN_MODULUS_BYTES;
}

function reject(reason: GoogleIdTokenRejection): VerifyGoogleIdTokenResult {
  return { ok: false, code: "SAMO-AUTH-008", reason };
}

function decodeJson(segment: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export interface VerifyGoogleIdTokenOptions {
  /** Our OAuth client id — pinned as the required `aud` (and `azp` if present). */
  clientId: string;
  /** The nonce this browser's signed state cookie recorded at /authorize time. */
  expectedNonce: string;
  /** Where signing keys come from — normally a long-lived {@link GoogleJwks}. */
  jwks: JwksKeySource;
  /** Epoch **MILLISECONDS**. Named for the unit because the token's are seconds. */
  nowMs: number;
}

/**
 * Verify a Google ID token end to end. Never throws: every failure is a typed
 * `{ok:false}` with a precise reason, mirroring `token.ts`'s `VerifyResult`.
 */
export async function verifyGoogleIdToken(
  token: string,
  opts: VerifyGoogleIdTokenOptions,
): Promise<VerifyGoogleIdTokenResult> {
  // ---- 1. Structural bounds, before any crypto and before any network -----
  if (typeof token !== "string" || token.length === 0) return reject("malformed_token");
  if (Buffer.byteLength(token, "utf8") > GOOGLE_ID_TOKEN_MAX_BYTES) {
    return reject("token_too_large");
  }
  const parts = token.split(".");
  if (parts.length !== 3) return reject("malformed_token");

  const header = decodeJson(parts[0] as string);
  if (header === null) return reject("bad_header");

  // ---- 2. Pin the algorithm BEFORE any key lookup -------------------------
  // String equality against the literal. The token does NOT get to choose the
  // verification routine; see the module header for why this ordering is the
  // whole defence against the alg-confusion family.
  if (header.alg !== "RS256") return reject("alg_not_rs256");

  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) return reject("missing_kid");

  // ---- 3. Key selection ---------------------------------------------------
  const jwk = await opts.jwks.getKey(kid, opts.nowMs);
  if (jwk === undefined) return reject("unknown_kid");
  if (!isUsableRs256Key(jwk)) return reject("key_unusable");

  let publicKey;
  try {
    const keyInput: JsonWebKeyInput = {
      key: jwk as JsonWebKeyInput["key"],
      format: "jwk",
    };
    publicKey = createPublicKey(keyInput);
  } catch {
    return reject("key_unusable");
  }

  // ---- 4. Verify over the EXACT received bytes ----------------------------
  // `token.slice(0, secondDot)` is the received `header.payload` substring
  // verbatim. Re-serializing the decoded header/payload instead would open a
  // canonicalization gap: the bytes we verified would not be the bytes we then
  // trusted (same discipline as `token.ts`).
  const firstDot = token.indexOf(".");
  const secondDot = token.indexOf(".", firstDot + 1);
  const signingInput = token.slice(0, secondDot);

  const signature = Buffer.from(parts[2] as string, "base64url");
  if (signature.length === 0) return reject("bad_signature");
  let signatureOk = false;
  try {
    signatureOk = createVerify("RSA-SHA256")
      .update(signingInput, "utf8")
      .verify(publicKey, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return reject("bad_signature");

  // ---- 5. Claims — only now, on an authenticated payload ------------------
  // Every check below is a HARD reject. There is no "warn and continue" and no
  // "skip when absent": an absent claim is an attacker-controlled condition,
  // because omitting a field is the cheapest thing a forger can do.
  const claims = decodeJson(parts[1] as string);
  if (claims === null) return reject("bad_payload");

  // `iss`: EXACT membership in a 2-element literal allowlist. A suffix or prefix
  // test here would accept `https://accounts.google.com.evil.tld`.
  const iss = claims.iss;
  if (typeof iss !== "string") return reject("iss_not_allowed");
  if (!(GOOGLE_ID_TOKEN_ISSUERS as readonly string[]).includes(iss)) {
    return reject("iss_not_allowed");
  }

  // `aud`: our client id exactly, or an array containing it. This is what stops
  // a token minted for a DIFFERENT OAuth client — including our own non-prod
  // client, whose secret lives in a lower-trust preview .env — from signing
  // anyone into prod.
  const aud = claims.aud;
  const audMatches =
    aud === opts.clientId ||
    (Array.isArray(aud) && aud.some((entry) => entry === opts.clientId));
  if (!audMatches) return reject("aud_mismatch");

  // `azp` (authorized party) is optional; when present it must be us. It is the
  // claim that distinguishes "issued to us" from "issued to someone else but
  // listing us in aud".
  const azp = claims.azp;
  if (azp !== undefined && azp !== opts.clientId) return reject("azp_mismatch");

  // UNIT CONVERSION, exactly once. `exp`/`iat` are epoch SECONDS in the token;
  // `opts.nowMs` is epoch MILLISECONDS. The ×1000 happens here and nowhere else,
  // and the products carry `Ms` in their names.
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return reject("expired");
  const expMs = exp * 1000;
  if (opts.nowMs - expMs > ID_TOKEN_CLOCK_SKEW_MS) return reject("expired");

  const iat = claims.iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return reject("iat_not_fresh");
  const iatMs = iat * 1000;
  // Issued in the future beyond skew → a forged or badly-clocked minter.
  if (iatMs - opts.nowMs > ID_TOKEN_CLOCK_SKEW_MS) return reject("iat_not_fresh");
  // Issued too long ago → a captured token being replayed later in the window
  // between mint and expiry.
  if (opts.nowMs - iatMs > ID_TOKEN_MAX_IAT_AGE_MS) return reject("iat_not_fresh");

  // `nonce` binds this token to the browser that started THIS flow (the value
  // is in that browser's signed state cookie). A MISSING nonce REJECTS — it is
  // never treated as "nothing to compare, carry on", which would hand an
  // attacker a one-character bypass of the whole authorization-code-injection
  // defence. The expected value must be non-empty for the same reason: an empty
  // expectation must not be satisfiable by an empty claim.
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || nonce.length === 0) return reject("nonce_missing");
  if (typeof opts.expectedNonce !== "string" || opts.expectedNonce.length === 0) {
    return reject("nonce_missing");
  }
  const nonceMatches = constantTimeEqual(
    Buffer.from(nonce, "utf8"),
    Buffer.from(opts.expectedNonce, "utf8"),
  );
  if (!nonceMatches) return reject("nonce_mismatch");

  // `sub` is the identity key (`user_identities.provider_subject`) — it must be
  // present and bounded before it ever reaches the store.
  const subject = claims.sub;
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > GOOGLE_ID_TOKEN_MAX_SUBJECT_LENGTH
  ) {
    return reject("sub_invalid");
  }

  const email = claims.email;
  if (typeof email !== "string" || email.length === 0) return reject("email_missing");

  return {
    ok: true,
    identity: {
      provider: "google",
      subject,
      email,
      // REPORTED, not enforced. Boolean-strict, so the string "true" and the
      // number 1 both read as false. The service is the single enforcement
      // point for the §209 account-takeover gate.
      emailVerified: claims.email_verified === true,
    },
  };
}
