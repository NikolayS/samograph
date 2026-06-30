-- 0003_webhook_events — webhook idempotency ledger (SPEC §5.3, §6.2 #7).
--
-- Recall delivers webhooks AT LEAST once; ingest must dispatch each event AT
-- MOST once. This ledger records every accepted `(bot_id, recall_event_id)`;
-- the front door INSERTs ... ON CONFLICT DO NOTHING and only dispatches when a
-- row was newly inserted, so a re-delivery returns 200 without re-dispatching.
--
-- `bot_id` is the Recall bot id (text, matching calls.recall_bot_id), NOT a
-- uuid — it is the validated `?bot=` value the front door authenticated.

CREATE TABLE webhook_events (
  bot_id          text NOT NULL,
  recall_event_id text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, recall_event_id)
);

-- The runtime role inserts (and reads, for the dedup) under tenant scope.
GRANT SELECT, INSERT ON webhook_events TO samograph_app;

-- RLS via the call's tenant: there is no tenant_id column, so we join calls on
-- recall_bot_id and apply the MANDATORY InitPlan wrapper (§5.10) — a bare
-- current_setting(...) here would re-evaluate per row and defeat index usage.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_tenant_isolation ON webhook_events FOR ALL TO samograph_app
  USING (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.recall_bot_id = webhook_events.bot_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calls c
    WHERE c.recall_bot_id = webhook_events.bot_id
      AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));
