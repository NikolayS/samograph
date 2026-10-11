import { GOOGLE_AUTHORIZE_URL, GOOGLE_REGISTERED_REDIRECT_ORIGINS, GOOGLE_TOKEN_URL } from "../auth/google-oauth.ts";
import { GoogleCalendarClient } from "./google-calendar-client.ts";
import { present } from "../../../packages/shared/config/env.ts";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_CALENDAR_CALLBACK_PATH = "/calendar/connect/callback";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 10_000;
const MAX_BODY = 16 * 1024;

export interface GoogleCalendarOAuthPort {
  authorizeUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ ok: true; refreshToken: string; scopes: string[] } | { ok: false }>;
  revoke(token: string): Promise<boolean>;
  readonly apiClient?: GoogleCalendarClient;
}

export class GoogleCalendarOAuth implements GoogleCalendarOAuthPort {
  readonly apiClient: GoogleCalendarClient;
  readonly redirectUri: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  constructor(opts: { clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch }) {
    this.#clientId = opts.clientId; this.#clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri; this.#fetch = opts.fetchImpl ?? fetch;
    this.apiClient = new GoogleCalendarClient({ clientId: opts.clientId, clientSecret: opts.clientSecret, fetchImpl: this.#fetch });
  }
  authorizeUrl(input: { state: string; codeChallenge: string }): string {
    if (!input.state || !input.codeChallenge) throw new Error("Calendar OAuth state or challenge is empty");
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: this.#clientId, redirect_uri: this.redirectUri,
      scope: GOOGLE_CALENDAR_SCOPE, access_type: "offline", include_granted_scopes: "true",
      prompt: "consent", state: input.state, code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    })) url.searchParams.set(key, value);
    return url.toString();
  }
  async exchangeCode(input: { code: string; codeVerifier: string }) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code,
      redirect_uri: this.redirectUri, code_verifier: input.codeVerifier,
      client_id: this.#clientId, client_secret: this.#clientSecret });
    try {
      const res = await this.#fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (!res.ok || declared > MAX_BODY) return { ok: false as const };
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_BODY) return { ok: false as const };
      const value = JSON.parse(text) as Record<string, unknown>;
      if (typeof value.refresh_token !== "string" || value.refresh_token.length === 0) return { ok: false as const };
      const scopes = typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : [GOOGLE_CALENDAR_SCOPE];
      return { ok: true as const, refreshToken: value.refresh_token, scopes };
    } catch { return { ok: false as const }; }
  }
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.#fetch(GOOGLE_REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok;
    } catch { return false; }
  }
}

export function googleCalendarOAuthFromEnv(env: Record<string, string | undefined>, webOrigin: string): GoogleCalendarOAuth | undefined {
  const id = present(env.GOOGLE_OAUTH_CLIENT_ID), secret = present(env.GOOGLE_OAUTH_CLIENT_SECRET);
  if (!id && !secret) return undefined;
  if (!id || !secret) throw new Error("Google OAuth credentials must both be configured");
  const override = present(env.GOOGLE_CALENDAR_REDIRECT_URI);
  const redirectUri = override ?? `${new URL(webOrigin).origin}${GOOGLE_CALENDAR_CALLBACK_PATH}`;
  const url = new URL(redirectUri);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== GOOGLE_CALENDAR_CALLBACK_PATH || url.toString() !== redirectUri) throw new Error("Invalid GOOGLE_CALENDAR_REDIRECT_URI");
  if (!override && !(GOOGLE_REGISTERED_REDIRECT_ORIGINS as readonly string[]).includes(url.origin)) throw new Error("Calendar redirect origin is not registered");
  return new GoogleCalendarOAuth({ clientId: id, clientSecret: secret, redirectUri });
}
