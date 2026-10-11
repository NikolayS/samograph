-- 0007_magic_links — restart/replica-safe store for outstanding magic links
-- (SPEC §5.1, §5.10; issue #62).
--
-- The magic-link callback runs BEFORE any tenant context exists, so this table
-- is PRIVILEGED exactly like `users`/`tenants`: it is deliberately NOT granted
-- to the runtime `samograph_app` role and carries NO Row-Level Security. Auth
-- reaches it only over the privileged (migration/superuser) connection — the
-- same pre-tenant seam PostgresUserStore uses. Do NOT add it to the §5.10
-- tenant-scoped RLS surface, and do NOT grant it to samograph_app.
--
-- Single-use + supersession are enforced by the DDL + a single atomic
-- `UPDATE ... WHERE status = 'outstanding' RETURNING *` in
-- PostgresMagicLinkStore.consume: the row lock makes a concurrent double-consume
-- resolve to exactly one 'consumed' (the replica-safe property the in-memory
-- JS read-modify-write cannot provide).

-- Lifecycle of one issued link. Mirrors the MagicLinkStatus union in auth/types.ts.
CREATE TYPE magic_link_status AS ENUM (
  'outstanding', -- freshly issued, not yet used
  'consumed',    -- used exactly once (first valid callback)
  'superseded'   -- invalidated by a newer link for the same email
);

CREATE TABLE magic_links (
  jti        text PRIMARY KEY,
  email      text NOT NULL,
  status     magic_link_status NOT NULL DEFAULT 'outstanding',
  kid        text NOT NULL,
  -- Token iat/exp as epoch-ms (parity with the HMAC claims + MagicLinkRecord).
  iat        bigint NOT NULL,
  exp        bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The supersede step updates the prior OUTSTANDING link for an email at issue
-- time; a partial index keeps that lookup cheap and matches the WHERE exactly.
CREATE INDEX magic_links_email_outstanding_idx
  ON magic_links (email)
  WHERE status = 'outstanding';

-- NOTE: intentionally NO `GRANT ... TO samograph_app` and NO
-- `ENABLE ROW LEVEL SECURITY` — privileged pre-tenant table (see header).
