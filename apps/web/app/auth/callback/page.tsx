"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MagicLinkCallback } from "../../../components/MagicLinkCallback.tsx";
import { createHttpAppApiClient } from "../../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

function CallbackInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? undefined;
  return <MagicLinkCallback token={token} client={client} />;
}

export default function AuthCallbackPage() {
  return (
    <main>
      <Suspense fallback={<p>Loading…</p>}>
        <CallbackInner />
      </Suspense>
    </main>
  );
}
