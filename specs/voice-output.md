# Voice Output — Feature Spec

Adds spoken TTS voice to the bot in the call, with barge-in interruption support.

## Goal

The agent can speak in the call instead of (or in addition to) sending chat messages. Participants hear the bot's voice. If someone starts talking mid-sentence, TTS stops immediately — the bot doesn't talk over people.

**User experience:**
1. Agent calls `samoagent speak "Your query is running now, please wait."`
2. Bot's voice plays in the call (all participants hear it)
3. If anyone talks, TTS stops within ~300ms
4. Agent can call `samoagent speak-stop` to halt manually

## New CLI Commands

```
samoagent speak "text here"         # synthesize and play in call
samoagent speak-stop                # stop current TTS immediately
```

`speak` exits 0 when TTS is queued/playing. It does not block until playback finishes.
`speak-stop` exits 0 if a stop signal was sent (or nothing was playing).

Both commands require an active bot session (`~/.samoagent/state.json`).

New env var: `OPENAI_API_KEY` — required for TTS synthesis.

Optional flag on `samoagent join`:
```
--voice alloy          # OpenAI TTS voice (default: alloy)
--no-interruption      # disable VAD-based barge-in
```

## Architecture

### Option A — `output_audio` endpoint (simple, no interruption)

```
samoagent speak "text"
  → OpenAI TTS API (mp3, non-streaming)
  → base64 encode
  → POST /v1/bot/{bot_id}/output_audio
  → recall.ai plays MP3 in call
```

**Implementation:** ~50 lines. No changes to `avatar.html`. No state needed on the webhook server.

**Tradeoffs:**
- No interruption: once submitted, audio plays to completion
- No streaming: full synthesis before playback starts (latency ~1-3s)
- Simple to implement and debug
- Works with current bot mode (no `output_media` needed)

### Option B — `output_media` webpage with VAD (full interruption)

```
samoagent join → bot renders a webpage (output_media mode)
  The page handles both: video avatar + TTS audio

samoagent speak "text"
  → webhook server receives request
  → pushes to webpage via SSE or WebSocket

Webpage (running in recall.ai headless browser):
  → connects to OpenAI TTS streaming endpoint
  → plays audio via Web Audio API
  → monitors incoming call audio for VAD (voice activity)
  → on VAD trigger: stop TTS immediately
  → signals back to webhook server: "interrupted"
```

**Interruption signal chain:**
```
user speaks in call
  → call audio arrives in webpage via Web Audio API
  → VAD detects activity (energy threshold or Silero VAD WASM)
  → AudioBufferSourceNode.stop() called immediately
  → SSE event sent to webhook server: { "event": "interrupted" }
  → webhook server writes to transcript: "[TTS interrupted]"
```

**Barge-in via transcript monitor (fallback, simpler VAD):**
```
samoagent watch → detects new words from non-bot speaker
  → calls samoagent speak-stop
  → POST /v1/bot/{bot_id}/output_audio with empty payload (or webpage stop via SSE)
```
This has ~1-2s lag (transcript processing latency) but requires no in-page VAD.

**Tradeoffs:**
- True low-latency interruption via in-page VAD (~100-300ms)
- Requires `output_media` mode: avatar page must also handle TTS
- More complex: SSE channel between webhook server and bot page, WASM VAD
- OpenAI streaming TTS needs chunked playback queuing in browser
- `output_media` requires a publicly reachable URL for the page (already have ngrok)

## Implementation Plan by Option

### Option A (recommended for first version)

1. Add `OPENAI_API_KEY` check in `samoagent speak`
2. Call `openai.audio.speech.create(model="tts-1", voice=..., input=text)`
3. POST `base64(mp3_bytes)` to `https://api.recall.ai/api/v1/bot/{bot_id}/output_audio`
4. Add `samoagent speak-stop` — no-op for Option A (no stop API exists); document limitation
5. For soft interruption: `samoagent watch` line parser can call speak-stop when a non-bot speaker appears while `~/.samoagent/speaking.lock` exists

Estimated effort: 1–2 hours.

### Option B

1. Extend `avatar.html` to open an SSE connection to the webhook server (`/tts-stream`)
2. Webhook server: add `/speak` endpoint (receives text from CLI), pushes via SSE
3. Browser: stream OpenAI TTS audio chunks, queue in Web Audio API, track playback node
4. VAD: start with energy threshold (simple). Upgrade to Silero WASM if false positives
5. On VAD: `sourceNode.stop()`, send `{ event: "interrupted" }` back to server
6. `samoagent speak-stop`: POST `/speak-stop` to webhook server → SSE stop event

Estimated effort: 2–3 days.

## Recommendation

**Start with Option A.** It covers the primary use case (agent speaks in the call) with minimal risk and no changes to the bot rendering architecture. Interruption via transcript monitor (1-2s lag) is acceptable for current usage — the agent isn't doing real-time dialogue.

Upgrade to Option B only if true barge-in latency becomes a real pain point.

## Open Questions

- Does recall.ai `output_audio` accept streaming chunks (repeated POSTs), or does it queue them? Need to test whether calling it multiple times creates a playback queue or replaces current audio.
- Is there a recall.ai API to stop/cancel current `output_audio` playback?
- What happens if `output_media` and `output_audio` are used together? The docs suggest they're mutually exclusive — confirm.
- Should the bot's own speech be excluded from the transcript? (Deepgram will transcribe it since it goes through the call.) May need a speaker-label filter.
- Voice selection: one fixed voice per session, or configurable per `speak` call?

## Out of Scope

- Real-time streaming TTS with sub-500ms first-word latency (requires Option B)
- Multi-language voice selection (automatic language detection)
- Wake-word or always-on voice activation — agent decides when to speak
- Recording/logging of bot's own speech in transcript
- TTS for chat messages (speak is a separate explicit command)
- Text-to-speech from external tools other than OpenAI
