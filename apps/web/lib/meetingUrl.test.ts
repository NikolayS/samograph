import { describe, expect, it } from "bun:test";
import { displayMeetingUrl, meetingTitle } from "./meetingUrl.ts";

/**
 * Mobile audit M7 / `d02`: the dashboard rendered the raw meeting URL as a row's
 * title — including the Zoom `?pwd=` join secret, verbatim, in plain text. These
 * are the two pure helpers every surface that shows a meeting URL must go
 * through: a readable title and a display-safe URL. Both MUST drop the query
 * string and the fragment, always.
 */
const ZOOM_WITH_PWD =
  "https://us04web.zoom.us/j/75208520803?pwd=GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1";

describe("meetingTitle", () => {
  it("names a Google Meet room by its code", () => {
    expect(meetingTitle("https://meet.google.com/qpd-zbkg-jfo")).toBe(
      "Google Meet · qpd-zbkg-jfo",
    );
  });

  it("names a Zoom room by its id, grouped the way Zoom writes it", () => {
    expect(meetingTitle(ZOOM_WITH_PWD)).toBe("Zoom · 752 0852 0803");
    expect(meetingTitle("https://zoom.us/j/1234567890")).toBe("Zoom · 123 456 7890");
    expect(meetingTitle("https://zoom.us/j/123456789")).toBe("Zoom · 123 456 789");
  });

  it("never contains the password, the query string or the fragment", () => {
    const title = meetingTitle(`${ZOOM_WITH_PWD}#frag`);
    expect(title).not.toContain("pwd");
    expect(title).not.toContain("GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1");
    expect(title).not.toContain("?");
    expect(title).not.toContain("#");
  });

  it("falls back to the host for a URL it does not recognise", () => {
    expect(meetingTitle("https://example.com/room/9?pwd=secret")).toBe("example.com");
    expect(meetingTitle("https://teams.microsoft.com/l/meetup-join/x")).toBe(
      "teams.microsoft.com",
    );
  });

  it("still parses a scheme-less link, and never echoes an unparseable one", () => {
    expect(meetingTitle("meet.google.com/qpd-zbkg-jfo")).toBe("Google Meet · qpd-zbkg-jfo");
    expect(meetingTitle("not a url ?pwd=secret")).toBe("Meeting");
    expect(meetingTitle("")).toBe("Meeting");
  });

  it("ignores a Zoom link whose id is not the room id", () => {
    expect(meetingTitle("https://zoom.us/wc/join/75208520803")).toBe("zoom.us");
  });
});

describe("displayMeetingUrl", () => {
  it("keeps scheme, host and path and drops the query string", () => {
    expect(displayMeetingUrl(ZOOM_WITH_PWD)).toBe("https://us04web.zoom.us/j/75208520803");
  });

  it("drops the fragment too", () => {
    expect(displayMeetingUrl("https://meet.google.com/qpd-zbkg-jfo#pinned")).toBe(
      "https://meet.google.com/qpd-zbkg-jfo",
    );
  });

  it("drops embedded credentials", () => {
    expect(displayMeetingUrl("https://user:pass@zoom.us/j/123456789")).toBe(
      "https://zoom.us/j/123456789",
    );
  });

  it("normalises a scheme-less link to https", () => {
    expect(displayMeetingUrl("meet.google.com/qpd-zbkg-jfo?authuser=1")).toBe(
      "https://meet.google.com/qpd-zbkg-jfo",
    );
  });

  it("returns an empty string rather than echoing an unparseable input", () => {
    expect(displayMeetingUrl("not a url ?pwd=secret")).toBe("");
    expect(displayMeetingUrl("")).toBe("");
  });
});

/**
 * #283 re-review NB1: three real join-link shapes fell through to the bare host
 * ("zoom.us", "meet.google.com") instead of naming the room — Zoom's `/w/`
 * webinar links, Zoom personal-meeting vanity links (`/my/<vanity>`), and Google
 * Meet codes pasted in upper case (calendar invites and email clients do this).
 */
describe("meetingTitle — join-link shapes that used to fall back to the host", () => {
  it("names a Zoom webinar link by its id", () => {
    expect(meetingTitle("https://zoom.us/w/75208520803")).toBe("Zoom · 752 0852 0803");
    expect(meetingTitle("https://us02web.zoom.us/w/1234567890?pwd=secret")).toBe(
      "Zoom · 123 456 7890",
    );
  });

  it("names a Zoom personal-meeting room by its vanity id", () => {
    expect(meetingTitle("https://zoom.us/my/nikolay")).toBe("Zoom · nikolay");
    expect(meetingTitle("https://us04web.zoom.us/my/samo.team?pwd=secret")).toBe(
      "Zoom · samo.team",
    );
  });

  it("names an upper-case Google Meet code, normalised to lower case", () => {
    expect(meetingTitle("https://meet.google.com/QPD-ZBKG-JFO")).toBe(
      "Google Meet · qpd-zbkg-jfo",
    );
    expect(meetingTitle("MEET.GOOGLE.COM/Qpd-Zbkg-Jfo")).toBe("Google Meet · qpd-zbkg-jfo");
  });

  it("still refuses to name a link whose path is not a room id", () => {
    expect(meetingTitle("https://zoom.us/wc/join/75208520803")).toBe("zoom.us");
    expect(meetingTitle("https://zoom.us/my/")).toBe("zoom.us");
    expect(meetingTitle("https://meet.google.com/lookup/abcdefg")).toBe("meet.google.com");
  });

  it("still never echoes the password from any of these shapes", () => {
    for (const url of [
      "https://us02web.zoom.us/w/1234567890?pwd=GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1",
      "https://us04web.zoom.us/my/samo.team?pwd=GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1",
    ]) {
      expect(meetingTitle(url)).not.toContain("GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1");
      expect(displayMeetingUrl(url)).not.toContain("GmbJ6pA9rUojNjPj7iNnLAvbpcF2uU.1");
    }
  });
});
