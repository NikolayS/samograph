# Runbook: ingest degraded (`SAMO-INGEST-DEGRADED`)

**Symptom.** The per-call page shows the banner *"Transcript delivery degraded —
recovering…"* and the live transcript stream carries a
`SAMOGRAPH-WARNING: tunnel unreachable …` line. The call is still `IN_CALL` but
`calls.ingest_degraded = true` (§5.2, §5.10). Lines spoken during the outage are
**lost** — they are not replayed when the tunnel recovers.

**Error code.** `SAMO-INGEST-DEGRADED` — an *overlay*, not a terminal status
(§5.16). It auto-recovers; the operator's job is to confirm recovery, find the
root cause, and decide whether to fail the affected calls over to a healthy
region.

## How it is detected

The leader-elected tunnel watchdog (§4.5/§4.6) probes the region's cloudflared
named tunnel `/health` every **20 s**. After **2 consecutive failed probes** it
flips the region to degraded, sets `calls.ingest_degraded = true` for every
`IN_CALL` call in that region, appends exactly one `SAMOGRAPH-WARNING: tunnel
unreachable` line to each, and increments `tunnel_probe_failed_total{region}`
(§5.11). On the next healthy probe it appends one `tunnel recovered` line and
clears `ingest_degraded`. See [leader-election.md](./leader-election.md) for why
this happens exactly once across ingest replicas.

## Triage (in order)

1. **Confirm scope.** Which region, how many calls?
   ```sql
   SELECT region, status, count(*)
   FROM calls
   WHERE ingest_degraded = true
   GROUP BY region, status;
   SELECT id, status, leader_id, last_probe_ts, leader_lease_expires_at
   FROM regions;
   ```
2. **Check the tunnel.** Is the regional cloudflared named tunnel up?
   ```bash
   cloudflared tunnel info <region-tunnel-name>
   curl -fsS "https://<region-tunnel-host>/health?nonce=oncall" | jq .
   ```
   A healthy response echoes the `samograph-health` marker and the `nonce`. An
   error/interstitial page (Cloudflare 1033/530, an HTML body, a missing marker)
   means the tunnel — not ingest — is the fault.
3. **Check the watchdog leader.** If `regions.leader_id` is stale or the lease
   expired, follow [leader-election.md](./leader-election.md): a dead leader
   stops probing and the region looks "stuck degraded" even after the tunnel
   recovers.
4. **Check ingest health.** Are ingest replicas accepting webhooks?
   `webhook_rejected_total{reason}` rising on `bad_signature`/`unknown_bot`
   points at a config/secret problem, not the tunnel.

## Recovery

- **Tunnel flapped and self-healed:** confirm a `tunnel recovered` line appended
  and `ingest_degraded` cleared. Note in the incident that lines during the
  outage window are gone (expected; not recoverable).
- **Tunnel down hard:** restart the regional `cloudflared` named tunnel. If it
  will not come back quickly, advise affected owners to **leave and rejoin** so a
  new bot is created (a new call routes through a healthy region per §4.7). Do
  not try to migrate an in-flight bot's tunnel.
- **Watchdog stuck:** force-failover the leader per
  [leader-election.md](./leader-election.md#force-failover); the new leader
  re-probes within ≤ lease + probe interval and clears `ingest_degraded` on the
  next healthy probe.

## Verify resolved

```sql
SELECT count(*) FROM calls WHERE ingest_degraded = true;   -- expect 0
```
The banner clears on the per-call page and live lines resume.

---

## Bot-worker unreachable (`SAMO-WORKER-503`)

A `SAMO-WORKER-503` is returned when a bot-worker action (chat/frame/presence/
leave, §5.8) cannot reach the worker — a crashed process or a **stale `workers`
row**. Transcript ingest is unaffected and keeps flowing; only the action fails.

1. Find the worker row and heartbeat:
   ```sql
   SELECT call_id, host, port, last_heartbeat_at, now() - last_heartbeat_at AS age
   FROM workers WHERE call_id = '<call_id>';
   ```
2. A stale `last_heartbeat_at` (older than the heartbeat interval) → the worker
   is gone. The client behavior is "retry once; transcript keeps flowing"
   (§5.16); a single retry that still 503s means the worker must be respawned by
   the bot-orchestrator. Clear the stale row so a fresh registration can land.
3. If many calls in a region 503 at once, suspect the worker tier / region, not
   one call — escalate to the platform on-call.

## Share-link rate limit (`SAMO-RATE-001`)

`SAMO-RATE-001` (HTTP 429) fires when a `share` token hits a §5.7 cap: 200
concurrent connections, 20 commands/min/connection, or 1000 establishments/hour.
This is usually a legitimately popular share link, **not** an incident.

1. Confirm it is a `share` actor, not abuse:
   ```sql
   SELECT id, call_id, scopes, expires_at, revoked_at
   FROM tokens WHERE id = '<token_id>';
   ```
2. The client must back off and honor `Retry-After` (§5.16). If the owner needs
   more headroom, that is a product limit, not an ops override — do not raise the
   caps per-token by hand. If the traffic looks like fuzzing, the owner can
   **revoke** the token (`revoked_at = now()`); revocation takes effect within
   ≤ 1 s (no verifier-side cache, §5.5/§5.7).
