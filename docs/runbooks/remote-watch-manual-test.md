# Manual test: `samograph watch --remote` (WebSocket, #307)

`watch --remote` reads a call's live transcript from the site over one outbound
WebSocket. The laptop needs no tunnel. This runbook is for a new engineer (and
their AI agent) checking it by hand:

- **Part A** runs everything locally with the in-repo Recall fake. It works end to end today.
- **Part B** points the CLI at the hosted site `samograph.samo.team`. Only part of it works today; see B.4.

Commands assume the repo root and a POSIX shell. Output that changes between
runs (call ids, timestamps, backoff delays) is shown as `<...>` or as the
shape to expect.

## How it works (one paragraph)

The CLI connects to `GET /calls/<id>/stream?since_seq=N` on the ws-hub:
- It sends the per-call **share token** only as `Authorization: Bearer`, read from the env var `SAMOGRAPH_SHARE_TOKEN`. The token never goes in argv or a URL.
- It prints each line once, in seq order, as `[ts] Speaker: text`, and appends it to `--out`. The default is `~/.samograph/remote_<call>_transcript.txt`.
- It keeps the resume cursor in `<out>.seq`.
- On a disconnect it reconnects with backoff from `since_seq=<last>`. Seq holes and `gap` frames are filled from `GET /calls/<id>/transcript?since_seq=<last>`.
- 401/403 stops it with exit code 3.
- A terminal call status appends `[ts] SAMOGRAPH_CALL_ENDED` to `--out` and exits 0.
- `--remote` must be `https://` unless the host is `localhost`, `127.0.0.1` or `[::1]`.

## Part A: fully local (dev-live-server + fake Recall)

### A.0 Setup (once)

```bash
bun install
createdb samograph_rw                                  # any local Postgres >= 14
export DATABASE_URL=postgres://$USER@localhost:5432/samograph_rw
bun packages/shared/db/migrate.ts                      # prints "applied: 0001_core_schema, ..."
```

### A.1 Automated checks first

```bash
bun test tests/remoteWatch.test.ts                     # client vs a scripted fake hub, no DB
bun test apps/ws-hub/remoteWatch.e2e.test.ts           # real ingest + ws-hub + Postgres
SAMOGRAPH_SLOW_TESTS=1 bun test apps/ws-hub/remoteWatch.e2e.test.ts -t "LONG IDLE"   # ~2 min
```

Expected output:
- the unit file: `17 pass, 0 fail`;
- the e2e file: `13 pass, 1 skip, 0 fail` (the skip is LONG IDLE);
- the LONG IDLE run: `1 pass` plus a line like `[idle] 120s: pings=4 reconnects=0 post-idle latency=15.0ms`.

### A.2 Start the live stack (terminal 1)

```bash
export DATABASE_URL=postgres://$USER@localhost:5432/samograph_rw
SAMO_ENV=dev WS_HUB_PORT=38788 INGEST_PORT=38089 DEV_CTRL_PORT=38790 \
  bun apps/ws-hub/dev-live-server.ts
```

Expected output:

```text
[live] composed ingest + ws-hub on a shared Hub (LOCAL-ONLY, fake)
  ws-hub stream : http://localhost:38788/calls/:id/stream  (WS) + /calls/:id/transcript (REST)
  ...
```

### A.3 Create a call and mint a share token (terminal 2)

```bash
export DATABASE_URL=postgres://$USER@localhost:5432/samograph_rw
eval "$(WS_HUB=http://localhost:38788 bun apps/ws-hub/bench/remoteWs.ts seed)"
echo "$CALL_ID"
```

`seed` inserts a user, a tenant and a `JOINING` call. It prints two `export` lines: `CALL_ID` and `SAMOGRAPH_SHARE_TOKEN`. The token is signed with dev-live-server's public **dev-only** `TOKEN_SECRET` default and is useless anywhere else.

### A.4 Watch, then inject lines

```bash
bun src/cli.ts watch --remote http://localhost:38788 --call "$CALL_ID" --mode ws --out /tmp/remote.txt &

curl -s localhost:38790/__dev/say -H 'content-type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"speaker\":\"Alice\",\"text\":\"hello from the site\"}"
curl -s localhost:38790/__dev/say -H 'content-type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"speaker\":\"Alice\",\"text\":\"second line\"}"
```

Expected output:

```text
samograph: connected ws://localhost:38788/calls/<CALL_ID>/stream?since_seq=0     # stderr
{"ok":true}
[2026-01-01 00:01:30] Alice: hello from the site                                  # stdout
{"ok":true}
[2026-01-01 00:01:30] Alice: second line
```

