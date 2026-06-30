# Runbook: could not record (`COULD_NOT_RECORD` / `SAMO-CALL-NOREC`)

**Symptom.** A call reaches terminal status `COULD_NOT_RECORD`. The dashboard
shows *"Couldn't start recording — check meeting permissions."* The API surfaces
`SAMO-CALL-NOREC`.

**Meaning.** The bot *did* join, but Recall reported the lifecycle event
`in_call_not_recording` instead of `in_call_recording` (§5.2, §5.9). Recording is
required for the product to function, so:

- the bot **does NOT post the recording-disclosure chat message** — claiming "is
  recording" when it is not would be factually wrong and harmful (§5.9);
- the bot **leaves the call cleanly**;
- the call transitions to terminal `COULD_NOT_RECORD`.

This is distinct from `COULD_NOT_JOIN` (never got in — see
[could-not-join.md](./could-not-join.md)): here the bot was admitted but the host
or platform blocked recording.

## Triage

1. **Confirm the transition and that no disclosure was posted.**
   ```sql
   SELECT id, status, status_reason, region, recall_bot_id, ended_at
   FROM calls WHERE id = '<call_id>';
   ```
   Then check the audit log — there must be a clean-leave entry and **no**
   disclosure-chat entry for this call:
   ```sql
   SELECT actor, action, ts FROM audit_log WHERE call_id = '<call_id>' ORDER BY ts;
   ```
2. **Classify the cause.** `in_call_not_recording` almost always means the
   meeting host disabled recording or the platform denied it (e.g. a Zoom account
   policy, a Meet org policy). It is a meeting-permissions problem, not a
   samograph fault.
3. **Watch for breadth.** A spike in `bot_join_total{result="could_not_record"}`
   (§5.11) across many tenants would be unusual and suggests a Recall-side or
   config regression — escalate to the call-path on-call.

## Recovery

- Single call: advise the owner to enable recording permission for external
  participants / the bot in their meeting platform, then start a **new** call
  (there is no in-place retry — the bot has already left cleanly).
- Confirm the bot actually left (no lingering participant): the clean-leave is
  driven by the lifecycle handler on `in_call_not_recording`; if a bot is somehow
  still present, treat it as a bot-worker fault (`SAMO-WORKER-503`, see
  [ingest-degraded.md](./ingest-degraded.md#bot-worker-unreachable-samo-worker-503)).

`COULD_NOT_RECORD` is terminal. Any transcript rows are not produced (the bot was
not recording), and `ingest_degraded` is reset to false on the terminal
transition (§5.10).
