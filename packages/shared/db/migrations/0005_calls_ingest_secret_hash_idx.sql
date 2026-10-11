-- 0005_calls_ingest_secret_hash_idx — index calls.ingest_secret_hash for the
-- §5.3 `?t=` webhook resolution (real-Recall path, issue #88 / amendment S2-10).
--
-- When Recall registers the realtime webhook at createBot time it does not yet
-- know its assigned bot id, so the URL carries only `?t=<ingest_secret>` (no
-- `?bot=`). Ingest then resolves the owning call by sha256(t) = ingest_secret_hash
-- on the privileged pre-tenant connection (apps/ingest/webhook.ts
-- pgLookupCallByIngestSecret). This index makes that a fast probe instead of a
-- sequential scan of `calls`. Partial (NULL hashes — PENDING calls before the
-- orchestrator sets it — are never resolved this way, so they stay out of the
-- index). Non-unique: some tests set placeholder hashes; a real ingest_secret is
-- 256-bit random so its hash is unique in practice, and the lookup uses LIMIT 1.
CREATE INDEX calls_ingest_secret_hash_idx
  ON calls (ingest_secret_hash)
  WHERE ingest_secret_hash IS NOT NULL;
