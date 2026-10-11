import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { AuthLanding } from "./AuthLanding.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { Call } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const tick = () => new Promise((r) => setTimeout(r, 0));

/** An anonymous visitor: the `GET /calls` session probe 401s. */
const ANON = {
  failListCallsWith: { code: "SAMO-CALL-LIST", message: "no session", status: 401 },
} as const;

describe("AuthLanding — sign-in page auth gate (SPEC §5.1)", () => {
  it("renders the magic-link form for an anonymous visitor (401 probe)", async () => {
    const client = createFakeAppApiClient({ ...ANON });
    const seen: string[] = [];
    const { getByText } = render(
      <AuthLanding client={client} redirect={(p) => seen.push(p)} />,
    );
    await tick();
    expect(getByText("Sign in to samograph")).toBeDefined();
    expect(seen).toEqual([]); // not redirected
  });

  it("redirects an already-signed-in visitor to /dashboard", async () => {
    const seed: Call[] = [
      { id: "call_1", meetingUrl: "https://zoom.us/j/1", provider: "zoom", status: "PENDING" },
    ];
    const client = createFakeAppApiClient({ seedCalls: seed });
    const seen: string[] = [];
    render(<AuthLanding client={client} redirect={(p) => seen.push(p)} />);
    await tick();
    expect(seen).toEqual(["/dashboard"]);
  });
});

/**
 * Google sign-in surface (issue #209, PR 6).
 *
 * `GET /auth/providers` is the SOLE gate: branch previews deliberately ship no
 * Google credentials, so the button must be genuinely ABSENT there — not
 * disabled, not hidden by CSS. Magic link stays available in both cases, because
 * Google must never become the only credential.
 *
 * The `<h1>` moved OUT of `MagicLinkRequestForm` and into this landing: the page
 * heading has to precede BOTH credential options in document order, and the
 * "check your email" state must not be able to put a second `<h1>` on the page.
 */
describe("AuthLanding — Continue with Google gating (#209)", () => {
  it("lays out the wordmark, heading, Google button, divider, and email form in order", async () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: true });
    const { container, getByRole, getByText } = render(
      <AuthLanding client={client} redirect={() => {}} />,
    );
    await tick();
    const auth = container.querySelector(".samograph-auth");
    expect(auth).not.toBeNull();
    const items = [
      auth!.querySelector("[data-wordmark]"),
      getByRole("heading", { level: 1 }),
      getByRole("link", { name: "Continue with Google" }),
      getByText("or"),
      auth!.querySelector("form"),
    ];
    expect(items.every(Boolean)).toBe(true);
    for (let index = 0; index < items.length - 1; index += 1) {
      expect(items[index]!.compareDocumentPosition(items[index + 1]!) & 4).toBe(4);
    }
  });

  it("renders the Google button when /auth/providers reports {google:true}", async () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: true });
    const { getByRole } = render(<AuthLanding client={client} redirect={() => {}} />);
    await tick();
    const link = getByRole("link", { name: "Continue with Google" });
    expect(link.getAttribute("href")).toBe("/auth/google/start");
  });

  it("renders NO Google button when /auth/providers reports {google:false}", async () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: false });
    const { queryByRole, getByLabelText } = render(
      <AuthLanding client={client} redirect={() => {}} />,
    );
    await tick();
    expect(queryByRole("link", { name: "Continue with Google" })).toBeNull();
    // …and magic link still works: Google is never the only credential.
    expect(getByLabelText("Email")).toBeDefined();
  });

  it("renders no Google button before the probe resolves (no flash of a dead button)", () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: true });
    const { queryByRole } = render(<AuthLanding client={client} redirect={() => {}} />);
    // Synchronous first paint — the probe has not settled yet.
    expect(queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });

  it("shows the divider only alongside the Google button", async () => {
    const on = createFakeAppApiClient({ ...ANON, googleEnabled: true });
    const withGoogle = render(<AuthLanding client={on} redirect={() => {}} />);
    await tick();
    expect(withGoogle.getByText("or")).toBeDefined();
    withGoogle.unmount();

    const off = createFakeAppApiClient({ ...ANON, googleEnabled: false });
    const withoutGoogle = render(<AuthLanding client={off} redirect={() => {}} />);
    await tick();
    expect(withoutGoogle.queryByText("or")).toBeNull();
  });

  it("renders EXACTLY ONE <h1>, and it precedes the Google button", async () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: true });
    const { container, getByRole } = render(
      <AuthLanding client={client} redirect={() => {}} />,
    );
    await tick();
    const h1s = container.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Sign in to samograph");
    const link = getByRole("link", { name: "Continue with Google" });
    // DOCUMENT_POSITION_FOLLOWING (4): the button comes AFTER the heading.
    expect(h1s[0].compareDocumentPosition(link) & 4).toBe(4);
  });

  it("still renders exactly one <h1> with Google disabled", async () => {
    const client = createFakeAppApiClient({ ...ANON, googleEnabled: false });
    const { container } = render(<AuthLanding client={client} redirect={() => {}} />);
    await tick();
    expect(container.querySelectorAll("h1").length).toBe(1);
  });
});

