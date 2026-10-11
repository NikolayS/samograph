"use client";

import { useParams, useRouter } from "next/navigation";
import { OwnerCallView } from "../../../components/OwnerCallView.tsx";
import { AppShell } from "../../../components/AppShell.tsx";
import { createHttpTranscriptStreamClient } from "../../../lib/transcriptStreamClient.ts";
import { createHttpShareApiClient } from "../../../lib/shareApiClient.ts";
import { createHttpAppApiClient } from "../../../lib/appApiClient.ts";

// Real seams; exercised in this issue only through the fakes (the ws-hub + share
// backend land separately). Module-scoped so identity is stable across renders.
const streamClient = createHttpTranscriptStreamClient();
const shareClient = createHttpShareApiClient();
// App-api client for the owner read and Delete action (`/calls/:id`).
const appClient = createHttpAppApiClient();

export default function CallPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const callId = typeof params.id === "string" ? params.id : "";
  return (
    <AppShell client={appClient} redirect={(path) => router.push(path)}>
      <OwnerCallView
        streamClient={streamClient}
        shareClient={shareClient}
        appClient={appClient}
        callId={callId}
        redirect={(path) => router.push(path)}
      />
    </AppShell>
  );
}
