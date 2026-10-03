import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { configSettings } from "./configSchema.js";
import { environmentVariableNames } from "./environmentVariables.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README", () => {
  it("documents every setting with its description", () => {
    for (const setting of configSettings) {
      expect(readme).toContain(`| \`${setting.name}\` |`);
      expect(readme).toContain(setting.description.replaceAll("|", "\\|"));
    }
  });

  it("documents every VOXKEY_* environment variable", () => {
    expect(environmentVariableNames.length).toBe(5);
    for (const name of environmentVariableNames) {
      expect(readme).toContain(`| \`${name}\` |`);
    }
  });
});
