import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { ExitError } from "./config.ts";

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type FetchFn = typeof fetch;

export interface GoogleDocsClient {
  appendText(docId: string, text: string): Promise<void>;
  appendToSection(docId: string, heading: string, text: string): Promise<void>;
}

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DOCS_API = "https://docs.googleapis.com/v1/documents";

interface DocsParagraph {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    paragraphStyle?: { namedStyleType?: string };
    elements?: Array<{
      textRun?: { content?: string };
    }>;
  };
}

interface DocsDocument {
  body?: { content?: DocsParagraph[] };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function resolveGoogleDocId(argDocId?: string | null): string {
  const docId = argDocId ?? process.env.GOOGLE_DOC_ID ?? "";
  if (!docId) {
    process.stderr.write(
      "Error: pass --doc-id ID or set GOOGLE_DOC_ID.\n",
    );
    throw new ExitError(2);
  }
  const match = docId.match(/\/document\/d\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : docId;
}

export function loadServiceAccountCredentials(path?: string | null): ServiceAccountCredentials {
  const rawPath = path ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "";
  if (!rawPath) {
    process.stderr.write(
      "Error: pass --credentials FILE or set GOOGLE_APPLICATION_CREDENTIALS.\n",
    );
    throw new ExitError(2);
  }
  if (!existsSync(rawPath)) {
    throw new Error(`Google credentials file not found: ${rawPath}`);
  }
  const parsed = JSON.parse(readFileSync(rawPath, "utf-8")) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Google credentials file must contain client_email and private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
    token_uri: parsed.token_uri,
  };
}

export function createJwtAssertion(
  credentials: ServiceAccountCredentials,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: credentials.client_email,
    scope: DOCS_SCOPE,
    aud: credentials.token_uri ?? TOKEN_URI,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.private_key);
  return `${unsigned}.${base64url(sig)}`;
}

export async function getAccessToken(
  credentials: ServiceAccountCredentials,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: createJwtAssertion(credentials),
  });
  const res = await fetchFn(credentials.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google OAuth failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Google OAuth response did not include access_token");
  }
  return json.access_token;
}

export function makeGoogleDocsClient(
  credentials: ServiceAccountCredentials,
  fetchFn: FetchFn = fetch,
): GoogleDocsClient {
  let cachedToken: string | null = null;
  let cachedTokenUseUntil = 0;

  async function token(): Promise<string> {
    if (!cachedToken || Date.now() >= cachedTokenUseUntil) {
      cachedToken = await getAccessToken(credentials, fetchFn);
      cachedTokenUseUntil = Date.now() + 50 * 60 * 1000;
    }
    return cachedToken;
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await token();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    return fetchFn(url, { ...init, headers });
  }

  async function getDoc(docId: string): Promise<DocsDocument> {
    const encodedDocId = encodeURIComponent(docId);
    const docRes = await request(
      `${DOCS_API}/${encodedDocId}?fields=body(content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType),elements(textRun(content)))))`,
    );
    if (!docRes.ok) {
      throw new Error(`Google Docs get failed: HTTP ${docRes.status} ${await docRes.text()}`);
    }
    return (await docRes.json()) as DocsDocument;
  }

  async function insertText(docId: string, index: number, text: string): Promise<void> {
    const encodedDocId = encodeURIComponent(docId);
    const updateRes = await request(`${DOCS_API}/${encodedDocId}:batchUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index },
              text,
            },
          },
        ],
      }),
    });
    if (!updateRes.ok) {
      throw new Error(`Google Docs update failed: HTTP ${updateRes.status} ${await updateRes.text()}`);
    }
  }

  function endInsertionIndex(doc: DocsDocument): number {
    const content = doc.body?.content ?? [];
    const endIndex = content.length ? content[content.length - 1]!.endIndex ?? 1 : 1;
    return Math.max(1, endIndex - 1);
  }

  function paragraphText(block: DocsParagraph): string {
    return (block.paragraph?.elements ?? [])
      .map((e) => e.textRun?.content ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isHeading(block: DocsParagraph): boolean {
    return Boolean(block.paragraph?.paragraphStyle?.namedStyleType?.startsWith("HEADING_"));
  }

  function sectionInsertionIndex(doc: DocsDocument, heading: string): number | null {
    const content = doc.body?.content ?? [];
    const wanted = heading.toLowerCase();
    const headingIdx = content.findIndex(
      (block) => isHeading(block) && paragraphText(block).toLowerCase() === wanted,
    );
    if (headingIdx === -1) return null;
    for (let i = headingIdx + 1; i < content.length; i++) {
      if (isHeading(content[i]!)) {
        return Math.max(1, (content[i]!.startIndex ?? content[i]!.endIndex ?? 1) - 1);
      }
    }
    return endInsertionIndex(doc);
  }

  return {
    async appendText(docId: string, text: string): Promise<void> {
      await insertText(docId, endInsertionIndex(await getDoc(docId)), text);
    },
    async appendToSection(docId: string, heading: string, text: string): Promise<void> {
      const doc = await getDoc(docId);
      const index = sectionInsertionIndex(doc, heading);
      if (index === null) {
        await insertText(docId, endInsertionIndex(doc), `\n${heading}\n${text}`);
        return;
      }
      await insertText(docId, index, text);
    },
  };
}
