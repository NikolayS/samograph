import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadDict } from "../src/dict.ts";
import { makeTmpDir, cleanupTmpDir, saveEnv, restoreEnv } from "./helpers.ts";

const REAL_DICT_DIR = join(import.meta.dir, "..", "dictionaries");

describe("loadDict", () => {
  let tmp: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    env = saveEnv();
    tmp = makeTmpDir();
    process.env.SAMOGRAPH_DICT_DIR = tmp;
  });
  afterEach(() => {
    restoreEnv(env);
    cleanupTmpDir(tmp);
  });

  it("none returns empty", () => {
    expect(loadDict(null)).toEqual([]);
  });

  it("string 'none' returns empty", () => {
    expect(loadDict("none")).toEqual([]);
  });

  it("string 'NONE' case insensitive", () => {
    expect(loadDict("NONE")).toEqual([]);
  });

  it("nonexistent returns empty with warning", () => {
    process.env.SAMOGRAPH_DICT_DIR = "/tmp/nonexistent_dict_dir_xyzzy";
    const result = loadDict("bogus_dict");
    expect(result).toEqual([]);
  });

  it("real postgresfm returns terms", () => {
    if (!existsSync(join(REAL_DICT_DIR, "postgresfm.txt"))) return;
    process.env.SAMOGRAPH_DICT_DIR = REAL_DICT_DIR;
    const terms = loadDict("postgresfm");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(100);
  });

  it("max 100 terms enforced", () => {
    const f = join(tmp, "big.txt");
    writeFileSync(
      f,
      Array.from({ length: 150 }, (_, i) => `term${i}`).join("\n"),
    );
    const result = loadDict("big");
    expect(result.length).toBe(100);
    expect(result[0]).toBe("term0");
    expect(result[99]).toBe("term99");
  });

  it("skips blank lines", () => {
    writeFileSync(join(tmp, "sparse.txt"), "alpha\n\nbeta\n\n\ngamma\n");
    expect(loadDict("sparse")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips whitespace", () => {
    writeFileSync(join(tmp, "ws.txt"), "  hello  \n  world  \n");
    expect(loadDict("ws")).toEqual(["hello", "world"]);
  });

  it("postgresfm at limit (exactly 100)", () => {
    if (!existsSync(join(REAL_DICT_DIR, "postgresfm.txt"))) return;
    process.env.SAMOGRAPH_DICT_DIR = REAL_DICT_DIR;
    const terms = loadDict("postgresfm");
    expect(terms.length).toBe(100);
  });
});
