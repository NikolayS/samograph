-- LOCK PROFILE: migrate.ts runs this entire file in one transaction and has no
-- non-transactional mode, so the unique index cannot use CONCURRENTLY. Its
-- regular build blocks writes to calls while it runs. The pairing CHECK is
-- installed NOT VALID and then validated to minimize the initial lock, though
-- validation still occurs in this transaction. This is acceptable while calls
-- is small in production; revisit with an online migration before it grows.
--
-- Calendar auto-join provenance. Manual creation remains the default so all
-- existing callers and rows retain their current semantics.
ALTER TABLE calls
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'calendar')),
  ADD COLUMN source_event_id text;

ALTER TABLE calls
  ADD CONSTRAINT calls_source_event_pairing_check
  CHECK (
    (source = 'manual' AND source_event_id IS NULL)
    OR (source = 'calendar' AND source_event_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE calls VALIDATE CONSTRAINT calls_source_event_pairing_check;

-- A provider event may create at most one call per tenant/source. NULL manual
-- identities remain unrestricted.
CREATE UNIQUE INDEX calls_tenant_source_event_unique_idx
  ON calls (tenant_id, source, source_event_id)
  WHERE source_event_id IS NOT NULL;
