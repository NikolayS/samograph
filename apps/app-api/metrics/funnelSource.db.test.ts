/**
 * DB-backed activation-funnel feed (SPEC §5.11 + §9; issue #16). Runs against
 * the ephemeral Postgres with the REAL migrations and skips cleanly when
 * DATABASE_URL is unset.
 *
 * Asserts EXACT cumulative stage counts (not mere existence) for a hand-seeded
 * scenario that places seven signups at seven distinct furthest stages, and that
 * the composed app-api renders those exact funnel lines at GET /metrics.
 *
 * The funnel is a GLOBAL aggregate (no tenant filter — it is the product-wide
 * success metric), so this test owns a clean slate: it TRUNCATEs the activation
 * tables before seeding. bun runs test files serially, so this never races a
 * sibling file's rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import {
  computeFunnelSnapshot,
  createCachedFunnelSource,
} from "./funnelSource.ts";
import { createAppApi } from "../app.ts";
import { MetricsRegistry } from "../../../packages/shared/observe/index.ts";
import type { SignupMethod } from "../../../packages/shared/observe/funnel.ts";
import type { SQL } from "bun";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

/** Seed one signup (with its §5.11 signup method) and return its user id. */
async function seedUser(
  sql: SQL,
  email: string,
  signupMethod: SignupMethod = "magic_link",
): Promise<string> {
  const users = await sql`
    INSERT INTO users (email, signup_method) VALUES (${email}, ${signupMethod}) RETURNING id`;
  const userId = users[0].id as string;
  await sql`INSERT INTO tenants (owner_user_id) VALUES (${userId})`;
  return userId;
}

/** Mark this email's magic link as clicked (consumed). */
async function seedConsumedLink(sql: SQL, email: string): Promise<void> {
  await sql`
    INSERT INTO magic_links (jti, email, status, kid, iat, exp)
    VALUES (${`jti-${email}`}, ${email}, 'consumed', 'test-kid', 0, 0)`;
}

/** Create a call for a user's tenant; optionally stamp first_line_at. */
async function seedCall(
  sql: SQL,
  userId: string,
  opts: { firstLine?: boolean } = {},
): Promise<string> {
  const t = await sql`SELECT id FROM tenants WHERE owner_user_id = ${userId}`;
  const tenantId = t[0].id as string;
  const firstLineAt = opts.firstLine ? sql`now()` : null;
  const calls = await sql`
    INSERT INTO calls (tenant_id, meeting_url, status, first_line_at)
    VALUES (${tenantId}, ${"https://meet.google.com/aaa-bbbb-ccc"}, 'IN_CALL', ${firstLineAt})
    RETURNING id`;
  return calls[0].id as string;
}

/** Append `count` transcript lines spanning `spanSeconds` wall-clock. */
async function seedTranscriptSpan(
  sql: SQL,
  callId: string,
  spanSeconds: number,
): Promise<void> {
  await sql`
    INSERT INTO transcripts (call_id, seq, ts, text)
    VALUES (${callId}, 1, now(), 'first'),
           (${callId}, 2, now() + (${spanSeconds} * interval '1 second'), 'last')`;
}

