import { GOOGLE_CALENDAR_EVENTS_URL, GOOGLE_CALENDAR_FIELDS } from "../../../apps/app-api/calendar/google-calendar-client.ts";
import { GOOGLE_TOKEN_URL } from "../../../apps/app-api/auth/google-oauth.ts";

export type FakeCalendarEvent = Record<string, unknown> & { id: string };
type Failure = { status?: number; retryAfter?: string; body?: string; timeout?: boolean; malformed?: boolean; oversized?: boolean };

export class FakeGoogleCalendar {
  readonly refreshRequests: Record<string, string>[] = [];
  readonly listRequests: Array<{ token: string | null; query: Record<string, string> }> = [];
  #events: FakeCalendarEvent[] = [];
  #pageSize = 2500;
  #nextFailure: Failure | undefined;
  #pageFailures = new Map<string, Failure>();
  #expired = new Set<string>();
  #revoked = new Set<string>();
  #forbidden = new Map<string, { reason: string; retryAfter?: string }>();
  #timeZone = "UTC";

  seedEvents(events: FakeCalendarEvent[], pageSize = 2500): void { this.#events = structuredClone(events); this.#pageSize = pageSize; }
  setCalendarTimeZone(timeZone: string): void { this.#timeZone = timeZone; }
  failNextList(failure: Failure): void { this.#nextFailure = failure; }
  failListPage(token: string, failure: Failure): void { this.#pageFailures.set(token, failure); }
  expireAccessToken(token: string): void { this.#expired.add(token); }
  revokeGrant(token: string): void { this.#revoked.add(token); }
  forbidAccessToken(token: string, reason: string, retryAfter?: string): void { this.#forbidden.set(token, { reason, retryAfter }); }

  #failure(value: Failure, signal?: AbortSignal | null): Promise<Response> | Response {
    if (value.timeout) return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
    const headers = value.retryAfter ? { "retry-after": value.retryAfter } : undefined;
    const body = value.oversized ? "x".repeat(70_000) : value.malformed ? "{" : value.body ?? JSON.stringify({ error: "fake" });
    return new Response(body, { status: value.status ?? 500, headers });
  }

  readonly fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.toString() === GOOGLE_TOKEN_URL) {
      const request = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      this.refreshRequests.push(request);
      const token = request.refresh_token ?? "";
      if (this.#revoked.has(token)) return Response.json({ error: "invalid_grant", error_description: "sensitive" }, { status: 400 });
      return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.origin + url.pathname !== GOOGLE_CALENDAR_EVENTS_URL) return new Response("not found", { status: 404 });
    const query = Object.fromEntries(url.searchParams);
    const token = init?.headers instanceof Headers ? init.headers.get("authorization") : new Headers(init?.headers).get("authorization");
    this.listRequests.push({ token, query });
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return new Response("method not allowed", { status: 405 });
    if (token !== "Bearer access-token") return new Response("unauthorized", { status: 401 });
    const timeMin = Date.parse(query.timeMin ?? ""), timeMax = Date.parse(query.timeMax ?? ""), maxResults = Number(query.maxResults);
    if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax) || timeMax <= timeMin || query.singleEvents !== "true" || query.orderBy !== "startTime" || query.showDeleted !== "false" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2500 || query.fields !== GOOGLE_CALENDAR_FIELDS) return new Response("bad query", { status: 400 });
    const pageToken = query.pageToken;
    const failure = (pageToken && this.#pageFailures.get(pageToken)) || this.#nextFailure;
    if (pageToken) this.#pageFailures.delete(pageToken); else this.#nextFailure = undefined;
    if (failure) return this.#failure(failure, init?.signal);
    const access = token?.replace(/^Bearer /, "") ?? "";
    if (this.#expired.delete(access)) return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
    const forbidden = this.#forbidden.get(access);
    if (forbidden) return Response.json({ error: { errors: [{ reason: forbidden.reason }], status: "PERMISSION_DENIED" } }, { status: 403, headers: forbidden.retryAfter ? { "retry-after": forbidden.retryAfter } : undefined });
    if (this.#revoked.has(access)) return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
    const windowEvents = this.#events.filter((event) => {
      const start = event.start as Record<string, unknown> | undefined; const end = event.end as Record<string, unknown> | undefined;
      const startValue = start?.dateTime ?? start?.date; const endValue = end?.dateTime ?? end?.date;
      if (typeof startValue !== "string" || typeof endValue !== "string") return false;
      const startInstant = Date.parse(typeof start?.date === "string" ? `${startValue}T00:00:00Z` : startValue);
      const endInstant = Date.parse(typeof end?.date === "string" ? `${endValue}T00:00:00Z` : endValue);
      return Number.isFinite(startInstant) && Number.isFinite(endInstant) && endInstant > timeMin && startInstant < timeMax;
    });
    const offset = pageToken ? (Number(pageToken.replace("page-", "")) - 1) * this.#pageSize : 0;
    const items = windowEvents.slice(offset, offset + this.#pageSize);
    const next = offset + this.#pageSize < windowEvents.length ? `page-${offset / this.#pageSize + 2}` : undefined;
    return Response.json({ items, timeZone: this.#timeZone, ...(next ? { nextPageToken: next } : {}) });
  }) as typeof fetch;
}
