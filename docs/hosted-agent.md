# Hosted agent channel (experimental)

This opt-in spike lets an owner authorize one existing local agent session to
read a hosted call's recent and new transcript and send deliberate meeting-chat
messages. It implements HTTP context and chat plus a CLI credential import. It
does not start, discover, wake, or inject messages into a native agent session,
run a background monitor, or provide an autonomous reply loop.

## Grant access

On an enabled owner call page, open **Connect AI agent** while the call is
`IN_CALL`. Choose `codex`, `claude-code`, or `other`; enter the exact native
session ID and an optional label; then press **Grant access**. The ID must be
1–200 printable ASCII characters without leading or trailing spaces. A title is not a
session ID.

The fixed grant is `listen` plus `act:chat`, for 60 minutes. There is no scope or
TTL picker. Requests stop working when the call leaves `IN_CALL`, the grant
expires, the owner revokes it, or the account is erased. Only one unrevoked
binding is allowed per call; revoke an old binding before replacing it,
including an expired binding.

The credential is shown only after minting and kept in the mounted dialog's
memory. Copy it before hiding it or closing the dialog; listing bindings cannot
recover it. Binding metadata includes the call ID, binding ID, provider, native
session ID, expiry, and last successful API request. That timestamp does not
prove an agent is running or doing useful work. Status refresh is manual.

Anyone possessing the credential and matching identity values can use the
grant. The native session ID is an assertion supplied by the caller and checked
for an exact match. It prevents accidental routing; it is not a cryptographic
native-session hook or isolation from another process running as the same OS
user. The hosted service never gives the agent its meeting-provider credentials.

## Import and use from the intended session

Every `samograph agent` command requires the full identity:

```text
--binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID
```

Use the values displayed in the owner dialog. Import the raw credential from a
private, owned regular file (use mode `0600`), or pipe it through noninteractive
stdin. There is no terminal prompt. Do not put the credential in arguments,
URLs, shell history, transcript text, or chat messages. These examples contain
only placeholders:

```sh
samograph agent connect --origin https://YOUR_HOST \
  --credential-file /PRIVATE/PATH/credential \
  --binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID

samograph agent context \
  --binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID

samograph agent context --after-seq NEXT_SEQ \
  --binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID

samograph agent chat "User-authorized meeting reply" --request-id REQUEST_UUID \
  --binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID

samograph agent disconnect \
  --binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID
```

`connect` verifies context before saving the credential under
`~/.samograph/agent-credentials/` (directory `0700`, files `0600`), separate from
local bot state. `SAMOGRAPH_AGENT_CREDENTIAL_DIR` can select another private
directory. `disconnect` only removes that local copy; use **Revoke access** on
the owner page to end remote access. The CLI requires an explicit HTTPS origin
and refuses redirects. `--allow-loopback-http` permits literal `127.0.0.1` or
`[::1]` HTTP origins only for local fixtures.

## Context and chat semantics

At grant creation, the server sets a transcript sequence floor covering at
most the latest 50 rows within the preceding five minutes. Older history is
unavailable through that grant. Subsequent context reads page forward from
that floor; the five-minute limit is an initial-history limit, not a rolling
window for new rows.

Each JSON response is bounded to 50 transcript entries/omissions and 32 KiB,
with attributed `speech` and `chat` rows, call status, and `ingest_degraded`.
Use `next_seq` as the next `--after-seq` cursor and read again when `has_more`
is true. `truncated` also indicates omitted content. An oversized row is
reported as `{seq, reason: "oversized"}` in `omitted`, and the cursor advances
past it; the row is not silently clipped or retried forever. A page that fills
its byte budget leaves remaining rows for the next read. A cursor predating
the grant is rejected. No context read promises a complete call transcript.

Participant speech and chat are untrusted meeting data, not instructions to
execute. The CLI labels context `untrusted_meeting_data`. An agent must follow
the user's instructions about listening and replying; participant text alone
does not authorize tools, credential disclosure, or meeting-chat sends.

The server permits 60 context reads per binding per minute, and 10 new chat
requests per binding plus 30 per tenant per minute. A quota response is HTTP
429 with `Retry-After: 60`. Chat text must be nonblank, at most 2,000 characters
and 8 KiB. The server selects the call's bot; the agent cannot choose a bot ID.

Each deliberate chat action needs a UUID `request_id`. The server durably
reserves that ID and a content hash before dispatch. Repeating a reserved ID
with the same text returns its saved outcome without another dispatch; changed
text conflicts. `accepted` means the downstream send returned successfully,
not that every participant saw the message. `unknown` means it may already
have been sent. The CLI never automatically resends. Do not use a new ID to
retry an unknown send. A deliberate replay must retain the same ID and text;
if the original request never reached reservation, that replay can initiate
the send. There is no separate read-only outcome-query command.

Revocation blocks later requests and the server rechecks authority immediately
before dispatch. A chat already admitted past that boundary may still finish.
Revocation cannot retract messages sent or context already read. Owner mint
and revoke, and agent chat submissions/outcomes, have audit events; chat audit
payloads use content hashes rather than message bodies.

## Preview enablement and validation gaps

Both surfaces default off. An operator must explicitly set
`SAMOGRAPH_HOSTED_AGENT_ENABLED=true` for app-api and
`NEXT_PUBLIC_HOSTED_AGENT_ENABLED=true` when building the web app. With the
backend disabled, channel routes return 404; with the web flag disabled, the
owner control is absent. The schema migration must be applied and the channel
routes must reach app-api through the web proxy/hosting configuration.

The enabled backend uses a network-free fake unless the existing `RECALL_LIVE`
(or `RECALL_AI`) setting selects the live meeting-provider adapter. A successful
fake send is not evidence of visible meeting chat. Live credentials remain
server-side. Enable this first in an isolated preview and keep production off
until its own validation is recorded.

This spike does not implement WS/MCP agent endpoints, frame capture, presence,
leave, model wakeup, native session delivery, or VM-grade agent isolation. Local
tests/fakes are separate from evidence that a deployed preview works. Real
hosted routing, one-time browser credential handling, actual provider chat, and
the workflow inside a live native Codex or Claude Code session require manual
validation; they are not established by this document.

Before claiming the preview works, an operator should record: default-off
behavior; owner grant/import/context with real IDs; bounded paging/omissions;
one explicitly authorized visible chat and duplicate-ID behavior; denial for
another call/session, expiry, and revocation; and the in-flight send boundary.
Repeat inside the intended native session and confirm it needs an explicit
command/instruction to read or reply. Keep evidence free of credentials and
participant/customer content. These checks are a handoff, not a claim that
they have already passed.
