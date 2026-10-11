"use client";

import { useRouter } from "next/navigation";
import { SettingsPage } from "../../components/SettingsPage.tsx";
import { AppShell } from "../../components/AppShell.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function SettingsRoute() {
  const router = useRouter();
  return (
    <AppShell client={client} redirect={(path) => router.replace(path)} pageClassName="samograph-page--prose">
      <SettingsPage client={client} redirect={(path) => router.replace(path)} />
    </AppShell>
  );
}