Then check the files:
- `/tmp/remote.txt` holds the same two lines.
- `cat /tmp/remote.txt.seq` prints `2`.
- `ls -l /tmp/remote.txt` shows `-rw-------` (the file is private).

The fake stamps a fixed `2026-01-01 00:01:30` on every injected line, so that timestamp is not wall-clock time.

### A.5 Disconnect / reconnect (no loss, no duplicate)

Keep the watch from A.4 running.
1. **Stop the server:** press Ctrl-C in terminal 1.
2. **Add a line while it is down.** This line never goes through the live push, so it can only come back through the resume:
   ```bash
   psql "$DATABASE_URL" -c "INSERT INTO transcripts (call_id, seq, ts, speaker, text)
     VALUES ('$CALL_ID', 3, now(), 'Bob', 'said while the server was down')"
   ```
3. **Start the server again:** repeat A.2.
4. **Inject one more line:**
   ```bash
   curl -s localhost:38790/__dev/say -H 'content-type: application/json' \
     -d "{\"call_id\":\"$CALL_ID\",\"speaker\":\"Alice\",\"text\":\"back online\"}"
   ```

Expected output. The delays are random and grow each time; the cursor stays at 2 until the socket is back:

```text
samograph: disconnected; reconnecting in 353ms from since_seq=2
samograph: disconnected; reconnecting in 636ms from since_seq=2
samograph: disconnected; reconnecting in 1528ms from since_seq=2
samograph: connected ws://localhost:38788/calls/<CALL_ID>/stream?since_seq=2
[<now, UTC>] Bob: said while the server was down
[2026-01-01 00:01:30] Alice: back online
```

`/tmp/remote.txt` now has exactly 4 lines with no repeats, and `/tmp/remote.txt.seq` is `4`.

Restarting the **CLI** also resumes from the cursor: kill it and run the A.4 `watch` command again. It connects with `since_seq=4` and reprints nothing.

### A.6 Revoke the share token

With the watch still running:

```bash
psql "$DATABASE_URL" -c "UPDATE tokens SET revoked_at = now() WHERE call_id = '$CALL_ID' AND revoked_at IS NULL"
```

Within about 1 s, the server's per-socket recheck closes the socket. The client reconnects once, gets a 403 and stops. It does not loop:

```text
samograph: disconnected; reconnecting in <n>ms from since_seq=4
samograph: not authorized for call <CALL_ID> (HTTP 403): the share token is invalid, expired, revoked, or for another call
```

Run the A.4 `watch` command again in the foreground and then `echo $?`. It prints the same message and `3`.

### A.7 Call ended → sentinel

In local dev, `/__dev/say` cannot end a call. But the server sends the terminal status when a socket opens, so this works:

```bash
eval "$(WS_HUB=http://localhost:38788 bun apps/ws-hub/bench/remoteWs.ts seed)"   # a fresh call + token
curl -s localhost:38790/__dev/say -H 'content-type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"speaker\":\"Alice\",\"text\":\"goodbye\"}"
psql "$DATABASE_URL" -c "UPDATE calls SET status = 'ENDED' WHERE id = '$CALL_ID'"
bun src/cli.ts watch --remote http://localhost:38788 --call "$CALL_ID" --mode ws --out /tmp/ended.txt; echo "exit=$?"
cat /tmp/ended.txt
```

Expected output:

```text
samograph: connected ws://localhost:38788/calls/<CALL_ID>/stream?since_seq=0
[2026-01-01 00:01:30] Alice: goodbye
samograph: call <CALL_ID> ended (ENDED)
exit=0
[2026-01-01 00:01:30] Alice: goodbye
[<local now>] SAMOGRAPH_CALL_ENDED
```

The status can also change while a watch is connected, via `psql` as above. The `UPDATE` pushes nothing live, so the watch sees the end only on its next reconnect. To trigger one, restart the server (A.5). A real lifecycle webhook does push the status live; the e2e test covers that path.

### A.8 Negative checks

```bash
# a token for another call: exit 3, no retry loop
bun src/cli.ts watch --remote http://localhost:38788 --call 00000000-0000-0000-0000-000000000000; echo "exit=$?"
# cleartext to a non-loopback host is refused before anything is sent
bun src/cli.ts watch --remote http://samograph.samo.team --call "$CALL_ID"; echo "exit=$?"
# no token in the env
env -u SAMOGRAPH_SHARE_TOKEN bun src/cli.ts watch --remote http://localhost:38788 --call "$CALL_ID"
```

Expected output, one block per command:
1. `samograph: not authorized for call 00000000-... (HTTP 403): ...` then `exit=3`.
2. `samograph: error: argument --remote: must be an https:// site (http:// is allowed only for localhost)` then `exit=2`.
3. `samograph: error: watch --remote needs a per-call share token in SAMOGRAPH_SHARE_TOKEN` with exit code 1.

