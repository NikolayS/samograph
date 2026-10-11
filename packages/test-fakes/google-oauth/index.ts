/**
 * In-repo fake Google IdP — a REAL identity provider, not a stub.
 *
 * It generates an actual RSA keypair with `generateKeyPairSync`, publishes a
 * real JWKS document over an injected `fetch`, and mints real RS256 JWTs with
 * `createSign("RSA-SHA256")`. Nothing here returns a pre-parsed claims object:
 * every token is a `base64url(header).base64url(payload).base64url(signature)`
 * string that the PRODUCTION `verifyGoogleIdToken` must do genuine RSA
 * verification on. That is the whole point — a fake that short-circuits the
 * crypto makes `alg:"none"`, HS256 confusion, unknown-kid and bad-signature
 * untestable, which are exactly the cases that matter.
 *
 * It follows the `packages/test-fakes/recall/` rule of importing the PRODUCTION
 * primitives it stands in front of (there: the webhook signing scheme; here:
 * the pinned JWKS URL and issuer allowlist), so the fake and the verifier
 * cannot drift apart (SPEC §6.1).
 *
 * Everything is a pure function of the constructor options plus explicit
 * arguments — no `Date.now()`, no ambient randomness beyond the one keypair —
 * so a test that pins `nowMs` gets byte-stable claims across runs.
 */
import {
  createHmac,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  GOOGLE_JWKS_URL,
  GOOGLE_ID_TOKEN_ISSUERS,
} from "../../../apps/app-api/auth/google-id-token.ts";
import { GOOGLE_TOKEN_URL } from "../../../apps/app-api/auth/google-oauth.ts";
import { GOOGLE_REVOKE_URL } from "../../../apps/app-api/calendar/google-calendar-oauth.ts";
import { codeChallengeS256 } from "../../../apps/app-api/auth/oauth-state.ts";

// Re-exported so tests reach for the pinned production values through the fake.
export { GOOGLE_JWKS_URL, GOOGLE_ID_TOKEN_ISSUERS };

/** Default subject — Google `sub` values are 21-digit numeric strings. */
export const FAKE_GOOGLE_SUB = "117000000000000000001";
export const FAKE_GOOGLE_EMAIL = "alice@example.com";
export const FAKE_GOOGLE_KID = "fake-google-kid-1";
/** What Google actually sends on `/oauth2/v3/certs`. */
export const FAKE_GOOGLE_CACHE_CONTROL =
  "public, max-age=20868, must-revalidate, no-transform";

export interface FakeGoogleIdpOptions {
  /** The OAuth client id minted into `aud`/`azp`. */
  clientId?: string;
  /** The nonce minted into the `nonce` claim. */
  nonce?: string;
  /** The `kid` published in the JWKS and set in the JOSE header. */
  kid?: string;
  /** RSA modulus size; 1024 exercises the too-short-key rejection. */
  modulusLength?: number;
  /** Fixed epoch MILLISECONDS the default `iat`/`exp` are derived from. */
  nowMs?: number;
  /** Artificial latency on the JWKS response, to exercise single-flight. */
  fetchDelayMs?: number;
  /** `undefined` → a Google-like header; `null` → send no Cache-Control. */
  cacheControl?: string | null;
  /** Merged into the published JWK; an `undefined` value REMOVES the field. */
  jwkOverrides?: Record<string, unknown>;
  /** Extra filler keys in the JWKS document, to exercise the key cap. */
  padKeys?: number;
  /** Extra padding bytes in the JWKS body, to exercise the size cap. */
  padBodyBytes?: number;
  /** HTTP status for the JWKS response. */
  status?: number;
  /** Replace the JWKS body wholesale (non-JSON, truncated, …). */
  rawBody?: string;
  /** Model Google's legal omission of a refresh token on an offline exchange. */
  omitRefreshToken?: boolean;
  /** Configurable revocation response; local disconnect must ignore failures. */
  revocationStatus?: number;
  /** Override the scope list returned by the next authorization-code exchange. */
  tokenResponseScopes?: string[];
}

export interface FakeAuthorizationRecord {
  scope: string[]; accessType: string | null; includeGrantedScopes: string | null;
  prompt: string | null; redirectUri: string | null; state: string | null;
}

