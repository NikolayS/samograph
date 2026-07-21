"use client";

import { Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { OwnerCallView } from "../../../components/OwnerCallView.tsx";
import { createHttpTranscriptStreamClient } from "../../../lib/transcriptStreamClient.ts";
import { createHttpShareApiClient } from "../../../lib/shareApiClient.ts";
import { createHttpAppApiClient } from "../../../lib/appApiClient.ts";

// Real seams; exercised in this issue only through the fakes (the ws-hub + share
// backend land separately). Module-scoped so identity is stable across renders.
const streamClient = createHttpTranscriptStreamClient();
const shareClient = createHttpShareApiClient();
// App-api client for the per-call Delete action (`DELETE /calls/:id`, §5.14).
const appClient = createHttpAppApiClient();

function OwnerCallInner({ callId }: { callId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // The dashboard links through with `?url=` so a Story-4 "Try again" can carry
  // the original meeting URL back to the paste input; empty is a safe default.
  const meetingUrl = params.get("url") ?? "";
  return (
    <OwnerCallView
      streamClient={streamClient}
      shareClient={shareClient}
      appClient={appClient}
      callId={callId}
      meetingUrl={meetingUrl}
      redirect={(path) => router.push(path)}
    />
  );
}

export default function CallPage() {
  const params = useParams<{ id: string }>();
  const callId = typeof params.id === "string" ? params.id : "";
  return (
    <main>
      {/* useSearchParams requires a Suspense boundary (App Router CSR bailout). */}
      <Suspense fallback={<p>Loading…</p>}>
        <OwnerCallInner callId={callId} />
      </Suspense>
    </main>
  );
}
