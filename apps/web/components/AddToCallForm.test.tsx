import { describe, it, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { AddToCallForm } from "./AddToCallForm.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { AppApiError } from "../lib/appApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("no <form> rendered");
  fireEvent.submit(form);
}

const REJECT_MESSAGE = "That doesn't look like a Zoom or Google Meet meeting link.";

describe("AddToCallForm — the dashboard's single primary action", () => {
  it("renders a level-2 heading or label, paste input, and submit button without an h1", () => {
    const client = createFakeAppApiClient();
    const { getByText, getByLabelText, getByRole, queryByRole } = render(
      <AddToCallForm client={client} />,
    );
    expect(getByText("Add samograph to a call")).toBeDefined();
    expect(queryByRole("heading", { level: 1 })).toBeNull();
    expect(getByRole("heading", { level: 2, name: "Add samograph to a call" })).toBeDefined();
    expect((getByLabelText("Meeting link") as HTMLInputElement).tagName).toBe("INPUT");
    expect(getByRole("button", { name: "Add to call" })).toBeDefined();
    expect(getByRole("button", { name: "Add to call" }).classList.contains("samograph-btn")).toBe(true);
    expect(getByRole("button", { name: "Add to call" }).classList.contains("samograph-btn--primary")).toBe(true);
  });

  it("focuses the meeting-link input on mount when autoFocus is true", () => {
    const client = createFakeAppApiClient();
    const { getByPlaceholderText } = render(
      <AddToCallForm client={client} autoFocus />,
    );
    const input = getByPlaceholderText("Paste a Zoom or Google Meet link");
    expect(document.activeElement === input).toBe(true);
  });

  it("does not focus the meeting-link input when autoFocus is omitted", () => {
    const client = createFakeAppApiClient();
    const { getByPlaceholderText } = render(<AddToCallForm client={client} />);
    const input = getByPlaceholderText("Paste a Zoom or Google Meet link");
    expect(document.activeElement).not.toBe(input);
  });

  it("lays out the mono input and primary submit button in the hero form row", () => {
    const client = createFakeAppApiClient();
    const { getByPlaceholderText, getByRole } = render(<AddToCallForm client={client} />);
    const input = getByPlaceholderText("Paste a Zoom or Google Meet link");
    const button = getByRole("button", { name: "Add to call" });
    const row = input.closest(".samograph-dash-hero-form");
    expect(input.classList.contains("samograph-field-input--mono")).toBe(true);
    expect(row).not.toBeNull();
    expect(row?.contains(input)).toBe(true);
    expect(row?.contains(button)).toBe(true);
    expect(button.classList.contains("samograph-btn")).toBe(true);
    expect(button.classList.contains("samograph-btn--primary")).toBe(true);
  });

  it("renders validation errors below, not inside, the input and button row", () => {
    const client = createFakeAppApiClient();
    const { container, getByText } = render(<AddToCallForm client={client} />);
    submit(container);
    const alert = getByText(REJECT_MESSAGE);
    const row = container.querySelector(".samograph-dash-hero-form");
    expect(row?.contains(alert)).toBe(false);
    expect(alert.previousElementSibling).toBe(row);
  });

  it("marks the Add to call button busy and disabled while creating", async () => {
    const client = createFakeAppApiClient();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = client.createCall.bind(client);
    client.createCall = async (input) => { await pending; return original(input); };
    const { container, getByLabelText, getByRole } = render(<AddToCallForm client={client} />);
    fireEvent.change(getByLabelText("Meeting link"), { target: { value: "https://meet.google.com/abc-defg-hij" } });
    submit(container);
    const button = getByRole("button", { name: "Add to call" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    release();
  });

  it("rejects an empty submit without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByText } = render(<AddToCallForm client={client} />);
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText(REJECT_MESSAGE)).toBeDefined();
    const alert = getByText(REJECT_MESSAGE);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.classList.contains("samograph-alert")).toBe(true);
    expect(alert.classList.contains("samograph-alert--error")).toBe(true);
  });

  it("rejects whitespace-only input without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, getByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "   " },
    });
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText(REJECT_MESSAGE)).toBeDefined();
  });

  it("rejects a non-meeting URL without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, getByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://example.com/whatever" },
    });
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText(REJECT_MESSAGE)).toBeDefined();
  });

  it("accepts a valid Google Meet URL, calls /calls, and renders PENDING", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    submit(container);

    expect(await findByText("PENDING")).toBeDefined();
    expect(client.requests).toEqual([
      {
        path: "/calls",
        method: "POST",
        body: { meeting_url: "https://meet.google.com/abc-defg-hij" },
      },
    ]);
  });

  it("accepts a valid Zoom URL", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://zoom.us/j/123456789" },
    });
    submit(container);
    expect(await findByText("PENDING")).toBeDefined();
    expect(client.requests[0]?.body).toEqual({
      meeting_url: "https://zoom.us/j/123456789",
    });
  });

  it("surfaces the server's typed {code,message} on a server-side rejection", async () => {
    // A URL that passes the client's loose pre-flight but the server rejects:
    // the form must show the SERVER's message, not a generic "Try again."
    const client = createFakeAppApiClient({
      failCreateCallWith: {
        code: "SAMO-CALL-URL",
        message: "That doesn't look like a Zoom or Google Meet meeting link.",
        status: 400,
      },
    });
    const { container, getByLabelText, findByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    submit(container);
    expect(
      await findByText("That doesn't look like a Zoom or Google Meet meeting link."),
    ).toBeDefined();
  });

  it("links to the existing call when SAMO-CALL-ACTIVE is returned", async () => {
    const client = createFakeAppApiClient({ failCreateCallWith: {
      code: "SAMO-CALL-ACTIVE", message: "Request failed.", status: 409,
    } });
    const { container, getByLabelText, findByRole, queryByRole } = render(<AddToCallForm client={client} />);
    client.createCall = async () => {
      throw new AppApiError("SAMO-CALL-ACTIVE", "Request failed.", false, 409, "active-1");
    };
    fireEvent.change(getByLabelText("Meeting link"), { target: { value: "https://zoom.us/j/123456789" } });
    submit(container);
    const link = await findByRole("link", { name: "samograph is already in this call" });
    expect(link.getAttribute("href")).toBe("/calls/active-1");
    expect(queryByRole("alert")).toBeNull();
  });

  it("shows a distinct 'signed out' copy (not generic) when the session is stale (#114)", async () => {
    // A deleted-tenant session returns 401 SAMO-AUTH-005. Even when the raw wire
    // message is the generic fallback, the form must derive and show the distinct
    // "you've been signed out" copy — never the generic "Request failed."
    const client = createFakeAppApiClient({
      failCreateCallWith: {
        code: "SAMO-AUTH-005",
        message: "Request failed.",
        status: 401,
      },
    });
    const { container, getByLabelText, findByText, queryByText } = render(
      <AddToCallForm client={client} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    submit(container);
    expect(
      await findByText("You've been signed out. Please sign in again."),
    ).toBeDefined();
    expect(queryByText("Request failed.")).toBeNull();
  });

  it("calls onCreated with the PENDING call after a successful create", async () => {
    const client = createFakeAppApiClient();
    const created: string[] = [];
    const { container, getByLabelText, findByText } = render(
      <AddToCallForm client={client} onCreated={(c) => created.push(c.id)} />,
    );
    fireEvent.change(getByLabelText("Meeting link"), {
      target: { value: "https://zoom.us/j/123456789" },
    });
    submit(container);
    expect(await findByText("PENDING")).toBeDefined();
    expect(created).toEqual(["call_1"]);
  });

  it("pre-fills the paste input from initialUrl (Story-4 hook)", () => {
    const client = createFakeAppApiClient();
    const { getByLabelText } = render(
      <AddToCallForm client={client} initialUrl="https://zoom.us/j/999" />,
    );
    expect((getByLabelText("Meeting link") as HTMLInputElement).value).toBe(
      "https://zoom.us/j/999",
    );
  });
});
