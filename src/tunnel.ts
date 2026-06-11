import { spawn as spawnChild } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { samographDir } from "./config.ts";

/** Minimal handle for a spawned long-lived tunnel process. */
export interface TunnelProc {
  pid: number;
  kill(): void;
}

export interface CloudflaredTunnel {
  proc: TunnelProc;
  /** Assigned public base URL (https://*.trycloudflare.com). */
  url: string;
}

// The quick-tunnel hostname is always <words>.trycloudflare.com over https;
// anchoring the suffix avoids matching lookalike hosts in arbitrary output.
const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![\w.-])/i;

export function parseCloudflaredUrl(text: string): string | null {
  const match = text.match(CLOUDFLARED_URL_RE);
  return match ? match[0] : null;
}

/** cloudflared binary: CLOUDFLARED_BIN env override, else PATH lookup. */
export function cloudflaredBinary(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLOUDFLARED_BIN || "cloudflared";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ~30 s budget: cloudflared usually prints the URL within a few seconds, but
// a cold start (download of the edge config) can take longer.
const CLOUDFLARED_URL_ATTEMPTS = 40;
const CLOUDFLARED_URL_SLEEP_MS = 750;

/**
 * Poll a reader of cloudflared's accumulated log output until the assigned
 * trycloudflare URL appears. Returns null on timeout or when `aborted`
 * reports the process failed (e.g. spawn ENOENT).
 */
export async function waitForCloudflaredUrl(
  readText: () => string,
  sleepFn: (ms: number) => Promise<void> = sleep,
  attempts = CLOUDFLARED_URL_ATTEMPTS,
  aborted: () => boolean = () => false,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const url = parseCloudflaredUrl(readText());
    if (url) return url;
    if (aborted()) return null;
    if (i < attempts - 1) await sleepFn(CLOUDFLARED_URL_SLEEP_MS);
  }
  return null;
}

/**
 * Start `cloudflared tunnel --url http://127.0.0.1:<port>` detached, with its
 * stderr (where cloudflared prints the quick-tunnel banner) redirected to
 * ~/.samograph/cloudflared.log, and poll that log for the assigned public
 * URL. The log-file indirection lets the process outlive join (like ngrok)
 * without holding a pipe that would break once join exits.
 * Returns null if the binary is missing or no URL appears in time.
 */
export async function startCloudflared(
  port: number,
): Promise<CloudflaredTunnel | null> {
  const dir = samographDir();
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "cloudflared.log");
  writeFileSync(logPath, ""); // truncate any previous run's log
  const fd = openSync(logPath, "a");

  let spawnFailed = false;
  const child = spawnChild(
    cloudflaredBinary(),
    ["tunnel", "--url", `http://127.0.0.1:${port}`],
    { detached: true, stdio: ["ignore", "ignore", fd] },
  );
  child.on("error", () => {
    spawnFailed = true; // e.g. ENOENT: cloudflared not installed
  });
  child.on("exit", () => {
    spawnFailed = true; // died before (or right after) printing the URL
  });
  child.unref();

  const url = await waitForCloudflaredUrl(
    () => {
      try {
        return readFileSync(logPath, "utf-8");
      } catch {
        return "";
      }
    },
    sleep,
    CLOUDFLARED_URL_ATTEMPTS,
    () => spawnFailed,
  );
  closeSync(fd); // the child keeps its own descriptor

  if (url === null || typeof child.pid !== "number") {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    return null;
  }
  return {
    proc: {
      get pid() {
        return child.pid!;
      },
      kill() {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      },
    },
    url,
  };
}
