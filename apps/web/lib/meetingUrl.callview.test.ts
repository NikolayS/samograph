import { describe, expect, it } from "bun:test";
import { displayMeetingUrl, meetingTitle } from "./meetingUrl.ts";

/**
 * Extra cases the call-view header (M4) depends on, kept apart from
 * `meetingUrl.test.ts` (owned by the dashboard-row change) so that file stays
 * byte-identical across both branches. Exact values only.
 */
describe("meetingUrl — what the call-view header relies on", () => {
  it("titles the two providers the app accepts", () => {
    expect(meetingTitle("https://meet.google.com/qpd-zbkg-jfo")).toBe("Google Meet · qpd-zbkg-jfo");
    expect(meetingTitle("https://zoom.us/j/1234567890")).toBe("Zoom · 123 456 7890");
    expect(meetingTitle("https://zoom.us/j/123456789")).toBe("Zoom · 123 456 789");
    expect(meetingTitle("https://us02web.zoom.us/j/12345678901")).toBe("Zoom · 123 4567 8901");
  });

  it("never lets a query string reach the title", () => {
    expect(meetingTitle("https://meet.google.com/qpd-zbkg-jfo?authuser=1")).toBe(
      "Google Meet · qpd-zbkg-jfo",
    );
    expect(meetingTitle("https://zoom.us/j/1234567890?pwd=s3cr3tPassw0rd")).toBe(
      "Zoom · 123 456 7890",
    );
  });

  it("never lets a query string reach the displayed URL", () => {
    expect(displayMeetingUrl("https://zoom.us/j/1234567890?pwd=s3cr3t#ok")).toBe(
      "https://zoom.us/j/1234567890",
    );
    expect(displayMeetingUrl("https://meet.google.com/qpd-zbkg-jfo?authuser=1")).toBe(
      "https://meet.google.com/qpd-zbkg-jfo",
    );
  });

  it("keeps a non-default port so a self-hosted link still resolves", () => {
    expect(displayMeetingUrl("https://meet.example.com:8443/room?x=1")).toBe(
      "https://meet.example.com:8443/room",
    );
  });

  it("yields the constants the header treats as 'no usable title/URL'", () => {
    expect(meetingTitle("")).toBe("Meeting");
    expect(meetingTitle("not a url")).toBe("Meeting");
    expect(displayMeetingUrl("")).toBe("");
    expect(displayMeetingUrl("not a url")).toBe("");
  });
});
