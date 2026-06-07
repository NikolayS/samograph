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
import { cmdFrames } from "./commands/frames.ts";
import { cmdDicts } from "./commands/dicts.ts";
import { cmdWatch } from "./commands/watch.ts";
import { cmdServe } from "./commands/serve.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdNotes } from "./commands/notes.ts";
import { cmdPresence } from "./commands/presence.ts";

const USAGE = `usage: samoagent <command> [options]

Put your AI agent in Zoom and Google Meet calls.
samoagent joins through Recall.ai, streams live transcript lines,
captures call frames on demand, and sends explicit chat messages.

Requires: Bun, RECALL_API_KEY env var (get one at recall.ai), and ngrok (or an alternative tunnel via --webhook-base).

commands:
  join <url> [--name N] [--dict D] [--port P] [--transcript-dir DIR] [--rtmp-url URL] [--rtmp] [--no-ws-video] [--frame-dir DIR] [--webhook-base URL] [--variant web|web_4_core|web_gpu]
  leave [bot_id]
  status [bot_id]
  screenshot [--out FILE] [bot_id]
  chat <message> [--bot-id ID]
  presence <listening|thinking|speaking|acting|idle> [message]
  transcript [--local] [--file FILE] [--cursor N] [--limit N] [bot_id]
  dicts
  watch
  notes <init|point|decision|action|transcript> [options]
  frame [--source SOURCE] [--out FILE] [--archive] [bot_id]
  frames
  doctor

flags:
  -h, --help     Show this help message
  -v, --version  Show version number
`;

