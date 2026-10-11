/**
 * The pinned Recall webhook signing contract (SPEC §5.3 step 1, §6.2 #7).
 *
 * This single module is the source of truth shared by the SIGNER (the in-repo
 * Recall fake, `packages/test-fakes/recall`) and the VERIFIER (the ingest
 * `POST /webhook` handler). Pinning the header name + the HMAC scheme + the
 * exact signing input here — and asserting a HARD-CODED digest — guarantees the
 * two sides can never silently drift apart.
 */
import { describe, it, expect } from "bun:test";
import {
  RECALL_SIGNATURE_HEADER,
  recallSignature,
  verifyRecallSignature,
} from "./signature.ts";

describe("Recall webhook signing contract (§5.3 step 1)", () => {
  it("pins the exact header name the signer sets and the verifier reads", () => {
    expect(RECALL_SIGNATURE_HEADER).toBe("x-recall-signature");
  });

  it("recallSignature over a fixed body equals a hard-coded HMAC-SHA256 digest", () => {
    // Exact-value pin: HMAC-SHA256(body, secret) as lowercase hex over the EXACT
    // raw body bytes. A change to the scheme/encoding breaks this on purpose.
    const digest = recallSignature('{"hello":"world"}', "whsec_fixed-secret-001");
    expect(digest).toBe(
      "7d3602fafd297e847aaee933517e85b79e0f3d0ff5a0e63c0e0a6953343f3b02",
    );
    // Stable across calls and accepts raw bytes identically to the string form.
    expect(recallSignature(new TextEncoder().encode('{"hello":"world"}'), "whsec_fixed-secret-001")).toBe(digest);
  });

  it("verifyRecallSignature accepts the matching signature in constant time", () => {
    const body = '{"a":1}';
    const sig = recallSignature(body, "sekret");
    expect(verifyRecallSignature(body, sig, "sekret")).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and an absent/short signature", () => {
    const body = '{"a":1}';
    const sig = recallSignature(body, "sekret");
    expect(verifyRecallSignature('{"a":2}', sig, "sekret")).toBe(false); // tampered body
    expect(verifyRecallSignature(body, sig, "other")).toBe(false); // wrong secret
    expect(verifyRecallSignature(body, "deadbeef", "sekret")).toBe(false); // wrong length
    expect(verifyRecallSignature(body, "", "sekret")).toBe(false); // empty
    expect(verifyRecallSignature(body, null, "sekret")).toBe(false); // missing header
  });
});
