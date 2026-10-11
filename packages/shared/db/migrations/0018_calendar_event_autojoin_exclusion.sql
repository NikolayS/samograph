-- 0018_calendar_event_autojoin_exclusion — durable per-provider-event skips.
--
-- Exclusions live outside the reconciled event cache so a snapshot deletion and
-- later recreation cannot silently discard a user's choice.

CREATE TABLE calendar_event_exclusions (
  connection_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, provider_event_id),
  CONSTRAINT calendar_event_exclusions_connection_fk FOREIGN KEY (connection_id, tenant_id) REFERENCES calendar_connections(id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE calendar_event_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_exclusions FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_event_exclusions_tenant_isolation ON calendar_event_exclusions FOR ALL TO samograph_app
  USING (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id'))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_event_exclusions TO samograph_app;
