/**
 * Hard rules for an AI agent while it is in a call. Printed by `join` in the
 * AGENT INSTRUCTIONS block and mirrored in README.md and CLAUDE.md.
 *
 * Why: on 2026-10-08 an agent following a call asked the human a question
 * through a blocking terminal dialog (Claude Code AskUserQuestion). The
 * session blocked, stopped reading the transcript for ~8 minutes, and people
 * in the call asked "do you hear us?" with no answer.
 */
export const IN_CALL_RULES: readonly string[] = [
  "NEVER use blocking interactive prompts while in a call: no AskUserQuestion, no plan-approval",
  "  dialogs, no terminal prompts, nothing that pauses your session. A blocked agent stops",
  "  reading the transcript and goes deaf.",
  "Ask questions and get decisions THROUGH THE CALL: samograph ask \"<question>\" --options \"A|B\"",
  "  --default A [--voice] (run it in the background), or a short 'samograph say' / 'samograph chat'.",
  "  Then keep listening.",
  "If nobody answers within the timeout, pick a sensible default and say it in the call",
  "  ('samograph ask --default' does this for you).",
  "Read EVERY transcript line (no keyword filtering). When addressed, reply briefly by voice",
  "  (samograph say) if voice is enabled, else in chat. Put links and long text in chat.",
];

/** The rules as printed by `join`: "- " bullets, continuation lines indented. */
export function formatInCallRules(): string {
  const body = IN_CALL_RULES.map((l) => (l.startsWith(" ") ? l : `- ${l}`)).join("\n");
  return `HARD RULES while in the call:\n${body}\n`;
}
