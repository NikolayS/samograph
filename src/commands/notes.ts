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
