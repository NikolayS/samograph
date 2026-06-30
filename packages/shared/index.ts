/**
 * @samograph/shared — code shared across samograph.dev apps.
 *
 * The transcript normalizer (§6.2 #1) and capability tokens (§6.2 #2) live
 * here; the tenancy-gate / auth helpers (§6.2 #4) land in their own Sprint-1
 * issue (#41).
 */
export const PACKAGE_NAME = "@samograph/shared";

// Canonical transcript normalizer (#39, SPEC §5.4 / §6.2 #1) — pure, no I/O.
export {
  normalizeTranscriptLine,
  sanitizeTranscriptField,
} from "./transcript/index.ts";

// Per-call transcript pub/sub fan-out port (#78, SPEC §5.5 / §5.11): the seam
// ingest/watchdog/lifecycle publish onto and ws-hub consumes, with an in-memory
// fake + a Postgres LISTEN/NOTIFY impl keyed per call_id.
export {
  InMemoryTranscriptPublisher,
  PgListenNotifyPublisher,
  createInMemoryTranscriptPublisher,
  transcriptChannel,
  type TranscriptControlFrame,
  type TranscriptFrame,
  type TranscriptLineFrame,
  type TranscriptPublisher,
} from "./transcript/publisher.ts";

// Capability token generator/verifier (#40, SPEC §5.7 / §6.2 #2). Pure signer
// + the persisted-token store (HMAC-SHA256, KID rotation, jti-unique replay
// prevention, constant-time verify; `share`/`act:*` persisted, `read` never).
export {
  ACT_SCOPES,
  PERSISTED_SCOPES,
  assertPersistableScopes,
  constantTimeEqual,
  isPersistedScope,
  signToken,
  tokenGrants,
  verifyTokenSignature,
  type Keyring,
  type PersistedScope,
  type SignatureVerifyResult,
  type SigningKey,
  type TokenPayload,
  type VerifyFailureReason,
  type VerifyOptions,
} from "./tokens/signing.ts";
export {
  mintShareToken,
  mintToken,
  revokeToken,
  verifyToken,
  type FullVerifyOptions,
  type FullVerifyResult,
  type MintedToken,
  type MintOptions,
} from "./tokens/store.ts";

// The pinned Recall webhook signing contract (#77, SPEC §5.3 step 1 / §6.2 #7).
// ONE source of truth shared by the signer (the in-repo Recall fake) and the
// verifier (the ingest POST /webhook front door).
export {
  RECALL_SIGNATURE_HEADER,
  recallSignature,
  verifyRecallSignature,
} from "./recall/signature.ts";

// The §5.11 observability surface (#87): the metrics registry that aggregates
// the already-emitted counters, the Prometheus `/metrics` endpoint, the
// tenant-context-enforcing structured logger, and the §9 activation-funnel
// aggregator that feeds the W1-activation dashboard.
export {
  MetricsRegistry,
  COUNTER_SPECS,
  nearestRankPercentiles,
  aggregateFunnel,
  FUNNEL_STAGES,
  buildLogRecord,
  formatLogLine,
  createLogger,
  MissingLogContextError,
  metricsHttpHandler,
  METRICS_CONTENT_TYPE,
  type CounterName,
  type PickupLatencySummary,
  type ActivationEvent,
  type FunnelSnapshot,
  type FunnelStage,
  type LogContext,
  type LogLevel,
  type StructuredLogRecord,
} from "./observe/index.ts";
