# samograph.dev — Product Blueprint

This directory publishes the product spec for **samograph.dev**: a zero-setup,
hosted SaaS that wraps the `samograph` CLI and its Recall.ai meeting bot so you
never run the CLI, hold a Recall token, or operate a tunnel. It ships in two
phases:

- **v1 (MVP):** sign in with an email magic link, paste a Zoom or Google Meet
  URL, and the bot is in your call streaming a **live, persisted, shareable
  transcript**. Nothing else — no calendar, no OAuth, no AI in the product UI,
  no billing.
- **v2 (the differentiator):** a **secure bidirectional AI-agent channel** for
  any active call. The owner mints a per-call, capability-scoped, revocable
  token and pastes it into an external AI tool (Claude Code, Codex). The agent
  can **listen** to the live transcript and **act** (chat, frame, presence,
  leave) over an HTTP/WebSocket API and an MCP endpoint — designed-for in v1
  (capability tokens, bot-worker command/act API, tenancy gate, audit log) and
  built next.

## Contents

- **[SPEC.md](./SPEC.md)** — the **authoritative** specification (v0.3). This is
  the source of truth for agents and engineers building the product: full scope,
  architecture, user stories, test plan, and risks.
- **[brief.html](./brief.html)** — a polished, self-contained **human view**: a
  skimmable summary with architecture and user-journey Mermaid diagrams. Open it
  directly in a browser.
- **[TLDR.md](./TLDR.md)** — one-screen scope summary.

## Provenance

The spec was authored with [samospec](https://github.com/NikolayS/samospec) and
reached **v0.3** through two Claude review rounds (round 1: 15 findings applied;
round 2: 12 findings applied). The commit history in this PR shows each
iteration (v0.1 → v0.2 → v0.3).
