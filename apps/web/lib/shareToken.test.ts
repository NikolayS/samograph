/**
 * `callIdFromShareToken` — decode the call binding out of a share token
 * (SPEC §5.7, Story 2). The share token's FIRST dot-segment is
 * base64url(JSON {kid, call_id, scopes, iat, exp, jti}) (see
 * packages/shared/tokens/signing.ts); the read-only page needs the `call_id`
 * to open `/calls/:call_id/stream?token=…` — connecting with the token itself
 * as the path id is exactly the Sprint-2 bug where no recipient ever saw a
 * shared transcript.
 *
 * Strict red/green TDD: written BEFORE `shareToken.ts` exists.
 */
import { describe, it, expect } from "bun:test";
import { signToken, type SigningKey } from "../../../packages/shared/tokens/signing.ts";
import { callIdFromShareToken } from "./shareToken.ts";

const KEY: SigningKey = { kid: "k1", secret: "share-token-test-secret-aaaaaaaaaaaaaaaa" };

function mint(callId: string): string {
  return signToken(
    {
      kid: KEY.kid,
      call_id: callId,
      scopes: ["share"],
      iat: 1_000,
      exp: 2_000_000_000,
      jti: "11111111-1111-4111-8111-111111111111",
    },
    KEY,
  );
}

describe("callIdFromShareToken (§5.7)", () => {
  it("decodes the exact call_id out of a real minted-format token", () => {
    const callId = "33333333-3333-4333-8333-333333333333";
    expect(callIdFromShareToken(mint(callId))).toBe(callId);
  });

  it("handles base64url payloads containing - and _ characters", () => {
    // A call_id long/odd enough that the encoded body contains url-safe chars.
    const callId = "call-with~unusual?characters/… ünïcode";
    expect(callIdFromShareToken(mint(callId))).toBe(callId);
  });

  it("returns null for an opaque non-token string", () => {
    expect(callIdFromShareToken("shr_abc")).toBeNull();
  });

  it("returns null for valid base64url that is not the token JSON shape", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url");
    expect(callIdFromShareToken(`${body}.sig`)).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(callIdFromShareToken("")).toBeNull();
  });
});
