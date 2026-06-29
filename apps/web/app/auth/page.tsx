"use client";

import { MagicLinkRequestForm } from "../../components/MagicLinkRequestForm.tsx";
import { createHttpAppApiClient } from "../../lib/appApiClient.ts";

const client = createHttpAppApiClient();

export default function AuthRequestPage() {
  return (
    <main>
      <MagicLinkRequestForm client={client} />
    </main>
  );
}
