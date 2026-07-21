import { describe, it, expect } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import {
  AccountDangerZone,
  ACCOUNT_DELETE_CONFIRM_PHRASE,
} from "./AccountDangerZone.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

function renderZone(over: { redirect?: (p: string) => void } = {}) {
  const app = createFakeAppApiClient();
  const redirected: string[] = [];
  const utils = render(
    <AccountDangerZone
      client={app}
      redirect={over.redirect ?? ((p) => redirected.push(p))}
    />,
  );
  return { app, redirected, ...utils };
}

describe("AccountDangerZone — delete-account danger zone (SPEC §5.14 GDPR)", () => {
  // ── (e) The destructive action requires TYPE-TO-CONFIRM ──────────────────────
  it("keeps the delete button disabled until the EXACT confirmation phrase is typed", () => {
    const { app, getByRole } = renderZone();
    const button = getByRole("button", {
      name: /permanently delete account/i,
    }) as HTMLButtonElement;
    const input = getByRole("textbox") as HTMLInputElement;

    // Disabled up front, and while the typed text does not match exactly.
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "delete" } }); // wrong case
    expect(button.disabled).toBe(true);
    fireEvent.change(input, {
      target: { value: `${ACCOUNT_DELETE_CONFIRM_PHRASE} ` }, // trailing space
    });
    expect(button.disabled).toBe(true);

    // No DELETE was sent while the phrase was wrong.
    expect(app.requests.some((r) => r.method === "DELETE")).toBe(false);

    // Exact match enables the button.
    fireEvent.change(input, {
      target: { value: ACCOUNT_DELETE_CONFIRM_PHRASE },
    });
    expect(button.disabled).toBe(false);
  });

  it("on confirm it calls DELETE /account and redirects away from the dead session", async () => {
    const redirected: string[] = [];
    const { app, getByRole } = renderZone({ redirect: (p) => redirected.push(p) });
    const button = getByRole("button", {
      name: /permanently delete account/i,
    }) as HTMLButtonElement;
    const input = getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: ACCOUNT_DELETE_CONFIRM_PHRASE },
    });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(
      app.requests.some((r) => r.path === "/account" && r.method === "DELETE"),
    ).toBe(true);
    expect(redirected).toEqual(["/"]);
  });

  it("surfaces an error and does NOT redirect when the erase request fails", async () => {
    const redirected: string[] = [];
    const app = createFakeAppApiClient({
      failDeleteAccountWith: { code: "SAMO-AUTHZ-001", message: "nope", status: 403 },
    });
    const { getByRole, findByRole } = render(
      <AccountDangerZone client={app} redirect={(p) => redirected.push(p)} />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: ACCOUNT_DELETE_CONFIRM_PHRASE },
    });
    await act(async () => {
      fireEvent.click(
        getByRole("button", { name: /permanently delete account/i }),
      );
    });
    expect(await findByRole("alert")).toBeDefined();
    expect(redirected).toEqual([]);
  });
});
