import { describe, it, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  createJwtAssertion,
  getAccessToken,
  makeGoogleDocsClient,
  resolveGoogleDocId,
} from "../src/googleDocs.ts";
import { saveEnv, restoreEnv } from "./helpers.ts";

function privateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("googleDocs", () => {
  it("resolves doc id from env", () => {
    const env = saveEnv();
    try {
      process.env.GOOGLE_DOC_ID = "doc-env";
      expect(resolveGoogleDocId(null)).toBe("doc-env");
      expect(resolveGoogleDocId("doc-arg")).toBe("doc-arg");
      expect(resolveGoogleDocId("https://docs.google.com/document/d/doc-url/edit")).toBe("doc-url");
    } finally {
      restoreEnv(env);
    }
  });

  it("creates a signed JWT assertion", () => {
    const jwt = createJwtAssertion(
      {
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: privateKey(),
      },
      1_717_000_000,
    );
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("exchanges service-account JWT for an access token", async () => {
    const calls: Request[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      return Response.json({ access_token: "token-123" });
    };

    const token = await getAccessToken(
      {
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: privateKey(),
      },
      fetchFn as typeof fetch,
    );

    expect(token).toBe("token-123");
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(await calls[0]!.text()).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
  });

  it("appends text at the end of a Google Doc", async () => {
    const requests: Request[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      requests.push(req);
      if (req.url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "token-123" });
      }
      if (req.url.includes("?fields=body")) {
        expect(req.headers.get("authorization")).toBe("Bearer token-123");
        return Response.json({ body: { content: [{ endIndex: 42 }] } });
      }
      return Response.json({ replies: [] });
    };

    const client = makeGoogleDocsClient(
      {
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: privateKey(),
      },
      fetchFn as typeof fetch,
    );

    await client.appendText("doc id", "Alice: hello\n");

    expect(requests[1]!.url).toContain("/documents/doc%20id?fields=");
    expect(requests[2]!.url).toContain("/documents/doc%20id:batchUpdate");
    expect(await requests[2]!.json()).toEqual({
      requests: [
        {
          insertText: {
            location: { index: 41 },
            text: "Alice: hello\n",
          },
        },
      ],
    });
  });
});
