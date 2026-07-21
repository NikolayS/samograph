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
import type { SQL } from "bun";

const HAVE_DB = !!process.env.DATABASE_URL;
const d = HAVE_DB ? describe : describe.skip;

/** Seed one signup and return its user id. */
async function seedUser(sql: SQL, email: string): Promise<string> {
  const users = await sql`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
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

    // u2: signup + consumed magic link                       → magic_link_clicked (1)
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
      magic_link_clicked: 6,
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
      emailSender: { async sendMagicLink() {}, async sendAccountDeletion() {} },
      webOrigin: "http://localhost:3000",
      enqueue: () => {},
      registry,
      funnel: source.thunk,
    });

    const res = await api.fetch(new Request("http://app.local/metrics"));
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('samograph_funnel_stage{stage="signup"} 7');
    expect(body).toContain('samograph_funnel_stage{stage="magic_link_clicked"} 6');
    expect(body).toContain('samograph_funnel_stage{stage="call_created"} 5');
    expect(body).toContain('samograph_funnel_stage{stage="first_line"} 4');
    expect(body).toContain('samograph_funnel_stage{stage="streamed_30s"} 3');
    expect(body).toContain("samograph_funnel_total 7");
    expect(body).toContain("samograph_funnel_activated 3");
  });
});
