import { describe, it, expect } from "bun:test";
import { parseArgs } from "../src/cli.ts";

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

  it("join dict optional", () => {
    expect(parseArgs(["join", "https://zoom.us/j/1"]).dict).toBeNull();
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

  it("join frame-dir parsed", () => {
    expect(
      parseArgs(["join", "https://zoom.us/j/1", "--frame-dir", "/tmp/frames"]).frame_dir,
    ).toBe("/tmp/frames");
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

  it("dicts subcommand", () => {
    expect(parseArgs(["dicts"]).command).toBe("dicts");
  });

  it("watch subcommand", () => {
    expect(parseArgs(["watch"]).command).toBe("watch");
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
    ]);
    expect(args.call_id_file).toBe("/tmp/state.json");
    expect(args.frame_token).toBe("secret");
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
});
