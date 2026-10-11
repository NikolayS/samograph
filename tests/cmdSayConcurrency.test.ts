import { expect, it } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, cleanupTmpDir } from "./helpers.ts";

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("worker barrier timed out");
    await Bun.sleep(5);
  }
}

it("only one process can enter chat/playback, including simultaneous stale recovery", async () => {
  // Run both a fresh acquisition and recovery after the owner is killed.
  for (const stale of [false, true]) {
    const root = makeTmpDir();
    writeFileSync(join(root, "state.json"), "{}");
    const workers: ReturnType<typeof Bun.spawn>[] = [];
    const spawn = (id: string) => {
      const worker = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/sayWorker.ts"), root, id], { stdout: "pipe", stderr: "pipe" });
      workers.push(worker);
      return worker;
    };
    try {
      if (stale) {
        const dead = spawn("dead");
        await until(() => existsSync(join(root, "ready-dead")));
        dead.kill("SIGKILL");
        await dead.exited;
      }
      const first = spawn("1");
      // Fresh case deterministically holds first in sendChat before starting the contender.
      if (!stale) await until(() => existsSync(join(root, "ready-1")));
      const second = spawn("2");
      await until(() => ["1", "2"].every(id => existsSync(join(root, `ready-${id}`)) || existsSync(join(root, `done-${id}`))));
      writeFileSync(join(root, "release"), "go");
      const exits = await Promise.all([first.exited, second.exited]);
      const errors = await Promise.all([first, second].map(w => new Response(w.stderr).text()));
      expect(exits.sort()).toEqual([0, 1]);
      expect(errors.join(" ")).toContain("already speaking");
      expect(readdirSync(root).filter(f => f.startsWith("audio-"))).toHaveLength(1);
    } finally {
      for (const worker of workers) worker.kill();
      await Promise.all(workers.map(w => w.exited));
      cleanupTmpDir(root);
    }
  }
}, 15000);
