-- 0002_rls_and_invariants — Row-Level Security + data-layer invariants (§5.10, §5.2).
--
-- Every tenant-scoped table is locked down so the runtime `samograph_app` role
-- only ever sees rows for the tenant in `app.tenant_id`. FORCE makes RLS apply
-- even to a table owner (superusers still bypass — that is how fixtures are
-- seeded in tests). The tenant context is set transaction-locally by the
-- tenancy gate via `set_config('app.tenant_id', $1, true)` (§5.6 / #41).
--
-- CRITICAL CONTRACT (§5.10): every policy predicate MUST wrap current_setting in
-- a scalar sub-SELECT — `tenant_id = (SELECT current_setting('app.tenant_id'))::uuid`
-- — so the planner hoists it into a once-per-statement InitPlan instead of
-- re-evaluating it per row (which also defeats index usage). A bare
-- `current_setting(...)` here would be a correctness-adjacent performance bug.

-- tenants: a tenant sees only its own row (its id IS the tenant id).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON tenants FOR ALL TO samograph_app
  USING (id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (id = (SELECT current_setting('app.tenant_id'))::uuid);

-- calls: filtered directly on tenant_id.
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
CREATE POLICY calls_tenant_isolation ON calls FOR ALL TO samograph_app
  USING (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid);

-- audit_log: filtered directly on tenant_id.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log FOR ALL TO samograph_app
  USING (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid);

-- transcripts: no tenant_id column — filtered via its call's tenant_id (§5.10).
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY transcripts_tenant_isolation ON transcripts FOR ALL TO samograph_app
  USING (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = transcripts.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = transcripts.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));

-- tokens: filtered via its call's tenant_id.
ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tokens_tenant_isolation ON tokens FOR ALL TO samograph_app
  USING (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = tokens.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = tokens.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));

-- workers: PK is call_id — filtered via its call's tenant_id (§5.10).
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers FORCE ROW LEVEL SECURITY;
CREATE POLICY workers_tenant_isolation ON workers FOR ALL TO samograph_app
  USING (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = workers.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.id = workers.call_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));

-- Invariant (§5.2): ingest_degraded is reset to false on any TERMINAL status
-- transition. It is an overlay that can flip while IN_CALL; once the call
-- reaches a terminal state the overlay is meaningless and must be cleared.
CREATE OR REPLACE FUNCTION reset_ingest_degraded_on_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('ENDED', 'COULD_NOT_JOIN', 'COULD_NOT_RECORD', 'BOT_REMOVED') THEN
    NEW.ingest_degraded := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_calls_reset_ingest_degraded
  BEFORE UPDATE OF status ON calls
  FOR EACH ROW
  EXECUTE FUNCTION reset_ingest_degraded_on_terminal();