### A.9 Optional: measurements

```bash
WS_HUB=http://localhost:38788 DEV_CTRL=http://localhost:38790 bun apps/ws-hub/bench/remoteWs.ts measure   # ~2.5 min
```

This prints a table with inject→stdout latency (p50 is single-digit ms), a 200-line burst (200/200, 0 dupes, in order) and 120 s idle (pings, 0 reconnects).

## Part B: hosted site (`https://samograph.samo.team`)

### B.1 What is already there

- **ws-hub paths:** prod serves `/calls/<id>/stream` and `/calls/<id>/transcript` on the same origin. The path goes Cloudflare → Caddy → ws-hub.
- **The branch CLI already reaches it.** This was checked with a junk token:

  ```bash
  SAMOGRAPH_SHARE_TOKEN=not-a-real-token \
    bun src/cli.ts watch --remote https://samograph.samo.team --call 00000000-0000-0000-0000-000000000000
  # samograph: not authorized for call 00000000-... (HTTP 403): the share token is invalid, expired, revoked, or for another call
  # exit code 3
  ```

- **The CLI is client-side,** so you can run this branch's CLI against prod before the PR is merged.

### B.2 Create a call on the site

1. Sign in at `https://samograph.samo.team/auth` (magic link or Google).
2. On the Dashboard, paste a Meet/Zoom link into "Add to call". This sends `POST /calls {meeting_url}` and returns `201 {id, status}`. The call id is in the call page URL.

The site creates the bot. The bot's transcript webhook points at the **site**, not at a laptop. A bot started with `samograph join` (the laptop/tunnel flow) is a different call: that call does not exist in the site's database, and `watch --remote` cannot read it.

A real bot joins only when the host runs with a live Recall configuration. Otherwise the call uses the fake and stays silent.

### B.3 Get a share token

**UI:** open the call page, click **Share**, then **Create** or **Copy**. The link looks like `https://samograph.samo.team/c/<token>`. The part after `/c/` is the share token.

**API.** This needs your `samo_session` cookie from the browser devtools. The proxy forwards these routes only with `Sec-Fetch-Dest: empty`.

```bash
curl -s -X POST -H 'Sec-Fetch-Dest: empty' -H "Cookie: samo_session=$SESSION" \
  "https://samograph.samo.team/calls/$CALL_ID/share"
# 201 {"token":"...","token_id":"...","url":"/c/..."}   (TTL 30 days)
```

Then watch:

```bash
export SAMOGRAPH_SHARE_TOKEN='<token>'          # env only; never pass it as an argument
bun src/cli.ts watch --remote https://samograph.samo.team --call "$CALL_ID" --mode ws
```

To revoke, use **Share → Revoke** in the UI, or:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H 'Sec-Fetch-Dest: empty' \
  -H "Cookie: samo_session=$SESSION" "https://samograph.samo.team/calls/$CALL_ID/share"
# 204
```

Within about 1 s, the running watch prints the 403 message and exits 3.

### B.4 What does NOT work yet on the hosted site

1. **This PR is not deployed.** Prod runs `main`, so its ws-hub has neither of this PR's two server changes.
   - **No 30 s keepalive ping.** On a silent call, the client's 75 s stale timer reconnects, and it resumes from `since_seq`, so no lines are lost. Cloudflare may also drop the idle socket after about 100 s, with the same reconnect.
   - **No terminal status on connect.** A watch started after the call ended does not exit.
2. **The call-ended status never reaches the hosted ws-hub.** The status poller writes `ENDED` to the database and announces it through `pg_notify`, but the ws-hub has no `LISTEN` consumer yet (deferred). The bots also don't send lifecycle webhooks. So a watch that is connected when the call ends keeps waiting. Stop it with Ctrl-C. After this PR ships, the next reconnect sees the end, writes the sentinel and exits.
3. **No preview env was up for this branch while the PR was a draft.** `samograph-feat-307-remote-ws.samo.cat` returned 525. samohost creates PR previews on a 5-minute timer at `samograph-<branch>.samo.cat`. Once one is up, repeat B.2–B.3 against it, because that env runs this branch's server.
4. **A 403 with a token that was just minted:** app-api signs share tokens and ws-hub verifies them. Both must use the same `TOKEN_SECRET` and key id. If they don't, every token is refused. Check the env config before you suspect the client.
5. **One bot, one site:** the laptop `samograph join` flow and the site flow are still separate. There is no way yet to start a bot from the CLI that delivers to the site.
