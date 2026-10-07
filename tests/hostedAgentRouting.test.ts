import { expect, test } from "bun:test";

test("samohost sends scoped hosted-agent routes to app-api before web fallback", async () => {
  const manifest = Bun.TOML.parse(await Bun.file(new URL("../.samohost.toml",import.meta.url)).text()) as {routes:Array<{matchRegexp?:string;to?:string}>};
  for(const path of ["/calls/call-id/agent-bindings","/calls/call-id/agent-bindings/binding-id","/calls/call-id/agent/context","/calls/call-id/agent/chat"]) {
    const route=manifest.routes.find(r=>r.matchRegexp && new RegExp(r.matchRegexp).test(path));
    expect(route?.to).toBe("app-api");
  }
  for(const path of ["/calls/call-id","/calls/call-id/agent-wrong","/calls/call-id/agent/context/wrong"]) {
    expect(manifest.routes.some(r=>r.to==="app-api" && r.matchRegexp && new RegExp(r.matchRegexp).test(path))).toBe(false);
  }
});
