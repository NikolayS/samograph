export const PRESENCE_STATES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "acting",
] as const;

export type PresenceState = typeof PRESENCE_STATES[number];

export interface PresenceSnapshot {
  state: PresenceState;
  message: string;
  updated_at: string;
}

const DEFAULT_MESSAGES: Record<PresenceState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  acting: "Acting",
};

export function normalizePresenceState(value: unknown): PresenceState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (PRESENCE_STATES as readonly string[]).includes(normalized)
    ? normalized as PresenceState
    : null;
}

export function defaultPresenceMessage(state: PresenceState): string {
  return DEFAULT_MESSAGES[state];
}

export function sanitizePresenceMessage(value: unknown, state: PresenceState): string {
  if (typeof value !== "string") return defaultPresenceMessage(state);
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 160) : defaultPresenceMessage(state);
}

export function newPresenceSnapshot(
  state: PresenceState = "listening",
  message = defaultPresenceMessage(state),
): PresenceSnapshot {
  return {
    state,
    message,
    updated_at: new Date().toISOString(),
  };
}

export function presencePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>samoagent presence</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b0f19;
      color: #f8fafc;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0b0f19;
    }
    .samoagent-presence {
      width: min(82vmin, 720px);
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      text-align: center;
    }
    .panel {
      width: 74%;
      aspect-ratio: 1;
      border-radius: 16px;
      display: grid;
      place-items: center;
      border: 14px solid var(--accent, #22c55e);
      box-shadow: 0 0 56px var(--glow, rgba(34, 197, 94, 0.45)), inset 0 0 48px rgba(15, 23, 42, 0.9);
      background: rgba(15, 23, 42, 0.72);
    }
    .state {
      font-size: clamp(42px, 10vmin, 92px);
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .message {
      margin-top: 18px;
      padding: 0 8%;
      font-size: clamp(22px, 4.5vmin, 40px);
      line-height: 1.16;
      color: #cbd5e1;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main class="samoagent-presence">
    <section class="panel" aria-live="polite">
      <div>
        <div class="state" id="state">listening</div>
        <div class="message" id="message">Listening</div>
      </div>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const styles = {
      idle: ["#94a3b8", "rgba(148, 163, 184, 0.38)"],
      listening: ["#22c55e", "rgba(34, 197, 94, 0.45)"],
      thinking: ["#38bdf8", "rgba(56, 189, 248, 0.48)"],
      speaking: ["#f59e0b", "rgba(245, 158, 11, 0.48)"],
      acting: ["#f43f5e", "rgba(244, 63, 94, 0.48)"]
    };
    async function refresh() {
      try {
        const response = await fetch("/presence.json?token=" + encodeURIComponent(token), { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        const state = String(data.state || "listening");
        document.getElementById("state").textContent = state;
        document.getElementById("message").textContent = String(data.message || "");
        const pair = styles[state] || styles.listening;
        document.documentElement.style.setProperty("--accent", pair[0]);
        document.documentElement.style.setProperty("--glow", pair[1]);
      } catch {}
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}
