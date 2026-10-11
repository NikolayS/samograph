-- 0001_core_schema — core tables for the samograph.dev data model (SPEC §5.10).
--
-- This migration creates the tables, the call-status enum (§5.2), the
-- application role used at runtime, and its table grants. Row-Level Security is
-- enabled in 0002 so the policies can reference these tables.
--
-- `gen_random_uuid()` is a core function in Postgres 13+ (no extension needed).

-- Runtime application role. The app connects as this NON-superuser, NON-owner
-- role so RLS actually applies to it (superusers and table owners bypass RLS).
-- Created idempotently because roles are cluster-global and outlive a DROP DATABASE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samograph_app') THEN
    CREATE ROLE samograph_app NOLOGIN;
  END IF;
END
$$;

-- Single call-status enum (§5.2). `ingest_degraded` is a SEPARATE boolean
-- overlay, never a status value (see calls.ingest_degraded below).
CREATE TYPE call_status AS ENUM (
  'PENDING',
  'JOINING',
  'IN_CALL',
  'ENDED',
  'COULD_NOT_JOIN',
  'COULD_NOT_RECORD',
  'BOT_REMOVED'
);

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 1:1 with a user in v1 (UNIQUE owner).
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recall_bot_id      text,
  meeting_url        text NOT NULL,
  region             text,
  status             call_status NOT NULL DEFAULT 'PENDING',
  -- Independent boolean overlay (§5.2): can flip while IN_CALL without changing
  -- status, and is reset to false on any terminal transition (trigger in 0002).
  ingest_degraded    boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  first_line_at      timestamptz,
  ingest_secret_hash text
);
CREATE INDEX calls_tenant_id_idx ON calls (tenant_id);

-- Append-only; PK is the (call_id, seq) pair (§5.10).
CREATE TABLE transcripts (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  seq     bigint NOT NULL,
  ts      timestamptz NOT NULL,
  speaker text,
  text    text NOT NULL,
  PRIMARY KEY (call_id, seq)
);

-- Only PERSISTED scopes live here: `share` (v1), `act:*` (v2). `read` is
-- session-derived and NEVER stored (§5.7, §6.2 #2).
CREATE TABLE tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  scopes     text[] NOT NULL,
  kid        text NOT NULL,
  jti        text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX tokens_call_id_idx ON tokens (call_id);

CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id        uuid REFERENCES calls(id) ON DELETE SET NULL,
  actor          text NOT NULL,
  action         text NOT NULL,
  payload_sha256 text,
  ts             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_id_idx ON audit_log (tenant_id);

CREATE TABLE workers (
  call_id            uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  host               text NOT NULL,
  port               integer NOT NULL,
  worker_secret_hash text NOT NULL,
  registered_at      timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz
);

-- Region/leader-election infrastructure (§4.7). Not tenant-scoped: a region id
-- is an operational slug (e.g. 'eu-central'), read by privileged infra paths.
CREATE TABLE regions (
  id                       text PRIMARY KEY,
  tunnel_hostname          text NOT NULL,
  status                   text NOT NULL,
  last_probe_ts            timestamptz,
  leader_id                text,
  leader_lease_expires_at  timestamptz
);

-- Table privileges for the runtime role. RLS (0002) governs WHICH ROWS it sees.
-- `users` and `regions` are deliberately NOT granted here: they are accessed by
-- privileged paths (auth runs before any tenant context exists; regions is
-- infra), so they stay off the tenant-scoped RLS surface (SPEC §5.10).
GRANT USAGE ON SCHEMA public TO samograph_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON tenants, calls, transcripts, tokens, audit_log, workers
  TO samograph_app;
