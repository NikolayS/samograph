import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { sha256Hex } from "../../../packages/shared/crypto.ts";
import { createAppApi } from "../app.ts";
import { InMemoryEmailSender } from "../auth/index.ts";
import { signSession } from "../auth/session.ts";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("hosted agent CLI over real HTTP and PostgreSQL", () => {
  test("owner grant → CLI connect/context/idempotent chat → revoke denies both → local disconnect", async () => {
    const sql = connect();
    const user = randomUUID(), tenant = randomUUID(), call = randomUUID();
    const now = Date.now(), sessionSecret = "cli-e2e-fixture-session";
    const nativeSession = `cli-e2e-${randomUUID()}`;
    const directory = mkdtempSync(join(tmpdir(), "samograph-cli-e2e-"));
    chmodSync(directory, 0o700);
    const credentialDirectory = join(directory, "credentials");
    const sent: Array<{ bot: string; text: string }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/chat") return new Response(null, { status: 404 });
        sent.push(await request.json() as { bot: string; text: string });
        return new Response(null, { status: 204 });
      },
    });
    const api = createAppApi({
      sql, sessionSecret, magicLinkKid: "cli-e2e", magicLinkSecret: "cli-e2e-fixture-link",
      tokenKeyring: { current: { kid: "cli-e2e", secret: "cli-e2e-fixture-token" } },
      emailSender: new InMemoryEmailSender(), webOrigin: "http://web.test", clock: () => now,
      enqueue: () => {},
      hostedAgentChat: async (bot, text) => {
        const response = await fetch(`${upstream.url}chat`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot, text }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("Fixture upstream rejected chat");
      },
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch });
    const ownerHeaders = {
      cookie: `samo_session=${signSession({ userId: user, tenantId: tenant, iat: now }, sessionSecret)}`,
      origin: "http://web.test", "content-type": "application/json",
    };
    let credential = "";
    const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
    async function cli(args: string[], input?: string) {
      // A real subprocess with a fresh private credential store and no inherited provider keys.
      // spawnSync would deadlock the loopback servers running in this process.
      const child = Bun.spawn([process.execPath, cliPath, "agent", ...args], {
        env: { PATH: process.env.PATH ?? "", SAMOGRAPH_AGENT_CREDENTIAL_DIR: credentialDirectory },
        stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        // Boolean assertions keep a private credential out of failed-test diagnostics too.
        expect(credential !== "" && (stdout.includes(credential) || stderr.includes(credential))).toBe(false);
        return { exitCode, stdout, stderr };
      } finally { clearTimeout(timeout); child.kill(); }
    }
    try {
      await migrate(sql);
      await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`})`;
      await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user})`;
      await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','cli-e2e-server-selected-bot')`;
      const ts = new Date(now);
      await sql`INSERT INTO transcripts(call_id,seq,ts,speaker,text) VALUES (${call},1,${new Date(now - 600_000)},'owner','old excluded history'),(${call},2,${ts},'owner','private fixture context')`;

      const granted = await fetch(`${server.url}calls/${call}/agent-bindings`, {
        method: "POST", headers: ownerHeaders,
        body: JSON.stringify({ provider: "codex", native_session_id: nativeSession, label: "CLI subprocess fixture" }),
      });
      expect(granted.status).toBe(201);
      const binding = await granted.json() as { id: string; credential: string };
      credential = binding.credential;
      expect(typeof credential === "string" && credential.length > 0).toBe(true);
      const identity = ["--binding", binding.id, "--call", call, "--provider", "codex", "--session", nativeSession];
      const connected = await cli(["connect", ...identity, "--origin", server.url.origin, "--allow-loopback-http"], `${credential}\n`);
      expect(connected.exitCode).toBe(0);
      expect(connected.stderr).toBe("");
      expect(JSON.parse(connected.stdout)).toEqual({ binding_id: binding.id, connected: true });
      const savedPath = join(credentialDirectory, `${binding.id}.json`);
      expect(statSync(credentialDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(savedPath).mode & 0o777).toBe(0o600);

      const context = await cli(["context", ...identity]);
      expect(context.exitCode).toBe(0);
      expect(context.stderr).toBe("");
      expect(JSON.parse(context.stdout)).toEqual({
        trust: "untrusted_meeting_data",
        binding: { id: binding.id, call_id: call, provider: "codex", native_session_id: nativeSession },
        status: "IN_CALL", ingest_degraded: false,
        lines: [{ seq: 2, ts: ts.toISOString(), speaker: "owner", text: "private fixture context", kind: "speech" }],
        omitted: [], next_seq: 2, has_more: false, truncated: false,
      });
      const requestId = randomUUID(), text = "CLI subprocess fixture reply";
      for (let attempt = 0; attempt < 2; attempt++) {
        const chat = await cli(["chat", text, ...identity, "--request-id", requestId]);
        expect(chat.exitCode).toBe(0);
        expect(chat.stderr).toBe("");
        expect(JSON.parse(chat.stdout)).toEqual({ request_id: requestId, outcome: "accepted" });
      }
      expect(sent).toEqual([{ bot: "cli-e2e-server-selected-bot", text }]);
      const ledger = await sql`SELECT request_id,content_sha256,outcome FROM agent_chat_requests WHERE binding_id=${binding.id}`;
      expect(ledger.map((row: { request_id: string; content_sha256: string; outcome: string }) => ({ request_id: row.request_id, content_sha256: row.content_sha256, outcome: row.outcome })))
        .toEqual([{ request_id: requestId, content_sha256: sha256Hex(text), outcome: "accepted" }]);

      const revoked = await fetch(`${server.url}calls/${call}/agent-bindings/${binding.id}`, { method: "DELETE", headers: ownerHeaders });
      expect(revoked.status).toBe(204);
      for (const args of [["context", ...identity], ["chat", "denied fixture reply", ...identity, "--request-id", randomUUID()]]) {
        const denied = await cli(args);
        expect(denied.exitCode).toBe(1);
        expect(denied.stdout).toBe("");
        expect(denied.stderr).toBe("samograph: error: Agent request denied (403)\n");
      }
      expect(sent).toEqual([{ bot: "cli-e2e-server-selected-bot", text }]);
      expect((await sql`SELECT count(*)::int AS n FROM agent_chat_requests WHERE binding_id=${binding.id}`)[0].n).toBe(1);

      // Disconnect is local: it succeeds even after the HTTP service has stopped.
      server.stop(true);
      const disconnected = await cli(["disconnect", ...identity]);
      expect(disconnected.exitCode).toBe(0);
      expect(disconnected.stderr).toBe("");
      expect(JSON.parse(disconnected.stdout)).toEqual({ binding_id: binding.id, disconnected: true, remote_revoked: false });
      expect(existsSync(savedPath)).toBe(false);
      expect(readdirSync(credentialDirectory)).toEqual([]);
    } finally {
      server.stop(true);
      upstream.stop(true);
      try {
        await sql`DELETE FROM calls WHERE tenant_id=${tenant}`;
        await sql`DELETE FROM audit_log WHERE tenant_id=${tenant}`;
        await sql`DELETE FROM tenants WHERE id=${tenant}`;
        await sql`DELETE FROM users WHERE id=${user}`;
      } finally { await sql.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  }, 60_000);
});
