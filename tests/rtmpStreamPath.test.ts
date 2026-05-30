import { describe, it, expect } from "bun:test";
import { rtmpStreamPath } from "../src/rtmp.ts";

describe("rtmpStreamPath", () => {
  it("simple path", () => {
    expect(rtmpStreamPath("rtmp://1.2.3.4:1935/live/call")).toBe("live/call");
  });

  it("single segment", () => {
    expect(rtmpStreamPath("rtmp://host:1935/stream")).toBe("stream");
  });

  it("deep path", () => {
    expect(rtmpStreamPath("rtmp://host/a/b/c")).toBe("a/b/c");
  });

  it("no path", () => {
    expect(rtmpStreamPath("rtmp://host:1935/")).toBe("");
  });

  it("localhost url", () => {
    expect(rtmpStreamPath("rtmp://localhost:1935/live/call")).toBe("live/call");
  });
});
