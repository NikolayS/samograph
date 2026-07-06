import { describe, it, expect } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { LogoutButton } from "./LogoutButton.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

describe("LogoutButton — calls logout() then redirects to sign-in", () => {
  it("renders a visible 'Log out' button", () => {
    const client = createFakeAppApiClient();
    const { getByRole } = render(
      <LogoutButton client={client} redirect={() => {}} />,
    );
    expect(getByRole("button", { name: /log out/i })).toBeDefined();
  });

  it("POSTs /auth/logout then redirects to /auth", async () => {
    const client = createFakeAppApiClient();
    const seen: string[] = [];
    const { getByRole } = render(
      <LogoutButton client={client} redirect={(p) => seen.push(p)} />,
    );
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /log out/i }));
    });
    // The redirect happened only after a real POST /auth/logout was issued.
    expect(seen).toEqual(["/auth"]);
    expect(client.requests).toEqual([
      { path: "/auth/logout", method: "POST", body: {} },
    ]);
  });

  it("still redirects to /auth when the logout request fails (best-effort)", async () => {
    const client = createFakeAppApiClient({
      failLogoutWith: { code: "SAMO-AUTH-LOGOUT", message: "boom", status: 500 },
    });
    const seen: string[] = [];
    const { getByRole } = render(
      <LogoutButton client={client} redirect={(p) => seen.push(p)} />,
    );
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /log out/i }));
    });
    expect(seen).toEqual(["/auth"]);
    expect(client.requests.some((r) => r.path === "/auth/logout")).toBe(true);
  });
});
