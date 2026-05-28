import { watch } from "../transcript.ts";

export async function cmdWatch(): Promise<void> {
  await watch();
}
