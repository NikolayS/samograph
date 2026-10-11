/**
 * Pure unit tests for the ws-hub request parsers (SPEC §5.6, §5.7).
 *
 * `request.ts` lifts the SAME credentials + `?since_seq` cursor off the wire for
 * BOTH the `GET /calls/:id/stream` WS upgrade and the `GET /calls/:id/transcript`
 * REST gap-resync path, then hands them to the one tenancy gate. A parsing slip
 * here silently mis-scopes access on both surfaces, so these assert EXACT values
 * (no DB, no network — deterministic).
 *
 * SURPRISE documented below: `parseSinceSeq` `.trim()`s before validating, so a
 * whitespace-padded number like `" 3 "` is ACCEPTED (→ 3), not rejected. The test
 * pins the real behavior and calls it out; see the "whitespace" case.
 */
import { describe, it, expect } from "bun:test";
import {
  readCookie,
  readShareToken,
  readCallCredentials,
  parseSinceSeq,
} from "./request.ts";
import { SESSION_COOKIE_NAME } from "../app-api/auth/session.ts";

// --- tiny wire builders (no server, no DB) ---------------------------------
function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("https://hub.example/calls/c1/stream", { headers });
}
function urlWith(params: Record<string, string> = {}): URL {
  const u = new URL("https://hub.example/calls/c1/stream");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

describe("SESSION_COOKIE_NAME — the real session cookie name", () => {
  it("is `samo_session` (the name readCallCredentials defaults to)", () => {
    expect(SESSION_COOKIE_NAME).toBe("samo_session");
  });
});

describe("readCookie — extract a named cookie from the Cookie header", () => {
  it("returns the value of the named cookie among several (trimmed)", () => {
    const req = reqWith({ cookie: "a=1; samo_session=xyz; b=2" });
    expect(readCookie(req, "samo_session")).toBe("xyz");
  });

  it("finds the cookie regardless of position (first / last)", () => {
    expect(readCookie(reqWith({ cookie: "samo_session=first; b=2" }), "samo_session")).toBe("first");
    expect(readCookie(reqWith({ cookie: "a=1; samo_session=last" }), "samo_session")).toBe("last");
  });

  it("returns null when there is no Cookie header at all", () => {
    expect(readCookie(reqWith(), "samo_session")).toBeNull();
  });

  it("returns null when the header has no cookie of that name", () => {
    expect(readCookie(reqWith({ cookie: "a=1; b=2" }), "samo_session")).toBeNull();
  });

  it("returns null on a malformed segment with no `=` (name-only)", () => {
    expect(readCookie(reqWith({ cookie: "samo_session" }), "samo_session")).toBeNull();
  });

  it("does NOT match on a substring / prefix of the name", () => {
    // `samo_session_x` must not satisfy a lookup for `samo_session`.
    expect(readCookie(reqWith({ cookie: "samo_session_x=nope" }), "samo_session")).toBeNull();
  });

  it("matches exactly even with surrounding whitespace around name and value", () => {
    expect(readCookie(reqWith({ cookie: "  samo_session = spaced  " }), "samo_session")).toBe("spaced");
  });
});

describe("readShareToken — `?token=` wins over `Authorization: Bearer …`", () => {
  it("prefers the `?token=` query param over the Authorization header", () => {
    const token = readShareToken(
      reqWith({ authorization: "Bearer HEADER_TOK" }),
      urlWith({ token: "QUERY_TOK" }),
    );
    expect(token).toBe("QUERY_TOK");
  });

  it("parses `Bearer  tok` with extra spaces (\\s+ after the scheme)", () => {
    expect(readShareToken(reqWith({ authorization: "Bearer   tok" }), urlWith())).toBe("tok");
  });

  it("is case-insensitive on the scheme (`bearer` / `BEARER`)", () => {
    expect(readShareToken(reqWith({ authorization: "bearer tok" }), urlWith())).toBe("tok");
    expect(readShareToken(reqWith({ authorization: "BEARER tok" }), urlWith())).toBe("tok");
  });

  it("tolerates leading/trailing whitespace around the whole header", () => {
    expect(readShareToken(reqWith({ authorization: "   Bearer tok   " }), urlWith())).toBe("tok");
  });

  it("falls back to the header when `?token=` is present but empty", () => {
    const u = urlWith();
    u.searchParams.set("token", "");
    expect(readShareToken(reqWith({ authorization: "Bearer HDR" }), u)).toBe("HDR");
  });

  it("returns null on a non-Bearer (garbage) Authorization scheme", () => {
    expect(readShareToken(reqWith({ authorization: "Basic zzz" }), urlWith())).toBeNull();
  });

  it("returns null when neither a query token nor an Authorization header is present", () => {
    expect(readShareToken(reqWith(), urlWith())).toBeNull();
  });
});

describe("readCallCredentials — compose session cookie + share token", () => {
  it("carries BOTH a session cookie and a share token when both are on the wire", () => {
    const creds = readCallCredentials(
      reqWith({ cookie: "samo_session=sess-1", authorization: "Bearer share-1" }),
      urlWith(),
    );
    expect(creds).toEqual({ sessionCookie: "sess-1", shareToken: "share-1" });
  });

  it("session-only request → sessionCookie set, shareToken null (`read` scope)", () => {
    const creds = readCallCredentials(reqWith({ cookie: "samo_session=sess-only" }), urlWith());
    expect(creds).toEqual({ sessionCookie: "sess-only", shareToken: null });
  });

  it("share-only request → shareToken set (from `?token=`), sessionCookie null (`share` scope)", () => {
    const creds = readCallCredentials(reqWith(), urlWith({ token: "share-only" }));
    expect(creds).toEqual({ sessionCookie: null, shareToken: "share-only" });
  });

  it("anonymous request → both null", () => {
    expect(readCallCredentials(reqWith(), urlWith())).toEqual({
      sessionCookie: null,
      shareToken: null,
    });
  });

  it("defaults the cookie name to SESSION_COOKIE_NAME (`samo_session`)", () => {
    const creds = readCallCredentials(reqWith({ cookie: "samo_session=defaulted" }), urlWith());
    expect(creds.sessionCookie).toBe("defaulted");
  });

  it("honors an explicit cookieName override", () => {
    const creds = readCallCredentials(
      reqWith({ cookie: "legacy_sess=override" }),
      urlWith(),
      "legacy_sess",
    );
    expect(creds.sessionCookie).toBe("override");
    // …and the default name is NOT read when overridden.
    expect(readCallCredentials(reqWith({ cookie: "samo_session=ignored" }), urlWith(), "legacy_sess").sessionCookie).toBeNull();
  });
});

describe("parseSinceSeq — non-negative integer cursor, else null", () => {
  it("parses a positive integer: '42' → 42", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "42" }))).toBe(42);
  });

  it("parses zero: '0' → 0 (a valid cursor, distinct from null)", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "0" }))).toBe(0);
  });

  it("returns null when since_seq is absent", () => {
    expect(parseSinceSeq(urlWith())).toBeNull();
  });

  it("returns null on the empty string", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "" }))).toBeNull();
  });

  it("returns null on a negative value ('-5' fails ^\\d+$)", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "-5" }))).toBeNull();
  });

  it("returns null on non-numeric garbage ('abc')", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "abc" }))).toBeNull();
  });

  it("returns null above MAX_SAFE_INTEGER ('99999999999999999999' is not a safe integer)", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "99999999999999999999" }))).toBeNull();
  });

  // SURPRISE: the parser `.trim()`s BEFORE validating, so a whitespace-padded
  // number is ACCEPTED. `" 3 "` → 3, NOT null. (Contrast a raw ` 3 ` that never
  // gets trimmed, which would fail ^\d+$.) Pinning the real, current behavior.
  it("ACCEPTS a whitespace-padded number after trim: ' 3 ' → 3 (documented surprise)", () => {
    expect(parseSinceSeq(urlWith({ since_seq: " 3 " }))).toBe(3);
  });

  it("returns null on a numeric string with an internal space ('1 2' fails ^\\d+$)", () => {
    expect(parseSinceSeq(urlWith({ since_seq: "1 2" }))).toBeNull();
  });
});
