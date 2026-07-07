-- §5.9 recording-disclosure idempotency marker (samorev gate, #117).
--
-- The recording-disclosure chat is a NON-idempotent external Recall POST. This
-- durable stamp lets the status poller send it AT MOST once per call and retry
-- only while unsent, instead of re-posting it on every 10 s sweep whenever a
-- post-send step (audit insert / commit) rolls back the status-flip transaction.
-- NULL = not yet disclosed; set once the chat has been posted.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS disclosure_posted_at timestamptz;
