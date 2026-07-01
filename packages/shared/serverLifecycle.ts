/**
 * Stop a `Bun.serve` server with a bounded wait. Bun 1.3.14's `server.stop()`
 * does not resolve once the server has INITIATED a `ws.close()` (ws-hub's
 * revoke-recheck path) — the listener is closing but the promise hangs. Callers
 * stop to exit (tests / dev shutdown), so cap the wait to keep teardown
 * deterministic. Shared by the ws-hub and ingest entrypoints.
 */
export async function stopServerBounded(
  server: { stop(closeActive?: boolean): Promise<void> },
  ms = 2000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    server.stop(true).then(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}
