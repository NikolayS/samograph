import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { handleWebhook, serve, tokensEqual } from "../src/server.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

function makeTranscriptEvent(
  speaker: string,
  words: string[],
  timestamp = "2024-01-15T10:30:45.000Z",
): unknown {
  return {
    event: "transcript.data",
    data: {
      data: {
        participant: { name: speaker },
        words: words.map((w) => ({
          text: w,
          start_timestamp: { absolute: timestamp },
        })),
      },
    },
  };
}

describe("webhook handler", () => {
  let tmp: string;
  let tf: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
  });
  afterEach(() => {
    cleanupTmpDir(tmp);
  });

  it("transcript event writes line", async () => {
    await handleWebhook(makeTranscriptEvent("Alice", ["Hello", "world"]), tf);
    const lines = readFileSync(tf, "utf-8").split("\n").filter((l) => l);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Alice");
    expect(lines[0]).toContain("Hello world");
  });

  it("line format: timestamp speaker text", async () => {
    await handleWebhook(
      makeTranscriptEvent("Bob", ["Nice", "to", "meet", "you"], "2024-03-20T14:05:30.123Z"),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toBe(
      "[2024-03-20 14:05:30] Bob: Nice to meet you",
    );
  });

  it("multiple words joined with spaces", async () => {
    await handleWebhook(
      makeTranscriptEvent("Carol", ["one", "two", "three", "four", "five"]),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toContain("one two three four five");
  });

  it("sanitizes speaker and text fields onto one transcript line", async () => {
    await handleWebhook(makeTranscriptEvent("Alice\nInjected", ["hello\r\n", "world"]), tf);
    const lines = readFileSync(tf, "utf-8").split("\n").filter((l) => l);
    expect(lines).toEqual(["[2024-01-15 10:30:45] Alice Injected: hello world"]);
  });

  it("unknown event ignored", async () => {
    await handleWebhook({ event: "some.other.event", data: {} }, tf);
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("missing event field ignored", async () => {
    await handleWebhook({ data: {} }, tf);
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("empty words list not written", async () => {
    await handleWebhook(
      {
        event: "transcript.data",
        data: { data: { participant: { name: "Dan" }, words: [] } },
      },
      tf,
    );
    expect(readFileSync(tf, "utf-8")).toBe("");
  });

  it("multiple events appended", async () => {
    await handleWebhook(makeTranscriptEvent("A", ["first"]), tf);
    await handleWebhook(makeTranscriptEvent("B", ["second"]), tf);
    await handleWebhook(makeTranscriptEvent("C", ["third"]), tf);
    const lines = readFileSync(tf, "utf-8").split("\n").filter((l) => l);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("third");
  });

  it("missing speaker defaults to question mark", async () => {
    await handleWebhook(
      {
        event: "transcript.data",
        data: {
          data: {
            words: [
              { text: "hi", start_timestamp: { absolute: "2024-01-01T00:00:00Z" } },
            ],
          },
        },
      },
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toBe("[2024-01-01 00:00:00] ?: hi");
  });

  it("timestamp truncated to seconds", async () => {
    await handleWebhook(
      makeTranscriptEvent("Eve", ["test"], "2025-12-31T23:59:59.999999Z"),
      tf,
    );
    expect(readFileSync(tf, "utf-8").trim()).toStartWith(
      "[2025-12-31 23:59:59]",
    );
  });

  it("Bun.serve round trip POST /webhook with token", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=secret-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Zed", ["roundtrip"])),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(readFileSync(tf, "utf-8")).toContain("Zed: roundtrip");
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve rejects POST /webhook without token", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Mallory", ["inject"])),
      });
      expect(resp.status).toBe(403);
      expect(readFileSync(tf, "utf-8")).toBe("");
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve rejects oversized webhook payloads", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const largeBody = "x".repeat(1024 * 1024 + 1);
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=secret-token`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: largeBody,
      });
      expect(resp.status).toBe(413);
      expect(readFileSync(tf, "utf-8")).toBe("");
    } finally {
      server.stop(true);
    }
  });

  it("accepts a webhook body of exactly 1 MB (boundary)", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const body = "x".repeat(1024 * 1024);
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=secret-token`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
    } finally {
      server.stop(true);
    }
  });

  it("rejects oversized bodies at the transport layer, before token checks", async () => {
    // With maxRequestBodySize set, Bun 1.3.x answers 413 itself when
    // Content-Length exceeds the cap — the fetch handler (and therefore the
    // token check, which would otherwise return 403) never runs.
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=wrong-token`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "x".repeat(1024 * 1024 + 1),
      });
      expect(resp.status).toBe(413);
    } finally {
      server.stop(true);
    }
  });

  it("frame routes reject missing token", async () => {
    const server = serve(0, tf, { webhookToken: "webhook-token", frameToken: "frame-token" });
    try {
      const resp = await fetch(`http://localhost:${server.port}/frame`);
      const meta = await fetch(`http://localhost:${server.port}/frame.json`);
      expect(resp.status).toBe(403);
      expect(meta.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("presence page and json are token gated and start in listening state", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const blocked = await fetch(`http://localhost:${server.port}/presence`);
      expect(blocked.status).toBe(403);

      const page = await fetch(`http://localhost:${server.port}/presence?token=presence-token`);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("samograph-presence");
      expect(html).toContain("Heard");
      expect(html).toContain("Comments");
      expect(html).toContain("samoagent");
      expect(html).toContain("plasma-canvas");
      expect(html).toContain("initPlasma");
      expect(html).toContain("drawSpherePlasma");
      expect(html).toContain("backgroundMode");
      // unknown bg values fall back to the robot avatar (the default look)
      expect(html).toContain(
        "[\"robot\", \"sphere\", \"field\", \"static\", \"cycle\", \"avatar\"].includes(bgParam) ? bgParam : \"robot\"",
      );
      expect(html).toContain("backgroundMode === \"cycle\"");
      expect(html).toContain("const frameMs = 100");
      expect(html).toContain("-webkit-line-clamp: 2");
      expect(html).toContain("flex-direction: column");
      expect(html).toContain("items.slice(0, 14)");
      expect(html).toContain("label.classList.add(\"repeated\")");
      expect(html).toContain("backgroundMode !== \"static\"");
      expect(html).toContain("Render FPS");
      expect(html).toContain("initFpsProbe");
      expect(html).toContain("scheduleRedraw");
      expect(html).toContain("nextW === w && nextH === h");

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      expect(jsonResp.status).toBe(200);
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        activities: unknown[];
      };
      expect(json.state).toBe("listening");
      expect(json.message).toBe("Listening");
      expect(json.activities).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  it("transcript webhook appends heard activity without resetting state or message", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const before = await (
        await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      })
      ).json() as { updated_at: string };

      const resp = await fetch(`http://localhost:${server.port}/webhook?token=webhook-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Nik", ["We", "need", "action"])),
      });
      expect(resp.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        updated_at: string;
        activities: Array<{ kind: string; label: string; text: string }>;
      };
      expect(json).toMatchObject({
        state: "listening",
        message: "Listening",
      });
      expect(Date.parse(json.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));
      expect(json.activities[0]).toMatchObject({
        kind: "heard",
        label: "Nik",
        text: "We need action",
      });
      expect(json.activities).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  it("transcript webhook preserves agent-set presence state", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const updated = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "write-token",
        },
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect(updated.status).toBe(200);

      const resp = await fetch(`http://localhost:${server.port}/webhook?token=webhook-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Nik", ["We", "need", "action"])),
      });
      expect(resp.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        activities: Array<{ kind: string; label: string; text: string }>;
      };
      expect(json).toMatchObject({
        state: "thinking",
        message: "Checking indexes",
      });
      expect(json.activities[0]).toMatchObject({
        kind: "heard",
        label: "Nik",
        text: "We need action",
      });
    } finally {
      server.stop(true);
    }
  });

  it("presence update changes later presence json", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const blocked = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect(blocked.status).toBe(403);

      const queryOnly = await fetch(`http://localhost:${server.port}/presence?token=write-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "acting", message: "Query token should not update" }),
      });
      expect(queryOnly.status).toBe(403);

      const readToken = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "presence-token",
        },
        body: JSON.stringify({ state: "acting", message: "Read token should not update" }),
      });
      expect(readToken.status).toBe(403);

      const updated = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "write-token",
        },
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect(updated.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        activities: Array<{ kind: string; label: string; text: string }>;
      };
      expect(json).toMatchObject({
        state: "thinking",
        message: "Checking indexes",
      });
      expect(json.activities[0]).toMatchObject({
        kind: "comment",
        label: "Comment",
        text: "Checking indexes",
      });
    } finally {
      server.stop(true);
    }
  });

  it("POST /chime sets a chime timestamp visible in presence json", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const blocked = await fetch(`http://localhost:${server.port}/chime`, { method: "POST" });
      expect(blocked.status).toBe(403);

      const ok = await fetch(`http://localhost:${server.port}/chime`, {
        method: "POST",
        headers: { "X-Samograph-Presence-Token": "write-token" },
      });
      expect(ok.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as { chime: { at: string } | null };
      expect(json.chime).not.toBeNull();
      expect(Number.isNaN(Date.parse(json.chime?.at ?? ""))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("bare state toggle without message uses the default message and adds no activity", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const updated = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "write-token",
        },
        body: JSON.stringify({ state: "idle" }),
      });
      expect(updated.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        activities: unknown[];
      };
      expect(json).toMatchObject({ state: "idle", message: "Idle" });
      expect(json.activities).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  it("empty and whitespace-only messages behave as bare toggles (no activity)", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      for (const [message, state, defaultMessage] of [
        ["", "thinking", "Checking"],
        ["   ", "acting", "Working"],
      ] as const) {
        const updated = await fetch(`http://localhost:${server.port}/presence`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Samograph-Presence-Token": "write-token",
          },
          body: JSON.stringify({ state, message }),
        });
        expect(updated.status).toBe(200);

        const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
          headers: { "X-Samograph-Presence-Token": "presence-token" },
        });
        const json = await jsonResp.json() as {
          state: string;
          message: string;
          activities: unknown[];
        };
        expect(json).toMatchObject({ state, message: defaultMessage });
        expect(json.activities).toEqual([]);
      }
    } finally {
      server.stop(true);
    }
  });

  it("presence update rejects invalid state", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "write-token",
        },
        body: JSON.stringify({ state: "confused" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  it("presence GET routes work with read token even when a write token is configured", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const page = await fetch(`http://localhost:${server.port}/presence?token=presence-token`);
      expect(page.status).toBe(200);
      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      expect(jsonResp.status).toBe(200);
      const writeOnGet = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "write-token" },
      });
      expect(writeOnGet.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("presence routes fail closed when no presence token is configured", async () => {
    const server = serve(0, tf, { webhookToken: "webhook-token" });
    try {
      const page = await fetch(`http://localhost:${server.port}/presence?token=anything`);
      expect(page.status).toBe(403);
      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json?token=anything`);
      expect(jsonResp.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("presence GET routes accept the read token via header", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const page = await fetch(`http://localhost:${server.port}/presence`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      expect(page.status).toBe(200);
      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      expect(jsonResp.status).toBe(200);

      const wrongPage = await fetch(`http://localhost:${server.port}/presence`, {
        headers: { "X-Samograph-Presence-Token": "wrong-token" },
      });
      expect(wrongPage.status).toBe(403);
      const wrongJson = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "wrong-token" },
      });
      expect(wrongJson.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("presence.json accepts the read token only via header, never via query", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const viaQuery = await fetch(`http://localhost:${server.port}/presence.json?token=presence-token`);
      expect(viaQuery.status).toBe(403);
      const viaHeader = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      expect(viaHeader.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  it("presence page polls adaptively: 1s while active, 5s after 30s idle", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const page = await fetch(`http://localhost:${server.port}/presence?token=presence-token`);
      expect(page.status).toBe(200);
      const html = await page.text();
      // adaptive rescheduling replaces the fixed 1 s interval — every poll is
      // a request through the tunnel, so an idle call must not burn quota
      expect(html).not.toContain("setInterval(refresh");
      expect(html).toContain("setTimeout(pollLoop");
      // 1000 ms polls while something changed within the last 30000 ms,
      // backing off to 5000 ms when idle (avatar mode polls faster; see
      // presence-page tests)
      expect(html).toContain("< 30000");
      expect(html).toContain("active ? 1000 : 5000");
      // activity is detected by comparing the snapshot's updated_at stamp
      expect(html).toContain("!== lastSignature");
    } finally {
      server.stop(true);
    }
  });

  it("presence page polls presence.json with the header token, not the query token", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const page = await fetch(`http://localhost:${server.port}/presence?token=presence-token`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("X-Samograph-Presence-Token");
      expect(html).not.toContain("/presence.json?token=");
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve rejects oversized presence payloads", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const largeBody = "x".repeat(1024 * 1024 + 1);
      const resp = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Samograph-Presence-Token": "write-token",
        },
        body: largeBody,
      });
      expect(resp.status).toBe(413);
    } finally {
      server.stop(true);
    }
  });

  it("accepts a presence body of exactly 1 MB (boundary)", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
      presenceWriteToken: "write-token",
    });
    try {
      const prefix = '{"state":"thinking","message":"';
      const suffix = '"}';
      const body =
        prefix +
        "x".repeat(1024 * 1024 - prefix.length - suffix.length) +
        suffix;
      expect(new TextEncoder().encode(body).byteLength).toBe(1024 * 1024);
      const resp = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samograph-Presence-Token": "write-token",
        },
        body,
      });
      expect(resp.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  it("binds to loopback only", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });

  it("keeps only the newest ACTIVITY_LIMIT activities end-to-end", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      for (let i = 1; i <= 17; i++) {
        const resp = await fetch(`http://localhost:${server.port}/webhook?token=webhook-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeTranscriptEvent("Nik", ["line", String(i)])),
        });
        expect(resp.status).toBe(200);
      }
      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json`, {
        headers: { "X-Samograph-Presence-Token": "presence-token" },
      });
      const json = await jsonResp.json() as { activities: Array<{ text: string }> };
      expect(json.activities).toHaveLength(16);
      expect(json.activities[0]!.text).toBe("line 17");
      expect(json.activities[15]!.text).toBe("line 2");
      expect(json.activities.some((a) => a.text === "line 1")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("video websocket stores latest frame in memory and frame routes require token", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      frameToken: "frame-token",
      currentCallId: () => "bot-123",
    });
    try {
      const publicWs = await fetch(`http://localhost:${server.port}/video-ws`);
      expect(publicWs.status).toBe(403);

      const ws = new WebSocket(`ws://localhost:${server.port}/video-ws?token=frame-token`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("websocket open failed"));
      });
      ws.send(JSON.stringify({
        event: "video_separate_png.data",
        data: {
          data: {
            buffer: Buffer.from([1, 2, 3]).toString("base64"),
            type: "webcam",
            participant: { id: "p1", name: "Alice", is_host: true },
            timestamp: { absolute: "2026-05-30T15:00:00Z" },
          },
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const blocked = await fetch(`http://localhost:${server.port}/frame`);
      expect(blocked.status).toBe(403);

      const frame = await fetch(`http://localhost:${server.port}/frame`, {
        headers: { "X-Samograph-Frame-Token": "frame-token" },
      });
      expect(frame.status).toBe(200);
      expect(new Uint8Array(await frame.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const meta = await fetch(`http://localhost:${server.port}/frame.json`, {
        headers: { "X-Samograph-Frame-Token": "frame-token" },
      });
      expect(meta.status).toBe(200);
      const json = (await meta.json()) as { call_id: string; participant: { id: string } };
      expect(json.call_id).toBe("bot-123");
      expect(json.participant.id).toBe("p1");
      ws.close();
    } finally {
      server.stop(true);
    }
  });

  it("video websocket stores latest frame per source and exposes inventory", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      frameToken: "frame-token",
      currentCallId: () => "bot-123",
    });
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}/video-ws?token=frame-token`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("websocket open failed"));
      });
      ws.send(JSON.stringify({
        event: "video_separate_png.data",
        data: {
          data: {
            buffer: Buffer.from([1, 1, 1]).toString("base64"),
            type: "webcam",
            participant: { id: "p1", name: "Alice", is_host: true },
            timestamp: { absolute: "2026-05-30T15:00:00Z" },
          },
        },
      }));
      ws.send(JSON.stringify({
        event: "video_separate_png.data",
        data: {
          data: {
            buffer: Buffer.from([2, 2, 2]).toString("base64"),
            type: "screen_share",
            participant: { id: "screen", name: "Screen", is_host: false },
            timestamp: { absolute: "2026-05-30T15:00:01Z" },
          },
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const inventory = await fetch(`http://localhost:${server.port}/frames.json`, {
        headers: { "X-Samograph-Frame-Token": "frame-token" },
      });
      expect(inventory.status).toBe(200);
      const json = (await inventory.json()) as {
        frames: Array<{ source_key: string; type: string; participant: { id: string } }>;
      };
      expect(json.frames.map((f) => f.source_key).sort()).toEqual([
        "participant:p1",
        "type:screen_share",
      ]);

      const screen = await fetch(`http://localhost:${server.port}/frame?source=screen`, {
        headers: { "X-Samograph-Frame-Token": "frame-token" },
      });
      expect(screen.status).toBe(200);
      expect(new Uint8Array(await screen.arrayBuffer())).toEqual(new Uint8Array([2, 2, 2]));

      const webcam = await fetch(`http://localhost:${server.port}/frame?source=participant:p1`, {
        headers: { "X-Samograph-Frame-Token": "frame-token" },
      });
      expect(webcam.status).toBe(200);
      expect(new Uint8Array(await webcam.arrayBuffer())).toEqual(new Uint8Array([1, 1, 1]));
      ws.close();
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve rejects all requests when no token configured", async () => {
    const server = serve(0, tf, "");
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("X", ["test"])),
      });
      expect(resp.status).toBe(403);
      expect(readFileSync(tf, "utf-8")).toBe("");
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve returns 404 for GET /webhook", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(
        `http://localhost:${server.port}/webhook?token=secret-token`,
      );
      expect(resp.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve returns 404 for unknown paths", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(`http://localhost:${server.port}/health`, {
        method: "POST",
      });
      expect(resp.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  it("GET /health echoes the nonce and includes the health marker, no token needed", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(
        `http://localhost:${server.port}/health?nonce=abc-123`,
      );
      expect(resp.status).toBe(200);
      const json = await resp.json() as { ok: boolean; nonce: string; marker: string };
      expect(json.ok).toBe(true);
      expect(json.nonce).toBe("abc-123");
      expect(json.marker).toBe("samograph-health");
    } finally {
      server.stop(true);
    }
  });

  it("GET /health without a nonce still answers with the marker", async () => {
    const server = serve(0, tf, "secret-token");
    try {
      const resp = await fetch(`http://localhost:${server.port}/health`);
      expect(resp.status).toBe(200);
      const json = await resp.json() as { ok: boolean; nonce: string; marker: string };
      expect(json.ok).toBe(true);
      expect(json.nonce).toBe("");
      expect(json.marker).toBe("samograph-health");
    } finally {
      server.stop(true);
    }
  });

  it("Bun.serve ignores invalid JSON body gracefully", async () => {
    const server = serve(0, tf, "tok");
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=tok`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }}}",
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
      expect(readFileSync(tf, "utf-8")).toBe("");
    } finally {
      server.stop(true);
    }
  });

  it("tokensEqual compares tokens in constant time semantics", () => {
    expect(tokensEqual("secret", "secret")).toBe(true);
    expect(tokensEqual("secret", "Secret")).toBe(false);
    expect(tokensEqual("secret", "secret-longer")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
    expect(tokensEqual(null, "secret")).toBe(false);
    expect(tokensEqual("secret", null)).toBe(false);
    expect(tokensEqual(undefined, undefined)).toBe(false);
  });

  it("Bun.serve rejects wrong token", async () => {
    const server = serve(0, tf, "correct-token");
    try {
      const resp = await fetch(
        `http://localhost:${server.port}/webhook?token=wrong-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeTranscriptEvent("A", ["hi"])),
        },
      );
      expect(resp.status).toBe(403);
      expect(readFileSync(tf, "utf-8")).toBe("");
    } finally {
      server.stop(true);
    }
  });
});
