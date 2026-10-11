/**
 * Hosted Settings `/settings` HTTP adapter — DB-backed integration (SPEC §5.12,
 * §5.10). Runs against the CI ephemeral Postgres with the REAL migrations + REAL
 * RLS (no mocks; SPEC §6.1) and skips cleanly when DATABASE_URL is unset.
 *
 * Covers:
 *  (a) GET/PUT round-trip of keyterms/language/chime/preset, defaults on first GET;
 *  (b) tenant-isolation NEGATIVE — tenant A cannot read or write tenant B's row,
 *      proven at BOTH the route level and the RLS data-layer (WITH CHECK);
 *  (c) POST /calls reads the tenant's settings and enqueues the resolved
 *      keyterms + language onto the orchestrator job (Deepgram passthrough).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { signSession, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { createSettingsHandler } from "./http.ts";
import { createCallsHandler } from "../calls/http.ts";
import type { OrchestratorJob } from "../../bot-orchestrator/index.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "settings-db-test-session-secret-cccccccccccccccccccc";
const MEET_URL = "https://meet.google.com/abc-defg-hij";

d("/settings HTTP adapter (DB-backed, §5.12 / §5.10)", () => {
  let sql: ReturnType<typeof connect>;

  const userA = randomUUID();
  const userB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const SESSION_IAT = Date.now();
  const cookieA = signSession({ userId: userA, tenantId: tenantA, iat: SESSION_IAT }, SESSION_SECRET);
  const cookieB = signSession({ userId: userB, tenantId: tenantB, iat: SESSION_IAT }, SESSION_SECRET);

  function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.cookie}`;
    return new Request(`http://app-api.local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  function settingsHandler() {
    return createSettingsHandler({ sql, sessionSecret: SESSION_SECRET });
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users (id, email) VALUES
      (${userA}, ${`${userA}@a.test`}), (${userB}, ${`${userB}@b.test`})`;
    await sql`INSERT INTO tenants (id, owner_user_id) VALUES
      (${tenantA}, ${userA}), (${tenantB}, ${userB})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await sql.close();
  });

  // ── (a) defaults on first GET ───────────────────────────────────────────────
  it("GET /settings with no row → 200 with the §5.12 defaults + options catalog", async () => {
    const res = await settingsHandler()(req("GET", "/settings", { cookie: cookieA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown>; options: Record<string, unknown> };
    expect(body.settings).toEqual({
      dictionary_preset: "none",
      keyterms: [],
      language: "multi",
      chime: "blip",
    });
    // The UI needs the choice catalog to render its selects.
    expect(Array.isArray(body.options.chimes)).toBe(true);
    expect(body.options.presets).toContain("postgresfm");
  });

  it("GET /settings with no cookie → 401", async () => {
    const res = await settingsHandler()(req("GET", "/settings"));
    expect(res.status).toBe(401);
  });

  // ── (a) PUT round-trip ──────────────────────────────────────────────────────
  it("PUT then GET round-trips keyterms/language/chime/preset exactly", async () => {
    const put = await settingsHandler()(
      req("PUT", "/settings", {
        cookie: cookieA,
        body: {
          dictionary_preset: "postgresfm",
          keyterms: ["pg_stat_statements", "WAL"],
          language: "es",
          chime: "bell",
        },
      }),
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { settings: Record<string, unknown> };
    expect(putBody.settings).toEqual({
      dictionary_preset: "postgresfm",
      keyterms: ["pg_stat_statements", "WAL"],
      language: "es",
      chime: "bell",
    });

    const get = await settingsHandler()(req("GET", "/settings", { cookie: cookieA }));
    const getBody = (await get.json()) as { settings: Record<string, unknown> };
    expect(getBody.settings).toEqual({
      dictionary_preset: "postgresfm",
      keyterms: ["pg_stat_statements", "WAL"],
      language: "es",
      chime: "bell",
    });
  });

  it("PUT with an invalid language → 400, and the stored row is unchanged", async () => {
    const res = await settingsHandler()(
      req("PUT", "/settings", { cookie: cookieA, body: { language: "klingon" } }),
    );
    expect(res.status).toBe(400);
    // Prior valid value (es) survives the rejected write.
    const get = await settingsHandler()(req("GET", "/settings", { cookie: cookieA }));
    const body = (await get.json()) as { settings: { language: string } };
    expect(body.settings.language).toBe("es");
  });

  // ── (b) tenant isolation — route level ──────────────────────────────────────
  it("tenant B GET sees its OWN defaults, never tenant A's saved row", async () => {
    const res = await settingsHandler()(req("GET", "/settings", { cookie: cookieB }));
    const body = (await res.json()) as { settings: { language: string; keyterms: string[] } };
    // A saved language 'es' + custom keyterms above; B must be untouched defaults.
    expect(body.settings.language).toBe("multi");
    expect(body.settings.keyterms).toEqual([]);
  });

  // ── (b) tenant isolation — RLS data layer (WITH CHECK / USING) ───────────────
  it("RLS: tenant B context cannot SELECT or UPDATE tenant A's settings row", async () => {
    const seen = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE samograph_app");
      await tx`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      const rows = (await tx`SELECT tenant_id FROM settings WHERE tenant_id = ${tenantA}`) as unknown as unknown[];
      const upd = (await tx`
        UPDATE settings SET language = 'ru' WHERE tenant_id = ${tenantA} RETURNING tenant_id`) as unknown as unknown[];
      return { readCount: rows.length, updCount: upd.length };
    });
    expect(seen.readCount).toBe(0); // A's row is invisible under B's tenant context
    expect(seen.updCount).toBe(0); // and unwritable
  });

  it("RLS: tenant B context cannot INSERT a row for tenant A (WITH CHECK)", async () => {
    let threw = false;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE samograph_app");
        await tx`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO settings (tenant_id, language) VALUES (${tenantA}, 'ru')`;
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // ── (c) POST /calls enqueues the tenant's resolved keyterms + language ───────
  it("POST /calls reads the tenant's settings and enqueues keyterms + language", async () => {
    // tenantA already saved: preset postgresfm + [pg_stat_statements, WAL] + es.
    const jobs: OrchestratorJob[] = [];
    const calls = createCallsHandler({
      sql,
      sessionSecret: SESSION_SECRET,
      enqueue: (job) => {
        jobs.push(job);
      },
    });
    const res = await calls(req("POST", "/calls", { cookie: cookieA, body: { meeting_url: MEET_URL } }));
    expect(res.status).toBe(201);
    expect(jobs.length).toBe(1);
    // Deepgram passthrough (§5.12): the enqueued job carries the tenant language
    // and the effective keyterms (preset ∪ user terms), NOT the hardwired default.
    expect(jobs[0]!.language).toBe("es");
    expect(jobs[0]!.keyterms).toContain("pg_stat_statements");
    expect(jobs[0]!.keyterms).toContain("WAL");
    expect(jobs[0]!.keyterms).toContain("Nikolay Samokhvalov"); // from the postgresfm preset
  });

  it("POST /calls for a tenant with NO settings row enqueues the defaults (multi, no terms)", async () => {
    const jobs: OrchestratorJob[] = [];
    const calls = createCallsHandler({
      sql,
      sessionSecret: SESSION_SECRET,
      enqueue: (job) => {
        jobs.push(job);
      },
    });
    const res = await calls(req("POST", "/calls", { cookie: cookieB, body: { meeting_url: MEET_URL } }));
    expect(res.status).toBe(201);
    expect(jobs[0]!.language).toBe("multi");
    expect(jobs[0]!.keyterms).toEqual([]);
  });
});
