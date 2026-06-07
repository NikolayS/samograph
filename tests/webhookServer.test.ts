import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { handleWebhook, serve } from "../src/server.ts";
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
      expect(html).toContain("samoagent-presence");
      expect(html).toContain("Heard");
      expect(html).toContain("Thinks");
      expect(html).toContain("Says");
      expect(html).toContain("plasma-canvas");
      expect(html).toContain("initPlasma");
      expect(html).toContain("drawSpherePlasma");
      expect(html).toContain("backgroundMode");
      expect(html).toContain("params.get(\"bg\") || \"static\"");
      expect(html).toContain("const frameMs = 250");
      expect(html).toContain("-webkit-line-clamp: 7");
      expect(html).toContain("grid-template-rows: repeat(2, minmax(0, 1fr))");
      expect(html).toContain("label.classList.add(\"repeated\")");
      expect(html).toContain("backgroundMode !== \"static\"");
      expect(html).toContain("animation: drift 16s steps(48, end)");
      expect(html).toContain("@keyframes drift");

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json?token=presence-token`);
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

  it("transcript webhook updates presence with heard activity", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/webhook?token=webhook-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTranscriptEvent("Nik", ["We", "need", "action"])),
      });
      expect(resp.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json?token=presence-token`);
      const json = await jsonResp.json() as {
        state: string;
        message: string;
        activities: Array<{ kind: string; label: string; text: string }>;
      };
      expect(json).toMatchObject({
        state: "listening",
        message: "Heard Nik: We need action",
      });
      expect(json.activities[0]).toMatchObject({
        kind: "thought",
        label: "Thinking",
        text: "Processing latest speech: We need action",
      });
      expect(json.activities[1]).toMatchObject({
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
    });
    try {
      const blocked = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect(blocked.status).toBe(403);

      const queryOnly = await fetch(`http://localhost:${server.port}/presence?token=presence-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "acting", message: "Query token should not update" }),
      });
      expect(queryOnly.status).toBe(403);

      const updated = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samoagent-Presence-Token": "presence-token",
        },
        body: JSON.stringify({ state: "thinking", message: "Checking indexes" }),
      });
      expect(updated.status).toBe(200);

      const jsonResp = await fetch(`http://localhost:${server.port}/presence.json?token=presence-token`);
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
        kind: "thought",
        label: "Thinking",
        text: "Checking indexes",
      });
    } finally {
      server.stop(true);
    }
  });

  it("presence update rejects invalid state", async () => {
    const server = serve(0, tf, {
      webhookToken: "webhook-token",
      presenceToken: "presence-token",
    });
    try {
      const resp = await fetch(`http://localhost:${server.port}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Samoagent-Presence-Token": "presence-token",
        },
        body: JSON.stringify({ state: "confused" }),
      });
      expect(resp.status).toBe(400);
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
        headers: { "X-Samoagent-Frame-Token": "frame-token" },
      });
      expect(frame.status).toBe(200);
      expect(new Uint8Array(await frame.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const meta = await fetch(`http://localhost:${server.port}/frame.json`, {
        headers: { "X-Samoagent-Frame-Token": "frame-token" },
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
