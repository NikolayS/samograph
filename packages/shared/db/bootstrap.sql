-- bootstrap.sql — SUPERUSER-run, idempotent, PER-ENV DB role wiring (#186, §5.10).
--
-- This is NOT a migration and MUST NOT go through `migrate.ts`: the migrate path
-- connects as the NON-superuser app LOGIN role, which cannot `ALTER ROLE ...
-- BYPASSRLS` or self-grant membership. The login-role NAME is env-specific (e.g.
-- `samo` in prod, the `samograph` superuser in CI), so it is parameterized.
--
-- DEPLOY ORDER (per env, every fresh DB / DBLab preview clone):
--     1. run THIS as a SUPERUSER, once, e.g.:
--          psql -v app_login_role=samo -f packages/shared/db/bootstrap.sql
--        (or programmatically via `bootstrap.ts`), THEN
--     2. run `migrate.ts` as the app login role.
--
-- What this wires (the two grants whose absence broke prod sign-in twice, #180):
--   * `samograph_app` NOLOGIN NOBYPASSRLS — the runtime role RLS is written for.
--     Kept NOBYPASSRLS so tenant isolation is real even if it is ever mis-wired.
--   * `GRANT samograph_app TO <login>` — so tenant routes' `SET LOCAL ROLE
--     samograph_app` (apps/app-api/calls/http.ts) don't throw 42501.
--   * `ALTER ROLE <login> BYPASSRLS` — so the pre-tenant magic-link auth
--     `INSERT INTO tenants` (PostgresUserStore) passes FORCE RLS before any
--     `app.tenant_id` exists.
--
-- Idempotent: safe to re-run on every deploy (guarded CREATE ROLE; ALTER/GRANT
-- are naturally repeatable).

-- The runtime application role. Cluster-global, so guard the CREATE (it outlives
-- DROP DATABASE and is shared across per-env preview DBs on one cluster).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samograph_app') THEN
    CREATE ROLE samograph_app NOLOGIN;
  END IF;
END
$$;

-- Pin the isolation invariant: the runtime role must NEVER bypass RLS.
ALTER ROLE samograph_app NOBYPASSRLS;

-- Let the app login role escalate to samograph_app (`SET ROLE`) — closes the
-- 42501 "permission denied to set role" prod incident.
GRANT samograph_app TO :"app_login_role";

-- Let the app login role bypass RLS for the PRE-TENANT auth INSERT INTO tenants,
-- which runs before any app.tenant_id is set (FORCE RLS would otherwise block it).
ALTER ROLE :"app_login_role" WITH BYPASSRLS;
