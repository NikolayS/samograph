"use client";

import { useParams } from "next/navigation";
import { ShareCallView } from "../../../components/ShareCallView.tsx";
import { AppShell } from "../../../components/AppShell.tsx";
import { createHttpTranscriptStreamClient } from "../../../lib/transcriptStreamClient.ts";

// No session/cookie on the read-only page — the share token is the only credential.
const streamClient = createHttpTranscriptStreamClient();

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <AppShell variant="public">
      <ShareCallView streamClient={streamClient} shareToken={token} />
    </AppShell>
  );
}
