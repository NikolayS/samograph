import { describe, expect, it } from "bun:test";
import {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_REVOKE_URL,
  GoogleCalendarOAuth,
} from "./google-calendar-oauth.ts";

describe("GoogleCalendarOAuth", () => {
  it("builds the exact incremental offline-consent authorization request", () => {
    const oauth = new GoogleCalendarOAuth({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://samograph.dev/calendar/connect/callback",
    });
    const url = new URL(oauth.authorizeUrl({ state: "state", codeChallenge: "challenge" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-id",
      redirect_uri: "https://samograph.dev/calendar/connect/callback",
      scope: GOOGLE_CALENDAR_SCOPE,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state: "state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("nonce")).toBe(false);
  });

  it("requires a refresh token and sends the original PKCE verifier", async () => {
    let body = "";
    const oauth = new GoogleCalendarOAuth({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://samograph.dev/calendar/connect/callback",
      fetchImpl: (async (_input, init) => {
        body = String(init?.body);
        return Response.json({ access_token: "access", refresh_token: "refresh", scope: GOOGLE_CALENDAR_SCOPE });
      }) as typeof fetch,
    });
    expect(await oauth.exchangeCode({ code: "code", codeVerifier: "verifier" })).toEqual({
      ok: true,
      refreshToken: "refresh",
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://samograph.dev/calendar/connect/callback",
      code_verifier: "verifier",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("rejects a successful token response that omits refresh_token", async () => {
    const oauth = new GoogleCalendarOAuth({
      clientId: "id", clientSecret: "secret",
      redirectUri: "http://localhost:3000/calendar/connect/callback",
      fetchImpl: (async () => Response.json({ access_token: "access" })) as unknown as typeof fetch,
    });
    expect(await oauth.exchangeCode({ code: "code", codeVerifier: "verifier" })).toEqual({ ok: false });
  });

  it("revokes at Google's exact endpoint with a form-encoded token", async () => {
    let seen: [string, RequestInit | undefined] | undefined;
    const oauth = new GoogleCalendarOAuth({
      clientId: "id", clientSecret: "secret",
      redirectUri: "http://localhost:3000/calendar/connect/callback",
      fetchImpl: (async (input, init) => {
        seen = [String(input), init];
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(await oauth.revoke("refresh token/+" )).toBe(true);
    expect(seen?.[0]).toBe(GOOGLE_REVOKE_URL);
    expect(seen?.[1]?.method).toBe("POST");
    expect(seen?.[1]?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(seen?.[1]?.body).toBe("token=refresh+token%2F%2B");
  });
});
