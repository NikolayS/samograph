import { describe, it, expect } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

/**
 * Greenroom Settings page (SPEC §5.12). It loads the tenant's hosted settings
 * (dictionary preset + keyterms, language, chat chime), renders them into a
 * form, and PUTs the edited document back. Auth-gated like the dashboard.
 */
describe("SettingsPage — hosted per-tenant settings (§5.12)", () => {
  it("groups settings into four exactly named regions and a sticky save bar", async () => {
    const client = createFakeAppApiClient({
      googleCalendarEnabled: true,
      seedAccountEmail: "owner@example.com",
    });
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    await view.findByLabelText(/language/i);
    await waitFor(() => expect(view.queryByRole("region", { name: "Integrations" })).not.toBeNull());
    const regions = view.getAllByRole("region");
    expect(regions.map((region) => region.getAttribute("aria-labelledby") &&
      document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent)).toEqual([
      "Transcription", "In-call", "Account", "Integrations",
    ]);
    expect(view.getByLabelText(/preset/i).closest('[role="region"]')?.textContent).toContain("Transcription");
    expect(view.getByLabelText(/chime/i).closest('[role="region"]')?.textContent).toContain("In-call");
    expect(view.getByText("Sign-in").closest('[role="region"]')?.textContent).toContain("Account");
    expect(view.getByText("Google Calendar").closest('[role="region"]')?.textContent).toContain("Integrations");
    const save = view.getByRole("button", { name: "Save settings" });
    const savebar = save.closest(".samograph-savebar")!;
    const form = view.container.querySelector("form")!;
    const wrapper = view.container.querySelector(".samograph-settings")!;
    expect(form.contains(savebar)).toBe(false);
    expect(wrapper.lastElementChild).toBe(savebar);

    fireEvent.change(view.getByLabelText(/language/i), { target: { value: "de" } });
    fireEvent.click(save);
    await waitFor(() => expect(client.requests.some((request) =>
      request.method === "PUT" && request.path === "/settings")).toBe(true));
  });

  /**
   * The CSS that suppresses the divider under the page header
   * (`.samograph-page-header + * > .samograph-section:first-child`) can only
   * match if the markup keeps this shape: the <form> is the header's next
   * sibling and the first settings section is that form's first child
   * (#295 review). Assert the shape, not the pixels.
   */
  it("puts the first section directly inside the element after the page header", async () => {
    const client = createFakeAppApiClient();
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    await view.findByLabelText(/language/i);
    const header = view.container.querySelector(".samograph-page-header")!;
    expect(header.tagName).toBe("HEADER");
    const next = header.nextElementSibling!;
    expect(next.tagName).toBe("FORM");
    const first = next.firstElementChild!;
    expect(first.className).toBe("samograph-section samograph-settings-section");
    expect(first.querySelector("h2")?.textContent).toBe("Transcription");
  });

  it("enables save only when dirty and resets dirty after saving", async () => {
    const client = createFakeAppApiClient();
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    const language = await view.findByLabelText(/language/i);
    const save = view.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(language, { target: { value: "de" } });
    expect(save.disabled).toBe(false);
    expect(view.getByText("Unsaved changes").className).toContain("samograph-savebar-status");
    fireEvent.click(save);
    expect(await view.findByText("Settings saved.")).toBeDefined();
    expect(save.disabled).toBe(true);
  });
  it("loads and renders the tenant's current settings", async () => {
    const client = createFakeAppApiClient({
      seedSettings: {
        dictionaryPreset: "postgresfm",
        keyterms: ["WAL", "pg_stat_statements"],
        language: "es",
        chime: "bell",
      },
    });
    const { findByLabelText } = render(<SettingsPage client={client} redirect={() => {}} />);

    const lang = (await findByLabelText(/language/i)) as HTMLSelectElement;
    expect(lang.value).toBe("es");
    const terms = (await findByLabelText(/keyterms/i)) as HTMLTextAreaElement;
    expect(terms.value.split(/\n/)).toEqual(["WAL", "pg_stat_statements"]);
    const chime = (await findByLabelText(/chime/i)) as HTMLSelectElement;
    expect(chime.value).toBe("bell");
    const preset = (await findByLabelText(/preset/i)) as HTMLSelectElement;
    expect(preset.value).toBe("postgresfm");
  });

  it("edits and saves — PUTs the new document and confirms", async () => {
    const client = createFakeAppApiClient({
      seedSettings: {
        dictionaryPreset: "none",
        keyterms: [],
        language: "multi",
        chime: "blip",
      },
    });
    const { findByLabelText, getByRole, findByText } = render(
      <SettingsPage client={client} redirect={() => {}} />,
    );

    fireEvent.change(await findByLabelText(/language/i), { target: { value: "de" } });
    fireEvent.change(await findByLabelText(/keyterms/i), {
      target: { value: "autovacuum\npgbouncer" },
    });
    fireEvent.change(await findByLabelText(/chime/i), { target: { value: "glass" } });

    const save = getByRole("button", { name: "Save settings" });
    expect(save.className).toContain("samograph-btn samograph-btn--primary");
    fireEvent.click(save);

    const saved = await findByText("Settings saved.");
    expect(saved.getAttribute("role")).toBe("status");
    expect(saved.className).toContain("samograph-alert samograph-alert--success");
    const put = client.requests.find((r) => r.method === "PUT" && r.path === "/settings");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      dictionary_preset: "none",
      keyterms: ["autovacuum", "pgbouncer"],
      language: "de",
      chime: "glass",
    });
  });

  it("marks Save settings busy and disabled while saving", async () => {
    const client = createFakeAppApiClient();
    client.saveSettings = () => new Promise(() => {});
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    const save = await view.findByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    fireEvent.change(await view.findByLabelText(/language/i), { target: { value: "de" } });
    fireEvent.click(save);
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps edits made during a save dirty and sends them on the next save", async () => {
    const client = createFakeAppApiClient();
    const submitted: string[] = [];
    let resolveFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    client.saveSettings = async (settings) => {
      submitted.push(settings.language);
      if (submitted.length === 1) await firstSave;
    };
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    const language = await view.findByLabelText(/language/i);
    const save = view.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;

    fireEvent.change(language, { target: { value: "de" } });
    fireEvent.click(save);
    fireEvent.change(language, { target: { value: "es" } });
    resolveFirst();

    await waitFor(() => expect(save.disabled).toBe(false));
    expect(view.getByText("Unsaved changes")).toBeDefined();
    fireEvent.click(save);
    await waitFor(() => expect(submitted).toEqual(["de", "es"]));
  });

  it("styles save failures as error alerts", async () => {
    const client = createFakeAppApiClient({
      failSaveSettingsWith: { code: "SAMO-SETTINGS", message: "Could not save.", status: 500 },
    });
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    fireEvent.change(await view.findByLabelText(/language/i), { target: { value: "de" } });
    fireEvent.click(await view.findByRole("button", { name: "Save settings" }));
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toBe("Could not save.");
    expect(alert.className).toContain("samograph-alert samograph-alert--error");
    expect((view.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByText("Unsaved changes")).toBeDefined();
  });

  it("redirects to sign-in when loading settings 401s", async () => {
    const client = createFakeAppApiClient({
      failGetSettingsWith: { code: "SAMO-AUTHZ-001", message: "no", status: 401 },
    });
    let to: string | null = null;
    render(<SettingsPage client={client} redirect={(p) => (to = p)} />);
    await waitFor(() => expect(to).toBe("/auth"));
  });
  it("wraps every select in the designed .samograph-select control", async () => {
    const client = createFakeAppApiClient();
    const view = render(<SettingsPage client={client} redirect={() => {}} />);
    await view.findByLabelText(/language/i);
    const selects = [...view.container.querySelectorAll("select")];
    expect(selects.length).toBe(3);
    for (const select of selects) {
      expect(select.parentElement?.className).toBe("samograph-select");
      // The wrapper is the select's immediate parent so `.samograph-select >
      // select` (and the ::after end-cap) actually apply.
      expect(select.parentElement?.tagName).toBe("DIV");
    }
    // Still one field group per control, so labels/hints keep their rhythm.
    expect(view.getByLabelText(/preset/i).closest(".samograph-field")).not.toBeNull();
    expect(view.getByLabelText(/chime/i).closest(".samograph-field")).not.toBeNull();
  });
});
