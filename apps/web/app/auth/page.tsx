"use client";

import { useRouter } from "next/navigation";
import { AuthLanding } from "../../components/AuthLanding.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function AuthRequestPage() {
  const router = useRouter();
  return (
    <main>
      <AuthLanding client={client} redirect={(path) => router.replace(path)} />
    </main>
  );
}
