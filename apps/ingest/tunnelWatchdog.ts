/**
 * STUB (RED) — server-side tunnel watchdog + leader election (#81).
 * Replaced by the real implementation in the GREEN commit.
 */
import type { SQL } from "bun";
import type { HealthFetch } from "../../src/server.ts";
import type { TranscriptPublisher } from "../../packages/shared/transcript/publisher.ts";

export interface WatchdogMetrics {
  incTunnelProbeFailed(region: string): void;
}

export function inMemoryWatchdogMetrics(): WatchdogMetrics & {
  failed: Record<string, number>;
} {
  const failed: Record<string, number> = {};
  return {
    failed,
    incTunnelProbeFailed() {},
  };
}

export interface RegionWatchdogDeps {
  sql: SQL;
  regionId: string;
  replicaId: string;
  publisher: TranscriptPublisher;
  metrics: WatchdogMetrics;
  fetch: HealthFetch;
  now: () => Date;
  nonce?: () => string;
  leaseMs?: number;
  failureThreshold?: number;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => { stop(): void };
}

export interface RegionWatchdogHandle {
  tick(): Promise<void>;
  isLeader(): boolean;
  stop(): void;
}

export function startRegionWatchdog(_deps: RegionWatchdogDeps): RegionWatchdogHandle {
  return {
    async tick() {},
    isLeader() {
      return false;
    },
    stop() {},
  };
}
