"use client";

import { useRouter } from "next/navigation";
import { Dashboard } from "../../components/Dashboard.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function DashboardPage() {
  const router = useRouter();
  return (
    <main>
      <Dashboard client={client} redirect={(path) => router.replace(path)} />
    </main>
  );
}
