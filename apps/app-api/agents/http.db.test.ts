import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../../../packages/shared/db/client.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { mintToken, mintShareToken } from "../../../packages/shared/tokens/store.ts";
import { signSession } from "../auth/session.ts";
import { createAgentsHandler } from "./http.ts";

const d = process.env.DATABASE_URL ? describe : describe.skip;
d("hosted agent channel real DB", () => {
  let sql: ReturnType<typeof connect>;
  const user = randomUUID(), tenant = randomUUID(), call = randomUUID();
  const foreignUser = randomUUID(), foreignTenant = randomUUID(), foreignCall = randomUUID();
  const key = { kid: "agent-test", secret: "test-agent-key-not-a-real-secret" };
  const secret = "test-session-key";
  const now = Date.now();
  let handler: (req: Request) => Promise<Response>;
  let binding: any;
  const sent: Array<[string, string]> = [];
  const ownerCookie = () => `samo_session=${signSession({ userId: user, tenantId: tenant, iat: now }, secret)}`;
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => handler(new Request(`https://web.test/calls/${call}/${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  const owner = { cookie: ownerCookie(), origin: "https://web.test" };
  const agent = () => ({ authorization: `Bearer ${binding.credential}`, "x-samograph-binding": binding.id, "x-samograph-provider": "codex", "x-samograph-session": "native-123" });
  beforeAll(async () => {
    sql = connect();
    await migrate(sql);
    await sql`INSERT INTO users(id,email) VALUES (${user},${`${user}@test.invalid`}), (${foreignUser},${`${foreignUser}@test.invalid`})`;
    await sql`INSERT INTO tenants(id,owner_user_id) VALUES (${tenant},${user}),(${foreignTenant},${foreignUser})`;
    await sql`INSERT INTO calls(id,tenant_id,meeting_url,status,recall_bot_id) VALUES (${call},${tenant},'https://meet.google.com/abc-defg-hij','IN_CALL','server-bot'),(${foreignCall},${foreignTenant},'https://meet.google.com/abc-defg-hij','IN_CALL','foreign-bot')`;
    for (let seq = 1; seq <= 80; seq++) await sql`INSERT INTO transcripts(call_id,seq,ts,speaker,text,kind) VALUES (${call},${seq},${new Date(now - (80-seq)*1000)},'Speaker',${`line ${seq}`},${seq % 2 ? "speech" : "chat"})`;
    handler = createAgentsHandler({ sql, sessionSecret: secret, keyring: { current: key }, webOrigin: "https://web.test", clock: () => now, sendChat: async (bot,text) => { sent.push([bot,text]); if (text === "timeout") throw new Error("upstream timeout"); } });
  });
  afterAll(async () => { await sql`DELETE FROM calls WHERE id IN (${call},${foreignCall})`; await sql`DELETE FROM tenants WHERE id IN (${tenant},${foreignTenant})`; await sql`DELETE FROM users WHERE id IN (${user},${foreignUser})`; await sql.close(); });
  test("owner authentication and origin are required", async () => {
    const body = { provider: "codex", native_session_id: "native-123", label: "session" };
    expect((await request("agent-bindings","POST",body)).status).toBe(401);
    expect((await request("agent-bindings","POST",body,{cookie: ownerCookie()})).status).toBe(403);
    expect((await request("agent-bindings","POST",body,{...owner,origin:"https://foreign.test"})).status).toBe(403);
    expect((await request("agent-bindings","POST",body,{...owner,cookie:`samo_session=${signSession({userId:foreignUser,tenantId:foreignTenant,iat:now},secret)}`})).status).toBe(403);
  });
  test("mint fixed grant and conflict, bounded cold context", async () => {
    const res = await request("agent-bindings","POST",{provider:"codex",native_session_id:"native-123",label:"session"},owner);
    expect(res.status).toBe(201); binding = await res.json();
    expect(binding.scopes).toEqual(["listen","act:chat"]);
    expect(new Date(binding.expires_at).getTime()).toBe(Math.floor(now/1000)*1000+3600000);
    expect((await request("agent-bindings","POST",{provider:"codex",native_session_id:"another"},owner)).status).toBe(409);
    const context: any = await (await request("agent/context", "GET", undefined, agent())).json();
    expect(context.lines.map((l: any)=>l.seq)).toEqual(Array.from({length:50},(_,i)=>i+31));
    expect(context.lines[0].kind).toBe("speech"); expect(context.lines[1].kind).toBe("chat");
    expect(context.next_seq).toBe(80); expect(context.has_more).toBe(false);
    const metadata = JSON.stringify(await (await request("agent-bindings","GET",undefined,owner)).json());
    expect(metadata.includes(binding.credential)).toBe(false);
    expect(metadata.includes("last_request_at")).toBe(true);
  });
  test("Bearer-only and exact binding/session/scope/call", async () => {
    for (const headers of [{...owner}, {...agent(),"x-samograph-binding":randomUUID()}, {...agent(),"x-samograph-session":"other"}]) expect((await request("agent/context","GET",undefined,headers)).status).toBe(403);
    for (const scopes of [["share"],["act:frame"]]) {
      const token = await mintToken(sql,{callId:call,scopes,signingKey:key,ttlSeconds:3600,now:Math.floor(now/1000)});
      expect((await request("agent/context","GET",undefined,{...agent(),authorization:`Bearer ${token.token}`})).status).toBe(403);
    }
    const foreign = await handler(new Request(`https://web.test/calls/${foreignCall}/agent/context`,{headers:agent()}));
    expect(foreign.status).toBe(403);
    expect((await request("agent/context?after_seq=-1","GET",undefined,agent())).status).toBe(400);
    expect((await request("agent/context?after_seq=0","GET",undefined,agent())).status).toBe(400);
    expect(sent).toEqual([]);
  });
  test("chat forwards exact text once; unknown never retries", async () => {
    const id = randomUUID();
    const body = {text:"deliberate reply",request_id:id};
    const results = await Promise.all([request("agent/chat","POST",body,agent()), request("agent/chat","POST",body,agent())]);
    expect(results.map(r=>r.status)).toEqual([200,200]);
    expect(sent).toEqual([["server-bot","deliberate reply"]]);
    expect((await request("agent/chat","POST",{...body,text:"changed"},agent())).status).toBe(409);
    const uncertain = {text:"timeout",request_id:randomUUID()};
    expect(((await (await request("agent/chat","POST",uncertain,agent())).json()) as any).outcome).toBe("unknown");
    expect(((await (await request("agent/chat","POST",uncertain,agent())).json()) as any).outcome).toBe("unknown");
    expect(sent).toEqual([["server-bot","deliberate reply"],["server-bot","timeout"]]);
  });
  test("revoke blocks reads and writes, leaves share intact", async () => {
    const share = await mintShareToken(sql,{callId:call,signingKey:key,ttlSeconds:3600});
    expect((await request(`agent-bindings/${binding.id}`,"DELETE",undefined,owner)).status).toBe(204);
    expect((await request(`agent-bindings/${binding.id}`,"DELETE",undefined,owner)).status).toBe(204);
    expect((await request("agent/context","GET",undefined,agent())).status).toBe(403);
    expect((await request("agent/chat","POST",{text:"denied",request_id:randomUUID()},agent())).status).toBe(403);
    expect((await sql`SELECT revoked_at FROM tokens WHERE jti=${share.jti}`)[0].revoked_at).toBeNull();
    expect(sent.length).toBe(2);
  });
});
