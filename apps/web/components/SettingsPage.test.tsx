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

    fireEvent.click(getByRole("button", { name: /save/i }));

    await findByText(/saved/i);
    const put = client.requests.find((r) => r.method === "PUT" && r.path === "/settings");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      dictionary_preset: "none",
      keyterms: ["autovacuum", "pgbouncer"],
      language: "de",
      chime: "glass",
    });
  });

  it("redirects to sign-in when loading settings 401s", async () => {
    const client = createFakeAppApiClient({
      failGetSettingsWith: { code: "SAMO-AUTHZ-001", message: "no", status: 401 },
    });
    let to: string | null = null;
    render(<SettingsPage client={client} redirect={(p) => (to = p)} />);
    await waitFor(() => expect(to).toBe("/auth"));
  });
});
