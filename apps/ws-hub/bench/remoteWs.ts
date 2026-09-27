/**
 * #307 prototype 3/3 measurement harness — remote watch over WebSocket.
 *
 * LOCAL-ONLY. Runs against a running `apps/ws-hub/dev-live-server.ts` (ingest +
 * ws-hub composed, in-repo Recall fake) and its `POST /__dev/say` injector. No
 * real Recall, no real secrets: the share token is signed with the dev-server's
 * DEV-ONLY TOKEN_SECRET default (or whatever TOKEN_SECRET you started it with).
 *
 *   bun apps/ws-hub/bench/remoteWs.ts seed     # create a call + print a dev share token
 *   bun apps/ws-hub/bench/remoteWs.ts measure  # latency / burst / idle, prints a table
 *
 * `measure` drives the REAL CLI (`bun src/cli.ts watch --remote … --mode ws`) as
 * a child process and timestamps each stdout line against the inject time.
 *
 * Env: DATABASE_URL (same DB as the dev-live-server), WS_HUB (default
 * http://localhost:8788), DEV_CTRL (default http://localhost:8790), TOKEN_SECRET,
 * LAT_LINES (60), BURST_LINES (200), BURST_CONCURRENCY (8), IDLE_SECONDS (120).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../../../packages/shared/db/client.ts";
import { mintShareToken } from "../../../packages/shared/tokens/store.ts";
import { remoteWatch, type RemoteWatchEvent } from "../../../src/remoteWatch.ts";

const WS_HUB = process.env.WS_HUB ?? "http://localhost:8788";
const DEV_CTRL = process.env.DEV_CTRL ?? "http://localhost:8790";
// Must match dev-live-server.ts: kid "dev-share" + its TOKEN_SECRET (DEV-ONLY default).
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-abcd";
const LAT_LINES = Number(process.env.LAT_LINES ?? 60);
const BURST_LINES = Number(process.env.BURST_LINES ?? 200);
const BURST_CONCURRENCY = Number(process.env.BURST_CONCURRENCY ?? 8);
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 120);
const REPO = resolve(import.meta.dir, "../../..");

async function seed(): Promise<{ callId: string; token: string }> {
  const sql = connect();
  const user = randomUUID();
  const tenant = randomUUID();
  const callId = randomUUID();
  await sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@bench.local`})`;
  await sql`INSERT INTO tenants (id, owner_user_id) VALUES (${tenant}, ${user})`;
  await sql`INSERT INTO calls (id, tenant_id, meeting_url, status, region)
            VALUES (${callId}, ${tenant}, 'https://meet.google.com/bench-307', 'JOINING','us-east')`;
  const { token } = await mintShareToken(sql, {
    callId,
    signingKey: { kid: "dev-share", secret: TOKEN_SECRET },
    ttlSeconds: 6 * 3600,
  });
  await sql.close();
  return { callId, token };
}

async function say(callId: string, text: string): Promise<void> {
  const res = await fetch(`${DEV_CTRL}/__dev/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ call_id: callId, speaker: "Bench", text }),
  });
  if (!res.ok) throw new Error(`/__dev/say → ${res.status} ${await res.text()}`);
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

/** Spawn the real CLI and timestamp every stdout line as it is printed. */
function spawnCli(callId: string, token: string) {
  const out = join(mkdtempSync(join(tmpdir(), "rw307-")), "remote.txt");
  const proc = Bun.spawn(
    ["bun", "src/cli.ts", "watch", "--remote", WS_HUB, "--call", callId, "--mode", "ws", "--out", out],
    { cwd: REPO, env: { ...process.env, SAMOGRAPH_SHARE_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
  );
  const seen = new Map<string, number>(); // text → arrival ms
  const order: string[] = [];
  const waiters = new Map<string, () => void>();
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      const now = performance.now();
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const text = line.replace(/^\[[^\]]+\] [^:]+: /, "");
        seen.set(text, now);
        order.push(text);
        waiters.get(text)?.();
      }
    }
  })();
  const wait = (text: string, ms = 10_000) =>
    seen.has(text)
      ? Promise.resolve()
      : new Promise<void>((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout waiting for "${text}"`)), ms);
          waiters.set(text, () => {
            clearTimeout(t);
            res();
          });
        });
  return { proc, seen, order, wait, out };
}

async function measure(): Promise<void> {
  const { callId, token } = await seed();
  const cli = spawnCli(callId, token);
  await say(callId, "warmup");
  await cli.wait("warmup");

  // 1) latency: one line at a time, inject → CLI stdout
  const lat: number[] = [];
  for (let i = 0; i < LAT_LINES; i++) {
    const text = `lat ${i}`;
    const t0 = performance.now();
    await say(callId, text);
    await cli.wait(text);
    lat.push(cli.seen.get(text)! - t0);
    await Bun.sleep(20);
  }

  // 2) burst: BURST_LINES as fast as possible (BURST_CONCURRENCY in flight)
  const b0 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: BURST_CONCURRENCY }, async () => {
      while (next < BURST_LINES) await say(callId, `burst ${next++}`);
    }),
  );
  await cli.wait(`burst ${BURST_LINES - 1}`, 30_000);
  const burstTexts = cli.order.filter((t) => t.startsWith("burst "));
  await Bun.sleep(500);
  const burstMs = Math.max(...burstTexts.map((t) => cli.seen.get(t)!)) - b0;
  const burstDupes = burstTexts.length - new Set(burstTexts).size;
  // With N in flight, label order ≠ commit order; "in order" means the CLI
  // printed exactly the DB's seq order.
  const db = connect();
  const dbOrder = ((await db`SELECT text FROM transcripts WHERE call_id = ${callId}
    AND text LIKE 'burst %' ORDER BY seq`) as { text: string }[]).map((r) => r.text);
  await db.close();
  const inSeqOrder = JSON.stringify(dbOrder) === JSON.stringify(burstTexts);

  // 3) idle: an in-process client (same code as the CLI) counts pings/messages/
  //    reconnects during IDLE_SECONDS of silence, then one line must arrive.
  const events: RemoteWatchEvent[] = [];
  let idleMsgs = 0;
  const ctl = new AbortController();
  const rw = remoteWatch({
    site: WS_HUB, callId, token, sinceSeq: 1_000_000_000, signal: ctl.signal,
    onLine: () => void idleMsgs++, onEvent: (e) => events.push(e),
  });
  await Bun.sleep(IDLE_SECONDS * 1000);
  const idleOpens = events.filter((e) => e.type === "open").length;
  const idlePings = events.filter((e) => e.type === "ping").length;
  ctl.abort();
  await rw;
  const it0 = performance.now();
  await say(callId, "after idle");
  await cli.wait("after idle", 15_000);
  const afterIdleMs = cli.seen.get("after idle")! - it0;

  cli.proc.kill("SIGINT");
  await cli.proc.exited;
  const fileLines = (await Bun.file(cli.out).text()).trim().split("\n").length;

  const f = (n: number) => n.toFixed(1);
  console.log(`\n#307 prototype 3/3 (WebSocket) — ${new Date().toISOString()}`);
  console.log(`| metric | value |\n|---|---|`);
  console.log(`| latency inject→CLI stdout, n=${lat.length} | p50 ${f(pct(lat, 50))} ms, p95 ${f(pct(lat, 95))} ms, max ${f(Math.max(...lat))} ms |`);
  console.log(`| burst ${BURST_LINES} lines (${BURST_CONCURRENCY} in flight) | first inject→last line ${f(burstMs)} ms; got ${new Set(burstTexts).size}/${BURST_LINES}, dupes ${burstDupes}, in seq order ${inSeqOrder} |`);
  console.log(`| idle ${IDLE_SECONDS}s (client side) | ${idlePings} pings (${f((idlePings * 60) / IDLE_SECONDS)}/min), 0 HTTP requests, ${idleMsgs} data msgs, ${idleOpens - 1} reconnects (server side: +1 auth-recheck txn/s per socket) |`);
  console.log(`| CLI socket after ${IDLE_SECONDS}s idle | line arrived in ${f(afterIdleMs)} ms, no manual restart |`);
  console.log(`| CLI transcript file | ${fileLines} lines (warmup + ${LAT_LINES} + ${BURST_LINES} + 1) |`);
}

const cmd = process.argv[2];
if (cmd === "seed") {
  const { callId, token } = await seed();
  // DEV-ONLY token, signed with the dev-live-server's public dev default secret.
  console.log(`export CALL_ID=${callId}`);
  console.log(`export SAMOGRAPH_SHARE_TOKEN=${token}`);
} else if (cmd === "measure") {
  await measure();
} else {
  console.error("usage: bun apps/ws-hub/bench/remoteWs.ts seed|measure");
  process.exit(2);
}
