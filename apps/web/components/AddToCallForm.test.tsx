import { describe, it, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { AddToCallForm } from "./AddToCallForm.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("no <form> rendered");
  fireEvent.submit(form);
}

const REJECT_MESSAGE = "Enter a Zoom or Google Meet link.";

describe("AddToCallForm — the dashboard's single primary action", () => {
  it("renders the heading, paste input, and submit button", () => {
    const client = createFakeAppApiClient();
    const { getByText, getByLabelText, getByRole } = render(
      <AddToCallForm client={client} />,
    );
    expect(getByText("Add samograph to a call")).toBeDefined();
    expect((getByLabelText("Meeting link") as HTMLInputElement).tagName).toBe("INPUT");
    expect(getByRole("button", { name: "Add to call" })).toBeDefined();
  });

  it("rejects an empty submit without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByText } = render(<AddToCallForm client={client} />);
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText(REJECT_MESSAGE)).toBeDefined();
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
        body: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
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
      meetingUrl: "https://zoom.us/j/123456789",
    });
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
