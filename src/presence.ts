import { ROBOT_DATA_URI } from "./robotImage";

// Order matches help text and docs (listed in typical-use order); the initial
// snapshot state is set explicitly in newPresenceSnapshot, not from index 0.
export const PRESENCE_STATES = [
  "listening",
  "thinking",
  "speaking",
  "acting",
  "idle",
] as const;

export type PresenceState = typeof PRESENCE_STATES[number];

export interface PresenceSnapshot {
  state: PresenceState;
  message: string;
  updated_at: string;
  activities: PresenceActivity[];
  chime: PresenceChime | null;
  speak: PresenceSpeak | null;
}

// A transient speech cue for the realtime avatar (bg=avatar mode). The camera
// page makes the avatar say `text` once per distinct `at` timestamp, so the
// same line sitting in the snapshot never re-speaks. Independent of `message`
// (the on-screen status string), which is capped shorter for the dashboard.
export interface PresenceSpeak {
  text: string;
  at: string;
}

// Speech lines can run longer than the 160-char on-screen status message.
export const SPEAK_MAX_CHARS = 400;

// A transient audio cue. The camera page plays a short sound once per distinct
// `at` timestamp (e.g. when the bot posts a meeting-chat message), so the same
// chime sitting in the snapshot never replays.
export interface PresenceChime {
  at: string;
}

export type PresenceActivityKind = "heard" | "comment";

export interface PresenceActivity {
  kind: PresenceActivityKind;
  label: string;
  text: string;
  at: string;
}

const DEFAULT_MESSAGES: Record<PresenceState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Checking",
  speaking: "Commenting",
  acting: "Working",
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
    chime: null,
    speak: null,
  };
}

// Stamp a transient chime onto the snapshot. Bumping updated_at makes the
// page's adaptive poller treat it as fresh activity and pick it up quickly.
export function withChime(snapshot: PresenceSnapshot): PresenceSnapshot {
  return {
    ...snapshot,
    updated_at: new Date().toISOString(),
    chime: { at: new Date().toISOString() },
  };
}

// Stamp a transient speech line onto the snapshot for the realtime avatar to
// speak. Like withChime, bumps updated_at so the poller picks it up promptly.
// Empty/whitespace text is a no-op (returns the snapshot unchanged).
export function withSpeak(snapshot: PresenceSnapshot, text: string): PresenceSnapshot {
  const clean = sanitizePresenceText(text, SPEAK_MAX_CHARS);
  if (!clean) return snapshot;
  const at = new Date().toISOString();
  return {
    ...snapshot,
    updated_at: at,
    speak: { text: clean, at },
  };
}

const ACTIVITY_LIMIT = 16;

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

export function activityKindForState(_state: PresenceState): PresenceActivityKind {
  // Agent-initiated presence updates are always comments; "heard" comes only
  // from transcript lines via activityFromTranscriptLine.
  return "comment";
}

