/**
 * `createAppApi` functional equivalence — auth + calls happy path, DB-backed
 * (issues #105 + #64; SPEC §5.1, §5.2). Runs against the ephemeral Postgres
 * with the REAL migrations + RLS, and skips cleanly when DATABASE_URL is unset.
 *
 * Proves the composed factory still routes the WHOLE happy path end to end:
 * magic-link request → callback (real user+tenant creation, session cookie that
 * RETAINS Secure in the prod composition) → POST /calls (PENDING row + enqueue).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../packages/shared/db/client.ts";
import { migrate } from "../../packages/shared/db/migrate.ts";
import { createAppApi } from "./app.ts";
import { InMemoryEmailSender, SESSION_COOKIE_NAME } from "./auth/index.ts";
import type { OrchestratorJob } from "../bot-orchestrator/index.ts";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

const SESSION_SECRET = "app-func-session-secret-cccccccccccccccccccc";
const MEET_URL = "https://meet.google.com/abc-defg-hij";

d("createAppApi — functional equivalence (auth + calls happy path)", () => {
  let sql: ReturnType<typeof connect>;
  const email = `func-${randomUUID()}@test.local`;
  const jobs: OrchestratorJob[] = [];
  const emailSender = new InMemoryEmailSender();
  let api: { fetch: (req: Request) => Promise<Response> };

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    api = createAppApi({
      sql,
      sessionSecret: SESSION_SECRET,
      magicLinkKid: "func-kid",
      magicLinkSecret: "func-magic-secret",
      tokenKeyring: { current: { kid: "func-share", secret: "func-token-secret" } },
      emailSender,
      webOrigin: "http://web.test",
      enqueue: (job) => {
        jobs.push(job);
      },
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE email = ${email.toLowerCase()}`;
    await sql.close();
  });

  it("magic-link request → callback (Secure session) → POST /calls PENDING + enqueue", async () => {
    // 1. request a magic link → 200, link captured by the in-memory sender.
    const reqRes = await api.fetch(
      new Request("http://api.test/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    expect(reqRes.status).toBe(200);
    const sent = emailSender.lastFor(email.toLowerCase());
    expect(sent).toBeDefined();
    const token = sent!.token;
    expect(typeof token).toBe("string");

    // 2. callback → 200 + Set-Cookie that RETAINS Secure (prod composition).
    const cbRes = await api.fetch(
      new Request(`http://api.test/auth/callback?token=${encodeURIComponent(token)}`),
    );
    expect(cbRes.status).toBe(200);
    const setCookie = cbRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Secure");
    const m = setCookie!.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    expect(m).not.toBeNull();
    const cookieVal = m![1];

    // 3. POST /calls with the session cookie → 201 PENDING + exactly one enqueue.
    const callRes = await api.fetch(
      new Request("http://api.test/calls", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${cookieVal}`,
        },
        body: JSON.stringify({ meeting_url: MEET_URL }),
      }),
    );
    expect(callRes.status).toBe(201);
    const body = (await callRes.json()) as { id: string; status: string };
    expect(body.status).toBe("PENDING");
    expect(typeof body.id).toBe("string");
    expect(jobs.length).toBe(1);
    expect(jobs[0].callId).toBe(body.id);
    expect(jobs[0].meetingUrl).toBe(MEET_URL);
  });
});
