-- 0009_deleted_calls — per-call GDPR erasure tombstone (SPEC §5.14).
--
-- DELETE /calls/:id erases a single call and ALL of its child data
-- (transcripts, capability/share tokens, its workers row) plus the Recall
-- recording. For audit integrity we retain a minimal TOMBSTONE — the call id,
-- its tenant, who deleted it, and when — so a deletion is provable AFTER the
-- call row itself is gone.
--
-- The tombstone deliberately holds the raw `call_id` with NO foreign key to
-- `calls`: the call row is being erased, but the tombstone must outlive it.
-- It is append-only for the runtime role (no UPDATE/DELETE grant): a tombstone
-- is immutable once written.
--
-- `audit_log` already records the `call_deleted` action, but its own `call_id`
-- column is nulled by the calls→audit_log `ON DELETE SET NULL` FK when the row
-- goes (0001). So the durable per-call record of the erasure is THIS tombstone.

CREATE TABLE deleted_calls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Raw id of the erased call. NO FK to `calls` (the call row is deleted); the
  -- tombstone must survive the delete for audit integrity (§5.14).
  call_id    uuid NOT NULL,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deleted_by text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deleted_calls_tenant_id_idx ON deleted_calls (tenant_id);
CREATE INDEX deleted_calls_call_id_idx ON deleted_calls (call_id);

-- Append-only tombstone: the runtime role may INSERT and (RLS-scoped) SELECT,
-- but never UPDATE/DELETE — the row is immutable once written.
GRANT SELECT, INSERT ON deleted_calls TO samograph_app;

-- RLS: the same tenant-isolation contract as audit_log (§5.10). The scalar
-- sub-SELECT wrapper hoists current_setting into a once-per-statement InitPlan.
ALTER TABLE deleted_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY deleted_calls_tenant_isolation ON deleted_calls FOR ALL TO samograph_app
  USING (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid);
