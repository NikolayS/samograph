-- 0014_calendar_connections — encrypted Google Calendar credentials owned by
-- the consenting user (SPEC amendment S5-3; issue #240).
--
-- Calendar consent happens after authentication, but credential access occurs
-- outside tenant-scoped request paths. This table is therefore PRIVILEGED like
-- `user_identities` (0011): deliberately NOT granted to the runtime
-- `samograph_app` role and carrying NO Row-Level Security. Calendar services
-- reach it only over the privileged BYPASSRLS infrastructure connection.
--
-- WHY `provider` IS A CHECK AND NOT A PG ENUM: migrate.ts wraps every migration
-- in a transaction, so future provider expansion must not require
-- `ALTER TYPE ... ADD VALUE`.

-- Calendar connections belong to the consenting tenant owner. The composite
-- key lets the connection FK enforce that user_id owns tenant_id, rather than
-- merely checking that each value exists independently.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_id_owner_user_id_key UNIQUE (id, owner_user_id);

CREATE TABLE calendar_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id               uuid NOT NULL,
  provider                text NOT NULL DEFAULT 'google'
                          CHECK (provider IN ('google')),
  provider_account_id     text,
  encrypted_refresh_token bytea NOT NULL,
  refresh_token_iv        bytea NOT NULL
                          CHECK (octet_length(refresh_token_iv) = 12),
  refresh_token_tag       bytea NOT NULL
                          CHECK (octet_length(refresh_token_tag) = 16),
  encryption_key_version  integer NOT NULL CHECK (encryption_key_version > 0),
  granted_scopes          text[] NOT NULL,
  status                  text NOT NULL DEFAULT 'connected'
                          CHECK (status IN ('connected', 'broken')),
  broken_reason           text
                          CHECK (
                            (status = 'connected' AND broken_reason IS NULL)
                            OR (
                              status = 'broken'
                              AND broken_reason IS NOT NULL
                              AND broken_reason IN (
                                'invalid_grant',
                                'revoked',
                                'scope_missing',
                                'refresh_failed'
                              )
                            )
                          ),
  connected_at            timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  last_sync_at            timestamptz,
  last_sync_error_at      timestamptz,
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenants (id, owner_user_id) ON DELETE CASCADE,
  UNIQUE (user_id, provider),
  UNIQUE (id, tenant_id)
);

CREATE INDEX calendar_connections_tenant_id_idx
  ON calendar_connections (tenant_id);

-- Privileged pre-tenant credential table:
-- intentionally no GRANT to samograph_app and no RLS policy.
