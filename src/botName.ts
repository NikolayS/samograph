/**
 * Build the bot display name shown in the call.
 *
 * Truncation uses CODE POINTS (not UTF-16 units) to faithfully match Python's
 * `base[:100]`, where the 🔴 emoji counts as a single character.
 */
export function botName(agentName?: string | null): string {
  let base: string;
  if (agentName) {
    base = `${agentName} \u{1F534} (samocall)`;
  } else {
    base = "samocall \u{1F534}";
  }
  return [...base].slice(0, 100).join(""); // recall.ai limit, code-point aware
}