export function labelForPresenceState(_state: PresenceState): string {
  // Same rationale as activityKindForState: agent updates render as comments.
  return "Comment";
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
  <title>samograph presence</title>
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
      --comment: #38bdf8;
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
    .samograph-presence {
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
      grid-template-rows: auto minmax(0, 1fr) auto;
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
      inset: 0;
      z-index: 0;
      pointer-events: none;
      opacity: 0.54;
      background:
        radial-gradient(circle at 50% 50%, var(--accent-soft), transparent 34%),
        linear-gradient(90deg, rgba(15, 23, 42, 0.7), transparent 42%, transparent 58%, rgba(15, 23, 42, 0.7));
    }
    .tile > * {
      position: relative;
      z-index: 2;
    }
    .plasma-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      opacity: 1;
      filter: saturate(1.1) contrast(1.08);
      pointer-events: none;
    }
    .robot-img {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      object-fit: cover;
      z-index: 2147483647;
      display: none;
      pointer-events: none;
    }
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
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
    .lanes {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(210px, 0.82fr) minmax(0, 1fr);
      gap: clamp(16px, 2.2vw, 30px);
      align-self: stretch;
      align-items: center;
      height: 100%;
      min-height: 0;
    }
    .mind {
      position: relative;
      width: min(100%, clamp(210px, 27vw, 360px));
      aspect-ratio: 1;
      justify-self: center;
      display: grid;
      place-items: center;
      border-radius: 50%;
      overflow: hidden;
      border: 1px solid rgba(226, 232, 240, 0.18);
      box-shadow:
        0 0 0 1px rgba(15, 23, 42, 0.85),
        0 0 42px rgba(56, 189, 248, 0.32),
        inset 0 0 48px rgba(15, 23, 42, 0.86);
      background: #020617;
    }
    .mind::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background:
        radial-gradient(circle at 30% 22%, rgba(191, 219, 254, 0.22), transparent 14%),
        radial-gradient(circle at 68% 80%, transparent 42%, rgba(0, 0, 0, 0.58) 84%),
        radial-gradient(circle at 50% 50%, transparent 59%, rgba(147, 197, 253, 0.18) 62%, transparent 70%);
      box-shadow:
        inset -28px -32px 62px rgba(0, 0, 0, 0.58),
        inset 16px 14px 36px rgba(147, 197, 253, 0.08);
      z-index: 3;
      pointer-events: none;
    }
    .lane {
      min-width: 0;
      height: 100%;
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: clamp(8px, 1.2vh, 12px);
      padding: clamp(12px, 1.8vw, 18px);
      border-left: 2px solid rgba(226, 232, 240, 0.14);
      border-right: 2px solid rgba(226, 232, 240, 0.08);
      background: rgba(2, 6, 23, 0.42);
      box-shadow: inset 0 1px 0 rgba(248, 250, 252, 0.05);
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
    .lane[data-kind="comment"] .lane-title { color: var(--comment); }
    .activity {
      gap: clamp(8px, 1.1vh, 12px);
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      /* Pin the stack to the top: the first line appears at the top and each
         new line is added below it (newest at the bottom, chat order). Once the
         lane is full, the oldest lines overflow off the top. */
      justify-content: flex-start;
    }
    .item {
      display: block;
      min-width: 0;
      flex: 0 0 auto;
      border-left: 2px solid currentColor;
      padding: 0 0 0 9px;
      color: #e2e8f0;
      opacity: 0.92;
    }
    .label {
      color: #94a3b8;
      font-size: clamp(10px, 1.1vw, 14px);
      font-weight: 900;
      text-transform: uppercase;
      line-height: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label.repeated {
      display: none;
    }
    .text {
      color: #f8fafc;
      font-size: clamp(12px, 1.18vw, 17px);
      line-height: 1.04;
      min-height: 0;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .empty {
      color: #64748b;
      font-size: clamp(13px, 1.35vw, 18px);
      line-height: 1.1;
      align-self: center;
    }
    .footer {
      display: grid;
      grid-template-columns: 1fr auto auto;
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
    .diagnostic {
      color: var(--accent);
      white-space: nowrap;
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
      .mind {
        width: min(64vw, 300px);
        order: -1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .plasma-canvas,
      .tile::after,
      .item {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <main class="samograph-presence">
    <section class="tile" aria-live="polite">
      <header class="header">
        <div class="brand"><span class="mark">S</span><span>samograph live presence</span></div>
        <div class="live" id="live">listening</div>
      </header>
      <div class="lanes">
        <section class="lane" data-kind="heard">
          <div class="lane-title">Heard</div>
          <div class="activity" id="heard"></div>
        </section>
      <div class="mind" aria-label="samoagent avatar">
        <canvas class="plasma-canvas" id="plasma" aria-hidden="true"></canvas>
        <img class="robot-img" id="robot" src="${ROBOT_DATA_URI}" alt="samoagent" aria-hidden="true">
      </div>
        <section class="lane" data-kind="comment">
          <div class="lane-title">Comments</div>
          <div class="activity" id="comment"></div>
        </section>
      </div>
      <footer class="footer">
        <div class="timestamp" id="updated">Waiting for live signal</div>
        <div class="diagnostic" id="render-fps">Render FPS --</div>
        <div id="count">0 events</div>
      </footer>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const bgParam = params.get("bg") || "robot";
    // Named modes only; unknown values fall back to the robot avatar.
    const backgroundMode = ["robot", "sphere", "field", "static", "cycle", "avatar"].includes(bgParam) ? bgParam : "robot";
    const styles = {
      idle: ["#64748b", "rgba(100, 116, 139, 0.18)", "rgba(100, 116, 139, 0.36)"],
      listening: ["#38bdf8", "rgba(56, 189, 248, 0.16)", "rgba(56, 189, 248, 0.44)"],
      thinking: ["#818cf8", "rgba(129, 140, 248, 0.18)", "rgba(129, 140, 248, 0.48)"],
      speaking: ["#a78bfa", "rgba(167, 139, 250, 0.2)", "rgba(167, 139, 250, 0.5)"],
      acting: ["#60a5fa", "rgba(96, 165, 250, 0.18)", "rgba(96, 165, 250, 0.46)"]
    };
    const laneConfig = [
      ["heard", document.getElementById("heard"), "No speech yet"],
      ["comment", document.getElementById("comment"), "No comments yet"]
    ];
    let activityEnergy = 0;
    const classify = (item) => {
      if (item && item.kind === "heard") return "heard";
      return "comment";
    };
    function hexToRgb(hex) {
      const match = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(String(hex || ""));
      if (!match) return [56, 189, 248];
      return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
    }
    function cssVarRgb(name) {
      return hexToRgb(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    }
    function showRobotFullFrame() {
      // Move the static image to be a direct child of <body> (escaping the
      // tile's stacking/overflow context), then remove the entire dynamic
      // dashboard so no header/lanes/footer/FPS text can show.
      const robot = document.getElementById("robot");
      const root = document.querySelector(".samograph-presence");
      if (robot) {
        document.body.appendChild(robot);
        robot.style.display = "block";
      }
      if (root) root.remove();
      document.body.style.background = "#000";
    }
    function initRobot() {
      // Robot mode is just a full-frame static picture. No refresh/FPS loops
      // do anything visible in this mode (the dashboard is gone).
      showRobotFullFrame();
    }
    // Realtime avatar (bg=avatar): a full-frame talking head streamed from Anam
    // over WebRTC. The page asks the server (which alone holds the API key) for
    // a short-lived session token, attaches the stream to a full-frame <video>,
    // and speaks each new presence "speak" line via the agent-driven talk()
    // command — the persona's own brain stays out of it (disableInputAudio +
    // we never call sendUserMessage). Any failure falls back to the static
    // robot avatar so the bot camera is never blank.
    let avatarClient = null;
    async function initAvatar() {
      // Keep the dashboard in the DOM for now: the full-frame video covers it,
      // and the static-avatar fallback needs the #robot image (a child of the
      // dashboard) to still exist. Only remove the dashboard once the avatar
      // stream is actually live.
      document.body.style.background = "#000";
      const video = document.createElement("video");
      video.id = "anam-video";
      video.autoplay = true;
      video.playsInline = true;
      // Deliberately NOT muted: Recall captures this page's audio into the call,
      // so the avatar's voice must play. (muted is a boolean attribute — setting
      // it at all, even to false, silences the element.)
      video.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;background:#000;z-index:2147483646;";
      document.body.appendChild(video);
      try {
        const resp = await fetch("/avatar/session", {
          cache: "no-store",
          headers: { "X-Samograph-Presence-Token": token },
        });
        const data = await resp.json();
        if (!data || !data.enabled || !data.sessionToken) {
          console.warn("[avatar] session not enabled; falling back to static avatar");
          video.remove();
          showRobotFullFrame();
          return;
        }
        // Pinned ESM build off the CDN the official Anam quickstart uses; esm.sh
        // polyfills the SDK's node:buffer dependency for the browser.
        const mod = await import("https://esm.sh/@anam-ai/js-sdk@4.17.1");
        const client = mod.createClient(data.sessionToken, { disableInputAudio: true });
        await client.streamToVideoElement("anam-video");
        avatarClient = client;
        // Stream is live and the full-frame video covers everything — now drop
        // the dashboard (header/lanes/footer) so nothing peeks through.
        const root = document.querySelector(".samograph-presence");
        if (root) root.remove();
        console.log("[avatar] connected to Anam persona " + (data.personaId || ""));
      } catch (err) {
        console.error("[avatar] init failed; falling back to static avatar", err);
        video.remove();
        showRobotFullFrame();
      }
    }
    // Speak each new presence.speak line via the avatar's talk() command. Like
    // the chime cue, the first poll only establishes a baseline so a line
    // already sitting in the snapshot at (re)connect does not double-speak.
    let lastSpeakAt = "";
    let speakReady = false;
    function handleSpeak(speak) {
      const at = speak && speak.at ? String(speak.at) : "";
      if (!speakReady) { lastSpeakAt = at; speakReady = true; return; }
      if (!at || at === lastSpeakAt) return;
      // If the Anam stream is not live yet (connect is async and takes a few
      // seconds), do NOT advance lastSpeakAt — leave the cue so the next poll
      // retries it once connected. Otherwise a line spoken right after join
      // (e.g. a startup announcement) would be silently consumed and lost.
      if (!avatarClient) return;
      lastSpeakAt = at;
      const text = speak && speak.text ? String(speak.text) : "";
      if (text) {
        Promise.resolve(avatarClient.talk(text)).catch((e) => console.error("[avatar] talk failed", e));
      }
    }
    function initPlasma() {
      const canvas = document.getElementById("plasma");
      const ctx = canvas && canvas.getContext("2d", { alpha: true });
      if (!canvas || !ctx) return;
      let w = 1;
      let h = 1;
      let image = null;
      let lastFrame = 0;
      const frameMs = 100;
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let redrawQueued = false;
      function scheduleRedraw() {
        if (redrawQueued) return;
        redrawQueued = true;
        requestAnimationFrame((now) => {
          redrawQueued = false;
          lastFrame = now - frameMs;
          draw(now);
        });
      }
      function resize() {
        const rect = canvas.getBoundingClientRect();
        const nextW = Math.max(96, Math.min(220, Math.floor(rect.width / 3.2)));
        const nextH = Math.max(96, Math.min(220, Math.floor(rect.height / 3.2)));
        if (image && nextW === w && nextH === h) return;
        w = nextW;
        h = nextH;
        canvas.width = w;
        canvas.height = h;
        image = ctx.createImageData(w, h);
        // Reassigning canvas dimensions clears the bitmap; in static or
        // reduced-motion modes the animation loop never repaints, so schedule
        // a one-shot redraw (the running loop covers animated modes).
        if (reduce || backgroundMode === "static") scheduleRedraw();
      }
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }
      function mix(a, b, n) {
        return a + (b - a) * n;
      }
      function plasmaBands(x, y, z, t, energy) {
        return (
          Math.sin(x * 6.0 + y * 2.2 + t * (1.9 + energy * 2.2)) +
          Math.sin(y * 7.2 - z * 3.8 - t * (1.4 + energy * 1.6)) +
          Math.sin((x + z) * 8.4 + t * (2.4 + energy * 2.8)) +
          Math.sin(Math.atan2(y, x) * 5.0 + z * 4.2 - t * (1.7 + energy * 2.0))
        ) / 4;
      }
      function drawFieldPlasma(data, accent, t, energy) {
        const cx = w * 0.5;
        const cy = h * 0.5;
        let p = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const nx = (x - cx) / cx;
            const ny = (y - cy) / cy;
            const n = plasmaBands(nx, ny, Math.hypot(nx, ny), t, energy) * 0.5 + 0.5;
            data[p] = Math.round(mix(12, accent[0] + 100, n));
            data[p + 1] = Math.round(mix(20, accent[1] + 62, 1 - Math.abs(n - 0.55)));
            data[p + 2] = Math.round(mix(46, accent[2] + 76, 1 - n));
            data[p + 3] = 190;
            p += 4;
          }
        }
      }
      function drawSpherePlasma(data, accent, t, energy) {
        const cx = w * 0.5;
        const cy = h * 0.5;
        const pulse = 1 + Math.sin(t * 3.2) * (0.035 + energy * 0.045);
        const radius = Math.min(w, h) * 0.44 * pulse;
        let p = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dx = (x - cx) / radius;
            const dy = (y - cy) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) {
              const z = Math.sqrt(Math.max(0, 1 - dist * dist));
              const spin = t * (0.55 + energy * 0.7);
              const cos = Math.cos(spin);
              const sin = Math.sin(spin);
              const rx = dx * cos - z * sin;
              const rz = dx * sin + z * cos;
              const bands = plasmaBands(rx, dy, rz, t, energy) * 0.5 + 0.5;
              const rim = Math.pow(dist, 3.4);
              const light = clamp(0.22 + z * 0.5 - dx * 0.1 - dy * 0.15 + energy * 0.1, 0, 1.05);
              const glow = Math.pow(bands, 1.45);
              const depth = Math.pow(1 - bands, 1.15);
              data[p] = Math.round(clamp((24 + glow * 96 + depth * 16) * light + rim * 24, 0, 190));
              data[p + 1] = Math.round(clamp((48 + glow * 142 + depth * 54) * light + rim * 48, 0, 228));
              data[p + 2] = Math.round(clamp((116 + glow * 156 + depth * 120) * light + rim * 72, 0, 255));
              data[p + 3] = 255;
            } else {
              const halo = clamp(1 - (dist - 1) / 0.42, 0, 1);
              data[p] = Math.round(34 * halo);
              data[p + 1] = Math.round(82 * halo);
              data[p + 2] = Math.round(180 * halo);
              data[p + 3] = Math.round(120 * halo * halo);
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
        const energy = activityEnergy;
        const t = backgroundMode === "static" ? 420 : now * (0.00055 + energy * 0.0007);
        const data = image.data;
        const cycle = (now * 0.00005) % 1;
        if (backgroundMode === "static") drawSpherePlasma(data, accent, t, 0);
        else if (backgroundMode === "field") drawFieldPlasma(data, accent, t, energy);
        else if (backgroundMode === "cycle" && cycle < 0.5) drawFieldPlasma(data, accent, t, energy);
        else if (backgroundMode === "cycle") drawSpherePlasma(data, accent, t, energy);
        else drawSpherePlasma(data, accent, t, energy); // sphere (and fallback)
        ctx.putImageData(image, 0, 0);
        if (!reduce && backgroundMode !== "static") requestAnimationFrame(draw);
      }
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      resize();
      requestAnimationFrame(draw);
    }
    // Soft "blip" audio cue, synthesized with WebAudio (no asset files). Played
    // once per new chime timestamp — e.g. when the bot posts a meeting-chat
    // message — so people notice it without watching the camera. Recall renders
    // this page as the bot camera and streams its audio into the call.
    let audioCtx = null;
    function chimeAudioContext() {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        try { audioCtx = new Ctx(); } catch { return null; }
      }
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return audioCtx;
    }
    function playChime() {
      const ctx = chimeAudioContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800; // shave harshness for a soft tone
      osc.type = "sine";
      // A gentle upward "bl-ip" rather than a flat beep.
      osc.frequency.setValueAtTime(540, t);
      osc.frequency.exponentialRampToValueAtTime(680, t + 0.06);
      // Quick soft attack, smooth decay; low peak gain so it stays unobtrusive.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(lp);
      lp.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    }
    let lastChimeAt = "";
    let chimeReady = false;
    function handleChime(chime) {
      const at = chime && chime.at ? String(chime.at) : "";
      // First poll establishes a baseline without playing, so a chime already
      // sitting in the snapshot at page load does not fire on join.
      if (!chimeReady) { lastChimeAt = at; chimeReady = true; return; }
      if (!at || at === lastChimeAt) return;
      lastChimeAt = at;
      playChime();
    }
    function formatUpdated(value) {
      const date = new Date(String(value || ""));
      if (Number.isNaN(date.getTime())) return "Waiting for live signal";
      return "Updated " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    function initFpsProbe() {
      const target = document.getElementById("render-fps");
      if (!target) return;
      let frames = 0;
      let last = performance.now();
      function tick(now) {
        frames += 1;
        const elapsed = now - last;
        if (elapsed >= 1000) {
          target.textContent = "Render FPS " + Math.round((frames * 1000) / elapsed);
          frames = 0;
          last = now;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
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
      // items arrive newest-first; render oldest-first so the newest line lands
      // at the bottom of the lane (chat order). Keep only the newest 14.
      let lastLabel = "";
      for (const item of items.slice(0, 14).reverse()) {
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
    // Adaptive polling: every poll is a request through the public tunnel
    // (the page is loaded by Recall via the tunnel URL, so same-origin
    // fetches ride it too). Poll fast only while the snapshot is changing;
    // back off when the call goes quiet to preserve tunnel request quota.
    let lastSignature = "";
    let lastActivityAt = Date.now();
    async function refresh() {
      try {
        const response = await fetch("/presence.json", {
          cache: "no-store",
          headers: { "X-Samograph-Presence-Token": token },
        });
        if (!response.ok) return;
        const data = await response.json();
        handleChime(data.chime);
        handleSpeak(data.speak);
        const signature = String(data.updated_at || "");
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastActivityAt = Date.now();
        }
        const state = String(data.state || "listening");
        document.getElementById("live").textContent = state;
        const buckets = { heard: [], comment: [] };
        const activities = Array.isArray(data.activities) ? data.activities : [];
        const now = Date.now();
        const recent = activities.filter((item) => {
          const at = Date.parse(String(item && item.at || ""));
          return Number.isFinite(at) && now - at < 12000;
        }).length;
        activityEnergy = Math.max(activityEnergy * 0.78, Math.min(1, recent / 5));
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
    function nextPollDelay() {
      const active = Date.now() - lastActivityAt < 30000;
      // Avatar mode drives realtime SPEECH off this poll (the speak cue is only
      // picked up on a poll), so it polls faster while active for snappier
      // reactions — its tunnel carries low-rate JSON and is used with a
      // no-request-limit tunnel. Other modes keep the conservative 1 s / 5 s
      // cadence to preserve tunnel request quota.
      if (backgroundMode === "avatar") return active ? 300 : 2000;
      return active ? 1000 : 5000;
    }
    async function pollLoop() {
      await refresh();
      setTimeout(pollLoop, nextPollDelay());
    }
    if (backgroundMode === "robot") {
      initRobot();
    } else if (backgroundMode === "avatar") {
      initAvatar();
    } else {
      initPlasma();
      initFpsProbe();
    }
    // Poll on every background, including the static robot avatar: the loop
    // drives the chime cue and live activity lanes, which must not depend on
    // the animated plasma backgrounds being active.
    pollLoop();
  </script>
</body>
</html>`;
}
