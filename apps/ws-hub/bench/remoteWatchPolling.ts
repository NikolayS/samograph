/**
 * #307 prototype 1 — measurement harness for `samograph watch --remote` (plain
 * polling) against a LOCAL `dev-live-server.ts` (in-repo Recall fake, dev-only
 * secrets, no real tokens). Not a CI gate; run by hand:
 *
 *   SAMO_ENV=dev DATABASE_URL=... bun apps/ws-hub/dev-live-server.ts &
 *   SAMO_ENV=dev DATABASE_URL=... bun apps/ws-hub/bench/remoteWatchPolling.ts [mint|latency|burst|idle|all]
 *
 * It creates a throwaway user/tenant/IN_CALL call, mints a share token with the
 * dev-server's keyring (kid `dev-share`, TOKEN_SECRET or its public dev default)
 * into a 0600 temp file, and spawns the REAL CLI:
 *
 *   bun src/cli.ts watch --remote http://127.0.0.1:<proxy> --call <id> --token-file <f>
 *
 * A counting loopback proxy sits in front of ws-hub so requests/min are the
 * CLI's real traffic. Lines are injected with `POST /__dev/say` (the real §5.4
 * pipeline + fan-in). The token is never printed.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../../packages/shared/db/index.ts";
import { migrate } from "../../../packages/shared/db/migrate.ts";
import { mintShareToken } from "../../../packages/shared/tokens/store.ts";

const WS = `http://127.0.0.1:${process.env.WS_HUB_PORT ?? 8788}`;
const CTRL = `http://127.0.0.1:${process.env.DEV_CTRL_PORT ?? 8790}`;
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd"; // public dev default
const INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? 2);
const LAT_N = Number(process.env.LATENCY_LINES ?? 60);
const IDLE_S = Number(process.env.IDLE_SECONDS ?? 60);
const mode = process.argv[2] ?? "all";

const sql = connect();
await migrate(sql);

async function setup(): Promise<{ callId: string; tokenFile: string; dir: string }> {
  const user = randomUUID();
  const tenant = randomUUID();
  const callId = randomUUID();
  await sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@bench.test`})`;
  await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user})`;
  await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
    VALUES (${callId}, ${tenant}, 'https://meet.google.com/bench', 'IN_CALL')`;
  const { token } = await mintShareToken(sql, {
    callId,
    signingKey: { kid: "dev-share", secret: TOKEN_SECRET },
    ttlSeconds: 6 * 3600,
  });
  const dir = mkdtempSync(join(tmpdir(), "p307-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, 0o600);
  return { callId, tokenFile, dir };
}

/** Counting reverse proxy → ws-hub. */
function startProxy() {
  let count = 0;
  const statuses: Record<number, number> = {};
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      count++;
      const u = new URL(req.url);
      const res = await fetch(`${WS}${u.pathname}${u.search}`, { headers: req.headers });
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, count: () => count, statuses, stop: () => srv.stop(true) };
}

/** Spawn the real CLI in remote mode (argv array, no shell); track stdout lines. */
function spawnCli(base: string, callId: string, tokenFile: string, dir: string) {
  const argv = [
    "bun", "src/cli.ts", "watch", "--remote", base, "--call", callId,
    "--token-file", tokenFile, "--interval", String(INTERVAL_S),
    "--transcript-file", join(dir, "transcript.txt"),
  ];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, SAMOGRAPH_HOME: dir } });
  const lines: { text: string; at: number }[] = [];
  const stderr: string[] = [];
  const waiters: { needle: string; resolve: (at: number) => void }[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const at = performance.now();
        lines.push({ text, at });
        for (let k = waiters.length - 1; k >= 0; k--) {
          if (text.endsWith(waiters[k]!.needle)) {
            waiters[k]!.resolve(at);
            waiters.splice(k, 1);
          }
        }
      }
    }
  })();
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) stderr.push(dec.decode(chunk));
  })();
  const waitFor = (needle: string) =>
    new Promise<number>((resolve) => {
      const hit = lines.find((l) => l.text.endsWith(needle));
      if (hit) resolve(hit.at);
      else waiters.push({ needle, resolve });
    });
  return { proc, lines, stderr, waitFor };
}

