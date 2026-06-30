-- 0004_calls_status_reason — persist the Recall failure reason on a terminal call.
--
-- When Recall reports `fatal` before join, the call goes terminal `COULD_NOT_JOIN`
-- (`SAMO-CALL-JOIN`, §5.16) and the dashboard surfaces "Couldn't join — <Recall
-- reason>." (§5.2, §5.16). That human reason is Recall's `status.sub_code`
-- (e.g. `meeting_not_found`); there was nowhere to keep it. This adds a single
-- nullable column on `calls`; the bot-lifecycle handler (§5.2, issue #79) writes
-- it on the `fatal → COULD_NOT_JOIN` transition. It is NOT a status driver and is
-- read only for the terminal-failure copy (the enum stays exactly the §5.2 set).
ALTER TABLE calls ADD COLUMN status_reason text;
