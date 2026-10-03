import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConfig, readConfigOrDefaults, saveConfig } from "./configFile.js";
import { defaultConfig } from "./configSchema.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "config-"));
  process.env.VOXKEY_HOME = home;
});

afterEach(() => {
  delete process.env.VOXKEY_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("config file", () => {
  it("reads the defaults when ~/.voxkey/config.json does not exist yet", () => {
    expect(Effect.runSync(readConfig)).toEqual(defaultConfig);
  });

  it("writes every setting and reads the same config back", () => {
    const config = { ...defaultConfig, dictationLanguage: "he" as const, refineModel: "grok-4.5" };
    Effect.runSync(saveConfig(config));

    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toMatchObject({
      dictationLanguage: "he",
      refineModel: "grok-4.5",
      narrationVoice: "F4",
    });
    expect(Effect.runSync(readConfig)).toEqual(config);
  });

  it("fails on a broken file, while workers fall back to the defaults", () => {
    writeFileSync(path.join(home, "config.json"), '{ "narrationMode": "loud" }');

    expect(Exit.isFailure(Effect.runSyncExit(readConfig))).toBe(true);
    expect(Effect.runSync(readConfigOrDefaults)).toEqual(defaultConfig);
  });
});