/**
 * `?error=<CODE>` display (§5.16 / S5-1). The Google callback cannot return a
 * JSON body — it 302s the browser — so it hands the code back on the URL and the
 * sign-in page renders the same copy the magic-link callback would.
 */
describe("AuthLanding — ?error= copy from the Google callback (#209)", () => {
  const cases: Array<[string, string]> = [
    ["SAMO-AUTH-007", "That sign-in attempt expired — please try again."],
    ["SAMO-AUTH-008", "Google couldn't sign you in right now."],
    ["SAMO-AUTH-009", "Your Google account's email isn't verified."],
    ["SAMO-AUTH-010", "Google sign-in isn't available here."],
    // #219: Google's token endpoint answered 5xx, or identity provisioning
    // failed. Our fault and retryable — it must NOT tell the user their link
    // was bad, and it must stay in the `role="alert"` branch.
    ["SAMO-AUTH-500", "Something went wrong on our end — please try again."],
  ];

  for (const [code, copy] of cases) {
    it(`renders the exact §5.16 copy for ${code} as an alert`, async () => {
      const client = createFakeAppApiClient({ ...ANON });
      const { getByRole } = render(
        <AuthLanding client={client} redirect={() => {}} errorCode={code} />,
      );
      await tick();
      expect(getByRole("alert").textContent).toBe(copy);
    });
  }

  it("renders SAMO-AUTH-006 in an INFO tone (status), not an alert", async () => {
    const client = createFakeAppApiClient({ ...ANON });
    const { getByRole, queryByRole } = render(
      <AuthLanding client={client} redirect={() => {}} errorCode="SAMO-AUTH-006" />,
    );
    await tick();
    expect(getByRole("status").textContent).toBe(
      "Sign-in cancelled. Choose a way to sign in below.",
    );
    expect(queryByRole("alert")).toBeNull();
  });

  it("renders the fallback copy for an unrecognized ?error= value", async () => {
    const client = createFakeAppApiClient({ ...ANON });
    const { getByRole } = render(
      <AuthLanding client={client} redirect={() => {}} errorCode="../../etc/passwd" />,
    );
    await tick();
    expect(getByRole("alert").textContent).toBe(
      "Couldn't sign you in. Request a new link.",
    );
  });

  it("renders no alert and no status when there is no ?error=", async () => {
    const client = createFakeAppApiClient({ ...ANON });
    const { queryByRole } = render(
      <AuthLanding client={client} redirect={() => {}} />,
    );
    await tick();
    expect(queryByRole("alert")).toBeNull();
    expect(queryByRole("status")).toBeNull();
  });
});
