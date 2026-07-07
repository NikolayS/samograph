# samograph.dev on-call runbooks

Operator playbooks for the samograph.dev call path (SPEC §8 SRE track, §5.16
error-code reference). Each runbook maps a user-visible symptom — a terminal
`calls.status` (§5.2) or a `SAMO-*` error code (§5.16) — to a diagnosis and a
recovery procedure. They assume the v1 architecture: one multi-tenant Postgres
with RLS (§5.10), one regional cloudflared **named** tunnel per region (§4.3),
and a leader-elected ingest watchdog (§4.5/§4.6).

## Quick reference — symptom → runbook

| Symptom (status / code) | Meaning | Runbook |
|---|---|---|
| `SAMO-INGEST-DEGRADED` (overlay) | Tunnel/ingest outage mid-call; transcript lines lost while degraded | [ingest-degraded.md](./ingest-degraded.md) |
| `SAMO-WORKER-503` | Bot-worker unreachable (crash / stale `workers` row) | [ingest-degraded.md](./ingest-degraded.md#bot-worker-unreachable-samo-worker-503) |
| `SAMO-RATE-001` | Share/agent connection or command cap hit (§5.7) | [ingest-degraded.md](./ingest-degraded.md#share-link-rate-limit-samo-rate-001) |
| status `COULD_NOT_JOIN` / `SAMO-CALL-JOIN` | Recall could not get the bot into the call | [could-not-join.md](./could-not-join.md) |
| status `COULD_NOT_RECORD` / `SAMO-CALL-NOREC` | Bot joined but Recall reported `in_call_not_recording` | [could-not-record.md](./could-not-record.md) |
| status `BOT_REMOVED` | Host removed the bot from the call | [could-not-join.md](./could-not-join.md#related-terminal-statuses) |
| status `ENDED` | Normal call end (Recall `call_ended` or owner "leave") | not an incident — see the status table below |
| Duplicated / missing degraded warnings across replicas | Watchdog leader-election fault | [leader-election.md](./leader-election.md) |

## Terminal call statuses (§5.2)

`calls.status` is a single enum. The operator-reachable terminal values:

| Status | Trigger | Operator action |
|---|---|---|
| `ENDED` | Recall `call_ended`, or owner "leave" verb | None — expected. Transcript stays in the dashboard. |
| `COULD_NOT_JOIN` | Recall `fatal` before join | [could-not-join.md](./could-not-join.md) |
| `COULD_NOT_RECORD` | Recall `in_call_not_recording` | [could-not-record.md](./could-not-record.md) |
| `BOT_REMOVED` | Recall `bot_removed` (host kicked the bot) | [could-not-join.md](./could-not-join.md#related-terminal-statuses) |

`ingest_degraded` is an INDEPENDENT boolean overlay (§5.10), not a status value:
a call can be `IN_CALL` **and** degraded at the same time. See
[ingest-degraded.md](./ingest-degraded.md).

## Operational toggles

| Toggle | Effect | Doc |
|---|---|---|
| `RECALL_LIVE` + `RECALL_API_KEY` | Flip the bot-orchestrator from the deterministic fake to the REAL Recall client so an actual bot joins (default = fake; never set in CI) | [real-recall-flag.md](./real-recall-flag.md) |

## Deployment invariants

| Invariant | Why it matters | Doc |
|---|---|---|
| app-api sits behind a trusted edge that **overwrites** `X-Forwarded-For`; never exposed directly | `clientIp()` trusts the first XFF hop — without a trusted proxy the 20/hr per-IP magic-link limit is spoofable and direct callers collapse into one `unknown` bucket (§5.1 / SPEC.amendments item 11) | [trusted-proxy.md](./trusted-proxy.md) |

## Conventions

- All log lines are structured JSON carrying `call_id`, `tenant_id`, `region`
  (§5.11). Grep by `call_id` to follow one call end-to-end.
- Queries below run as a privileged infra role (RLS bypass) unless noted; never
  paste tenant data into tickets.
- Counters referenced (`tunnel_probe_failed_total{region}`,
  `ws_dropped_total{call_id}`, `webhook_rejected_total{reason}`,
  `bot_join_total{result}`, `pickup_latency_ms`) are exported on `/metrics`
  (§5.11) and rendered on the activation-funnel dashboard.
