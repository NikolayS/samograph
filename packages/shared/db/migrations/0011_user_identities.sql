-- 0011_user_identities — external sign-in identities keyed on the provider's
-- immutable subject (SPEC §5.1; issue #209).
--
-- The OAuth callback resolves WHO is signing in BEFORE any tenant context
-- exists, so this table is PRIVILEGED exactly like `users` (0001) and
-- `magic_links` (0007): it is deliberately NOT granted to the runtime
-- `samograph_app` role and carries NO Row-Level Security. Auth reaches it only
-- over the privileged BYPASSRLS login connection — the same pre-tenant seam
-- PostgresUserStore already uses. Do NOT add it to the §5.10 tenant-scoped RLS
-- surface, and do NOT grant it to samograph_app.
--
-- WHY (provider, provider_subject) AND NOT users.email: an email is mutable and
-- provider-controlled. Keying identity on it breaks four ways — a Google-side
-- email change silently locks a user out of her own tenant; a REASSIGNED
-- corporate address walks its new holder into the previous holder's tenant on a
-- legitimately email_verified token; one address held as two distinct subjects
-- (consumer + Workspace) collapses into one account with no record; and the
-- rename can collide with a UNIQUE row that already belongs to someone else.
-- The provider's `sub` is opaque, stable and never reassigned, so a known
-- subject never consults email at all.
--
-- WHY `provider` IS A CHECK AND NOT A PG ENUM: `ALTER TYPE ... ADD VALUE` cannot
-- run inside a transaction, and migrate.ts wraps every migration file in one — a
-- future 'github' value would break the runner. Same call `transcripts.kind`
-- made in 0008. (`magic_link_status` in 0007 is an enum only because its domain
-- is closed by the protocol and will never grow.)

CREATE TABLE user_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cascade so a hard user delete cannot orphan a subject. NOTE: the §5.14
  -- account erasure writes a tombstone and deliberately does NOT delete the
  -- `users` row, so this cascade never fires there — the erasure path deletes
  -- these rows EXPLICITLY on the privileged connection (apps/app-api/account).
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google')),
  -- The provider's opaque, immutable subject identifier (Google's `sub`).
  provider_subject text NOT NULL,
  -- The address the provider asserted, kept for audit/display only. It is NEVER
  -- the identity key, and it never rewrites `users.email` (immutable after
  -- creation), so a provider-side rename is a no-op rather than a lockout.
  email            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  -- One account per (provider, subject). The upsert that backs the callback is
  -- `ON CONFLICT (provider, provider_subject) DO UPDATE SET email, last_login_at`
  -- and deliberately never touches `user_id`, so two concurrent callbacks
  -- converge on ONE row still owned by the ORIGINAL user.
  UNIQUE (provider, provider_subject)
);

-- Deliberately NO `UNIQUE (user_id, provider)`: a second, also-verified Google
-- account on one user is a normal outcome (Google's own conflicting-accounts
-- state), and failing that sign-in with a constraint violation is worse than
-- carrying two rows.
--
-- Deliberately NO separate index on (provider, provider_subject) either — the
-- UNIQUE constraint's index already serves the callback's only hot lookup. This
-- index serves the reverse direction: "which identities does this user hold"
-- (the §5.14 erasure delete and the Settings read).
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

-- NOTE: intentionally NO `GRANT ... TO samograph_app` and NO
-- `ENABLE ROW LEVEL SECURITY` — privileged pre-tenant table (see header).
