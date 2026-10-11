# Runbook: watchdog leader election (advisory-lock)

The tunnel watchdog (§4.5) must run **exactly once per region**, even though
ingest scales horizontally. If every replica probed, a single outage would
produce one `SAMOGRAPH-WARNING` line *per replica* — duplicated warnings, noisy
transcripts, and racing writes to `regions.status` / `calls.ingest_degraded`.
Leader election (§4.6) guarantees one prober per region.

## Mechanism (§4.6)

- Leadership is a **Postgres advisory lock keyed on `region_id`**. Exactly one
  ingest replica holds the lock for a region at a time; it is the leader.
- The leader holds a **60 s lease** (`regions.leader_lease_expires_at`), renewed
  every **20 s** (one renew per probe interval). If the leader dies, the lease
  expires automatically — no manual cleanup, no fencing token needed.
- **Only the leader** runs probes, writes `regions.status`, flips
  `calls.ingest_degraded`, and emits warning/recovery lines. **Followers run no
  probes.**
- On leader death, the next replica acquires the advisory lock and takes over
  within **≤ lease + probe interval** (≤ 60 s + 20 s = ≤ 80 s worst case). This
  is the recovery-time bound to quote in an incident.

The lock is a session/transaction-scoped Postgres advisory lock; the `region_id`
is hashed to the lock's `bigint` key. Followers attempt a non-blocking acquire
(`pg_try_advisory_lock`) each cycle and become leader the moment it succeeds.

## Diagnose

1. **Who is the leader, and is the lease fresh?**
   ```sql
   SELECT id, status, leader_id, last_probe_ts, leader_lease_expires_at,
          leader_lease_expires_at < now() AS lease_expired
   FROM regions;
   ```
   A `lease_expired = true` with no new `leader_id` means **no replica is
   probing** — the region is unmonitored (and may be "stuck degraded").
2. **Inspect the live advisory lock.** Confirm exactly one holder per region:
   ```sql
   SELECT l.locktype, l.classid, l.objid, l.pid, a.application_name, a.state
   FROM pg_locks l
   JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory';
   ```
   - **Zero rows** for a region → no leader (dead leader, lease not yet taken
     over). Wait up to the recovery bound, or force-failover below.
   - **More than one holder** for the same `region_id` key → a real bug
     (split-brain); capture `pg_locks` + both PIDs and escalate. This should be
     impossible with a single advisory lock.

## Force-failover

If a leader is wedged (holding the lock but not probing — e.g. a hung process
whose session is still alive), reclaim leadership:

1. Identify the stuck leader's backend PID from the `pg_locks` query above.
2. Terminate that backend so the advisory lock releases:
   ```sql
   SELECT pg_terminate_backend(<pid>);
   ```
   (Or restart that ingest replica.) Releasing the lock lets the next replica
   acquire it on its next cycle.
3. The new leader re-probes within ≤ lease + probe interval and, on the next
   healthy probe, clears any stale `calls.ingest_degraded` for the region.

Never edit `regions.leader_id` / `leader_lease_expires_at` by hand to "assign" a
leader — the advisory lock, not the row, is the source of truth. Hand-edited rows
do not move the lock and cause split-brain symptoms.

## Verify exactly-once

After failover or during an outage, confirm warnings/recoveries were emitted
exactly once per outage across the cluster (not once per replica):

```sql
-- One degraded warning + one recovery per affected call per outage window.
SELECT call_id, count(*) FILTER (WHERE text LIKE '%tunnel unreachable%')   AS warns,
                          count(*) FILTER (WHERE text LIKE '%tunnel recovered%') AS recovers
FROM transcripts
WHERE ts >= now() - interval '1 hour'
GROUP BY call_id
HAVING count(*) FILTER (WHERE text LIKE '%tunnel unreachable%') > 1;
```

Rows returned (warns > 1 for a single outage) indicate duplicate warnings —
i.e., leader election failed and more than one replica probed. Cross-check the
`pg_locks` advisory holders and `tunnel_probe_failed_total{region}` (§5.11): the
counter should advance on one replica only. This is exercised under concurrent
replicas in the distributed test (§6.2 #5).
