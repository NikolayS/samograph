import { describe, it, expect } from "bun:test";
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { MagicLinkCallback } from "./MagicLinkCallback.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { AuthErrorCode } from "../lib/authErrors.ts";
import { installDom } from "../test/setup.tsx";

installDom();

describe("MagicLinkCallback", () => {
  it("reads the token, calls verify, and shows the verifying state", () => {
    const client = createFakeAppApiClient({ holdVerify: true });
    const { getByText } = render(
      <MagicLinkCallback token="abc" client={client} />,
    );
    expect(getByText("Verifying your sign-in link…")).toBeDefined();
    expect(client.requests).toEqual([
      { path: "/auth/callback", method: "GET", body: { token: "abc" } },
    ]);
  });

  it("shows the signed-in state when verification succeeds", async () => {
    const client = createFakeAppApiClient();
    const { findByText } = render(
      <MagicLinkCallback token="abc" client={client} />,
    );
    expect(await findByText("You're signed in.")).toBeDefined();
  });

  it("treats a missing token as invalid without calling the client", () => {
    const client = createFakeAppApiClient();
    const { getByText } = render(
      <MagicLinkCallback token={undefined} client={client} />,
    );
    expect(getByText("This sign-in link isn't valid.")).toBeDefined();
    expect(client.requests).toEqual([]);
  });

  const cases: Array<{ code: AuthErrorCode; message: string }> = [
    { code: "SAMO-AUTH-001", message: "This sign-in link isn't valid." },
    { code: "SAMO-AUTH-002", message: "This sign-in link has expired." },
    { code: "SAMO-AUTH-003", message: "This link was already used." },
    { code: "SAMO-AUTH-004", message: "Too many sign-in attempts — try again shortly." },
  ];

  for (const { code, message } of cases) {
    it(`maps ${code} to its exact §5.16 message`, async () => {
      const client = createFakeAppApiClient({
        // Server "message" is intentionally different — the page must render the
        // code-mapped copy, not whatever string the server returned.
        failVerifyWith: { code, message: "SERVER-SIDE-RAW" },
      });
      const { findByText } = render(
        <MagicLinkCallback token="some-token" client={client} />,
      );
      expect(await findByText(message)).toBeDefined();
    });
  }

  it("verifies a single-use token EXACTLY once under StrictMode double-invoke", async () => {
    // React StrictMode (enabled in next.config) double-invokes effects in dev:
    // setup → cleanup → setup on the same instance. Against a single-use magic
    // link, a second verify races and intermittently 401s ("already used"). The
    // callback must guard the double-invoke so verify fires once.
    const client = createFakeAppApiClient();
    const { findByText } = render(
      <StrictMode>
        <MagicLinkCallback token="one-shot-token" client={client} />
      </StrictMode>,
    );
    expect(await findByText("You're signed in.")).toBeDefined();
    const verifyCalls = client.requests.filter((r) => r.path === "/auth/callback");
    expect(verifyCalls).toHaveLength(1);
  });

  it("shows the infra-error copy (not the invalid-link copy) on a 5xx whose body lacks a code", async () => {
    // Infra 5xx: app-api's throwTyped falls the code back to SAMO-AUTH-001 when
    // the body has no `code`, but it carries status=500. The page must branch on
    // status, not code, and NOT claim the link itself is invalid.
    const client = createFakeAppApiClient({
      failVerifyWith: { code: "SAMO-AUTH-001", message: "Request failed.", status: 500 },
    });
    const { findByText, queryByText } = render(
      <MagicLinkCallback token="valid-token" client={client} />,
    );
    expect(
      await findByText("Something went wrong on our end — please try again."),
    ).toBeDefined();
    expect(queryByText("This sign-in link isn't valid.")).toBeNull();
  });

  it("shows the infra-error copy on a network error (no HTTP status)", async () => {
    const client = createFakeAppApiClient({
      failVerifyWithRaw: new TypeError("Failed to fetch"),
    });
    const { findByText } = render(
      <MagicLinkCallback token="valid-token" client={client} />,
    );
    expect(
      await findByText("Something went wrong on our end — please try again."),
    ).toBeDefined();
  });

  it("keeps the invalid-link copy for a 401 token-invalid failure", async () => {
    const client = createFakeAppApiClient({
      failVerifyWith: { code: "SAMO-AUTH-001", message: "x", status: 401 },
    });
    const { findByText, queryByText } = render(
      <MagicLinkCallback token="bad-token" client={client} />,
    );
    expect(await findByText("This sign-in link isn't valid.")).toBeDefined();
    expect(
      queryByText("Something went wrong on our end — please try again."),
    ).toBeNull();
  });

  it("keeps the already-used copy for a 410 token failure", async () => {
    const client = createFakeAppApiClient({
      failVerifyWith: { code: "SAMO-AUTH-003", message: "x", status: 410 },
    });
    const { findByText } = render(
      <MagicLinkCallback token="used-token" client={client} />,
    );
    expect(await findByText("This link was already used.")).toBeDefined();
  });

  it("offers a 'Request a new link' affordance on failure", async () => {
    const client = createFakeAppApiClient({
      failVerifyWith: { code: "SAMO-AUTH-002", message: "x" },
    });
    const { findByText } = render(
      <MagicLinkCallback token="t" client={client} />,
    );
    const link = (await findByText("Request a new link")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/auth");
  });
});
