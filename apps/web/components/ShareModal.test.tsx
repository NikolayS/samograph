import { describe, it, expect, beforeEach } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { ShareModal } from "./ShareModal.tsx";
import { createFakeShareApiClient } from "../lib/fakeShareApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

/** Install a recording clipboard stub; happy-dom's navigator.clipboard is read-only. */
function stubClipboard(): string[] {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    },
  });
  return writes;
}

describe("ShareModal — owner share-link control (SPEC §4.1, §5.7, Story 2)", () => {
  beforeEach(() => {
    stubClipboard();
  });

  it("offers 'Create share link' when no share exists, then mints and shows /c/<token>", async () => {
    const client = createFakeShareApiClient();
    const { findByText } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    const create = await findByText("Create share link");
    await act(async () => {
      fireEvent.click(create);
    });
    expect(await findByText("/c/shr_1")).toBeDefined();
    expect(client.requests.some((r) => r.path === "/calls/call_1/share" && r.method === "POST")).toBe(true);
  });

  it("shows an already-active share link on open without re-minting", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1"); // pre-existing share
    const { findByText } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    expect(await findByText("/c/shr_1")).toBeDefined();
  });

  it("copies the link to the clipboard and confirms 'Copied'", async () => {
    const writes = stubClipboard();
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    const { findByText, getByText } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    await findByText("/c/shr_1");
    await act(async () => {
      fireEvent.click(getByText("Copy link"));
    });
    expect(await findByText("Copied")).toBeDefined();
    expect(writes).toEqual(["/c/shr_1"]);
  });

  it("rotates the link: a new token replaces the old, with a 'previous link stopped working' note", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    const { findByText, getByText } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    await findByText("/c/shr_1");
    await act(async () => {
      fireEvent.click(getByText("Rotate"));
    });
    expect(await findByText("/c/shr_2")).toBeDefined();
    expect(getByText(/previous link stopped working/i)).toBeDefined();
  });

  it("revokes the link and returns to the empty state", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    const { findByText, getByText } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    await findByText("/c/shr_1");
    await act(async () => {
      fireEvent.click(getByText("Revoke"));
    });
    expect(await findByText("Create share link")).toBeDefined();
    expect(client.requests.some((r) => r.path === "/calls/call_1/share" && r.method === "DELETE")).toBe(true);
  });

  it("surfaces a typed SAMO-RATE-001 failure via role=alert", async () => {
    const client = createFakeShareApiClient({
      failMintWith: { code: "SAMO-RATE-001", message: "Too many connections/commands on this link.", status: 429 },
    });
    const { findByText, findByRole } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => {}} />,
    );
    fireEvent.click(await findByText("Create share link"));
    expect(await findByRole("alert")).toBeDefined();
  });

  it("closes via the close affordance", async () => {
    const client = createFakeShareApiClient();
    const closed: boolean[] = [];
    const { findByRole } = render(
      <ShareModal shareClient={client} callId="call_1" onClose={() => closed.push(true)} />,
    );
    const close = await findByRole("button", { name: /close/i });
    fireEvent.click(close);
    expect(closed).toEqual([true]);
  });
});