const COMMAND_HELP: Record<string, string> = {
  join: `usage: samoagent join <url> [options]

Join a Zoom or Google Meet call as a Recall.ai bot.
By default, samoagent streams transcript events and receives call frames over WebSocket.

options:
  --name N               Bot display name
  --dict D               Deepgram keyword dictionary name
  --port P               Local callback server port (default: 8080)
  --transcript-dir DIR   Directory for timestamped transcript files
  --frame-dir DIR        Directory for on-demand frame output
  --no-ws-video          Disable WebSocket call-frame capture
  --webhook-base URL     Use an existing public tunnel URL instead of starting ngrok
                         (e.g. localtunnel/cloudflared pointing at --port)
  --variant NAME         Recall Output Media bot size: web|web_4_core|web_gpu
                         Use web_4_core when webpage camera rendering is choppy
  --rtmp                 Use local RTMP path through ngrok TCP
  --rtmp-url URL         Use an existing RTMP endpoint

examples:
  samoagent join "https://meet.google.com/abc-defg-hij" --name Leo
  samoagent join "https://zoom.us/j/123" --dict postgresfm
  samoagent join "https://zoom.us/j/123" --variant web_4_core
`,
  frame: `usage: samoagent frame [--source SOURCE] [--out FILE] [--archive] [bot_id]

Write the latest call frame to disk.
With the default WebSocket path, frames stay in memory until this command is run.

options:
  --source SOURCE  Frame source: latest, screen, webcam, participant:<id>, type:<type>
  --out FILE       Output path. Defaults to latest frame path from active state.
  --archive        Also write a timestamped PNG+JSON archive copy.

examples:
  samoagent frame
  samoagent frame --source screen --out /tmp/screen.png
  samoagent frame --out /tmp/current-call.png
  samoagent frame --archive
`,
  frames: `usage: samoagent frames

List WebSocket frame sources currently buffered in memory.
Use the source keys with: samoagent frame --source SOURCE
`,
  doctor: `usage: samoagent doctor

Check local prerequisites for joining meetings:
Bun, RECALL_API_KEY, ngrok, ffmpeg, and active samoagent state.
`,
  presence: `usage: samoagent presence <state> [message]

Update the bot camera presence shown in the meeting.
States: listening|thinking|speaking|acting|idle

examples:
  samoagent presence listening
  samoagent presence thinking "Checking the migration plan"
  samoagent presence speaking "Answering in chat"
`,
  notes: `usage: samoagent notes <init|point|decision|action|transcript> [options]

Maintain a GitLab-style live meeting doc.
Uses GOOGLE_DOC_ID and GOOGLE_APPLICATION_CREDENTIALS when flags are omitted.

options:
  --doc-id ID           Google Doc document ID or URL
  --credentials FILE    Google service-account JSON credentials
  --title TITLE         Title for notes init
  --section NAME        Section for notes point
  --speaker NAME        Speaker prefix for notes point
  --owner NAME          Action-item owner
  --due DATE            Action-item due date
  --from-start          For transcript: copy existing lines before tailing live lines

examples:
  samoagent notes init --doc-id 1abc...
  samoagent notes point "Customer is blocked on migration risk" --speaker Alice
  samoagent notes decision "Use logical replication for phase 1"
  samoagent notes action "Open migration checklist issue" --owner Nik --due 2026-06-07
  samoagent notes transcript --from-start
`,
  transcript: `usage: samoagent transcript [--local] [--file FILE] [--cursor N] [--limit N] [bot_id]

Print a finished Recall.ai transcript, falling back to the local live transcript.

options:
  --cursor N   Start at transcript line N (0-based)
  --file FILE  Read a local transcript file instead of Recall
  --limit N    Return at most N lines and print the next cursor
  --local      Read the active/default local transcript instead of Recall

examples:
  samoagent transcript
  samoagent transcript --local --cursor 0 --limit 20
  samoagent transcript --file ~/.samoagent/20260604_022915_transcript.txt --cursor 0 --limit 20
  samoagent transcript --cursor 0 --limit 20
  samoagent transcript --cursor 20 --limit 20 <bot_id>
`,
};

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
    join: new Set(["--name", "--dict", "--port", "--transcript-dir", "--rtmp-url", "--frame-dir", "--webhook-base", "--variant"]),
    leave: new Set(),
    status: new Set(),
    screenshot: new Set(["--out"]),
    chat: new Set(["--bot-id"]),
    presence: new Set(),
    transcript: new Set(["--cursor", "--file", "--limit"]),
    dicts: new Set(),
    watch: new Set(),
    notes: new Set(["--doc-id", "--credentials", "--title", "--section", "--speaker", "--owner", "--due"]),
    frame: new Set(["--out", "--source"]),
    frames: new Set(),
    doctor: new Set(),
    _serve: new Set(["--port", "--transcript-file", "--webhook-token", "--call-id-file", "--frame-token", "--presence-token"]),
  };
  const boolFlags: Record<string, Set<string>> = {
    join: new Set(["--rtmp", "--no-ws-video"]),
    leave: new Set(),
    status: new Set(),
    screenshot: new Set(),
    chat: new Set(),
    presence: new Set(),
    transcript: new Set(["--local"]),
    dicts: new Set(),
    watch: new Set(),
    notes: new Set(["--from-start"]),
    frame: new Set(["--archive"]),
    frames: new Set(),
    doctor: new Set(),
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
      result.webhook_base = (opts["--webhook-base"] as string) ?? null;
      result.frame_dir = (opts["--frame-dir"] as string) ?? null;
      result.variant = (opts["--variant"] as string) ?? null;
      if (result.variant !== null && !["web", "web_4_core", "web_gpu"].includes(result.variant)) {
        throw new ArgError(
          `argument --variant: invalid choice: '${result.variant}' (choose from web, web_4_core, web_gpu)`,
        );
      }
      break;
    }
    case "leave":
    case "status":
    case "transcript": {
      result.bot_id = positionals.length ? positionals[0] : null;
      result.transcript_local = opts["--local"] === true;
      result.transcript_file = (opts["--file"] as string) ?? undefined;
      const rawCursor = opts["--cursor"];
      if (rawCursor !== undefined) {
        const c = Number(rawCursor);
        if (!Number.isInteger(c) || c < 0) {
          throw new ArgError(`argument --cursor: invalid non-negative integer: '${rawCursor}'`);
        }
        result.transcript_cursor = c;
      }
      const rawLimit = opts["--limit"];
      if (rawLimit !== undefined) {
        const l = Number(rawLimit);
        if (!Number.isInteger(l) || l < 1) {
          throw new ArgError(`argument --limit: invalid positive integer: '${rawLimit}'`);
        }
        result.transcript_limit = l;
      }
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
      result.frame_source = (opts["--source"] as string) ?? null;
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
    case "presence": {
      if (positionals.length < 1) {
        throw new ArgError("the following arguments are required: state");
      }
      result.presence_state = positionals[0];
      result.message = positionals.slice(1).join(" ") || undefined;
      break;
    }
    case "dicts":
    case "watch":
    case "doctor":
    case "frames":
      break;
    case "notes": {
      result.doc_id = (opts["--doc-id"] as string) ?? null;
      result.credentials = (opts["--credentials"] as string) ?? null;
      result.from_start = opts["--from-start"] === true;
      result.notes_action = positionals[0] ?? "help";
      result.message = positionals.slice(1).join(" ") || undefined;
      result.title = (opts["--title"] as string) ?? null;
      result.section = (opts["--section"] as string) ?? null;
      result.speaker = (opts["--speaker"] as string) ?? null;
      result.owner = (opts["--owner"] as string) ?? null;
      result.due = (opts["--due"] as string) ?? null;
      break;
    }
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
      result.presence_token = (opts["--presence-token"] as string) ?? "";
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
    case "presence":
      return cmdPresence(args);
    case "frame":
      return cmdFrame(args);
    case "frames":
      return cmdFrames();
    case "dicts":
      return cmdDicts();
    case "watch":
      return cmdWatch();
    case "notes":
      return cmdNotes(args);
    case "doctor":
      return cmdDoctor();
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
    argv[0] === "-h"
  ) {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.length >= 2 && (argv[1] === "--help" || argv[1] === "-h")) {
    const help = COMMAND_HELP[argv[0]!];
    process.stdout.write(help ?? USAGE);
    process.exit(help ? 0 : 2);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
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
