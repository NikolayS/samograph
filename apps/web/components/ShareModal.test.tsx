import { describe, it, expect, beforeEach, mock } from "bun:test";
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

function createPendingShareClient() {
  const client = createFakeShareApiClient();
  client.getShare = () => new Promise(() => {});
  return client;
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
    expect(create.className).toContain("samograph-btn samograph-btn--primary");
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

  it("styles all active-link actions as secondary", async () => {
    const client = createFakeShareApiClient();
    await client.mintShare("call_1");
    const view = render(<ShareModal shareClient={client} callId="call_1" onClose={() => {}} />);
    await view.findByText("/c/shr_1");
    for (const name of ["Copy link", "Rotate", "Revoke"]) {
      expect(view.getByRole("button", { name }).className).toContain("samograph-btn--secondary");
    }
    expect(view.getByRole("button", { name: "Close" }).className).toContain("samograph-btn--ghost");
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
    expect((await findByRole("alert")).className).toContain("samograph-alert samograph-alert--error");
  });

  it("marks Create share link busy and disabled while minting", async () => {
    const client = createFakeShareApiClient();
    client.mintShare = () => new Promise(() => {});
    const view = render(<ShareModal shareClient={client} callId="call_1" onClose={() => {}} />);
    const create = await view.findByRole("button", { name: "Create share link" }) as HTMLButtonElement;
    fireEvent.click(create);
    expect(create.disabled).toBe(true);
    expect(create.getAttribute("aria-busy")).toBe("true");
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

  it("is a labelled modal dialog", () => {
    const view = render(<ShareModal shareClient={createPendingShareClient()} callId="call_1" onClose={() => {}} />);
    const dialog = view.getByRole("dialog");
    const title = view.getByRole("heading", { name: "Share read-only link" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
  });

  it("moves focus inside on open and restores it to the trigger on unmount", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(<ShareModal shareClient={createPendingShareClient()} callId="call_1" onClose={() => {}} />);
    const dialog = view.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes exactly once on Escape", () => {
    const onClose = mock(() => {});
    render(<ShareModal shareClient={createPendingShareClient()} callId="call_1" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab focus in both directions", async () => {
    const view = render(<ShareModal shareClient={createFakeShareApiClient()} callId="call_1" onClose={() => {}} />);
    const dialog = view.getByRole("dialog");
    const first = view.getByRole("button", { name: "Close" });
    const last = await view.findByRole("button", { name: "Create share link" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes from the backdrop but not from inside the panel", () => {
    const onClose = mock(() => {});
    const view = render(<ShareModal shareClient={createPendingShareClient()} callId="call_1" onClose={onClose} />);
    fireEvent.click(view.getByTestId("modal-panel"));
    expect(onClose).toHaveBeenCalledTimes(0);
    fireEvent.click(view.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
