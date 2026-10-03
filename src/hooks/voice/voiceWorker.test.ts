import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const voiceDirectory = path.dirname(fileURLToPath(import.meta.url));
const voiceBinary = path.join(voiceDirectory, "dufflebag-voice");
const textToSpeechScript = path.join(voiceDirectory, "text_to_speech.py");

// Built by src/scripts/buildVoiceWorker.sh; CI runs tests before the native build exists.
const hasBinary = existsSync(voiceBinary);

const runVoice = (args: ReadonlyArray<string>): string =>
  execFileSync(voiceBinary, [...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  }).trim();

describe("native voice worker surface", () => {
  it.skipIf(!hasBinary)("exposes every worker subcommand", () => {
    const help = runVoice(["--help"]);
    for (const subcommand of "speak refine prepare watch-devin start stop-narration hotkey-check bench".split(" ")) {
      expect(help).toContain(subcommand);
    }
  });

  it.skipIf(!hasBinary)("renders markdown as speech prose", () => {
    const out = runVoice(["render", "--text", "# Hello\n\nWorld **bold**"]);
    expect(out).toContain("Hello.");
    expect(out).toContain("World bold.");
  });
});

describe("text_to_speech.py packaging", () => {
  it("ships the Supertonic speech script and its lock beside the native worker", () => {
    expect(existsSync(textToSpeechScript)).toBe(true);
    expect(existsSync(path.join(voiceDirectory, "text_to_speech.py.lock"))).toBe(true);
    const help = spawnSync("uv", ["run", "--frozen", "--script", textToSpeechScript, "--help"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 60_000,
    });
    expect(help.status).toBe(0);
    expect(help.stdout + help.stderr).toMatch(/serve/);
  });
});