d("activation-funnel DB feed — exact stage counts (§5.11 / §9)", () => {
  let sql: ReturnType<typeof connect>;

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    // Clean slate for a global aggregate. CASCADE from users clears
    // tenants/calls/transcripts; magic_links is email-keyed (no FK) so clear it too.
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;

    // u1: signup only (no consumed link, no call)            → furthest = signup (0)
    await seedUser(sql, "u1@test.local");

    // u2: signup + consumed magic link                       → auth_completed (1)
    await seedUser(sql, "u2@test.local");
    await seedConsumedLink(sql, "u2@test.local");

    // u3: + a call, no first line                            → call_created (2)
    const u3 = await seedUser(sql, "u3@test.local");
    await seedConsumedLink(sql, "u3@test.local");
    await seedCall(sql, u3);

    // u4: + first_line stamped, transcript span < 30 s       → first_line (3)
    const u4 = await seedUser(sql, "u4@test.local");
    await seedConsumedLink(sql, "u4@test.local");
    const c4 = await seedCall(sql, u4, { firstLine: true });
    await seedTranscriptSpan(sql, c4, 5);

    // u5, u6: fully activated — transcript spans >= 30 s      → streamed_30s (4)
    for (const email of ["u5@test.local", "u6@test.local"]) {
      const u = await seedUser(sql, email);
      await seedConsumedLink(sql, email);
      const c = await seedCall(sql, u, { firstLine: true });
      await seedTranscriptSpan(sql, c, 31);
    }

    // u7: silent-call edge — 30 s span but first_line_at NULL → streamed_30s (4),
    //     and cumulatively counted at first_line despite the NULL stamp.
    const u7 = await seedUser(sql, "u7@test.local");
    await seedConsumedLink(sql, "u7@test.local");
    const c7 = await seedCall(sql, u7, { firstLine: false });
    await seedTranscriptSpan(sql, c7, 31);
  });

  afterAll(async () => {
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;
    await sql.close();
  });

  it("computes EXACT cumulative stage counts + W1 fraction", async () => {
    const snap = await computeFunnelSnapshot(sql);
    expect(snap.stageCounts).toEqual({
      signup: 7,
      auth_completed: 6,
      call_created: 5,
      first_line: 4, // includes u7 (streamed_30s) despite NULL first_line_at
      streamed_30s: 3, // u5, u6, u7
    });
    expect(snap.total).toBe(7);
    expect(snap.activated).toBe(3);
    expect(snap.w1Fraction).toBeCloseTo(3 / 7, 12);
  });

  it("exposes the funnel stage lines at GET /metrics", async () => {
    const source = createCachedFunnelSource(sql);
    await source.refresh(); // populate the cache from the seeded DB
    const registry = new MetricsRegistry();
    const api = createAppApi({
      sql,
      sessionSecret: "s".repeat(32),
      magicLinkKid: "k",
      magicLinkSecret: "m".repeat(32),
      tokenKeyring: { current: { kid: "t", secret: "t".repeat(32) } },
      emailSender: {
        async sendMagicLink() {},
        async sendAccountDeletion() {},
        async sendIdentityLinked() {},
      },
      webOrigin: "http://localhost:3000",
      enqueue: () => {},
      registry,
      funnel: source.thunk,
    });

    const res = await api.fetch(new Request("http://app.local/metrics"));
    expect(res.status).toBe(200);
    const body = await res.text();

    // Every seeded user signed up by magic link, so the whole funnel lands on
    // the `magic_link` series and the `google` series is an explicit zero.
    expect(body).toContain('samograph_funnel_stage{stage="signup",method="magic_link"} 7');
    expect(body).toContain('samograph_funnel_stage{stage="auth_completed",method="magic_link"} 6');
    expect(body).toContain('samograph_funnel_stage{stage="call_created",method="magic_link"} 5');
    expect(body).toContain('samograph_funnel_stage{stage="first_line",method="magic_link"} 4');
    expect(body).toContain('samograph_funnel_stage{stage="streamed_30s",method="magic_link"} 3');
    expect(body).toContain('samograph_funnel_stage{stage="signup",method="google"} 0');
    expect(body).toContain("samograph_funnel_total 7");
    expect(body).toContain("samograph_funnel_activated 3");
  });
});

/**
 * S5-1 item 7 / issue #222 — the imputation bug, end to end against Postgres.
 *
 * On `main` this whole population was invisible to the funnel's stage 2, which
 * was derived from a consumed `magic_links` row and nothing else: a Google
 * signup never produces one, so every Google user who reached `call_created`
 * had `magic_link_clicked` IMPUTED by the cumulative back-fill.
 *
 * The seeded set is deliberately three populations, not one, because a fix that
 * simply added one to stage 2 everywhere would satisfy a single-user test:
 *   g1 — Google identity + a call        → auth_completed AND call_created
 *   g2 — Google identity, NO call        → auth_completed, NOT call_created
 *   x1 — NEITHER a consumed link nor an identity (the #180 provision-before-
 *        consume state) → signup ONLY, so auth_completed < signup and a blanket
 *        +1 is ruled out.
 */
