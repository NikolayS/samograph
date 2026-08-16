import { existsSync } from "node:fs";
import { stateFile, readConfig } from "../config.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function commandVersion(command: string, args = ["--version"]): { ok: boolean; detail: string } {
  try {
    const proc = Bun.spawnSync([command, ...args]);
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return {
        ok: false,
        detail: stderr || `${command} --version exited ${proc.exitCode}`,
      };
    }
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    return {
      ok: true,
      detail: stdout.split(/\r?\n/)[0] ?? "",
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function cmdDoctor(): Promise<void> {
  const bunVersion = commandVersion("bun");
  const ngrokVersion = commandVersion("ngrok");
  const ffmpegVersion = commandVersion("ffmpeg", ["-version"]);
  const checks: Check[] = [
    {
      name: "Bun",
      ok: bunVersion.ok,
      detail: bunVersion.detail || "not found in PATH",
    },
    {
      name: "RECALL_API_KEY",
      ok: Boolean(process.env.RECALL_API_KEY) || Boolean(readConfig().recall_api_key),
      detail: process.env.RECALL_API_KEY
        ? "set via env var"
        : readConfig().recall_api_key
          ? "set via ~/.samograph/config.json"
          : "missing (set via env var or: samograph config set recall-api-key <key>)",
    },
    {
      name: "ngrok",
      ok: ngrokVersion.ok,
      detail: ngrokVersion.detail || "not found in PATH",
    },
    {
      name: "ffmpeg",
      ok: ffmpegVersion.ok,
      detail: ffmpegVersion.detail || "not found in PATH",
    },
    {
      name: "state",
      ok: true,
      detail: existsSync(stateFile()) ? `active state at ${stateFile()}` : "no active bot state",
    },
  ];

  process.stdout.write("samograph doctor\n\n");
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exit(1);
  }
}
