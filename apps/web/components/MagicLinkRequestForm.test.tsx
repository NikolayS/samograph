import { describe, it, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { MagicLinkRequestForm } from "./MagicLinkRequestForm.tsx";
import { createFakeAppApiClient } from "../lib/fakeAppApiClient.ts";
import { installDom } from "../test/setup.tsx";

installDom();

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("no <form> rendered");
  fireEvent.submit(form);
}

describe("MagicLinkRequestForm", () => {
  it("renders an email input and a submit button", () => {
    const client = createFakeAppApiClient();
    const { getByLabelText, getByRole } = render(
      <MagicLinkRequestForm client={client} />,
    );
    const input = getByLabelText("Email") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("email");
    expect(getByRole("button", { name: "Send magic link" })).toBeDefined();
  });

  it("rejects an empty submit without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText("Enter your email address.")).toBeDefined();
  });

  it("POSTs the email to /auth/magic-link and shows the check-your-email state", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "dev@samograph.dev" },
    });
    submit(container);

    expect(await findByText("Check your email")).toBeDefined();
    const magicLinkRequests = client.requests.filter(
      (r) => r.path === "/auth/magic-link",
    );
    expect(magicLinkRequests).toEqual([
      {
        path: "/auth/magic-link",
        method: "POST",
        body: { email: "dev@samograph.dev" },
      },
    ]);
    expect(
      await findByText("We sent a sign-in link to dev@samograph.dev."),
    ).toBeDefined();
  });

  it("offers a resend affordance that re-POSTs the same email (SPEC §10 #7)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText, getByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "dev@samograph.dev" },
    });
    submit(container);
    await findByText("Check your email");
    fireEvent.click(getByText("Resend link"));
    await findByText("We sent a sign-in link to dev@samograph.dev.");
    const sends = client.requests.filter((r) => r.path === "/auth/magic-link");
    expect(sends).toHaveLength(2);
    expect(sends.every((r) => r.body.email === "dev@samograph.dev")).toBe(true);
  });

  it("offers an alternate-email path back to the form (SPEC §10 #7)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText, getByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "first@samograph.dev" },
    });
    submit(container);
    await findByText("Check your email");
    fireEvent.click(getByText("Use a different email"));
    // Back on the form.
    expect(getByLabelText("Email")).toBeDefined();
    expect(getByText("Sign in to samograph")).toBeDefined();
  });

  it("DEV: surfaces the magic link inline when the __dev endpoint returns one", async () => {
    const client = createFakeAppApiClient({
      devMagicLink: "http://localhost:3000/auth/callback?token=dev-token",
    });
    const { container, getByLabelText, findByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "dev@samograph.dev" },
    });
    submit(container);
    const link = (await findByText("open your sign-in link")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "http://localhost:3000/auth/callback?token=dev-token",
    );
  });
});
