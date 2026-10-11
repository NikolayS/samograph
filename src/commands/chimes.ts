import { chimeNames, DEFAULT_CHIME, resolveChime } from "../chime.ts";
import { loadState } from "../state.ts";

// List the selectable chime sounds. Marks the library default and, when a
// session default was set at join time (state.chime), the active session chime.
export function cmdChimes(): void {
  const sessionRaw = loadState().chime;
  const session = sessionRaw === undefined || sessionRaw === null
    ? null
    : resolveChime(sessionRaw).name;
  const lines: string[] = [];
  for (const name of chimeNames()) {
    const tags: string[] = [];
    if (name === DEFAULT_CHIME) tags.push("default");
    if (session !== null && name === session) tags.push("session");
    lines.push(tags.length ? `${name}  (${tags.join(", ")})` : name);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
