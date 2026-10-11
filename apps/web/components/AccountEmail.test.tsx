import { describe, it, expect } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { AccountEmail } from "./AccountEmail.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { AppShell } from "./AppShell.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { createFakeAppApiClient, type FakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { AppApiClient } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

/**
 * "Which account am I using?" (#238).
 *
 * The address is `users.email` off `GET /settings`' read-only `signin` block —
 * the one address this system stands behind (`apps/app-api/settings/signin.ts`).
 * It is deliberately read through the SAME existing endpoint on both surfaces
 * rather than a new `/me`: the fact is already on the wire.
 *
 * The load-bearing case is the pre-answer one. The dashboard's own list and this
 * fetch land independently, so there is a window where the header is rendered
 * and the address is not known yet. In that window the header must show neither
 * "undefined" nor a collapsed node that pops the row taller when the address
 * arrives — it reserves its line with a non-breaking space and hides it from
 * assistive tech until it says something true.
 */

const noopRedirect = () => {};

/** A client whose `GET /settings` never settles — the pre-answer window, held open. */
function withPendingSettings(client: FakeAppApiClient): AppApiClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "getSettings") return () => new Promise<never>(() => {});
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as AppApiClient;
}

describe("AccountEmail — the shared 'Signed in as …' chip", () => {
  it("renders the address with its label once known", () => {
    const { container } = render(<AccountEmail email="owner@example.test" />);
    const chip = container.querySelector(".samograph-account-email");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Signed in as owner@example.test");
    // Real content is readable, not hidden from assistive tech.
    expect(chip?.getAttribute("aria-hidden")).toBeNull();
    expect(chip?.getAttribute("data-loading")).toBeNull();
  });

  it("reserves its line with a non-breaking space while the address is unknown", () => {
    const { container } = render(<AccountEmail email={null} />);
    const chip = container.querySelector(".samograph-account-email");
    expect(chip).not.toBeNull();
    // Occupies a line (no layout jump) but says nothing — and never "undefined".
    expect(chip?.textContent).toBe(" ");
    expect(chip?.getAttribute("aria-hidden")).toBe("true");
    expect(chip?.getAttribute("data-loading")).toBe("true");
  });

  it("treats the server's degraded empty string as unknown, never as an address", () => {
    // `readSignIn` degrades a missing `users` row to "" rather than 500ing.
    const { container } = render(<AccountEmail email="" />);
    const chip = container.querySelector(".samograph-account-email");
    expect(chip?.textContent).toBe(" ");
    expect(chip?.getAttribute("data-loading")).toBe("true");
  });
});

describe("AppShell — shows which account you are signed in as (#238)", () => {
  it("renders the account email in the header, beside Log out", async () => {
    const client = createFakeAppApiClient({ seedAccountEmail: "nik@samograph.test" });
    const { container, findByRole } = render(
      <AppShell client={client} redirect={noopRedirect}><Dashboard client={client} redirect={noopRedirect} /></AppShell>,
    );
    await findByRole("button", { name: /log out/i });
    await waitFor(() => {
      const chip = container.querySelector("header .samograph-account-email");
      expect(chip?.textContent).toBe("Signed in as nik@samograph.test");
    });
    // Read off the endpoint that already serves it — no new API surface.
    expect(client.requests.some((r) => r.path === "/settings" && r.method === "GET")).toBe(true);
  });

  it("shows no 'undefined' and keeps the header's line while the address is pending", async () => {
    const client = withPendingSettings(createFakeAppApiClient());
    const { container, findByRole } = render(
      <AppShell client={client} redirect={noopRedirect}><Dashboard client={client} redirect={noopRedirect} /></AppShell>,
    );
    await findByRole("button", { name: /log out/i });
    const chip = container.querySelector("header .samograph-account-email");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe(" ");
    expect(container.textContent).not.toContain("undefined");
  });

  it("still renders the dashboard when GET /settings fails", async () => {
    const client = createFakeAppApiClient({
      failGetSettingsWith: { code: "INTERNAL", message: "boom", status: 500 },
    });
    const { container, findByText } = render(
      <AppShell client={client} redirect={noopRedirect}><Dashboard client={client} redirect={noopRedirect} /></AppShell>,
    );
    // The dashboard itself is unharmed; the chip simply never fills in.
    expect(await findByText(/No calls yet/)).toBeDefined();
    const chip = container.querySelector("header .samograph-account-email");
    expect(chip?.textContent).toBe(" ");
    expect(container.textContent).not.toContain("undefined");
  });
});

describe("SettingsPage — leaves account identity to AppShell", () => {
  it("does not render a duplicate account chip", async () => {
    const client = createFakeAppApiClient({ seedAccountEmail: "owner@samograph.test" });
    const { container, findByText } = render(
      <SettingsPage client={client} redirect={noopRedirect} />,
    );
    await findByText("Settings");
    expect(container.querySelector(".samograph-settings > .samograph-account-email")).toBeNull();
  });
});
