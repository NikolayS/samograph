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
  activities: PresenceActivity[];
}

export type PresenceActivityKind = "heard" | "thought" | "speech" | "action" | "status";

export interface PresenceActivity {
  kind: PresenceActivityKind;
  label: string;
  text: string;
  at: string;
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

export function sanitizePresenceText(value: unknown, maxLen = 220): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function newPresenceSnapshot(
  state: PresenceState = "listening",
  message = defaultPresenceMessage(state),
  activities: PresenceActivity[] = [],
): PresenceSnapshot {
  return {
    state,
    message,
    updated_at: new Date().toISOString(),
    activities,
  };
}

const ACTIVITY_LIMIT = 8;

export function appendPresenceActivity(
  snapshot: PresenceSnapshot,
  activity: Omit<PresenceActivity, "at">,
): PresenceSnapshot {
  const text = sanitizePresenceText(activity.text);
  if (!text) return snapshot;
  const label = sanitizePresenceText(activity.label, 40) || activity.kind;
  return {
    ...snapshot,
    updated_at: new Date().toISOString(),
    activities: [
      { kind: activity.kind, label, text, at: new Date().toISOString() },
      ...snapshot.activities,
    ].slice(0, ACTIVITY_LIMIT),
  };
}

export function activityKindForState(state: PresenceState): PresenceActivityKind {
  switch (state) {
    case "thinking":
      return "thought";
    case "speaking":
      return "speech";
    case "acting":
      return "action";
    default:
      return "status";
  }
}

export function labelForPresenceState(state: PresenceState): string {
  switch (state) {
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "acting":
      return "Acting";
    case "idle":
      return "Idle";
    case "listening":
      return "Listening";
  }
}

export function activityFromTranscriptLine(line: string): Omit<PresenceActivity, "at"> | null {
  const match = line.match(/^\[[^\]]+\]\s+([^:]+):\s*(.*)$/);
  if (match === null) return null;
  const label = sanitizePresenceText(match[1], 40);
  const text = sanitizePresenceText(match[2]);
  if (!text) return null;
  return { kind: "heard", label, text };
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
      background: #070a0f;
      color: #f8fafc;
      --accent: #2dd4bf;
      --accent-soft: rgba(45, 212, 191, 0.2);
      --accent-mid: rgba(45, 212, 191, 0.46);
      --heard: #a3e635;
      --thought: #38bdf8;
      --speech: #f59e0b;
      --action: #fb7185;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
        linear-gradient(180deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px),
        #070a0f;
      background-size: 56px 56px;
    }
    .samoagent-presence {
      width: 100vw;
      min-height: 100vh;
      display: grid;
      place-items: stretch;
      padding: min(3.2vh, 28px);
    }
    .tile {
      position: relative;
      width: min(100%, calc((100vh - min(6.4vh, 56px)) * 16 / 9));
      max-height: calc(100vh - min(6.4vh, 56px));
      aspect-ratio: 16 / 9;
      align-self: center;
      justify-self: center;
      border-radius: 8px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: clamp(12px, 2vh, 20px);
      border: 1px solid rgba(226, 232, 240, 0.14);
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 28px 80px rgba(0, 0, 0, 0.56);
      background: #050914;
      padding: clamp(18px, 3.2vh, 34px);
      overflow: hidden;
      isolation: isolate;
    }
    .tile::before {
      content: "";
      position: absolute;
      inset: 0;
      border-top: 4px solid var(--accent);
      box-shadow: inset 0 0 90px rgba(2, 6, 23, 0.75), inset 0 0 28px var(--accent-soft);
      pointer-events: none;
      z-index: 0;
    }
    .tile::after {
      content: "";
      position: absolute;
      inset: -42%;
      z-index: 0;
      pointer-events: none;
      opacity: 0.82;
      background:
        radial-gradient(circle at 18% 28%, var(--accent-mid), transparent 24%),
        radial-gradient(circle at 80% 36%, rgba(245, 158, 11, 0.44), transparent 28%),
        radial-gradient(circle at 48% 82%, rgba(56, 189, 248, 0.4), transparent 30%),
        conic-gradient(from 20deg at 50% 50%, transparent, var(--accent-soft), transparent 34%, rgba(245, 158, 11, 0.2), transparent 68%);
      transform: translate3d(-7%, -4%, 0) scale(1.04) rotate(-4deg);
      will-change: transform;
      animation: drift 7s linear infinite alternate;
    }
    .tile > * {
      position: relative;
      z-index: 2;
    }
    .plasma-canvas {
      position: absolute;
      inset: -9%;
      width: 118%;
      height: 118%;
      z-index: 0;
      opacity: 0.58;
      filter: blur(16px) saturate(1.12) contrast(1.04);
      transform: scale(1.01);
      pointer-events: none;
    }
    .scan {
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, transparent, rgba(248, 250, 252, 0.07), transparent);
      height: 26%;
      transform: translateY(-110%);
      opacity: 0.22;
      pointer-events: none;
      z-index: 1;
    }
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 20px;
      min-height: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      color: #cbd5e1;
      font-size: clamp(13px, 1.45vw, 18px);
      font-weight: 800;
      text-transform: uppercase;
    }
    .mark {
      width: clamp(30px, 3.8vw, 46px);
      height: clamp(30px, 3.8vw, 46px);
      border: 2px solid var(--accent);
      display: grid;
      place-items: center;
      font-size: clamp(14px, 1.8vw, 22px);
      color: #ffffff;
      background: rgba(15, 23, 42, 0.8);
      box-shadow: 0 0 26px var(--accent-mid);
      flex: 0 0 auto;
    }
    .live {
      color: var(--accent);
      border: 1px solid var(--accent-mid);
      background: rgba(15, 23, 42, 0.74);
      padding: 8px 12px;
      font-size: clamp(11px, 1.2vw, 15px);
      font-weight: 900;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status {
      min-width: 0;
    }
    .state {
      color: #ffffff;
      font-size: clamp(32px, 5vw, 68px);
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
      line-height: 0.92;
      overflow-wrap: anywhere;
    }
    .message {
      margin-top: clamp(8px, 1.4vh, 14px);
      max-width: 58ch;
      font-size: clamp(18px, 2.25vw, 30px);
      line-height: 1.14;
      color: #cbd5e1;
      overflow-wrap: anywhere;
      text-wrap: balance;
    }
    .pulse {
      display: grid;
      grid-template-columns: repeat(18, 1fr);
      gap: 5px;
      align-items: end;
      height: clamp(38px, 6vh, 66px);
      margin-top: clamp(10px, 1.6vh, 18px);
      opacity: 0.9;
    }
    .pulse span {
      display: block;
      min-width: 3px;
      height: 42%;
      background: var(--accent);
      box-shadow: 0 0 18px var(--accent-mid);
    }
    .pulse span:nth-child(3n) { height: 72%; }
    .pulse span:nth-child(3n + 1) { height: 54%; }
    .pulse span:nth-child(5n) { height: 88%; }
    .lanes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: clamp(10px, 1.6vw, 18px);
      align-self: stretch;
      align-items: stretch;
      height: 100%;
      min-height: 0;
    }
    .lane {
      min-width: 0;
      height: 100%;
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: clamp(8px, 1.2vh, 12px);
      padding: clamp(12px, 1.8vw, 18px);
      border: 1px solid rgba(226, 232, 240, 0.12);
      background: rgba(2, 6, 23, 0.58);
      backdrop-filter: blur(14px);
      box-shadow: inset 0 1px 0 rgba(248, 250, 252, 0.06);
    }
    .lane-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #e2e8f0;
      font-size: clamp(12px, 1.3vw, 17px);
      font-weight: 900;
      text-transform: uppercase;
    }
    .lane-title::after {
      content: "";
      height: 3px;
      flex: 1 1 auto;
      background: currentColor;
      opacity: 0.62;
    }
    .lane[data-kind="heard"] .lane-title { color: var(--heard); }
    .lane[data-kind="thought"] .lane-title { color: var(--thought); }
    .lane[data-kind="speech"] .lane-title { color: var(--speech); }
    .activity {
      display: grid;
      align-content: start;
      gap: clamp(8px, 1.1vh, 12px);
      grid-template-rows: repeat(2, minmax(0, 1fr));
      min-height: 0;
      overflow: hidden;
    }
    .item {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 6px;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border-left: 4px solid currentColor;
      padding: 0 0 0 12px;
      color: #e2e8f0;
      animation: enter 360ms ease-out both;
    }
    .label {
      color: #94a3b8;
      font-size: clamp(10px, 1.1vw, 14px);
      font-weight: 900;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label.repeated {
      display: none;
    }
    .text {
      color: #f8fafc;
      font-size: clamp(15px, 1.75vw, 24px);
      line-height: 1.12;
      min-height: 0;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 7;
      overflow: hidden;
    }
    .empty {
      color: #64748b;
      font-size: clamp(14px, 1.5vw, 20px);
      line-height: 1.2;
      align-self: center;
    }
    .footer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      color: #94a3b8;
      font-size: clamp(11px, 1.15vw, 15px);
      font-weight: 700;
      min-width: 0;
    }
    .timestamp {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @keyframes scan {
      to { transform: translateY(410%); }
    }
    @keyframes drift {
      to { transform: translate3d(8%, 5%, 0) scale(1.1) rotate(9deg); }
    }
    @keyframes enter {
      from { opacity: 1; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-aspect-ratio: 1/1) {
      .tile {
        width: 100%;
        max-height: none;
        min-height: calc(100vh - min(6.4vh, 56px));
        aspect-ratio: auto;
      }
      .lanes {
        grid-template-columns: 1fr;
      }
      .pulse {
        height: 34px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .scan,
      .plasma-canvas,
      .tile::after,
      .pulse span,
      .item {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <main class="samoagent-presence">
    <section class="tile" aria-live="polite">
      <canvas class="plasma-canvas" id="plasma" aria-hidden="true"></canvas>
      <div class="scan"></div>
      <header class="header">
        <div class="brand"><span class="mark">S</span><span>samoagent live presence</span></div>
        <div class="live" id="live">listening</div>
      </header>
      <div class="status">
        <div class="state" id="state">Listening</div>
        <div class="message" id="message">Listening</div>
        <div class="pulse" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
      </div>
      <div class="lanes">
        <section class="lane" data-kind="heard">
          <div class="lane-title">Heard</div>
          <div class="activity" id="heard"></div>
        </section>
        <section class="lane" data-kind="thought">
          <div class="lane-title">Thinks</div>
          <div class="activity" id="thought"></div>
        </section>
        <section class="lane" data-kind="speech">
          <div class="lane-title">Says</div>
          <div class="activity" id="speech"></div>
        </section>
      </div>
      <footer class="footer">
        <div class="timestamp" id="updated">Waiting for live signal</div>
        <div id="count">0 events</div>
      </footer>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const backgroundMode = params.get("bg") || "static";
    const styles = {
      idle: ["#94a3b8", "rgba(148, 163, 184, 0.2)", "rgba(148, 163, 184, 0.42)"],
      listening: ["#a3e635", "rgba(163, 230, 53, 0.16)", "rgba(163, 230, 53, 0.46)"],
      thinking: ["#38bdf8", "rgba(56, 189, 248, 0.17)", "rgba(56, 189, 248, 0.48)"],
      speaking: ["#f59e0b", "rgba(245, 158, 11, 0.18)", "rgba(245, 158, 11, 0.48)"],
      acting: ["#fb7185", "rgba(251, 113, 133, 0.18)", "rgba(251, 113, 133, 0.5)"]
    };
    const titles = { idle: "Idle", listening: "Listening", thinking: "Thinking", speaking: "Speaking", acting: "Acting" };
    const laneConfig = [
      ["heard", document.getElementById("heard"), "No speech yet"],
      ["thought", document.getElementById("thought"), "No thought yet"],
      ["speech", document.getElementById("speech"), "No reply yet"]
    ];
    const speechKinds = new Set(["speech", "action", "status"]);
    const classify = (item) => {
      if (item && item.kind === "heard") return "heard";
      if (item && item.kind === "thought") return "thought";
      if (item && speechKinds.has(item.kind)) return "speech";
      return "speech";
    };
    function hexToRgb(hex) {
      const match = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(String(hex || ""));
      if (!match) return [56, 189, 248];
      return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
    }
    function cssVarRgb(name) {
      return hexToRgb(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    }
    function initPlasma() {
      const canvas = document.getElementById("plasma");
      const ctx = canvas && canvas.getContext("2d", { alpha: true });
      if (!canvas || !ctx) return;
      let w = 1;
      let h = 1;
      let image = null;
      let lastFrame = 0;
      const scale = 1.2;
      const frameMs = 250;
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      function resize() {
        const rect = canvas.getBoundingClientRect();
        w = Math.max(32, Math.min(140, Math.floor(rect.width / 10)));
        h = Math.max(20, Math.min(80, Math.floor(rect.height / 10)));
        canvas.width = w;
        canvas.height = h;
        image = ctx.createImageData(w, h);
      }
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }
      function plasmaValue(x, y, t, cx, cy) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const v =
          Math.sin(x * 0.035 * scale + t * 2.4) +
          Math.sin(y * 0.043 * scale - t * 2.0) +
          Math.sin((x + y) * 0.026 * scale + t * 1.6) +
          Math.sin(r * 0.055 * scale - t * 3.2);
        return clamp((v + 4) / 8, 0, 1);
      }
      function writePlasmaPixel(data, p, accent, n, alphaScale = 1) {
        const hot = Math.pow(n, 1.8);
        const cool = Math.pow(1 - n, 2.4);
        const mid = Math.sin(p * 0.0007) * 0.5 + 0.5;
        data[p] = Math.round(8 + accent[0] * 0.3 + 126 * hot + 42 * mid + 44 * cool);
        data[p + 1] = Math.round(12 + accent[1] * 0.34 + 72 * hot + 98 * mid + 26 * cool);
        data[p + 2] = Math.round(34 + accent[2] * 0.4 + 94 * hot + 112 * cool);
        data[p + 3] = Math.round((126 + hot * 116) * alphaScale);
      }
      function drawFieldPlasma(data, accent, t) {
        const cx = w * 0.58;
        const cy = h * 0.46;
        let p = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            writePlasmaPixel(data, p, accent, plasmaValue(x, y, t, cx, cy));
            p += 4;
          }
        }
      }
      function drawSpherePlasma(data, accent, t) {
        const cx = w * 0.52;
        const cy = h * 0.47;
        const radius = Math.min(w, h) * 0.36;
        let p = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const base = plasmaValue(x, y, t * 0.72, cx, cy);
            if (dist < radius) {
              const edge = 1 - dist / radius;
              const z = Math.sqrt(Math.max(0, 1 - (dist / radius) ** 2));
              const latitude = Math.atan2(dy, radius * z + 0.001);
              const longitude = Math.atan2(dx, radius * z + 0.001);
              const bands = Math.sin(longitude * 5.0 + t * 3.0) * Math.cos(latitude * 4.0 - t * 1.6);
              const n = clamp(base * 0.65 + bands * 0.22 + edge * 0.38, 0, 1);
              const rim = Math.pow(1 - edge, 5);
              writePlasmaPixel(data, p, accent, n, 0.78 + rim * 0.45);
              data[p] = Math.min(255, data[p] + Math.round(rim * 80));
              data[p + 1] = Math.min(255, data[p + 1] + Math.round(rim * 52));
              data[p + 2] = Math.min(255, data[p + 2] + Math.round(rim * 96));
            } else {
              const orbit = Math.abs(dist - radius * (1.15 + 0.08 * Math.sin(t + Math.atan2(dy, dx) * 3)));
              const tendril = Math.max(0, 1 - orbit / (radius * 0.11));
              const fade = Math.max(0, 1 - dist / (radius * 2.2));
              const n = clamp(base * 0.36 + tendril * 0.9, 0, 1);
              writePlasmaPixel(data, p, accent, n, 0.28 * fade + tendril * 0.54);
            }
            p += 4;
          }
        }
      }
      function draw(now) {
        if (!reduce && now - lastFrame < frameMs) {
          requestAnimationFrame(draw);
          return;
        }
        lastFrame = now;
        if (!image) resize();
        const accent = cssVarRgb("--accent");
        const t = backgroundMode === "static" ? 420 : now * 0.0002;
        const data = image.data;
        const cycle = (now * 0.00005) % 1;
        if (backgroundMode === "static") drawSpherePlasma(data, accent, t);
        else if (backgroundMode === "field") drawFieldPlasma(data, accent, t);
        else if (backgroundMode === "sphere") drawSpherePlasma(data, accent, t);
        else if (cycle < 0.5) drawFieldPlasma(data, accent, t);
        else drawSpherePlasma(data, accent, t);
        ctx.putImageData(image, 0, 0);
        if (!reduce && backgroundMode !== "static") requestAnimationFrame(draw);
      }
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      resize();
      requestAnimationFrame(draw);
    }
    function formatUpdated(value) {
      const date = new Date(String(value || ""));
      if (Number.isNaN(date.getTime())) return "Waiting for live signal";
      return "Updated " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    function renderLane(element, items, fallback) {
      element.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = fallback;
        element.append(empty);
        return;
      }
      let lastLabel = "";
      for (const item of items.slice(0, 2)) {
        const row = document.createElement("div");
        row.className = "item";
        const label = document.createElement("div");
        label.className = "label";
        const labelText = String(item.label || item.kind || "event");
        if (labelText === lastLabel) label.classList.add("repeated");
        label.textContent = labelText;
        lastLabel = labelText;
        const text = document.createElement("div");
        text.className = "text";
        text.textContent = String(item.text || "");
        row.append(label, text);
        element.append(row);
      }
    }
    async function refresh() {
      try {
        const response = await fetch("/presence.json?token=" + encodeURIComponent(token), { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        const state = String(data.state || "listening");
        document.getElementById("state").textContent = titles[state] || state;
        document.getElementById("live").textContent = state;
        document.getElementById("message").textContent = String(data.message || "");
        const buckets = { heard: [], thought: [], speech: [] };
        const activities = Array.isArray(data.activities) ? data.activities : [];
        for (const item of activities) {
          buckets[classify(item)].push(item);
        }
        for (const [kind, element, fallback] of laneConfig) renderLane(element, buckets[kind], fallback);
        document.getElementById("updated").textContent = formatUpdated(data.updated_at);
        document.getElementById("count").textContent = activities.length + (activities.length === 1 ? " event" : " events");
        const pair = styles[state] || styles.listening;
        document.documentElement.style.setProperty("--accent", pair[0]);
        document.documentElement.style.setProperty("--accent-soft", pair[1]);
        document.documentElement.style.setProperty("--accent-mid", pair[2]);
      } catch {}
    }
    initPlasma();
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}
