-- 0008_transcripts_kind — mark whether a transcript line is spoken audio or a
-- typed meeting-chat message (#195 / #188).
--
-- `kind` distinguishes a Recall `transcript.data` utterance (kind='speech')
-- from an incoming `participant_events.chat_message` (kind='chat'). The render
-- layer adds the ` (chat)` marker after the speaker for a chat line; on disk the
-- distinction is carried solely by this column.
--
-- BACKWARD-COMPATIBLE: NOT NULL DEFAULT 'speech', so every pre-existing row — and
-- every speech line that never sets it — is 'speech'. The CHECK keeps the domain
-- to the two known kinds. No index: every transcripts read is by (call_id, seq)
-- (backfill / replay / re-hydrate), never filtered on `kind`, so an index would
-- only add write cost.
ALTER TABLE transcripts
  ADD COLUMN kind text NOT NULL DEFAULT 'speech'
    CHECK (kind IN ('speech', 'chat'));