async function say(callId: string, text: string): Promise<void> {
  const r = await fetch(`${CTRL}/__dev/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ call_id: callId, speaker: "Bench", text }),
  });
  if (!r.ok) throw new Error(`/__dev/say → ${r.status} ${await r.text()}`);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

type Cli = ReturnType<typeof spawnCli>;
type Proxy = ReturnType<typeof startProxy>;

async function withCli<T>(fn: (c: Cli, callId: string, proxy: Proxy) => Promise<T>): Promise<T> {
  const { callId, tokenFile, dir } = await setup();
  const proxy = startProxy();
  const cli = spawnCli(proxy.url, callId, tokenFile, dir);
  try {
    await Bun.sleep(500);
    return await fn(cli, callId, proxy);
  } finally {
    cli.proc.kill();
    proxy.stop();
    const errs = cli.stderr.join("").trim();
    if (errs) console.log(`  cli stderr (last 3): ${errs.split("\n").slice(-3).join(" | ")}`);
  }
}

if (mode === "mint") {
  const { callId, tokenFile } = await setup();
  console.log(`CALL_ID=${callId}\nTOKEN_FILE=${tokenFile}   # 0600; token not printed`);
}

if (mode === "latency" || mode === "all") {
  await withCli(async (cli, callId) => {
    const lat: number[] = [];
    for (let i = 1; i <= LAT_N; i++) {
      // Random phase vs the poll timer so the sample is not biased.
      await Bun.sleep(Math.random() * INTERVAL_S * 1000);
      const needle = `lat-${i}-${randomUUID().slice(0, 8)}`;
      const t0 = performance.now();
      const arrived = cli.waitFor(needle);
      await say(callId, needle);
      lat.push((await arrived) - t0);
    }
    console.log(
      `[latency] n=${lat.length} interval=${INTERVAL_S}s p50=${Math.round(pct(lat, 50))}ms ` +
        `p95=${Math.round(pct(lat, 95))}ms max=${Math.round(Math.max(...lat))}ms`,
    );
  });
}

if (mode === "burst" || mode === "all") {
  await withCli(async (cli, callId) => {
    const tag = randomUUID().slice(0, 8);
    const t0 = performance.now();
    for (let i = 1; i <= 200; i++) await say(callId, `burst-${tag}-${i}`);
    const injectedMs = performance.now() - t0;
    const lastAt = await cli.waitFor(`burst-${tag}-200`);
    await Bun.sleep(INTERVAL_S * 1000 + 500); // catch any late duplicates
    const re = new RegExp(`burst-${tag}-(\\d+)$`);
    const got = cli.lines
      .map((l) => l.text.match(re)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    const ok = got.length === 200 && got.every((n, i) => n === i + 1);
    console.log(
      `[burst] 200 lines: received=${got.length} in-order-no-dupes=${ok} ` +
        `inject=${Math.round(injectedMs)}ms first-inject→last-line=${Math.round(lastAt - t0)}ms`,
    );
  });
}

if (mode === "idle" || mode === "all") {
  await withCli(async (cli, callId, proxy) => {
    const c0 = proxy.count();
    await Bun.sleep(IDLE_S * 1000);
    const idleReq = proxy.count() - c0;
    const errLines = cli.stderr.join("").split("\n").filter((l) => /error|retrying|limited/.test(l)).length;
    const t0 = performance.now();
    const arrived = cli.waitFor("after-idle");
    await say(callId, "after-idle");
    const lat = (await arrived) - t0;
    console.log(
      `[idle] ${IDLE_S}s: requests=${idleReq} (${((idleReq * 60) / IDLE_S).toFixed(1)}/min) ` +
        `statuses=${JSON.stringify(proxy.statuses)} errors/retries=${errLines} ` +
        `post-idle latency=${Math.round(lat)}ms cli-alive=${cli.proc.exitCode === null}`,
    );
  });
}

await sql.close();
