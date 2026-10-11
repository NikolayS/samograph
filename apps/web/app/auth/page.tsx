"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthLanding } from "../../components/AuthLanding.tsx";
import { AppShell } from "../../components/AppShell.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";
import { PageSkeleton } from "../../components/PageSkeleton.tsx";

const client = createHttpAppApiClient();

/**
 * `useSearchParams` opts a client component into a render bailout, so in the App
 * Router it MUST sit under a `<Suspense>` boundary or `next build` fails the
 * whole route ("missing suspense boundary with useSearchParams"). Same split as
 * `app/auth/callback/page.tsx`.
 */
function AuthLandingInner() {
  const router = useRouter();
  const params = useSearchParams();
  // The Google callback 302s here as `/auth?error=SAMO-AUTH-00x` (issue #209) —
  // a browser redirect carries no JSON body, so the code rides the query string.
  const errorCode = params.get("error") ?? undefined;
  return (
    <AuthLanding
      client={client}
      redirect={(path) => router.replace(path)}
      errorCode={errorCode}
    />
  );
}

export default function AuthRequestPage() {
  return (
    <AppShell variant="public" pageClassName="samograph-page--form">
      <Suspense fallback={<PageSkeleton variant="form" />}>
        <AuthLandingInner />
      </Suspense>
    </AppShell>
  );
}
