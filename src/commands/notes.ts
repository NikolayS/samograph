import type { ParsedArgs } from "../args.ts";
import {
  loadServiceAccountCredentials,
  makeGoogleDocsClient,
  resolveGoogleDocId,
  type GoogleDocsClient,
} from "../googleDocs.ts";
import { streamTranscriptLines, type WatchOpts } from "../transcript.ts";

interface NotesDeps {
  docs?: GoogleDocsClient;
  watch?: WatchOpts;
}

export async function cmdNotes(args: ParsedArgs, deps: NotesDeps = {}): Promise<void> {
  const docId = resolveGoogleDocId(args.doc_id);
  const docs = deps.docs ?? makeGoogleDocsClient(loadServiceAccountCredentials(args.credentials));
  const action = args.notes_action ?? "help";

  if (action === "init") {
    const title = args.title ?? "Meeting live doc";
    await docs.appendText(docId, template(title));
    process.stdout.write(`Initialized live meeting doc ${docId}\n`);
    return;
  }

  if (action === "point") {
    const text = requireText(args.message, "point");
    const section = sectionHeading(args.section ?? "important");
    const speaker = args.speaker ? `${args.speaker}: ` : "";
    await docs.appendToSection(docId, section, `1. ${speaker}${text}\n`);
    process.stdout.write(`Added note to ${section}\n`);
    return;
  }

  if (action === "decision") {
    const text = requireText(args.message, "decision");
    await docs.appendToSection(docId, "Decisions", `1. ${text}\n`);
    process.stdout.write("Added decision\n");
    return;
  }

  if (action === "action") {
    const text = requireText(args.message, "action");
    const owner = args.owner ? `Owner: ${args.owner}. ` : "";
    const due = args.due ? `Due: ${args.due}. ` : "";
    await docs.appendToSection(docId, "Next steps / action items", `1. ${owner}${due}${text}\n`);
    process.stdout.write("Added action item\n");
    return;
  }

  if (action !== "transcript") {
    process.stderr.write(
      "usage: samocall notes <init|point|decision|action|transcript> [options]\n",
    );
    return;
  }
  process.stdout.write(`Writing live notes to Google Doc ${docId}\n`);
  await streamTranscriptLines(
    async (line) => {
      await docs.appendText(docId, line + "\n");
      process.stdout.write(line + "\n");
    },
    {
      ...deps.watch,
      fromStart: args.from_start === true,
    },
  );
}

function requireText(text: string | undefined, action: string): string {
  if (!text?.trim()) {
    throw new Error(`notes ${action} requires text`);
  }
  return text.trim();
}

function sectionHeading(section: string): string {
  const key = section.toLowerCase();
  const headings: Record<string, string> = {
    agenda: "Agenda / questions",
    question: "Agenda / questions",
    questions: "Agenda / questions",
    important: "Important points",
    points: "Important points",
    decision: "Decisions",
    decisions: "Decisions",
    action: "Next steps / action items",
    actions: "Next steps / action items",
    links: "Links / references",
    transcript: "Transcript excerpts",
  };
  return headings[key] ?? "Important points";
}

function template(title: string): string {
  return `\n${title}

Context
1. Goal:
2. Pre-work / references:
3. Expected outcome:

Agenda / questions
1.

Important points

Decisions

Next steps / action items

Links / references

Transcript excerpts
`;
}
