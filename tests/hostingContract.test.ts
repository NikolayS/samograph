import { describe, expect, it } from "bun:test";

const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("samohost hosting contract", () => {
  it("keeps every hosted listener path behind the loopback policy", async () => {
    const [appApi, appApiDev, ingest, wsHub, bridge, live, webPackage] = await Promise.all([
      read("apps/app-api/server.ts"),
      read("apps/app-api/dev-server.ts"),
      read("apps/ingest/server.ts"),
      read("apps/ws-hub/server.ts"),
      read("apps/ws-hub/liveBridge.ts"),
      read("apps/ws-hub/dev-live-server.ts"),
      read("apps/web/package.json"),
    ]);

    expect(appApi).toContain("resolveLoopbackHostname(env.HOST)");
    expect(appApiDev).toContain("resolveLoopbackHostname(env.HOST)");
    expect(ingest).toContain("resolveLoopbackHostname(deps.hostname)");
    expect(wsHub).toContain("resolveLoopbackHostname(deps.hostname)");
    expect(bridge).toContain("resolveLoopbackHostname(deps.hostname)");
    expect(live).toContain("resolveLoopbackHostname(process.env.HOST)");
    expect(JSON.parse(webPackage).scripts.start).toBe("next start --hostname 127.0.0.1");
  });

  it("keeps dev control out of prod/preview and out of hosted listeners", async () => {
    const [live, manifest] = await Promise.all([
      read("apps/ws-hub/dev-live-server.ts"),
      read(".samohost.toml"),
    ]);
    expect(live).toContain("shouldStartDevControl(process.env)");
    expect(manifest).not.toMatch(/^\s*name\s*=\s*"dev-ctrl"\s*$/m);
    expect(manifest).toContain('matchPath   = "/__dev*"');
    expect(manifest).toContain("status = 404");
  });

  it("pins DBLab, preview secret isolation, RLS, and dated release tags", async () => {
    const [manifest, workflow] = await Promise.all([
      read(".samohost.toml"),
      read(".github/workflows/ci.yml"),
    ]);
    expect(manifest).toContain('previewDbBackend  = "dblab"');
    expect(manifest).toContain('envDbVars         = ["DATABASE_URL"]');
    expect(manifest).toContain('previewEnvAllowlist = ["DATABASE_URL"]');
    expect(manifest).toContain('rlsUrlVar         = "DATABASE_URL"');
    expect(manifest).toContain("rlsNonSuperuser   = true");
    expect(manifest).toContain(
      'releaseTagPattern = "v[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9]*"',
    );
    expect(manifest).toContain('releaseTagFormat  = "date"');
    expect(manifest).toContain('releaseCiWorkflow = ".github/workflows/ci.yml"');
    expect(workflow).toContain('^v[0-9]{8}\\.[1-9][0-9]*$');
    for (const productionOnlyName of [
      "RECALL_LIVE",
      "RECALL_API_KEY",
      "PUBLIC_WEBHOOK_BASE",
      "RESEND_API_KEY",
    ]) {
      expect(manifest).toContain(`"${productionOnlyName}"`);
    }
  });
});
