-- 0010_settings — per-tenant hosted Settings (SPEC §5.12, §5.10).
--
-- One row per tenant holding the §5.12 v1 transcription + sound settings:
--   - dictionary_preset : a shipped preset name ('none' | 'postgresfm') layered
--                         under the tenant's own keyterms at resolve time;
--   - keyterms          : the tenant's user-defined Deepgram keyterms;
--   - language          : a specific Deepgram language code or 'multi' (auto-detect);
--   - chime             : the chat-chime id from the shipped chime library.
-- Defaults MUST mirror packages/shared/settings/index.ts DEFAULT_SETTINGS
-- ('none' / '{}' / 'multi' / 'blip' = DEFAULT_CHIME) so a first GET (which
-- synthesizes defaults without inserting a row) and a first INSERT agree.
--
-- Tenant-scoped like calls/audit_log (§5.10): RLS + FORCE RLS + a single policy
-- TO samograph_app whose predicate wraps current_setting in a scalar sub-SELECT
-- so the planner hoists it into a once-per-statement InitPlan (the 0002 contract).

CREATE TABLE settings (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  dictionary_preset text NOT NULL DEFAULT 'none',
  keyterms          text[] NOT NULL DEFAULT '{}',
  language          text NOT NULL DEFAULT 'multi',
  chime             text NOT NULL DEFAULT 'blip',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_tenant_isolation ON settings FOR ALL TO samograph_app
  USING (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid);

-- Runtime role privileges (RLS above governs WHICH ROWS it sees). Mirrors the
-- 0001 grants for the other tenant-scoped tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON settings TO samograph_app;
