import { readConfig, writeConfig, configFile } from "../config.ts";
import { ExitError } from "../config.ts";
import type { ParsedArgs } from "../args.ts";

const ALLOWED_KEYS = ["recall-api-key"] as const;
type AllowedKey = (typeof ALLOWED_KEYS)[number];

/** Map CLI key names (kebab-case) to config file field names (snake_case). */
const KEY_MAP: Record<AllowedKey, string> = {
  "recall-api-key": "recall_api_key",
};

export async function cmdConfig(args: ParsedArgs): Promise<void> {
  const action = args.config_action ?? "help";

  if (action === "get") {
    const key = args.config_key;
    if (!key) {
      process.stderr.write(
        "samograph config get: missing key\n" +
          `  usage: samograph config get <key>\n` +
          `  allowed keys: ${ALLOWED_KEYS.join(", ")}\n`,
      );
      throw new ExitError(2);
    }
    if (!ALLOWED_KEYS.includes(key as AllowedKey)) {
      process.stderr.write(
        `samograph config get: unknown key '${key}'\n` +
          `  allowed keys: ${ALLOWED_KEYS.join(", ")}\n`,
      );
      throw new ExitError(2);
    }
    const fieldName = KEY_MAP[key as AllowedKey];
    const cfg = readConfig();
    const value = cfg[fieldName as keyof typeof cfg];
    if (value === undefined) {
      process.stderr.write(`${key}: (not set)\n`);
      throw new ExitError(1);
    }
    process.stdout.write(`${value}\n`);
    return;
  }

  if (action === "set") {
    const key = args.config_key;
    const value = args.config_value;
    if (!key || !value) {
      process.stderr.write(
        "samograph config set: missing key or value\n" +
          `  usage: samograph config set <key> <value>\n` +
          `  allowed keys: ${ALLOWED_KEYS.join(", ")}\n`,
      );
      throw new ExitError(2);
    }
    if (!ALLOWED_KEYS.includes(key as AllowedKey)) {
      process.stderr.write(
        `samograph config set: unknown key '${key}'\n` +
          `  allowed keys: ${ALLOWED_KEYS.join(", ")}\n`,
      );
      throw new ExitError(2);
    }
    const fieldName = KEY_MAP[key as AllowedKey];
    writeConfig(fieldName, value);
    process.stdout.write(`Saved ${key} to ${configFile()}\n`);
    return;
  }

  // Default: show help / list current config.
  const cfg = readConfig();
  process.stdout.write(`Config file: ${configFile()}\n\n`);
  if (Object.keys(cfg).length === 0) {
    process.stdout.write("(empty — no values set)\n\n");
  } else {
    for (const [k, v] of Object.entries(cfg)) {
      // Redact the API key value for security.
      const display = k === "recall_api_key" ? `${String(v).slice(0, 8)}...` : String(v);
      process.stdout.write(`  ${k} = ${display}\n`);
    }
    process.stdout.write("\n");
  }
  process.stdout.write(
    `commands:\n` +
      `  samograph config set recall-api-key <key>   Store the Recall.ai API key\n` +
      `  samograph config get recall-api-key          Print the stored key\n`,
  );
}
