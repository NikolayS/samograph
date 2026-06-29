import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { AuthLanding } from "./AuthLanding.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { Call } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AuthLanding — sign-in page auth gate (SPEC §5.1)", () => {
  it("renders the magic-link form for an anonymous visitor (401 probe)", async () => {
    const client = createFakeAppApiClient({
      failListCallsWith: { code: "SAMO-CALL-LIST", message: "no session", status: 401 },
    });
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
