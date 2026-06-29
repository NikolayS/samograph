"use client";

import { AddToCallForm } from "../../components/AddToCallForm.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function DashboardPage() {
  return (
    <main>
      <AddToCallForm client={client} />
    </main>
  );
}
