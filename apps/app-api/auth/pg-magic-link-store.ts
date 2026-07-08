/**
 * Postgres-backed MagicLinkStore (SPEC §5.1, §5.10, §6.2 #6; issue #62) — the
 * restart/replica-safe replacement for InMemoryMagicLinkStore.
 *
 * The in-memory store enforces single-use with a JS read-modify-write that is
 * atomic ONLY because Node/Bun is single-threaded — it loses every outstanding
 * link on deploy and cannot coordinate across replicas. This store persists
 * links in `magic_links` (migration 0007) and makes `consume` a SINGLE atomic
 * `UPDATE ... WHERE status = 'outstanding' RETURNING *`: the row lock forces a
 * concurrent double-consume to resolve to exactly one `consumed`, the loser
 * seeing the row already `consumed`.
 *
 * Auth runs BEFORE any tenant context exists, so this is a PRIVILEGED path: the
 * `magic_links` table is intentionally NOT granted to the runtime
 * `samograph_app` role and carries no RLS (migration 0007). The injected `SQL`
 * connection is therefore the privileged auth connection.
 */
import type { SQL } from "bun";
import type { MagicLinkRecord, MagicLinkStatus } from "./types.ts";
import { normalizeEmail, type ConsumeResult, type MagicLinkStore } from "./stores.ts";

interface MagicLinkRow {
  jti: string;
  email: string;
  status: MagicLinkStatus;
  kid: string;
  // bigint columns come back as strings under bun:sql — coerce to number.
  iat: string | number | bigint;
  exp: string | number | bigint;
}

function rowToRecord(row: MagicLinkRow): MagicLinkRecord {
  return {
    jti: row.jti,
    email: row.email,
    kid: row.kid,
    issuedAt: Number(row.iat),
    expiresAt: Number(row.exp),
    status: row.status,
  };
}

export class PostgresMagicLinkStore implements MagicLinkStore {
  constructor(private readonly sql: SQL) {}

  /**
   * Persist a freshly issued link, superseding any prior OUTSTANDING link for
   * the same (normalized) email in the SAME transaction, then insert the new
   * one — so supersession and insert commit atomically (SPEC §5.1).
   */
  async issue(record: MagicLinkRecord): Promise<void> {
    const email = normalizeEmail(record.email);
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE magic_links SET status = 'superseded'
        WHERE email = ${email} AND status = 'outstanding'`;
      await tx`
        INSERT INTO magic_links (jti, email, status, kid, iat, exp)
        VALUES (${record.jti}, ${email}, 'outstanding', ${record.kid},
                ${record.issuedAt}, ${record.expiresAt})`;
    });
  }

  /**
   * Atomically consume by `jti`. The single UPDATE only matches an OUTSTANDING
   * row, so a concurrent second caller (blocked on the row lock, then re-reading
   * the committed `consumed` row under READ COMMITTED) matches zero rows and
   * falls through to the re-SELECT — distinguishing replay (already_consumed →
   * SAMO-AUTH-003, no cookie), supersession, and not_found. Same ConsumeResult
   * union as the in-memory store.
   */
  async consume(jti: string): Promise<ConsumeResult> {
    const updated = (await this.sql`
      UPDATE magic_links SET status = 'consumed'
      WHERE jti = ${jti} AND status = 'outstanding'
      RETURNING jti, email, status, kid, iat, exp`) as MagicLinkRow[];
    if (updated.length === 1) {
      return { outcome: "consumed", record: rowToRecord(updated[0]) };
    }

    // Zero rows updated: re-read to explain WHY (replay / superseded / unknown).
    const rows = (await this.sql`
      SELECT jti, email, status, kid, iat, exp FROM magic_links WHERE jti = ${jti}`) as MagicLinkRow[];
    if (rows.length === 0) return { outcome: "not_found" };
    const record = rowToRecord(rows[0]);
    if (record.status === "consumed") return { outcome: "already_consumed", record };
    // Only 'superseded' remains (an 'outstanding' row would have been updated).
    return { outcome: "superseded", record };
  }

  async get(jti: string): Promise<MagicLinkRecord | undefined> {
    const rows = (await this.sql`
      SELECT jti, email, status, kid, iat, exp FROM magic_links WHERE jti = ${jti}`) as MagicLinkRow[];
    return rows.length ? rowToRecord(rows[0]) : undefined;
  }
}
