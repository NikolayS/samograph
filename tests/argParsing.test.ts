import { describe, it, expect } from "bun:test";
import { parseArgs } from "../src/cli.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("argParsing", () => {
  it("join requires url", () => {
    expect(() => parseArgs(["join"])).toThrow();
  });

  it("join parses url", () => {
    const args = parseArgs(["join", "https://zoom.us/j/123"]);
    expect(args.url).toBe("https://zoom.us/j/123");
    expect(args.command).toBe("join");
  });

  it("join default port", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).port).toBe(8080);
  });

  it("join custom port", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--port", "9090"]).port,
    ).toBe(9090);
  });

  it("join rtmp-url optional", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).rtmp_url).toBeNull();
  });

  it("join rtmp-url parsed", () => {
    const args = parseArgs([
      "join",
      "https://zoom.us/j/1",
      "--rtmp-url",
      "rtmp://1.2.3.4:1935/live/call",
    ]);
    expect(args.rtmp_url).toBe("rtmp://1.2.3.4:1935/live/call");
  });

  it("join name optional", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).name).toBeNull();
  });

  it("join dict defaults to postgresfm", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).dict).toBe("postgresfm");
  });

  it("join rtmp flag default false", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).rtmp).toBe(false);
  });

  it("join rtmp flag set", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1", "--rtmp"]).rtmp).toBe(true);
  });

  it("join ws-video default true", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).ws_video).toBe(true);
  });

  it("join ws-video can be disabled with --no-ws-video", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1", "--no-ws-video"]).ws_video).toBe(false);
  });

  it("join no-presence default false", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).no_presence).toBe(false);
  });

  it("join no-presence parsed", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1", "--no-presence"]).no_presence).toBe(true);
  });

  it("join presence-bg default null", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).presence_bg).toBeNull();
  });

  it("join presence-bg accepts the four background modes", () => {
    for (const bg of ["sphere", "field", "static", "cycle"]) {
      expect(
        parseArgs(["join", "https://zoom.us/j/1", "--presence-bg", bg]).presence_bg,
      ).toBe(bg);
    }
  });

  it("join presence-bg rejects unknown values", () => {
    expect(() =>
      parseArgs(["join", "https://zoom.us/j/1", "--presence-bg", "lava-lamp"]),
    ).toThrow("invalid choice");
  });

  it("join frame-dir parsed", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--frame-dir", "/tmp/frames"]).frame_dir,
    ).toBe("/tmp/frames");
  });

  it("join variant defaults to web_4_core", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).variant).toBe("web_4_core");
  });

  it("join variant parsed", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--variant", "web_4_core"]).variant,
    ).toBe("web_4_core");
  });

  it("join variant accepts web", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--variant", "web"]).variant,
    ).toBe("web");
  });

  it("join variant accepts web_gpu", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--variant", "web_gpu"]).variant,
    ).toBe("web_gpu");
  });

  it("join variant rejects unknown values", () => {
    expect(() =>
      parseArgs(["join", "https://zoom.us/j/1", "--variant", "big-box"]),
    ).toThrow("invalid choice");
  });

  it("leave bot_id optional", () => {
    expect(parseArgs(["leave"]).bot_id).toBeNull();
  });

  it("leave bot_id explicit", () => {
    expect(parseArgs(["leave", "bot-abc"]).bot_id).toBe("bot-abc");
  });

  it("chat requires message", () => {
    expect(() => parseArgs(["chat"])).toThrow();
  });

  it("chat message parsed", () => {
    expect(parseArgs(["chat", "Hello meeting"]).message).toBe("Hello meeting");
  });

  it("presence parses state and message", () => {
    const args = parseArgs(["presence", "thinking", "Checking", "indexes"]);
    expect(args.command).toBe("presence");
    expect(args.presence_state).toBe("thinking");
    expect(args.message).toBe("Checking indexes");
  });

  it("presence requires state", () => {
    expect(() => parseArgs(["presence"])).toThrow();
  });

  it("presence rejects invalid state at parse time", () => {
    expect(() => parseArgs(["presence", "confused"])).toThrow(
      "argument state: invalid choice: 'confused' (choose from listening, thinking, speaking, acting, idle)",
    );
  });

  it("presence keeps accepting mixed-case states", () => {
    const args = parseArgs(["presence", "Thinking", "Checking", "indexes"]);
    expect(args.presence_state).toBe("Thinking");
    expect(args.message).toBe("Checking indexes");
  });

  it("dicts subcommand", () => {
    expect(parseArgs(["dicts"]).command).toBe("dicts");
  });

  it("watch subcommand", () => {
    expect(parseArgs(["watch"]).command).toBe("watch");
  });

  it("transcript cursor options", () => {
    const args = parseArgs([
      "transcript",
      "--local",
      "--file",
      "/tmp/transcript.txt",
      "--cursor",
      "20",
      "--limit",
      "10",
      "bot-abc",
    ]);
    expect(args.command).toBe("transcript");
    expect(args.bot_id).toBe("bot-abc");
    expect(args.transcript_local).toBe(true);
    expect(args.transcript_file).toBe("/tmp/transcript.txt");
    expect(args.transcript_cursor).toBe(20);
    expect(args.transcript_limit).toBe(10);
  });

  it("doctor subcommand", () => {
    expect(parseArgs(["doctor"]).command).toBe("doctor");
  });

  it("notes subcommand parses Google Doc options", () => {
    const args = parseArgs([
      "notes",
      "action",
      "Open",
      "issue",
      "--doc-id",
      "doc-123",
      "--credentials",
      "/tmp/google.json",
      "--owner",
      "Nik",
      "--due",
      "2026-06-07",
    ]);
    expect(args.command).toBe("notes");
    expect(args.notes_action).toBe("action");
    expect(args.message).toBe("Open issue");
    expect(args.doc_id).toBe("doc-123");
    expect(args.credentials).toBe("/tmp/google.json");
    expect(args.owner).toBe("Nik");
    expect(args.due).toBe("2026-06-07");
  });

  it("frame default out", () => {
    expect(parseArgs(["frame"]).out).toBeNull();
  });

  it("frame custom out", () => {
    expect(parseArgs(["frame", "--out", "myframe.png"]).out).toBe("myframe.png");
  });

  it("frame archive flag", () => {
    expect(parseArgs(["frame", "--archive"]).archive).toBe(true);
  });

  it("frame source option", () => {
    const args = parseArgs(["frame", "--source", "screen", "--out", "screen.png"]);
    expect(args.frame_source).toBe("screen");
    expect(args.out).toBe("screen.png");
  });

  it("frames command", () => {
    expect(parseArgs(["frames"]).command).toBe("frames");
  });

  it("screenshot default out", () => {
    expect(parseArgs(["screenshot"]).out).toBe("screenshot.png");
  });

  it("serve requires transcript-file", () => {
    expect(() => parseArgs(["_serve"])).toThrow();
  });

  it("serve parses transcript-file", () => {
    expect(
      parseArgs(["_serve", "--transcript-file", "/tmp/t.txt"]).transcript_file,
    ).toBe("/tmp/t.txt");
  });

  it("serve parses frame token and call id file", () => {
    const args = parseArgs([
      "_serve",
      "--transcript-file",
      "/tmp/t.txt",
      "--call-id-file",
      "/tmp/state.json",
      "--frame-token",
      "secret",
      "--presence-token",
      "presence-secret",
      "--presence-write-token",
      "write-secret",
    ]);
    expect(args.call_id_file).toBe("/tmp/state.json");
    expect(args.frame_token).toBe("secret");
    expect(args.presence_token).toBe("presence-secret");
    expect(args.presence_write_token).toBe("write-secret");
  });

  it("invalid command throws", () => {
    expect(() => parseArgs(["bogus"])).toThrow();
  });

  it("join rejects port 0", () => {
    expect(() => parseArgs(["join", "https://zoom.us/j/1", "--port", "0"])).toThrow();
  });

  it("join rejects port 65536", () => {
    expect(() => parseArgs(["join", "https://zoom.us/j/1", "--port", "65536"])).toThrow();
  });

  it("join rejects negative port", () => {
    expect(() => parseArgs(["join", "https://zoom.us/j/1", "--port", "-1"])).toThrow();
  });

  it("join rejects non-numeric port", () => {
    expect(() => parseArgs(["join", "https://zoom.us/j/1", "--port", "abc"])).toThrow();
  });

  it("join accepts port 1", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1", "--port", "1"]).port).toBe(1);
  });

  it("join accepts port 65535", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1", "--port", "65535"]).port).toBe(65535);
  });

  it("join webhook-base default null", () => {
    expect(parseArgs(["join", "https://meet.google.com/abc"]).webhook_base).toBeNull();
  });

  it("join webhook-base parsed", () => {
    expect(
      parseArgs(["join", "https://meet.google.com/abc", "--webhook-base", "https://my-tunnel.example"]).webhook_base,
    ).toBe("https://my-tunnel.example");
  });

  it("--help uses current product positioning", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Put your AI agent in Zoom and Google Meet calls.");
    expect(stdout).toContain("streams live transcript lines");
    expect(stdout).not.toContain("Meeting I/O helper");
  });

  it("join --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "join", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph join <url>");
    expect(stdout).toContain("--no-ws-video");
    expect(stdout).toContain("--rtmp-url URL");
    expect(stdout).toContain("--no-presence");
    expect(stdout).toContain("--presence-bg");
    expect(stdout).toContain("sphere|field|static|cycle");
  });

  it("presence --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "presence", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph presence <state>");
    expect(stdout).toContain("listening|thinking|speaking|acting|idle");
  });

  it("frame --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "frame", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph frame");
    expect(stdout).toContain("frames stay in memory");
    expect(stdout).toContain("--source SOURCE");
    expect(stdout).toContain("--archive");
  });

  it("frames --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "frames", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph frames");
    expect(stdout).toContain("List WebSocket frame sources");
  });

  it("doctor --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "doctor", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph doctor");
    expect(stdout).toContain("Check local prerequisites");
  });

  it("notes --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "notes", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph notes");
    expect(stdout).toContain("--doc-id ID");
  });

  it("transcript --help shows command-specific help", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "transcript", "--help"], { cwd: repoRoot });
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: samograph transcript");
    expect(stdout).toContain("--cursor N");
    expect(stdout).toContain("--file FILE");
    expect(stdout).toContain("--limit N");
  });

  it("-v prints version and exits 0", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "-v"], { cwd: repoRoot });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toMatch(/^samograph \d+\.\d+\.\d+/);
  });

  it("--version prints version and exits 0", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "--version"], { cwd: repoRoot });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toMatch(/^samograph \d+\.\d+\.\d+/);
  });

  it("-V is not a version alias (lowercase -v only)", () => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", "-V"], { cwd: repoRoot });
    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).not.toMatch(/^samograph \d+\.\d+\.\d+/);
  });
});
