"use client";

import { useRouter } from "next/navigation";
import { SettingsPage } from "../../components/SettingsPage.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function SettingsRoute() {
  const router = useRouter();
  return (
    <main>
      <SettingsPage client={client} redirect={(path) => router.replace(path)} />
    </main>
  );
}
