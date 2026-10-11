/**
 * The OAuth provider PORT and its in-memory fake (issue #209, PR 4).
 *
 * The point of these tests is NOT that the fake works — it is that the fake
 * ENFORCES the contract it stands in for. `InMemoryOAuthProvider` drives every
 * service/http/app test downstream, so if it accepted a missing nonce or an
 * empty `code_verifier`, a service that silently dropped either one would sail
 * through the entire suite and only fail against real Google. Each rejection
 * below is therefore asserted as an EXACT `{ok, code, reason, detail}` object:
 * "it rejected" is not enough to tell a nonce bug from a PKCE bug.
 */
import { describe, expect, it } from "bun:test";
import {
  InMemoryOAuthProvider,
  IN_MEMORY_AUTHORIZE_URL,
  IN_MEMORY_DEFAULT_IDENTITY,
  type ExchangeResult,
  type OAuthIdentity,
} from "./oauth.ts";

const STATE = "state-abc";
const NONCE = "nonce-xyz";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const NOW = 1_770_000_000_000;

function authorized(provider: InMemoryOAuthProvider): string {
  provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE });
  return provider.issueCode(STATE);
}

function exchange(
  provider: InMemoryOAuthProvider,
  over: Partial<{ code: string; codeVerifier: string; expectedNonce: string }> = {},
): Promise<ExchangeResult> {
  return provider.exchange({
    code: over.code ?? "unused",
    codeVerifier: over.codeVerifier ?? VERIFIER,
    expectedNonce: over.expectedNonce ?? NONCE,
    nowMs: NOW,
  });
}

describe("InMemoryOAuthProvider — authorize", () => {
  it("records the EXACT authorization and echoes it into the URL", () => {
    const provider = new InMemoryOAuthProvider();
    const url = provider.authorizeUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    });

    expect(provider.authorizations).toEqual([
      { state: STATE, nonce: NONCE, codeChallenge: CHALLENGE },
    ]);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(IN_MEMORY_AUTHORIZE_URL);
    expect(parsed.searchParams.get("state")).toBe(STATE);
    expect(parsed.searchParams.get("nonce")).toBe(NONCE);
    expect(parsed.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(parsed.searchParams.get("redirect_uri")).toBe(provider.redirectUri);
  });

  it("THROWS when the service forgets state, nonce, or the PKCE challenge", () => {
    const provider = new InMemoryOAuthProvider();
    expect(() =>
      provider.authorizeUrl({ state: "", nonce: NONCE, codeChallenge: CHALLENGE }),
    ).toThrow(/state/);
    expect(() =>
      provider.authorizeUrl({ state: STATE, nonce: "", codeChallenge: CHALLENGE }),
    ).toThrow(/nonce/);
    expect(() =>
      provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: "" }),
    ).toThrow(/codeChallenge/);
    expect(provider.authorizations).toEqual([]);
  });

  it("uses the configured redirectUri, defaulting to a fixed fake one", () => {
    expect(new InMemoryOAuthProvider().redirectUri).toBe(
      "https://oauth.invalid/auth/google/callback",
    );
    expect(
      new InMemoryOAuthProvider({ redirectUri: "https://x.test/auth/google/callback" })
        .redirectUri,
    ).toBe("https://x.test/auth/google/callback");
  });

  it("issueCode REFUSES a state that was never authorized", () => {
    const provider = new InMemoryOAuthProvider();
    expect(() => provider.issueCode("never-seen")).toThrow(/never-seen/);
  });
});

describe("InMemoryOAuthProvider — exchange", () => {
  it("returns the exact identity on a well-formed exchange", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);

    expect(await exchange(provider, { code })).toEqual({
      ok: true,
      identity: IN_MEMORY_DEFAULT_IDENTITY,
    });
    expect(IN_MEMORY_DEFAULT_IDENTITY).toEqual({
      provider: "google",
      subject: "117000000000000000001",
      email: "alice@example.com",
      emailVerified: true,
    });
  });

  it("returns the per-code identity issueCode was given", async () => {
    const provider = new InMemoryOAuthProvider();
    provider.authorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE });
    const identity: OAuthIdentity = {
      provider: "google",
      subject: "sub-2",
      email: "bob@example.com",
      emailVerified: false,
    };
    const code = provider.issueCode(STATE, identity);

    expect(await exchange(provider, { code })).toEqual({ ok: true, identity });
  });

  it("records every exchange it was asked for, verbatim", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);
    await exchange(provider, { code });

    expect(provider.exchanges).toEqual([
      { code, codeVerifier: VERIFIER, expectedNonce: NONCE, nowMs: NOW },
    ]);
  });

  // ---- the two enforcements that make the fake load-bearing ---------------

  it("REJECTS a nonce that does not match the one recorded at authorize time", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);

    expect(await exchange(provider, { code, expectedNonce: "some-other-nonce" })).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "nonce_mismatch",
      detail: "in-memory oauth: nonce does not match the one recorded at authorize time",
    });
  });

  it("REJECTS an EMPTY expected nonce — a service that drops it must not pass", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);

    expect(await exchange(provider, { code, expectedNonce: "" })).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "nonce_mismatch",
      detail: "in-memory oauth: nonce does not match the one recorded at authorize time",
    });
  });

  it("REJECTS an empty codeVerifier — a service that drops PKCE must not pass", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);

    expect(await exchange(provider, { code, codeVerifier: "" })).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "pkce_missing",
      detail: "in-memory oauth: codeVerifier is empty — PKCE was not threaded through",
    });
  });

  it("REJECTS a code it never issued", async () => {
    const provider = new InMemoryOAuthProvider();
    authorized(provider);

    expect(await exchange(provider, { code: "forged-code" })).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "unknown_code",
      detail: "in-memory oauth: unknown authorization code",
    });
  });

  it("checks PKCE BEFORE the nonce, so a doubly-broken service names PKCE first", async () => {
    const provider = new InMemoryOAuthProvider();
    const code = authorized(provider);

    const result = await exchange(provider, {
      code,
      codeVerifier: "",
      expectedNonce: "wrong",
    });
    expect(result).toEqual({
      ok: false,
      code: "SAMO-AUTH-008",
      reason: "pkce_missing",
      detail: "in-memory oauth: codeVerifier is empty — PKCE was not threaded through",
    });
  });
});