/** Header/claim surgery, so every negative case is expressible. */
export interface MintOverrides {
  /** Replace or add payload claims. Values are used VERBATIM. */
  claims?: Record<string, unknown>;
  /** Remove these claims from the payload entirely. */
  omitClaims?: string[];
  /** Replace or add JOSE header fields. */
  header?: Record<string, unknown>;
  /** Remove these fields from the JOSE header entirely. */
  omitHeader?: string[];
}

function b64url(value: string | Uint8Array): string {
  return Buffer.from(value as never).toString("base64url");
}

function encodeJson(obj: Record<string, unknown>): string {
  return b64url(JSON.stringify(obj));
}

/** Merge overrides, then delete omitted keys and any explicit `undefined`. */
function shape(
  base: Record<string, unknown>,
  over?: Record<string, unknown>,
  omit?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, ...over };
  for (const key of omit ?? []) delete out[key];
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

export class FakeGoogleIdp {
  readonly clientId: string;
  readonly nonce: string;
  readonly kid: string;
  readonly nowMs: number;

  /** JWKS requests served (a failed attempt still counts — it hit the wire). */
  fetchCount = 0;
  /** Every URL the injected fetch was asked for, in order. */
  readonly requestedUrls: string[] = [];
  readonly authorizationRequests: FakeAuthorizationRecord[] = [];
  readonly revokedTokens: string[] = [];

  readonly #privateKey: KeyObject;
  readonly #publicJwk: Record<string, unknown>;
  readonly #modulus: Buffer;
  readonly #fetchDelayMs: number;
  readonly #cacheControl: string | null;
  readonly #padKeys: number;
  readonly #padBodyBytes: number;
  readonly #status: number;
  readonly #rawBody: string | undefined;
  #failure: string | undefined;
  #foreignKey: KeyObject | undefined;
  readonly #codes = new Map<string, { refreshToken?: string; redirectUri: string | null; codeChallenge: string | null }>();
  readonly #refreshTokens = new Map<string, string>();
  readonly #invalidRefreshTokens = new Set<string>();
  #omitRefreshToken: boolean;
  #revocationStatus: number;
  #tokenResponseScopes: string[] | undefined;

