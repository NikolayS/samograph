import { describe, it, expect } from "bun:test";
import {
  decodeVideoSeparatePng,
  frameSourceKey,
  normalizeFrameSource,
  selectFrame,
  type StoredFrame,
} from "../src/frameStore.ts";

function f(id: string | null, type: string, receivedAt: number, byte: number): StoredFrame {
  const metadata = { type, participant: { id } } as StoredFrame["metadata"];
  metadata.source_key = frameSourceKey(metadata);
  return { raw: new Uint8Array([byte]), metadata, receivedAt };
}

describe("frame keying", () => {
  it("keys by participant AND type; Recall's 'screenshare' spelling is recognized", () => {
    expect(frameSourceKey({ type: "webcam", participant: { id: 300 } })).toBe("participant:300:webcam");
    expect(frameSourceKey({ type: "screenshare", participant: { id: 300 } })).toBe("participant:300:screenshare");
    expect(frameSourceKey({ type: "screen_share", participant: { id: 300 } })).toBe("participant:300:screenshare");
    expect(frameSourceKey({ type: "screenshare" })).toBe("type:screenshare");
  });

  it("decodes a Recall screenshare frame to its own key", () => {
    const d = decodeVideoSeparatePng({
      event: "video_separate_png.data",
      data: { data: { buffer: "AQID", type: "screenshare", participant: { id: 300, name: "Nik" } } },
    });
    expect(d?.metadata.source_key).toBe("participant:300:screenshare");
  });

  it("normalizes source aliases", () => {
    expect(normalizeFrameSource("screen")).toBe("type:screenshare");
    expect(normalizeFrameSource("screen_share")).toBe("type:screenshare");
    expect(normalizeFrameSource("type:screen_share")).toBe("type:screenshare");
    expect(normalizeFrameSource("participant:300:screen_share")).toBe("participant:300:screenshare");
    expect(normalizeFrameSource("300")).toBe("participant:300");
    expect(normalizeFrameSource("latest")).toBeNull();
  });
});

describe("selectFrame", () => {
  const now = 1_000_000;
  const cam = f("300", "webcam", now - 100, 1); // newest
  const scr = f("300", "screenshare", now - 2000, 2);
  const other = f("400", "webcam", now - 50, 3);
  const all = [cam, scr, other];

  it("screen picks the newest screenshare even when webcams are newer", () => {
    const scr2 = f("500", "screenshare", now - 500, 4);
    expect(selectFrame([...all, scr2], "screen", now)).toBe(scr2);
    expect(selectFrame(all, "screen", now)).toBe(scr);
  });

  it("default and bare participant prefer a fresh screenshare", () => {
    expect(selectFrame(all, null, now)).toBe(scr);
    expect(selectFrame(all, "participant:300", now)).toBe(scr);
  });

  it("falls back to newest when the screenshare is old", () => {
    const old = f("300", "screenshare", now - 60_000, 5);
    expect(selectFrame([cam, old, other], null, now)).toBe(other);
    expect(selectFrame([cam, old], "participant:300", now)).toBe(cam);
  });

  it("exact participant:type and webcam selection", () => {
    expect(selectFrame(all, "participant:300:webcam", now)).toBe(cam);
    expect(selectFrame(all, "webcam", now)).toBe(other);
    expect(selectFrame([cam], "screen", now)).toBeNull();
    expect(selectFrame(all, "participant:999", now)).toBeNull();
  });
});
