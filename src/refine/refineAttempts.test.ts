import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverProviders } from "./providerModels.js";
import { attemptQueue, codexModelCandidates, refinePrompt, shouldRotate } from "./refineAttempts.js";
import { codexFailedModels } from "./refineChoices.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

const PROVIDER_BINARIES = ["codex", "claude", "gemini", "agy", "grok", "agent", "ollama", "opencode", "pi", "pie"];

let home = "";
let bin = "";
const savedPath = process.env.PATH;
const savedHome = process.env.HOME;

// Every provider binary gets a fake first on PATH, so no test can reach a real agent CLI.
const writeFakeCli = (name: string, script: string) => {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "refine-"));
  bin = path.join(home, "bin");
  mkdirSync(bin);
  for (const name of PROVIDER_BINARIES) {
    writeFakeCli(name, "exit 0");
  }
  process.env.HOME = home;
  process.env.VOXKEY_HOME = path.join(home, ".voxkey");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  process.env.HOME = savedHome;
  delete process.env.VOXKEY_HOME;
  rmSync(home, { recursive: true, force: true });
});

// A fake codex that writes its reply to the `-o` file, or fails for the models listed in BAD_MODELS.
const fakeCodex = (request: { readonly reply: string; readonly badModels: ReadonlyArray<string> }) =>
  writeFakeCli(
    "codex",
    [
      'out=""; model=""; prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '  if [ "$prev" = "-m" ]; then model="$arg"; fi',
      '  prev="$arg"',
      "done",
      `case " ${request.badModels.join(" ")} " in *" $model "*) echo "ERROR: The '$model' model is not supported when using Codex with a ChatGPT account."; exit 1;; esac`,
      `printf '%s' '${request.reply}' > "$out"`,
    ].join("\n"),
  );

const refine = (draft: string) =>
  Effect.runPromiseExit(
    refinePrompt({ draft, provider: "codex", model: "", effort: "", allowPicker: false, log: () => undefined }),
  );

describe("codexModelCandidates", () => {
  it("tries the preferred model first, then the last good one, then the fallbacks", () => {
    const candidates = codexModelCandidates({ preferred: "my-model", lastGood: "gpt-5.4-mini", failed: new Set() });
    expect(candidates.slice(0, 3)).toEqual(["my-model", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  });

  it("starts with the last good model when the preferred one already failed, and defers failed models", () => {
    const candidates = codexModelCandidates({
      preferred: "gpt-5.3-codex-spark",
      lastGood: "gpt-5.4-mini",
      failed: new Set(["gpt-5.3-codex-spark", "o4-mini"]),
    });
    expect(candidates[0]).toBe("gpt-5.4-mini");
    expect(candidates.slice(-2)).toEqual(["gpt-5.3-codex-spark", "o4-mini"]);
  });
});

describe("refine rotation", () => {
  it("rotates on errors and model-unavailable replies but not on a dropped literal", () => {
    expect(shouldRotate("connection refused")).toBe(true);
    expect(shouldRotate("The model is not supported")).toBe(true);
    expect(shouldRotate("The model changed a protected literal: `x`")).toBe(false);
  });

  it("puts the preferred provider's models first, then one model from each other installed provider", async () => {
    writeFakeCli("pi", 'echo "openai-codex  gpt-5.4-mini  272K"; echo "openrouter  slow  128K"');
    writeFakeCli("opencode", 'echo "opencode/big-pickle"');
    const queue = await Effect.runPromise(attemptQueue({ provider: "pi", model: "default" }));

    expect(queue[0]).toEqual({ provider: "pi", model: "openai-codex/gpt-5.4-mini" });
    expect(queue.map((attempt) => attempt.provider)).toEqual(
      expect.arrayContaining(["pi", "codex", "opencode", "gemini", "grok"]),
    );
    expect(queue.find((attempt) => attempt.provider === "opencode")?.model).toBe("opencode/big-pickle");
  });

  it("refines with codex, keeps protected literals, and remembers the working model", async () => {
    fakeCodex({ reply: "finish-and-push: run `pnpm verify` then open a PR", badModels: [] });
    const refined = await refine("uh run `pnpm verify` and like open a pr dont merge");

    expect(refined).toEqual(Exit.succeed("finish-and-push: run `pnpm verify` then open a PR"));
    const choice = JSON.parse(readFileSync(path.join(home, ".voxkey", "refine-choice.json"), "utf8"));
    expect(choice).toMatchObject({ provider: "codex", model: "gpt-5.3-codex-spark", effort: "low" });
  });

  it("marks a model this account cannot use and moves on to the next one", async () => {
    fakeCodex({ reply: "Ship the voice refine fix", badModels: ["gpt-5.3-codex-spark"] });
    const refined = await refine("uh ship the voice refine fix please now");

    expect(refined).toEqual(Exit.succeed("Ship the voice refine fix"));
    expect([...codexFailedModels()]).toEqual(["gpt-5.3-codex-spark"]);
  });

  it("fails without typing anything when every provider prints an error envelope", async () => {
    for (const name of PROVIDER_BINARIES) {
      writeFakeCli(name, 'echo \'{"error":{"code":402,"message":"requires more credits"}}\'');
    }
    expect(Exit.isFailure(await refine("make a branch and open a pull request"))).toBe(true);
  });
});

describe("discoverProviders", () => {
  it("lists installed providers with their models", async () => {
    writeFakeCli("ollama", 'echo "NAME ID SIZE"; echo "llama3.2:latest abc 2.0 GB"');
    const providers = await Effect.runPromise(discoverProviders({ refresh: true }));
    const ollama = providers.find((provider) => provider.id === "ollama");

    expect(ollama).toEqual({
      id: "ollama",
      binary: "ollama",
      path: path.join(bin, "ollama"),
      effort: false,
      models: ["llama3.2:latest"],
    });
    expect(providers.map((provider) => provider.id)).toEqual([
      "codex",
      "claude",
      "gemini",
      "grok",
      "ollama",
      "opencode",
      "pi",
    ]);
  });
});
