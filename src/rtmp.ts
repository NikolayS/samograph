import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Extract path component from rtmp://host:port/path -> path. */
export function rtmpStreamPath(rtmpUrl: string): string {
  const parsed = new URL(rtmpUrl);
  return parsed.pathname.replace(/^\/+/, "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

/** Return the port where the ngrok local API is listening (4040..4043). */
export async function ngrokApiPort(
  fetchFn: FetchLike = fetch,
): Promise<number> {
  for (const p of [4040, 4041, 4042, 4043]) {
    try {
      const ctrl = AbortSignal.timeout(1000);
      const r = await fetchFn(`http://localhost:${p}/api/tunnels`, {
        signal: ctrl,
      });
      // consume body
      await r.text().catch(() => undefined);
      return p;
    } catch {
      // try next
    }
  }
  return 4040; // default, may fail later
}

export async function waitForNgrok(
  port: number,
  timeout = 15,
  fetchFn: FetchLike = fetch,
): Promise<string | null> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      const apiPort = await ngrokApiPort(fetchFn);
      const r = await fetchFn(`http://localhost:${apiPort}/api/tunnels`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = (await r.json()) as {
        tunnels?: Array<{
          public_url: string;
          config?: { addr?: string };
        }>;
      };
      const tunnels = data.tunnels ?? [];
      for (const t of tunnels) {
        if ((t.config?.addr ?? "").includes(String(port))) {
          return t.public_url;
        }
      }
      if (tunnels.length) {
        return tunnels[0]!.public_url;
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  return null;
}

/**
 * Start a ngrok TCP tunnel to localPort via the ngrok REST API.
 * Returns the public TCP URL on success, or null on failure.
 */
export async function startNgrokTcpTunnel(
  localPort: number,
  fetchFn: FetchLike = fetch,
): Promise<string | null> {
  const apiPort = await ngrokApiPort(fetchFn);
  const payload = JSON.stringify({
    addr: String(localPort),
    proto: "tcp",
    name: "rtmp",
  });
  try {
    const r = await fetchFn(`http://localhost:${apiPort}/api/tunnels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      if (body.includes("ERR_NGROK_8013") || body.includes("credit or debit card")) {
        process.stderr.write(
          "Error: ngrok TCP tunnels require a credit/debit card on file " +
            "(free plan — your card will NOT be charged).\n" +
            "Add a card at: https://dashboard.ngrok.com/settings#id-verification\n" +
            "Then retry with --rtmp.\n",
        );
      } else {
        process.stderr.write(
          `Error starting ngrok TCP tunnel: ${body.slice(0, 500)}\n`,
        );
      }
      return null;
    }
    const data = (await r.json()) as { public_url?: string };
    return data.public_url ?? null;
  } catch (e) {
    process.stderr.write(`Error starting ngrok TCP tunnel: ${e}\n`);
    return null;
  }
}

export interface SpawnLike {
  (cmd: string[], opts?: { stdout?: "ignore"; stderr?: "ignore" }): {
    pid: number;
    exitCode: number | null;
    kill: (signal?: number | string) => void;
  };
}

/** Return path to mediamtx binary, downloading it if necessary. */
export async function ensureMediamtx(): Promise<string> {
  // 1. Check PATH
  const inPath = Bun.which("mediamtx");
  if (inPath) {
    return inPath;
  }

  // 2. Check ~/.samograph/bin/mediamtx
  const localBin = join(homedir(), ".samograph", "bin", "mediamtx");
  if (existsSync(localBin)) {
    return localBin;
  }

  // 3. Auto-download from GitHub releases
  const machine: string = process.arch;
  const realArch =
    machine === "arm64" || machine === "aarch64" ? "arm64" : "amd64";

  const plat = process.platform; // "darwin" or "linux"
  if (plat !== "darwin" && plat !== "linux") {
    throw new Error(`Unsupported platform for mediamtx auto-download: ${plat}`);
  }

  const version = "v1.9.1";
  const filename = `mediamtx_${version}_${plat}_${realArch}.tar.gz`;
  const url = `https://github.com/bluenviron/mediamtx/releases/download/${version}/${filename}`;

  process.stdout.write(`Downloading mediamtx ${version}...\n`);

  const tmpdir = join(homedir(), ".samograph", "tmp-mediamtx");
  mkdirSync(tmpdir, { recursive: true });
  const archivePath = join(tmpdir, filename);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download mediamtx: ${resp.status}`);
  }
  await Bun.write(archivePath, resp);

  // Extract the mediamtx binary using tar.
  await Bun.$`tar -xzf ${archivePath} -C ${tmpdir} mediamtx`.quiet();
  const extracted = join(tmpdir, "mediamtx");
  if (!existsSync(extracted)) {
    throw new Error("mediamtx binary not found in downloaded archive");
  }

  mkdirSync(join(localBin, ".."), { recursive: true });
  copyFileSync(extracted, localBin);
  chmodSync(localBin, 0o755);
  return localBin;
}

/** Start mediamtx RTMP server on port 1935. Returns the process or null on failure. */
export async function startMediamtx(): Promise<Bun.Subprocess | null> {
  const mediamtxBin = await ensureMediamtx();
  const proc = Bun.spawn([mediamtxBin], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await sleep(1500); // wait for mediamtx to bind
  if (proc.exitCode !== null) {
    return null;
  }
  return proc;
}
