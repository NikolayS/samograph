/**
 * #307 prototype 2/3 — LOCAL measurement of `samograph watch --remote … --mode
 * longpoll` against `apps/ws-hub/dev-live-server.ts` (LOCAL-ONLY, in-repo fakes,
 * dev-default secrets — never point this at a real deployment).
 *
 * Prereqs: Postgres at DATABASE_URL (migrated), and dev-live-server running:
 *   DATABASE_URL=… bun apps/ws-hub/dev-live-server.ts
 *
 * Then:
 *   DATABASE_URL=… bun apps/ws-hub/bench/longpollRemote.ts [--lines 60] [--idle-s 120]
 *
 * What it does:
 *   1. seeds a throwaway user/tenant/call and mints a 1 h per-call SHARE token
 *      with the dev keyring (same kid/secret the dev-live-server verifies with);
 *   2. starts a counting pass-through proxy in front of ws-hub (every CLI request
 *      goes through it, so requests/min and statuses are measured, not guessed);
 *   3. spawns the REAL CLI (`bun src/cli.ts watch --remote <proxy> --call <id>
 *      --mode longpoll`) with the token in SAMOGRAPH_CALL_TOKEN;
 *   4. LATENCY: injects N lines via POST /__dev/say, 1 per ~250 ms, and times
 *      inject-start → the line appearing on the CLI's stdout (p50/p95/max);
 *   5. BURST: injects 200 lines back-to-back; asserts all 200 arrive exactly
 *      once in order; reports first inject → last line;
 *   6. IDLE: injects nothing for --idle-s seconds, counts requests + errors,
 *      then injects 1 line and asserts it arrives (no manual restart).
 * The token is never printed.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../../packages/shared/db/client.ts";
import { mintShareToken } from "../../../packages/shared/tokens/store.ts";

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
}
const N = arg("--lines", 60);
const BURST = arg("--burst", 200);
const IDLE_S = arg("--idle-s", 120);
const WS_HUB = process.env.WS_HUB_URL ?? "http://localhost:8788";
const CTRL = process.env.DEV_CTRL_URL ?? "http://localhost:8790";
// DEV-ONLY: the dev-live-server's keyring (kid "dev-share", TOKEN_SECRET or its dev default).
const DEV_KEY = { kid: "dev-share", secret: process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// ── 1. seed a throwaway call + share token ─────────────────────────────────────
const sql = connect();
const user = randomUUID();
const tenant = randomUUID();
const callId = randomUUID();
await sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@bench.test`})`;
await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user})`;
await sql`INSERT INTO calls (id, tenant_id, meeting_url, status)
  VALUES (${callId}, ${tenant}, 'https://meet.google.com/bench-lp', 'IN_CALL')`;
const { token } = await mintShareToken(sql, { callId, signingKey: DEV_KEY, ttlSeconds: 3600 });

// ── 2. counting pass-through proxy ─────────────────────────────────────────────
const reqLog: Array<{ at: number; status: number }> = [];
const proxy = Bun.serve({
  port: 0,
  idleTimeout: 255,
  async fetch(req) {
    const u = new URL(req.url);
    const res = await fetch(WS_HUB + u.pathname + u.search, { headers: req.headers, signal: req.signal }).catch(
      () => new Response(null, { status: 502 }),
    );
    reqLog.push({ at: performance.now(), status: res.status });
    return res;
  },
});

// ── 3. the real CLI ────────────────────────────────────────────────────────────
const outFile = join(mkdtempSync(join(tmpdir(), "samograph-lp-bench-")), "remote.txt");
const cli = Bun.spawn(
  ["bun", "src/cli.ts", "watch", "--remote", `http://localhost:${proxy.port}`, "--call", callId, "--mode", "longpoll", "--file", outFile],
  { env: { ...process.env, SAMOGRAPH_CALL_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
);
const arrivals = new Map<string, number>(); // text → first arrival
const seen: string[] = [];
let stderrText = "";
void (async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of cli.stdout) {
    const now = performance.now();
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const text = line.replace(/^\[[^\]]+\] [^:]+: /, "");
      seen.push(text);
      if (!arrivals.has(text)) arrivals.set(text, now);
    }
  }
})();
void (async () => {
  for await (const chunk of cli.stderr) stderrText += new TextDecoder().decode(chunk);
})();

async function say(text: string): Promise<number> {
  const t = performance.now();
  const r = await fetch(`${CTRL}/__dev/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ call_id: callId, speaker: "Alice", text }),
  });
  if (!r.ok) throw new Error(`/__dev/say → ${r.status} ${await r.text()}`);
  return t;
}
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

await sleep(1000); // let the first long poll park
const errorsBefore = () => (stderrText.match(/error|rate-limited/g) ?? []).length;

// ── 4. latency ─────────────────────────────────────────────────────────────────
const lat: number[] = [];
for (let i = 1; i <= N; i++) {
  const text = `lat-${i}-${randomUUID().slice(0, 8)}`;
  const t0 = await say(text);
  if (!(await until(() => arrivals.has(text), 10_000))) throw new Error(`line ${i} never arrived`);
  lat.push(arrivals.get(text)! - t0);
  await sleep(250);
}

// ── 5. burst ───────────────────────────────────────────────────────────────────
const burstTag = randomUUID().slice(0, 6);
const burstReqStart = reqLog.length;
const burstFirst = performance.now();
for (let i = 1; i <= BURST; i++) await say(`burst-${burstTag}-${i}`);
const lastText = `burst-${burstTag}-${BURST}`;
if (!(await until(() => arrivals.has(lastText), 120_000))) throw new Error("burst tail never arrived");
const burstMs = arrivals.get(lastText)! - burstFirst;
const burstSeen = seen.filter((t) => t.startsWith(`burst-${burstTag}-`));
const burstOk =
  burstSeen.length === BURST && burstSeen.every((t, i) => t === `burst-${burstTag}-${i + 1}`);
const burstReqs = reqLog.length - burstReqStart;
const burst429 = reqLog.slice(burstReqStart).filter((r) => r.status === 429).length;

// ── 6. long idle ───────────────────────────────────────────────────────────────
await sleep(2000); // settle after burst
const idleStartIdx = reqLog.length;
const idleErrBefore = errorsBefore();
const idleStart = performance.now();
await sleep(IDLE_S * 1000);
const idleReqs = reqLog.length - idleStartIdx;
const idleErrs = errorsBefore() - idleErrBefore;
const idleNon200 = reqLog.slice(idleStartIdx).filter((r) => r.status !== 200).length;
const idleText = `after-idle-${randomUUID().slice(0, 8)}`;
const idleT0 = await say(idleText);
const idleArrived = await until(() => arrivals.has(idleText), 30_000);
const idleMinutes = (performance.now() - idleStart) / 60_000;

// ── report ─────────────────────────────────────────────────────────────────────
const fileLines = readFileSync(outFile, "utf-8").split("\n").filter(Boolean).length;
const dupes = seen.length - new Set(seen).size;
console.log(JSON.stringify({
  latency_ms: { n: lat.length, p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), max: +Math.max(...lat).toFixed(1) },
  burst: { lines: BURST, all_in_order_once: burstOk, first_inject_to_last_line_ms: +burstMs.toFixed(0), requests: burstReqs, http_429: burst429 },
  idle: {
    seconds: IDLE_S,
    requests: idleReqs,
    requests_per_min: +(idleReqs / idleMinutes).toFixed(2),
    non_200: idleNon200,
    client_errors: idleErrs,
    line_after_idle_arrived: idleArrived,
    line_after_idle_ms: idleArrived ? +(arrivals.get(idleText)! - idleT0).toFixed(1) : null,
  },
  totals: { cli_stdout_lines: seen.length, duplicates: dupes, file_lines: fileLines, cli_alive: cli.exitCode === null },
}, null, 2));

cli.kill();
proxy.stop(true);
await sql`DELETE FROM users WHERE id = ${user}`;
await sql.close();
process.exit(burstOk && idleArrived && dupes === 0 ? 0 : 1);
