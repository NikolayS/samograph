/**
 * Per-tenant transcription config → Recall/Deepgram payload (SPEC §5.12).
 *
 * The hosted bot-create path must carry the TENANT'S dictionary keyterms and
 * language into the Deepgram streaming config, instead of the hardwired
 * `language: "multi"` default with no keyterms. This suite asserts the wiring at
 * two seams:
 *   1. `buildRealCreateBotPayload` maps `req.keyterms` / `req.language` into
 *      `recording_config.transcript.provider.deepgram_streaming`;
 *   2. `orchestrateJoin` threads the job's keyterms/language through to the
 *      Recall client — proven via the deterministic in-repo Recall FAKE, whose
 *      `createBot(payload)` records the exact payload it received (§6.1).
 */
import { describe, it, expect } from "bun:test";
import {
  orchestrateJoin,
  BOT_NAME,
  type CallStore,
  type CreateBotRequest,
  type OrchestratorJob,
  type RecallClient,
} from "./index.ts";
import { buildRealCreateBotPayload } from "./recallClient.ts";
import { createRecallFake } from "../../packages/test-fakes/recall/index.ts";

const PUBLIC = "https://samograph-main.samo.cat";
const SECRET = "ingsec_deadbeef";

function reqWith(extra: Partial<CreateBotRequest> = {}): CreateBotRequest {
  return {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botName: BOT_NAME,
    buildWebhookUrl: (id) => `${PUBLIC}/webhook?bot=${id}&t=${SECRET}`,
    ...extra,
  };
}

/** A no-op CallStore so orchestrateJoin runs without a database. */
const noopStore: CallStore = {
  async recordIngestSecret() {},
  async markJoining() {},
  async markCouldNotJoin() {},
};

describe("buildRealCreateBotPayload — per-tenant Deepgram keyterms + language (§5.12)", () => {
  it("maps req.keyterms and req.language into deepgram_streaming", () => {
    const payload = buildRealCreateBotPayload(
      reqWith({ keyterms: ["pg_stat_statements", "WAL"], language: "es" }),
    ) as Record<string, any>;
    const dg = payload.recording_config.transcript.provider.deepgram_streaming;
    expect(dg.language).toBe("es");
    expect(dg.keyterms).toEqual(["pg_stat_statements", "WAL"]);
  });

  it("defaults to multilingual with no keyterms when the tenant set nothing", () => {
    const payload = buildRealCreateBotPayload(reqWith()) as Record<string, any>;
    const dg = payload.recording_config.transcript.provider.deepgram_streaming;
    expect(dg.language).toBe("multi");
    expect("keyterms" in dg).toBe(false);
  });
});

describe("orchestrateJoin — tenant settings reach the Recall fake payload (§5.12)", () => {
  it("threads job.keyterms + job.language into the created-bot Deepgram config", async () => {
    // Own the fake so we can read back the exact payload createBot received.
    const fake = createRecallFake({ seed: "call-settings" });
    const recall: RecallClient = {
      async createBot(req: CreateBotRequest) {
        const { id } = fake.createBot(buildRealCreateBotPayload(req));
        return { id, webhookUrl: req.buildWebhookUrl(id) };
      },
    };

    const job: OrchestratorJob = {
      callId: "call-settings",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      keyterms: ["autovacuum", "pgbouncer"],
      language: "de",
    };
    await orchestrateJoin(job, {
      recall,
      store: noopStore,
      webhookBase: PUBLIC,
      generateSecret: () => SECRET,
    });

    const dg = (fake.lastCreateBotPayload as Record<string, any>).recording_config.transcript.provider
      .deepgram_streaming;
    expect(dg.language).toBe("de");
    expect(dg.keyterms).toEqual(["autovacuum", "pgbouncer"]);
  });
});
