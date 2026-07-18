# Runbook: could not join (`COULD_NOT_JOIN` / `SAMO-CALL-JOIN`)

**Symptom.** A call reaches terminal status `COULD_NOT_JOIN`. The dashboard shows
*"Couldn't join — &lt;Recall reason&gt;."* with a **Try again** action (Story 4).
API/UI surface the code `SAMO-CALL-JOIN`.

**Meaning.** Recall reported a `fatal` / non-recoverable bot lifecycle event
**before the bot was admitted** — a bad/expired meeting URL, a waiting room that
never admitted the bot, host-denied entry, or a Recall-side failure (§5.2,
§5.16). The human reason is Recall's `status.sub_code`, persisted on the call as
`status_reason` (migration 0004) and shown to the user.

## Triage

1. **Read the persisted reason** — it is usually self-explanatory:
   ```sql
   SELECT id, status, status_reason, region, recall_bot_id, created_at, ended_at
   FROM calls WHERE id = '<call_id>';
   ```
2. **Classify** by `status_reason`:
   - *Invalid/expired meeting URL* → user error. "Try again" returns them to the
     dashboard with the URL pre-filled (no implicit retry, no new `Call` row
     until they re-submit — Story 4).
   - *Waiting room / admit timeout / host denied* → meeting-side. The host must
     admit `samograph (recording)`; nothing to fix on our side.
   - *Recall fatal with no clear sub-code* → check Recall status for the region
     and the `bot_join_total{result="could_not_join"}` counter (§5.11). A spike
     across many tenants is a Recall/region incident — escalate.
3. **Correlate with join latency.** If bots reach `JOINING` but never `IN_CALL`
   across a region, confirm the regional tunnel and orchestrator are healthy
   (the bot may be joining but webhooks are not arriving — see
   [ingest-degraded.md](./ingest-degraded.md)).

## Recovery

- Single user, user-fixable cause: instruct them to use **Try again** and
  re-submit a corrected URL. A new `Call` row is created only on explicit
  re-submit.
- Region-wide spike: this is not per-call recovery — page the call-path on-call,
  check Recall status, and consider steering new calls to the warm second region
  (§4.7).

`COULD_NOT_JOIN` is terminal; the bot is not in the call, so there is nothing to
leave or clean up beyond the call row itself.

## Related terminal statuses

- **`BOT_REMOVED`** — Recall `bot_removed`: the host removed the bot *after* it
  joined. Dashboard shows *"The bot was removed from the call."* (`SAMO-CALL-REMOVED`).
  This is terminal and expected (the host chose to remove it); no recovery — the
  partial transcript up to removal stays in the dashboard. If a tenant reports
  bots being removed repeatedly, it is a meeting-policy conversation, not an
  outage.
- **`ENDED`** — normal end (Recall `call_ended` or owner "leave"). Not an
  incident.
- **`COULD_NOT_RECORD`** — joined but Recall would not record; see
  [could-not-record.md](./could-not-record.md).