  constructor(opts: FakeGoogleIdpOptions = {}) {
    this.clientId = opts.clientId ?? "fake-client-id.apps.googleusercontent.com";
    this.nonce = opts.nonce ?? "fake-nonce";
    this.kid = opts.kid ?? FAKE_GOOGLE_KID;
    this.nowMs = opts.nowMs ?? 1_770_000_000_000;
    this.#fetchDelayMs = opts.fetchDelayMs ?? 0;
    this.#cacheControl =
      opts.cacheControl === undefined ? FAKE_GOOGLE_CACHE_CONTROL : opts.cacheControl;
    this.#padKeys = opts.padKeys ?? 0;
    this.#padBodyBytes = opts.padBodyBytes ?? 0;
    this.#status = opts.status ?? 200;
    this.#rawBody = opts.rawBody;
    this.#omitRefreshToken = opts.omitRefreshToken ?? false;
    this.#revocationStatus = opts.revocationStatus ?? 200;
    this.#tokenResponseScopes = opts.tokenResponseScopes;

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: opts.modulusLength ?? 2048,
    });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    this.#modulus = Buffer.from(String(jwk.n), "base64url");
    this.#publicJwk = shape(
      { ...jwk, kid: this.kid, use: "sig", alg: "RS256" },
      opts.jwkOverrides,
    );
  }

  /** The raw RSA modulus bytes — the HMAC key in the HS256-confusion attack. */
  publicModulusBytes(): Buffer {
    return this.#modulus;
  }

  /** The published JWK, exactly as it appears in the JWKS document. */
  publicJwk(): Record<string, unknown> {
    return { ...this.#publicJwk };
  }

  /** The JWKS document this IdP serves. */
  jwksDocument(): { keys: Record<string, unknown>[] } {
    const filler = Array.from({ length: this.#padKeys }, (_, i) => ({
      ...this.#publicJwk,
      kid: `filler-kid-${i}`,
    }));
    return { keys: [...filler, this.publicJwk()] };
  }

  /** Make every subsequent JWKS fetch reject at the transport level. */
  failFetches(message = "fetch failed"): void {
    this.#failure = message;
  }

  /** Undo {@link failFetches}. */
  succeedFetches(): void {
    this.#failure = undefined;
  }

  omitNextRefreshToken(value = true): void { this.#omitRefreshToken = value; }
  invalidateRefreshToken(token: string): void { this.#invalidRefreshTokens.add(token); }
  setRevocationStatus(status: number): void { this.#revocationStatus = status; }
  setTokenResponseScopes(scopes: string[]): void { this.#tokenResponseScopes = scopes; }

  /** Accept an authorization URL and issue a code carrying offline consent state. */
  authorize(input: string | URL): { code: string; state: string | null; refreshToken?: string } {
    const url = new URL(input);
    const record: FakeAuthorizationRecord = {
      scope: (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
      accessType: url.searchParams.get("access_type"),
      includeGrantedScopes: url.searchParams.get("include_granted_scopes"),
      prompt: url.searchParams.get("prompt"), redirectUri: url.searchParams.get("redirect_uri"),
      state: url.searchParams.get("state"),
    };
    this.authorizationRequests.push(record);
    const code = `fake-code-${this.authorizationRequests.length}`;
    const shouldIssue = record.accessType === "offline" && record.prompt === "consent" && !this.#omitRefreshToken;
    const refreshToken = shouldIssue ? `fake-refresh-${this.authorizationRequests.length}` : undefined;
    this.#codes.set(code, { refreshToken, redirectUri: record.redirectUri, codeChallenge: url.searchParams.get("code_challenge") });
    if (refreshToken) this.#refreshTokens.set(refreshToken, `fake-access-${this.authorizationRequests.length}`);
    this.#omitRefreshToken = false;
    return { code, state: record.state, ...(refreshToken ? { refreshToken } : {}) };
  }

  /**
   * The injected transport. It answers ONLY the pinned production JWKS URL —
   * anything else 404s, so a verifier that invents its own endpoint (runtime
   * `.well-known` discovery, an env-supplied URL) fails loudly in tests.
   */
  readonly fetchImpl: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    this.requestedUrls.push(url);
    if (url === GOOGLE_TOKEN_URL) {
      const params = new URLSearchParams(String(_init?.body ?? ""));
      if (params.get("grant_type") === "authorization_code") {
        const grant = this.#codes.get(params.get("code") ?? "");
        if (!grant || grant.redirectUri !== params.get("redirect_uri") || (grant.codeChallenge && grant.codeChallenge !== codeChallengeS256(params.get("code_verifier") ?? ""))) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.#codes.delete(params.get("code") ?? "");
        return Response.json({ access_token: "fake-access", token_type: "Bearer", expires_in: 3600, scope: (this.#tokenResponseScopes ?? this.authorizationRequests.at(-1)?.scope)?.join(" "), ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}) });
      }
      if (params.get("grant_type") === "refresh_token") {
        const token = params.get("refresh_token") ?? "";
        if (!this.#refreshTokens.has(token) || this.#invalidRefreshTokens.has(token) || this.revokedTokens.includes(token)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: this.#refreshTokens.get(token), token_type: "Bearer", expires_in: 3600 });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url === GOOGLE_REVOKE_URL) {
      const token = new URLSearchParams(String(_init?.body ?? "")).get("token");
      if (token) this.revokedTokens.push(token);
      return new Response(null, { status: this.#revocationStatus });
    }
    if (url !== GOOGLE_JWKS_URL) {
      return new Response("not found", { status: 404 });
    }

    this.fetchCount += 1;
    if (this.#fetchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#fetchDelayMs));
    }
    if (this.#failure !== undefined) throw new TypeError(this.#failure);

    let body: string;
    if (this.#rawBody !== undefined) {
      body = this.#rawBody;
    } else if (this.#padBodyBytes > 0) {
      body = JSON.stringify({
        ...this.jwksDocument(),
        _pad: "x".repeat(this.#padBodyBytes),
      });
    } else {
      body = JSON.stringify(this.jwksDocument());
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#cacheControl !== null) headers["cache-control"] = this.#cacheControl;
    return new Response(body, { status: this.#status, headers });
  }) as typeof fetch;

  /** The claims a well-formed Google ID token carries for this IdP. */
  defaultClaims(): Record<string, unknown> {
    const iatSec = Math.floor(this.nowMs / 1000);
    return {
      iss: GOOGLE_ID_TOKEN_ISSUERS[0],
      azp: this.clientId,
      aud: this.clientId,
      sub: FAKE_GOOGLE_SUB,
      email: FAKE_GOOGLE_EMAIL,
      email_verified: true,
      nonce: this.nonce,
      iat: iatSec,
      exp: iatSec + 3600,
    };
  }

  #segments(over?: MintOverrides): { headerB64: string; payloadB64: string } {
    const header = shape(
      { alg: "RS256", kid: this.kid, typ: "JWT" },
      over?.header,
      over?.omitHeader,
    );
    const claims = shape(this.defaultClaims(), over?.claims, over?.omitClaims);
    return { headerB64: encodeJson(header), payloadB64: encodeJson(claims) };
  }

  #signRs256(signingInput: string, key: KeyObject): string {
    return b64url(createSign("RSA-SHA256").update(signingInput).sign(key));
  }

  /** Mint a genuinely signed RS256 ID token. */
  mint(over?: MintOverrides): string {
    const { headerB64, payloadB64 } = this.#segments(over);
    const signingInput = `${headerB64}.${payloadB64}`;
    return `${signingInput}.${this.#signRs256(signingInput, this.#privateKey)}`;
  }

  /**
   * A valid RS256 signature made by a DIFFERENT 2048-bit keypair, under this
   * IdP's `kid` — the "right shape, wrong signer" forgery.
   */
  mintWithForeignKey(over?: MintOverrides): string {
    this.#foreignKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const { headerB64, payloadB64 } = this.#segments(over);
    const signingInput = `${headerB64}.${payloadB64}`;
    return `${signingInput}.${this.#signRs256(signingInput, this.#foreignKey)}`;
  }

  /** `alg:"none"` with an empty signature segment — the classic bypass. */
  mintAlgNone(over?: MintOverrides): string {
    const { headerB64, payloadB64 } = this.#segments({
      ...over,
      header: { ...over?.header, alg: "none" },
    });
    return `${headerB64}.${payloadB64}.`;
  }

  /**
   * A real HS256 JWT, HMAC'd under an attacker-chosen key. Pass the client
   * secret, or `publicModulusBytes()` for the "verify the RSA public key as an
   * HMAC secret" confusion attack.
   */
  mintHs256(hmacKey: string | Buffer, over?: MintOverrides): string {
    const { headerB64, payloadB64 } = this.#segments({
      ...over,
      header: { ...over?.header, alg: "HS256" },
    });
    const signingInput = `${headerB64}.${payloadB64}`;
    const mac = createHmac("sha256", hmacKey).update(signingInput).digest();
    return `${signingInput}.${b64url(mac)}`;
  }

  /**
   * A CORRECTLY signed token whose payload segment is the given raw string —
   * for malformed JSON, and for VALID but non-canonically encoded JSON (extra
   * whitespace, different key order), which is how a verifier that re-serializes
   * instead of using the received bytes gets caught.
   */
  mintRawPayload(rawPayload: string, over?: MintOverrides): string {
    const header = shape(
      { alg: "RS256", kid: this.kid, typ: "JWT" },
      over?.header,
      over?.omitHeader,
    );
    const signingInput = `${encodeJson(header)}.${b64url(rawPayload)}`;
    return `${signingInput}.${this.#signRs256(signingInput, this.#privateKey)}`;
  }

  /** A CORRECTLY signed token whose JOSE header segment is the given raw string. */
  mintRawHeader(rawHeader: string, over?: MintOverrides): string {
    const claims = shape(this.defaultClaims(), over?.claims, over?.omitClaims);
    const signingInput = `${b64url(rawHeader)}.${encodeJson(claims)}`;
    return `${signingInput}.${this.#signRs256(signingInput, this.#privateKey)}`;
  }

  /**
   * Rewrite a minted token's claims while KEEPING its original signature — a
   * structurally perfect token whose signature no longer covers the payload.
   */
  tamperPayload(token: string, claims: Record<string, unknown>): string {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const parsed = JSON.parse(
      Buffer.from(String(payloadB64), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return `${headerB64}.${encodeJson({ ...parsed, ...claims })}.${sigB64}`;
  }
}
