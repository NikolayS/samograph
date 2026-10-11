import { describe, it, expect } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage.tsx";
import { createFakeAppApiClient, type FakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import type { AppApiClient } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

/**
 * The read-only "Sign-in" block on the Settings page (SPEC amendment S5-1 item
 * 8, §5.12; issue #223).
 *
 * It is the STANDING record that discharges S5-1 item 5: same-email linking to
 * an existing magic-link account is SILENT, so the one-time notification email
 * is the only moment a takeover is visible. This block is the place a user can
 * come back to, at any later date, and see which credentials open their tenant.
 *
 * Three display states, and the third is the load-bearing one: the `google` row
 * is OMITTED ENTIRELY — not rendered as "not connected" — wherever connecting is
 * impossible, because `GET /auth/providers` is the SOLE gate on Google in an
 * environment (`apps/app-api/auth/google-http.ts`). A "not connected" row on a
 * branch preview would advertise a credential that cannot exist there.
 */

/** The probe's `{google:false}` is also what a 5xx/network failure resolves to. */
function withFailingProbe(client: FakeAppApiClient): AppApiClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "authProviders") {
        return async () => {
          throw new Error("GET /auth/providers 503");
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as AppApiClient;
}

/** The rendered sign-in block, once the settings load AND the probe have landed. */
async function renderSettings(client: AppApiClient) {
  const utils = render(<SettingsPage client={client} redirect={() => {}} />);
  const account = await utils.findByRole("region", { name: "Account" });
  const block = account.querySelector(".samograph-signin") as HTMLElement;
  return { ...utils, block };
}

const ACCOUNT_EMAIL = "owner-223@example.test";

describe("SettingsPage — read-only Sign-in block (S5-1 item 8, #223)", () => {
  it("lists magic_link unconditionally, with the account email on file", async () => {
    const client = createFakeAppApiClient({
      googleEnabled: true,
      seedAccountEmail: ACCOUNT_EMAIL,
    });
    const { block } = await renderSettings(client);

    const row = block.querySelector('[data-provider="magic_link"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(ACCOUNT_EMAIL);
  });

  it("google available + zero identities → the google row renders as NOT connected", async () => {
    const client = createFakeAppApiClient({
      googleEnabled: true,
      seedAccountEmail: ACCOUNT_EMAIL,
      seedIdentities: [],
    });
    const { block } = await renderSettings(client);

    await waitFor(() => expect(block.querySelector('[data-provider="google"]')).not.toBeNull());
    expect(block.querySelector('[data-provider="google"]')!.textContent).toContain("Not connected");
    expect(block.querySelector('[data-provider="magic_link"]')).not.toBeNull();
  });

  it("google available + a linked identity → the google row renders as connected", async () => {
    const client = createFakeAppApiClient({
      googleEnabled: true,
      seedAccountEmail: ACCOUNT_EMAIL,
      seedIdentities: [{ provider: "google", connectedAt: "2026-03-04T09:15:00.000Z" }],
    });
    const { block } = await renderSettings(client);

    const row = await waitFor(() => {
      const el = block.querySelector('[data-provider="google"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.textContent).toContain("Connected");
    expect(row.textContent).not.toContain("Not connected");
    // Connection metadata only — the date it was linked, never the provider `sub`.
    expect(row.textContent).toContain("2026-03-04");
  });

  it("google NOT configured on this environment → no google row at all", async () => {
    const client = createFakeAppApiClient({
      googleEnabled: false,
      seedAccountEmail: ACCOUNT_EMAIL,
    });
    const { block, container } = await renderSettings(client);

    // The probe has definitely answered before we assert an ABSENCE.
    await waitFor(() =>
      expect(client.requests.some((r) => r.path === "/auth/providers")).toBe(true),
    );
    expect(block.querySelector('[data-provider="google"]')).toBeNull();
    // Absence of the STRING, not merely of a "connected" state.
    expect(container.innerHTML.toLowerCase()).not.toContain("google");
    expect(block.querySelector('[data-provider="magic_link"]')).not.toBeNull();
  });

  it("a FAILED /auth/providers probe takes the omit branch too", async () => {
    const fake = createFakeAppApiClient({ googleEnabled: true, seedAccountEmail: ACCOUNT_EMAIL });
    const { block, container } = await renderSettings(withFailingProbe(fake));

    await waitFor(() => expect(block.querySelector('[data-provider="magic_link"]')).not.toBeNull());
    expect(block.querySelector('[data-provider="google"]')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain("google");
  });

  it("is read-only: no controls, outside the settings form, absent from the PUT body", async () => {
    const client = createFakeAppApiClient({
      googleEnabled: true,
      seedAccountEmail: ACCOUNT_EMAIL,
      seedIdentities: [{ provider: "google", connectedAt: "2026-03-04T09:15:00.000Z" }],
      seedSettings: { dictionaryPreset: "none", keyterms: [], language: "multi", chime: "blip" },
    });
    const { block, getByRole, findByText } = await renderSettings(client);

    // No mutation affordance of any kind — connect/disconnect are [POSTPONED post-v1].
    expect(block.querySelectorAll("button").length).toBe(0);
    expect(block.querySelectorAll("input").length).toBe(0);
    expect(block.querySelectorAll("select").length).toBe(0);
    expect(block.querySelectorAll("a").length).toBe(0);
    // …and it is not inside the settings form, so it can never be submitted.
    expect(block.closest("form")).toBeNull();

    fireEvent.change(getByRole("combobox", { name: /language/i }), { target: { value: "de" } });
    fireEvent.click(getByRole("button", { name: /save/i }));
    await findByText(/saved/i);
    const put = client.requests.find((r) => r.method === "PUT" && r.path === "/settings");
    expect(put!.body).toEqual({
      dictionary_preset: "none",
      keyterms: [],
      language: "de",
      chime: "blip",
    });
  });
});
