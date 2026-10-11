import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdSay } from "../../src/commands/say.ts";
import type { RecallClient } from "../../src/recall.ts";

const root = process.argv[2]!;
const id = process.argv[3]!;
process.env.SAMOGRAPH_HOME = root;
process.env.SAMOGRAPH_STATE_FILE = join(root, "state.json");
const recall: RecallClient = {
  async leaveCall() { return new Response(); },
  async getBot() { return {}; },
  async screenshot() { return new Response(); },
  async createBot() { return { id: "fixture" }; },
  async sendChat() {
    writeFileSync(join(root, `ready-${id}`), "ready");
    while (!existsSync(join(root, "release"))) await Bun.sleep(5);
    return new Response("{}");
  },
  async outputAudio() {
    writeFileSync(join(root, `audio-${id}`), "played");
    return new Response("{}");
  },
};
try {
  await cmdSay({ command: "say", message: "Hello.", bot_id: "fixture", also_chat: true, no_barge_in: true, cooldown: 0 }, {
    recall,
    tts: { env: { OPENAI_API_KEY: "fixture" }, fetchFn: async () => new Response("fake mp3"), which: () => null, run: async () => ({ code: 0, stderr: "" }), platform: "linux" },
    durationOf: () => 0,
  });
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(join(root, `done-${id}`), "done");
}
