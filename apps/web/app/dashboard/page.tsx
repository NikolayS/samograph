"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Dashboard } from "../../components/Dashboard.tsx";
import { AppShell } from "../../components/AppShell.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";
import { PageSkeleton } from "../../components/PageSkeleton.tsx";

const client = createHttpAppApiClient();

function DashboardInner() {
  const router = useRouter();
  const params = useSearchParams();
  // Story-4: carry only the call id; Dashboard resolves the full owner URL from
  // its API-loaded list before the owner explicitly re-submits (§5.2, #286).
  const retryCallId = params.get("retry") ?? undefined;
  return (
    <Dashboard
      client={client}
      redirect={(path) => router.replace(path)}
      retryCallId={retryCallId}
    />
  );
}

export default function DashboardPage() {
  const router = useRouter();
  return (
    <AppShell client={client} redirect={(path) => router.replace(path)}>
      {/* useSearchParams requires a Suspense boundary (App Router CSR bailout). */}
      <Suspense fallback={<PageSkeleton variant="page" />}>
        <DashboardInner />
      </Suspense>
    </AppShell>
  );
}