d("activation funnel — Google signups are not magic-link clicks (#222)", () => {
  let sql: ReturnType<typeof connect>;

  /** Attach a Google identity to a user (no magic_links row anywhere). */
  async function seedIdentity(s: SQL, userId: string, subject: string): Promise<void> {
    await s`
      INSERT INTO user_identities (user_id, provider, provider_subject, email)
      VALUES (${userId}, 'google', ${subject}, NULL)`;
  }

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;

    const g1 = await seedUser(sql, "g1@test.local", "google");
    await seedIdentity(sql, g1, "google-sub-1");
    await seedCall(sql, g1);

    const g2 = await seedUser(sql, "g2@test.local", "google");
    await seedIdentity(sql, g2, "google-sub-2");

    // x1: a `users` row with NO consumed link and NO identity — auth never
    // completed (the retryable SAMO-AUTH-500 state, issue #180).
    await seedUser(sql, "x1@test.local", "magic_link");
  });

  afterAll(async () => {
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;
    await sql.close();
  });

  it("counts a Google signup at auth_completed from its identity row, not a link", async () => {
    const snap = await computeFunnelSnapshot(sql);
    expect(snap.stageCounts).toEqual({
      signup: 3,
      auth_completed: 2, // g1 + g2 — NOT x1, so this is not a blanket +1
      call_created: 1, // g1 only — g2 is not dragged forward
      first_line: 0,
      streamed_30s: 0,
    });
    // Zero magic links exist at all: the old derivation would score stage 2 = 0
    // and then impute g1's from the back-fill.
    const links = await sql`SELECT count(*)::int AS c FROM magic_links`;
    expect(links[0].c).toBe(0);
  });

  it("splits every stage by users.signup_method", async () => {
    const snap = await computeFunnelSnapshot(sql);
    expect(snap.byMethod.google.stageCounts).toEqual({
      signup: 2,
      auth_completed: 2,
      call_created: 1,
      first_line: 0,
      streamed_30s: 0,
    });
    expect(snap.byMethod.magic_link.stageCounts).toEqual({
      signup: 1,
      auth_completed: 0,
      call_created: 0,
      first_line: 0,
      streamed_30s: 0,
    });
    expect(snap.byMethod.google.total).toBe(2);
    expect(snap.byMethod.magic_link.total).toBe(1);
  });
});

/**
 * The `method`-labelled scrape and `samograph_magic_link_status`, both read from
 * a real database through the composed app (S5-1 item 7 / #222).
 */
d("/metrics — per-method funnel + magic-link status from Postgres (#222)", () => {
  let sql: ReturnType<typeof connect>;
  let body = "";

  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;

    // One magic-link user and one Google user, both at call_created.
    const m1 = await seedUser(sql, "m1@test.local", "magic_link");
    await seedConsumedLink(sql, "m1@test.local");
    await seedCall(sql, m1);

    const g1 = await seedUser(sql, "g1@test.local", "google");
    await sql`
      INSERT INTO user_identities (user_id, provider, provider_subject, email)
      VALUES (${g1}, 'google', 'google-sub-metrics', NULL)`;
    await seedCall(sql, g1);

    // Magic-link lifecycle fixture: 2 outstanding, 1 consumed (m1's), 3 superseded.
    for (const [n, status] of [
      ["o1", "outstanding"],
      ["o2", "outstanding"],
      ["s1", "superseded"],
      ["s2", "superseded"],
      ["s3", "superseded"],
    ] as const) {
      await sql`
        INSERT INTO magic_links (jti, email, status, kid, iat, exp)
        VALUES (${`jti-${n}`}, ${`${n}@test.local`}, ${status}, 'test-kid', 0, 0)`;
    }

    const registry = new MetricsRegistry();
    const source = createCachedFunnelSource(sql, { registry });
    await source.refresh();
    const api = createAppApi({
      sql,
      sessionSecret: "s".repeat(32),
      magicLinkKid: "k",
      magicLinkSecret: "m".repeat(32),
      tokenKeyring: { current: { kid: "t", secret: "t".repeat(32) } },
      emailSender: {
        async sendMagicLink() {},
        async sendAccountDeletion() {},
        async sendIdentityLinked() {},
      },
      webOrigin: "http://localhost:3000",
      enqueue: () => {},
      registry,
      funnel: source.thunk,
    });
    const res = await api.fetch(new Request("http://app.local/metrics"));
    expect(res.status).toBe(200);
    body = await res.text();
  });

  afterAll(async () => {
    await sql`TRUNCATE users, magic_links RESTART IDENTITY CASCADE`;
    await sql.close();
  });

  it("emits samograph_funnel_stage split by method, and no unlabelled series", () => {
    expect(body).toContain('samograph_funnel_stage{stage="auth_completed",method="magic_link"} 1');
    expect(body).toContain('samograph_funnel_stage{stage="auth_completed",method="google"} 1');
    expect(body).toContain('samograph_funnel_stage{stage="call_created",method="google"} 1');
    expect(body).not.toContain('samograph_funnel_stage{stage="auth_completed"}');
  });

  it("emits one samograph_magic_link_status series per MagicLinkStatus, exactly", () => {
    expect(body).toContain('samograph_magic_link_status{status="outstanding"} 2');
    expect(body).toContain('samograph_magic_link_status{status="consumed"} 1');
    expect(body).toContain('samograph_magic_link_status{status="superseded"} 3');
  });
});
