import { resolve } from "node:path";
import { loadState } from "../state.ts";
import type { ParsedArgs } from "../args.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ScreenshotDeps {
  run?: (cmd: string[]) => { exitCode: number };
  focus?: (meetingUrl: string) => void;
}

function defaultRun(cmd: string[]): { exitCode: number } {
  const proc = Bun.spawnSync(cmd);
  return { exitCode: proc.exitCode };
}

function defaultFocus(meetingUrl: string): void {
  const domain = meetingUrl.includes("meet.google.com")
    ? "meet.google.com"
    : "zoom.us";
  const script = `
tell application "Google Chrome"
    set found to false
    repeat with w in windows
        set tabIdx to 0
        repeat with t in tabs of w
            set tabIdx to tabIdx + 1
            if URL of t contains "${domain}" then
                set active tab index of w to tabIdx
                set index of w to 1
                set found to true
                exit repeat
            end if
        end repeat
        if found then exit repeat
    end repeat
end tell
tell application "Google Chrome" to activate
`;
  try {
    Bun.spawnSync(["osascript", "-e", script], {
      timeout: 5000,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // ignore
  }
}

export async function cmdScreenshot(
  args: ParsedArgs,
  deps: ScreenshotDeps = {},
): Promise<void> {
  const run = deps.run ?? defaultRun;
  const focus = deps.focus ?? defaultFocus;
  const out = args.out || "screenshot.png";
  const state = loadState();
  const meetingUrl = (state.meeting_url as string) ?? "";

  if (meetingUrl.includes("meet.google.com") || meetingUrl.includes("zoom.us")) {
    focus(meetingUrl);
    await sleep(1000);
  }

  const result = run(["screencapture", "-x", out]);
  if (result.exitCode !== 0) {
    throw new Error(`screencapture failed with code ${result.exitCode}`);
  }
  process.stdout.write(resolve(out) + "\n");
}
