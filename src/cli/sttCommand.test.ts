import { describe, expect, it } from "vitest";

import { normalizeDictationLanguage } from "./sttCommand.js";

describe("normalizeDictationLanguage", () => {
  it.each([
    ["en", "en"],
    ["english", "en"],
    [" EN-US ", "en"],
    ["he", "he"],
    ["lang=he", "he"],
    ["hebrew", "he"],
    ["ivrit", "he"],
    ["iw", "he"],
    ["nope", null],
  ])("maps %j to %s", (token, language) => {
    expect(normalizeDictationLanguage(token)).toBe(language);
  });
});
