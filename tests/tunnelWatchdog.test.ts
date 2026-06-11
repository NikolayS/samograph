import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTunnelWatchdog, type TunnelWatchdogHandle } from "../src/server.ts";
import { SENTINEL_RE } from "../src/transcript.ts";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

function healthOk(url: string): Response {
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  return Response.json({ ok: true, nonce, marker: "samograph-health" });
}

const WARNING_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOGRAPH-WARNING: tunnel unreachable/;

describe("startTunnelWatchdog", () => {
  let tmp: string;
  let tf: string;
  let scheduled: Array<{ ms: number }>;
  let stderrOut: string[];

  beforeEach(() => {
    tmp = makeTmpDir();
    tf = join(tmp, "transcript.txt");
    writeFileSync(tf, "");
    scheduled = [];
    stderrOut = [];
  });
  afterEach(() => {
    cleanupTmpDir(tmp);
  });

  function makeWatchdog(
    fetchImpl: (url: string) => Promise<Response>,
  ): TunnelWatchdogHandle {
    const handle = startTunnelWatchdog({
      publicBase: "https://tunnel.example",
      transcriptPath: tf,
      fetch: async (url) => fetchImpl(url),
      stderr: (s) => {
        stderrOut.push(s);
      },
      schedule: (_fn, ms) => {
        scheduled.push({ ms });
        return { stop() {} };
      },
    });
    expect(handle).not.toBeNull();
    return handle!;
  }

  function transcriptLines(): string[] {
    return readFileSync(tf, "utf-8").split("\n").filter((l) => l);
  }

  it("returns null when no public base is configured", () => {
    expect(
      startTunnelWatchdog({ publicBase: "", transcriptPath: tf }),
    ).toBeNull();
    expect(
      startTunnelWatchdog({ publicBase: null, transcriptPath: tf }),
    ).toBeNull();
    expect(
      startTunnelWatchdog({ publicBase: undefined, transcriptPath: tf }),
    ).toBeNull();
  });

  it("schedules health probes every 60s by default", () => {
    makeWatchdog(async (url) => healthOk(url));
    expect(scheduled).toEqual([{ ms: 60000 }]);
  });

  it("warns once into the transcript after 2 consecutive failures, no spam", async () => {
    const wd = makeWatchdog(async () => {
      throw new Error("tunnel down");
    });

    await wd.tick();
    // one failure could be a blip — not yet
    expect(transcriptLines()).toEqual([]);

    await wd.tick();
    const lines = transcriptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(WARNING_RE);
    expect(lines[0]).toContain("transcript may be incomplete");
    expect(lines[0]).toContain("rejoin with --tunnel cloudflared or --webhook-base");
    // it must look like a transcript line (so `watch` relays it) but must NOT
    // be the call-ended sentinel (watch would exit)
    expect(SENTINEL_RE.test(lines[0]!)).toBe(false);
    // mirrored to stderr
    expect(stderrOut.join("")).toContain("SAMOGRAPH-WARNING: tunnel unreachable");

    // continued failures: warn once per outage, never spam
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toHaveLength(1);
  });

  it("names the ngrok error code in the warning when the tunnel reports one", async () => {
    const wd = makeWatchdog(
      async () =>
        new Response("limit page", {
          status: 402,
          headers: { "ngrok-error-code": "ERR_NGROK_727" },
        }),
    );
    await wd.tick();
    await wd.tick();
    const lines = transcriptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(ERR_NGROK_727)");
  });

  it("a response that does not echo the nonce counts as a failure", async () => {
    const wd = makeWatchdog(async () =>
      Response.json({ ok: true, nonce: "stale", marker: "samograph-health" }),
    );
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toHaveLength(1);
    expect(transcriptLines()[0]).toMatch(WARNING_RE);
  });

  it("writes a single recovery line when the tunnel comes back", async () => {
    let down = true;
    const wd = makeWatchdog(async (url) => {
      if (down) throw new Error("down");
      return healthOk(url);
    });

    await wd.tick();
    await wd.tick(); // outage warning
    down = false;
    await wd.tick(); // recovery
    let lines = transcriptLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("SAMOGRAPH-WARNING: tunnel recovered");

    // further successes do not repeat the recovery line
    await wd.tick();
    expect(transcriptLines()).toHaveLength(2);

    // a fresh outage warns again (once)
    down = true;
    await wd.tick();
    await wd.tick();
    lines = transcriptLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(WARNING_RE);
  });

  it("success without a prior outage writes nothing", async () => {
    const wd = makeWatchdog(async (url) => healthOk(url));
    await wd.tick();
    await wd.tick();
    expect(transcriptLines()).toEqual([]);
    expect(stderrOut).toEqual([]);
  });

  it("an isolated single failure between successes never warns", async () => {
    let fail = false;
    const wd = makeWatchdog(async (url) => {
      if (fail) throw new Error("blip");
      return healthOk(url);
    });
    await wd.tick();
    fail = true;
    await wd.tick(); // 1 failure
    fail = false;
    await wd.tick(); // success resets the counter
    fail = true;
    await wd.tick(); // 1 failure again
    expect(transcriptLines()).toEqual([]);
  });
});
