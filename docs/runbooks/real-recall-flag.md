# Runbook: turning on a REAL Recall bot (`RECALL_LIVE`)

**What this is.** By default the samograph.dev call path uses the deterministic
in-repo Recall **fake** (SPEC §6.1) — no key, no network, so CI and local dev get
a `JOINING` row without any real bot. This flag flips the bot-orchestrator's
createBot path to the **real** `src/recall.ts` client so an ACTUAL bot joins a
Zoom / Google Meet call (issue #88, SPEC amendment S2-10).

**Scope.** This gets a real bot INTO the call (display name `samograph (recording)`,
§5.9) and registers a real-time Deepgram transcription webhook. **Live transcript
end-to-end is a SEPARATE step**: the registered webhook must be reachable from the
public internet, which needs the public webhook tunnel / ingress wired and healthy
(the Sprint-2 exit manual gate — see [ingest-degraded.md](./ingest-degraded.md)).
With the flag on but no reachable ingress, the bot still JOINS; it just sits silent
(no transcript), exactly the failure mode the CLI's tunnel preflight guards against.

## Environment variables

| Var | Required when live | Meaning |
|---|---|---|
| `RECALL_LIVE` | yes (set `1` / `true` / `yes` / `on`) | Enables the real Recall path. Alias: `RECALL_AI` (same semantics). Unset/`0`/`false` → the deterministic fake. **Never set in CI.** |
| `RECALL_API_KEY` | yes | The shared Recall API key (§4.4 — held only by the orchestrator + ingest). Flag on **without** a key → a clear **startup error**, never a silent fallback to the fake. |
| `PUBLIC_WEBHOOK_BASE` | recommended | Public https origin the per-call webhook is built against (e.g. `https://samograph-main.samo.cat`). Unset → the regional tunnel base default. A non-https value fails fast at startup. |

The bot's real-time transcription provider is **Deepgram** (Recall
`recording_config.transcript.provider.deepgram_streaming`, `nova-3` / `multi`),
matching the proven CLI shape.

## Turn it on

```bash
export RECALL_LIVE=1
export RECALL_API_KEY=…              # from the secret manager; never commit/log it
export PUBLIC_WEBHOOK_BASE=https://samograph-main.samo.cat
bun apps/app-api/dev-server.ts
# banner prints:  Recall: REAL (RECALL_LIVE) → bot joins; webhook base https://…
```

Then `POST /calls {meeting_url}` with a real Meet/Zoom URL — a real bot joins
within ~15 s and the call row flips PENDING → JOINING.

> **Known limitation (amendment S2-12): call status does NOT auto-advance yet with
> real Recall.** The real-time webhook endpoint carries `transcript.data` **only** —
> Recall rejects `bot.status_change` on a real-time endpoint (HTTP 400, "not a valid
> choice"). So the §5.2 lifecycle (`bot.status_change` → `calls.status`) receives no
> status events over this channel: the row stays JOINING and does **not** flip to
> IN_CALL / DONE on its own. Transcript ingest still works (the bot joins and is heard).
> Live status delivery from real Recall needs a **separate status / account-level
> webhook config** (not the real-time endpoint) and is tracked as its own follow-up.

## Turn it off

Unset `RECALL_LIVE` (or set it to `0`). The orchestrator reverts to the
deterministic fake — no key needed, no real bot.

## Notes

- The registered webhook URL carries the per-call ingest secret (`?t=…`) but not
  `?bot=` (Recall assigns the bot id only in the createBot response). Ingest
  resolves the owning call by `?t=` → `calls.ingest_secret_hash` when `?bot=` is
  absent (`apps/ingest/webhook.ts`, amendment S2-10) — this is what makes a
  `?t=`-only URL deliverable, so the bot is not "joined but deaf". The canonical
  `?bot=<id>&t=<secret>` form (§5.3) is recorded on the call row once Recall
  assigns the id.
- **Auth model (amendment S2-11):** Recall's real-time webhooks are **unsigned** —
  the `?t=` ingest_secret IS the authenticator (the proven CLI model). So ingest
  does NOT require a Recall signature on the real-time path (`RECALL_WEBHOOK_SECRET`
  is only needed if you also front account-level Svix webhooks); a signature is
  verified only if present. Keep the tunnel HTTPS — the secret rides in the URL.
- **Never** put `RECALL_API_KEY` in issues, PR comments, commits, or logs. If one
  leaks, rotate it immediately (§4.10).
