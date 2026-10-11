/**
 * ResendEmailSender — real transactional magic-link email via Resend's HTTP API
 * (SPEC §5.1: swappable EmailSender; this is the production implementation).
 *
 * All tests inject the fetch transport: NO network, NO real key. They assert
 * the EXACT request Resend would receive, plus a typed failure path (never a
 * silent hang, never a leaked key).
 */
import { describe, expect, it } from "bun:test";
import {
  ResendEmailSender,
  ResendEmailError,
  RESEND_EMAILS_URL,
  MAGIC_LINK_SUBJECT,
  IDENTITY_LINKED_SUBJECT,
  emailSenderFromEnv,
} from "./resend-email.ts";
import { InMemoryEmailSender } from "./email.ts";

const API_KEY = "re_test_fake_key_not_real";
const FROM = "SamoGraph <signin@samograph.dev>";
const TO = "alice@example.com";
const LINK = "https://samograph.dev/auth/callback?token=abc.def.ghi";

interface Captured {
  url: string;
  init: RequestInit;
}

/** fetch fake that records the single request and returns a canned response. */
function fakeFetch(response: Response, captured: Captured[]): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: "email_123" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendEmailSender", () => {
  it("POSTs the exact Resend request: url, auth header, from/to/subject, link in html", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(okResponse(), captured),
    });

    await sender.sendMagicLink({ to: TO, link: LINK, token: "abc.def.ghi" });

    expect(captured.length).toBe(1);
    const { url, init } = captured[0];
    expect(url).toBe(RESEND_EMAILS_URL);
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String(init.body));
    // Exact top-level shape Resend expects — no extra fields.
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "to"]);
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.subject).toBe(MAGIC_LINK_SUBJECT);
    // The sign-in link must be present in the html body (as the href).
    expect(body.html).toContain(`href="${LINK}"`);
    // The raw token must never ride along outside the link itself.
    expect(body.html.split(LINK).join("")).not.toContain("abc.def.ghi");
  });

  it("HTML-escapes link characters that would break the markup", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(okResponse(), captured),
    });
    const trickyLink = 'https://samograph.dev/cb?a=1&b="2"';
    await sender.sendMagicLink({ to: TO, link: trickyLink, token: "t" });
    const body = JSON.parse(String(captured[0].init.body));
    expect(body.html).toContain('href="https://samograph.dev/cb?a=1&amp;b=&quot;2&quot;"');
    expect(body.html).not.toContain(trickyLink); // raw unescaped form absent
  });

  it("surfaces a typed ResendEmailError on a non-2xx Resend response (exact fields)", async () => {
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(
        new Response(
          JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `from` field" }),
          { status: 422 },
        ),
        [],
      ),
    });

    const err = await sender
      .sendMagicLink({ to: TO, link: LINK, token: "t" })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResendEmailError);
    const rerr = err as ResendEmailError;
    expect(rerr.name).toBe("ResendEmailError");
    expect(rerr.status).toBe(422);
    expect(rerr.message).toContain("422");
    expect(rerr.message).toContain("Invalid `from` field");
  });

  it("wraps a transport failure (fetch rejection) in ResendEmailError — never a bare throw", async () => {
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: (async () => {
        throw new TypeError("Unable to connect");
      }) as unknown as typeof fetch,
    });

    const err = await sender
      .sendMagicLink({ to: TO, link: LINK, token: "t" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResendEmailError);
    expect((err as ResendEmailError).status).toBeUndefined();
    expect((err as ResendEmailError).message).toContain("Unable to connect");
  });

  it("NEVER leaks the API key in errors, even when the provider echoes it back", async () => {
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(
        new Response(`bad auth for key ${API_KEY}`, { status: 401 }),
        [],
      ),
    });

    const err = (await sender
      .sendMagicLink({ to: TO, link: LINK, token: "t" })
      .catch((e: unknown) => e)) as ResendEmailError;

    expect(err).toBeInstanceOf(ResendEmailError);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).toContain("[REDACTED]");
  });

  it("aborts (typed error) instead of hanging forever on a stuck transport", async () => {
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      timeoutMs: 20,
      fetchImpl: ((_url: any, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason ?? new Error("aborted")),
          );
        })) as typeof fetch,
    });

    const err = await sender
      .sendMagicLink({ to: TO, link: LINK, token: "t" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResendEmailError);
  });
});

/**
 * The one-time "a Google account was added to your sign-in" notice (issue #209 /
 * S5-1 item 5). It is the ONLY signal a user gets that a Google `sub` was
 * silently attached to their existing account, so what it contains — and what it
 * deliberately does NOT contain — is a security property, not copy.
 */
describe("ResendEmailSender.sendIdentityLinked (#209)", () => {
  it("POSTs the exact Resend request with the identity-linked subject", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(okResponse(), captured),
    });

    await sender.sendIdentityLinked({ to: TO, provider: "google" });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(RESEND_EMAILS_URL);
    expect((captured[0].init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    const body = JSON.parse(String(captured[0].init.body)) as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.subject).toBe(IDENTITY_LINKED_SUBJECT);
    expect(body.subject).toBe("A Google account was added to your samograph.dev sign-in");
  });

  it("carries NO link and NO token — a 'wasn't me?' mail with an action is a phishing template", async () => {
    const captured: Captured[] = [];
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(okResponse(), captured),
    });

    await sender.sendIdentityLinked({ to: TO, provider: "google" });

    const html = (JSON.parse(String(captured[0].init.body)) as { html: string }).html;
    expect(html).not.toContain("href");
    expect(html).not.toContain("http");
    expect(html).toContain("A Google account was added to your sign-in");
  });

  it("wraps a rejection in ResendEmailError and never leaks the API key", async () => {
    const sender = new ResendEmailSender({
      apiKey: API_KEY,
      from: FROM,
      fetchImpl: fakeFetch(new Response(`bad auth for key ${API_KEY}`, { status: 401 }), []),
    });

    const err = (await sender
      .sendIdentityLinked({ to: TO, provider: "google" })
      .catch((e: unknown) => e)) as ResendEmailError;

    expect(err).toBeInstanceOf(ResendEmailError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).toContain("[REDACTED]");
  });
});

describe("emailSenderFromEnv", () => {
  const fallback = new InMemoryEmailSender();

  it("returns the fallback when RESEND_API_KEY is unset (local/fake mode)", () => {
    expect(emailSenderFromEnv({}, fallback)).toBe(fallback);
    expect(emailSenderFromEnv({ MAGIC_LINK_FROM: FROM }, fallback)).toBe(fallback);
  });

  it("returns a ResendEmailSender when RESEND_API_KEY + MAGIC_LINK_FROM are set", () => {
    const sender = emailSenderFromEnv(
      { RESEND_API_KEY: API_KEY, MAGIC_LINK_FROM: FROM },
      fallback,
    );
    expect(sender).toBeInstanceOf(ResendEmailSender);
  });

  it("fails fast (exact message, no key echoed) when the key is set but MAGIC_LINK_FROM is missing", () => {
    let thrown: unknown;
    try {
      emailSenderFromEnv({ RESEND_API_KEY: API_KEY }, fallback);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toBe(
      "RESEND_API_KEY is set but MAGIC_LINK_FROM is missing — set MAGIC_LINK_FROM to a Resend-verified sender address",
    );
    expect(msg).not.toContain(API_KEY);
  });
});
