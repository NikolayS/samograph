#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:34099/presence?token=tok";
const port = Number(process.env.CDP_PORT || 9229);
const userDataDir = mkdtempSync(join(tmpdir(), "samoagent-chrome-"));

const scenarios = [
  { name: "current" },
  { name: "no-drift", css: ".tile::after{animation:none!important}" },
  {
    name: "no-blur",
    css: ".lane{backdrop-filter:none!important}.plasma-canvas{filter:none!important}.tile::before{box-shadow:none!important}",
  },
  {
    name: "no-overlays",
    css: ".scan,.plasma-canvas,.tile::after{display:none!important}.lane{backdrop-filter:none!important}.tile::before{box-shadow:none!important}",
  },
  {
    name: "flat",
    css: "*,*::before,*::after{animation:none!important;filter:none!important;backdrop-filter:none!important;box-shadow:none!important;text-shadow:none!important}.scan,.plasma-canvas,.tile::after{display:none!important}",
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string): Promise<Json> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return (await response.json()) as Json;
}

async function waitForTab(): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const tabs = (await fetchJson(`http://127.0.0.1:${port}/json`)) as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
      const tab = tabs.find((item) => item.webSocketDebuggerUrl && item.url?.startsWith(baseUrl));
      if (tab?.webSocketDebuggerUrl) return tab.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome DevTools tab did not appear");
}

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Json & { id?: number; error?: { message?: string } };
    if (typeof message.id !== "number") return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message || "CDP error"));
    else item.resolve(message);
  });
  return {
    call(method: string, params: Json = {}) {
      id += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<Json>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    async evaluate(expression: string) {
      for (let i = 0; i < 20; i += 1) {
        try {
          return await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        } catch (error) {
          if (!String(error).includes("Cannot find default execution context")) throw error;
          await sleep(100);
        }
      }
      throw new Error("Runtime context did not become ready");
    },
    close() {
      ws.close();
    },
  };
}

async function main() {
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,720",
    baseUrl,
  ], { stdio: "ignore" });

  try {
    const wsUrl = await waitForTab();
    const client = await cdp(wsUrl);
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await sleep(500);

    for (const scenario of scenarios) {
      const expression = `
        (async () => {
          document.querySelector('[data-bench-style]')?.remove();
          const style = document.createElement('style');
          style.setAttribute('data-bench-style', '${scenario.name}');
          style.textContent = ${JSON.stringify(scenario.css || "")};
          document.head.append(style);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          let frames = 0;
          const start = performance.now();
          await new Promise((resolve) => {
            function tick(now) {
              frames += 1;
              if (now - start >= 3000) resolve();
              else requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          });
          const elapsed = performance.now() - start;
          return { fps: Math.round(frames * 1000 / elapsed), elapsed: Math.round(elapsed) };
        })()
      `;
      const result = await client.evaluate(expression);
      const value = ((result.result as Json)?.result as Json)?.value as { fps: number; elapsed: number };
      console.log(`${scenario.name}\t${value.fps}\t${value.elapsed}ms`);
    }
    client.close();
  } finally {
    child.kill("SIGTERM");
  }
}

await main();
