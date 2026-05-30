#!/usr/bin/env bun
import { ExitError } from "./config.ts";
import type { ParsedArgs } from "./args.ts";
import { cmdJoin } from "./commands/join.ts";
import { cmdLeave } from "./commands/leave.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdScreenshot } from "./commands/screenshot.ts";
import { cmdTranscript } from "./commands/transcript.ts";
import { cmdChat } from "./commands/chat.ts";
import { cmdFrame } from "./commands/frame.ts";
import { cmdDicts } from "./commands/dicts.ts";
import { cmdWatch } from "./commands/watch.ts";
import { cmdServe } from "./commands/serve.ts";

const USAGE = `usage: samoagent <command> [options]

AI meeting agent for Zoom & Google Meet

commands:
  join <url> [--name N] [--dict D] [--port P] [--transcript-dir DIR] [--rtmp-url URL] [--rtmp] [--no-ws-video] [--frame-dir DIR]
  leave [bot_id]
  status [bot_id]
  screenshot [--out FILE] [bot_id]
  chat <message> [--bot-id ID]
  transcript [bot_id]
  dicts
  watch
  frame [--out FILE] [--archive] [bot_id]
`;

class ArgError extends Error {}

/**
 * Hand-rolled argument parser replicating the Python argparse subcommands.
 * Throws ArgError (mapped to ExitError(2)) on parse failure, mirroring argparse.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new ArgError("the following arguments are required: command");
  }
  const command = argv[0]!;
  const rest = argv.slice(1);

  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};

  // Define which flags take a value per command.
  const valueFlags: Record<string, Set<string>> = {
    join: new Set(["--name", "--dict", "--port", "--transcript-dir", "--rtmp-url", "--frame-dir"]),
    leave: new Set(),
    status: new Set(),
    screenshot: new Set(["--out"]),
    chat: new Set(["--bot-id"]),
    transcript: new Set(),
    dicts: new Set(),
    watch: new Set(),
    frame: new Set(["--out"]),
    _serve: new Set(["--port", "--transcript-file", "--webhook-token", "--call-id-file", "--frame-token"]),
  };
  const boolFlags: Record<string, Set<string>> = {
    join: new Set(["--rtmp", "--no-ws-video"]),
    leave: new Set(),
    status: new Set(),
    screenshot: new Set(),
    chat: new Set(),
    transcript: new Set(),
    dicts: new Set(),
    watch: new Set(),
    frame: new Set(["--archive"]),
    _serve: new Set(),
  };

  const knownCommands = Object.keys(valueFlags);
  if (!knownCommands.includes(command)) {
    throw new ArgError(`invalid choice: '${command}'`);
  }

  const vFlags = valueFlags[command]!;
  const bFlags = boolFlags[command]!;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith("--")) {
      // support --flag=value
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        const flag = tok.slice(0, eq);
        const val = tok.slice(eq + 1);
        if (vFlags.has(flag)) {
          opts[flag] = val;
        } else {
          throw new ArgError(`unrecognized arguments: ${tok}`);
        }
        continue;
      }
      if (bFlags.has(tok)) {
        opts[tok] = true;
        continue;
      }
      if (vFlags.has(tok)) {
        const val = rest[i + 1];
        if (val === undefined) {
          throw new ArgError(`argument ${tok}: expected one argument`);
        }
        opts[tok] = val;
        i += 1;
        continue;
      }
      throw new ArgError(`unrecognized arguments: ${tok}`);
    } else {
      positionals.push(tok);
    }
  }

  const result: ParsedArgs = { command };

  switch (command) {
    case "join": {
      if (positionals.length < 1) {
        throw new ArgError("the following arguments are required: url");
      }
      result.url = positionals[0];
      result.name = (opts["--name"] as string) ?? null;
      result.dict = (opts["--dict"] as string) ?? null;
      const rawPort = opts["--port"];
      if (rawPort !== undefined) {
        const p = Number(rawPort);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          throw new ArgError(`argument --port: invalid port number: '${rawPort}'`);
        }
        result.port = p;
      } else {
        result.port = 8080;
      }
      result.transcript_dir = (opts["--transcript-dir"] as string) ?? null;
      result.rtmp_url = (opts["--rtmp-url"] as string) ?? null;
      result.rtmp = opts["--rtmp"] === true;
      result.ws_video = opts["--no-ws-video"] !== true;
      result.frame_dir = (opts["--frame-dir"] as string) ?? null;
      break;
    }
    case "leave":
    case "status":
    case "transcript": {
      result.bot_id = positionals.length ? positionals[0] : null;
      break;
    }
    case "screenshot": {
      result.out = (opts["--out"] as string) ?? "screenshot.png";
      result.bot_id = positionals.length ? positionals[0] : null;
      break;
    }
    case "frame": {
      result.out = (opts["--out"] as string) ?? null;
      result.archive = opts["--archive"] === true;
      result.bot_id = positionals.length ? positionals[0] : null;
      break;
    }
    case "chat": {
      if (positionals.length < 1) {
        throw new ArgError("the following arguments are required: message");
      }
      result.message = positionals[0];
      result.bot_id = (opts["--bot-id"] as string) ?? null;
      break;
    }
    case "dicts":
    case "watch":
      break;
    case "_serve": {
      const rawPort2 = opts["--port"];
      if (rawPort2 !== undefined) {
        const p2 = Number(rawPort2);
        if (!Number.isInteger(p2) || p2 < 1 || p2 > 65535) {
          throw new ArgError(`argument --port: invalid port number: '${rawPort2}'`);
        }
        result.port = p2;
      } else {
        result.port = 8080;
      }
      if (opts["--transcript-file"] === undefined) {
        throw new ArgError(
          "the following arguments are required: --transcript-file",
        );
      }
      result.transcript_file = opts["--transcript-file"] as string;
      result.webhook_token = (opts["--webhook-token"] as string) ?? "";
      result.call_id_file = (opts["--call-id-file"] as string) ?? "";
      result.frame_token = (opts["--frame-token"] as string) ?? "";
      break;
    }
  }

  return result;
}

async function dispatch(args: ParsedArgs): Promise<void> {
  switch (args.command) {
    case "join":
      return cmdJoin(args);
    case "leave":
      return cmdLeave(args);
    case "status":
      return cmdStatus(args);
    case "screenshot":
      return cmdScreenshot(args);
    case "transcript":
      return cmdTranscript(args);
    case "chat":
      return cmdChat(args);
    case "frame":
      return cmdFrame(args);
    case "dicts":
      return cmdDicts();
    case "watch":
      return cmdWatch();
    case "_serve":
      return cmdServe(args);
    default:
      throw new ArgError(`invalid choice: '${args.command}'`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    argv.length === 0 ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V") {
    const pkg = (await import("../package.json")) as { version: string };
    process.stdout.write(`samoagent ${pkg.version}\n`);
    process.exit(0);
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`samoagent: error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  try {
    await dispatch(args);
  } catch (e) {
    if (e instanceof ExitError) {
      process.exit(e.code);
    }
    // Any other throw (recall HTTP errors from createBot/sendChat, a non-JSON
    // response surfacing as a SyntaxError, etc.) — emit a single clean line to
    // stderr instead of dumping a Bun stack trace.
    process.stderr.write(
      `samoagent: error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
