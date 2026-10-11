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
    expect(getByRole("button", { name: "Send magic link" }).className).toContain("samograph-btn");
    expect(getByRole("button", { name: "Send magic link" }).className).toContain("samograph-btn--primary");
  });

  it("marks Send magic link busy and disabled while sending", () => {
    const client = createFakeAppApiClient();
    client.requestMagicLink = () => new Promise(() => {});
    const { container, getByLabelText, getByRole } = render(<MagicLinkRequestForm client={client} />);
    fireEvent.change(getByLabelText("Email"), { target: { value: "dev@samograph.dev" } });
    submit(container);
    const button = getByRole("button", { name: "Send magic link" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("rejects an empty submit without calling the client", () => {
    const client = createFakeAppApiClient();
    const { container, getByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    submit(container);
    expect(client.requests).toEqual([]);
    expect(getByText("Enter your email address.")).toBeDefined();
    const alert = getByText("Enter your email address.");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.className).toContain("samograph-alert samograph-alert--error");
  });

  it("POSTs the email to /auth/magic-link and shows the check-your-email state", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText, findByRole, getByRole } = render(
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
    const info = await findByRole("status");
    expect(info.textContent).toBe("We sent a sign-in link to dev@samograph.dev.");
    expect(info.getAttribute("role")).toBe("status");
    expect(info.className).toContain("samograph-alert--info");
    expect(getByRole("button", { name: "Resend link" }).className).toContain("samograph-btn--secondary");
    expect(getByRole("button", { name: "Use a different email" }).className).toContain("samograph-btn--secondary");
  });

  it("groups the exact sent state, mono email, and secondary actions", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByRole, getByRole } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), { target: { value: "user@example.com" } });
    submit(container);

    const status = await findByRole("status");
    expect(status.textContent).toBe("We sent a sign-in link to user@example.com.");
    const email = status.querySelector("span.samograph-auth-email");
    expect(email?.textContent).toBe("user@example.com");
    expect(status.closest(".samograph-auth-sent")).not.toBeNull();
    const actions = container.querySelector(".samograph-actions");
    expect(actions).not.toBeNull();
    const resend = getByRole("button", { name: "Resend link" });
    const alternate = getByRole("button", { name: "Use a different email" });
    expect(resend.parentElement).toBe(actions);
    expect(alternate.parentElement).toBe(actions);
    expect(resend.className).toBe("samograph-btn samograph-btn--secondary");
    expect(alternate.className).toBe("samograph-btn samograph-btn--secondary");
  });

  it("offers a resend affordance that re-POSTs the same email (SPEC §10 #7)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText, findByRole, getByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "dev@samograph.dev" },
    });
    submit(container);
    await findByText("Check your email");
    fireEvent.click(getByText("Resend link"));
    expect((await findByRole("status")).textContent).toBe("We sent a sign-in link to dev@samograph.dev.");
    const sends = client.requests.filter((r) => r.path === "/auth/magic-link");
    expect(sends).toHaveLength(2);
    expect(sends.every((r) => r.body.email === "dev@samograph.dev")).toBe(true);
  });

  it("offers an alternate-email path back to the form (SPEC §10 #7)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText, getByText, queryByText } = render(
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
    expect(queryByText("Check your email")).toBeNull();
  });

  /**
   * Heading ownership moved to `AuthLanding` (issue #209, PR 6): the page `<h1>`
   * has to precede BOTH credential options, and two components each owning an
   * `<h1>` is how a page ends up with two. This form owns NO `<h1>` in any state;
   * its check-your-email heading is an `<h2>` beneath the landing's `<h1>`.
   */
  it("owns no <h1> — the landing does (#209)", () => {
    const client = createFakeAppApiClient();
    const { container } = render(<MagicLinkRequestForm client={client} />);
    expect(container.querySelectorAll("h1").length).toBe(0);
  });

  it("headings the check-your-email state as an <h2>, not an <h1> (#209)", async () => {
    const client = createFakeAppApiClient();
    const { container, getByLabelText, findByText } = render(
      <MagicLinkRequestForm client={client} />,
    );
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "h2@samograph.dev" },
    });
    submit(container);
    await findByText("Check your email");
    expect(container.querySelectorAll("h1").length).toBe(0);
    const h2s = container.querySelectorAll("h2");
    expect(h2s.length).toBe(1);
    expect(h2s[0].textContent).toBe("Check your email");
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
