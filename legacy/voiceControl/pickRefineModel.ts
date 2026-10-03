/** Pick the refine provider, model, and effort with the voice hook's own picker, and save the choice to config.json. */

import { spawnSync } from "node:child_process";

import { FileSystem, Path } from "@effect/platform";
import { Effect, Either, Schema } from "effect";

import { decodeConfig } from "../config/configSchema.js";
import { readConfig, saveConfig } from "../config/configSettings.js";
import { hooksPath } from "../install/installPaths.js";
import { findPackageRoot } from "../install/packageRoot.js";
import type { Scope } from "../install/receipt.js";

class RefinePickerError extends Schema.TaggedError<RefinePickerError>()("RefinePickerError", {
  issue: Schema.NonEmptyString,
}) {
  get message(): string {
    return this.issue;
  }
}

const pickerChoiceSchema = Schema.Struct({
  backend: Schema.Trim,
  model: Schema.Trim,
  reasoningEffort: Schema.optional(Schema.Trim),
});

const decodePickerChoice = Schema.decodeUnknownEither(Schema.parseJson(pickerChoiceSchema));

const findRefineScript = (scopeRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = process.env.HOME?.trim() || "";
    const packageRoot = yield* findPackageRoot;
    // The scope's install first, then a global install (common even for project scope), then the shipped source.
    const candidates = [
      path.join(scopeRoot, hooksPath, "voice", "refine_prompt.py"),
      ...(home && home !== scopeRoot ? [path.join(home, hooksPath, "voice", "refine_prompt.py")] : []),
      path.join(packageRoot, "src", "hooks", "voice", "refine_prompt.py"),
    ];
    const script = (yield* Effect.filter(candidates, (candidate) => fileSystem.exists(candidate))).at(0);
    if (script === undefined) {
      return yield* new RefinePickerError({
        issue: "refine_prompt.py not found. Run `dufflebag voice on` (or install voice) first.",
      });
    }

    return script;
  });

// Progress goes to stderr and stdout carries one JSON object; tolerate noise around it.
const parsePickerOutput = (stdout: string) => {
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : stdout;
  const choice = decodePickerChoice(jsonSlice);
  if (Either.isLeft(choice)) {
    return Either.left(new RefinePickerError({ issue: `pick-refine returned invalid JSON: ${stdout.slice(0, 400)}` }));
  }

  if (choice.right.backend === "" || choice.right.model === "") {
    return Either.left(new RefinePickerError({ issue: `pick-refine returned incomplete JSON: ${stdout}` }));
  }

  return Either.right({
    backend: choice.right.backend,
    model: choice.right.model,
    reasoningEffort: choice.right.reasoningEffort?.toLowerCase() || "low",
  });
};

// GUI launchers and some terminals start with a minimal PATH, which hides user-local codex/claude/pi/opencode.
const pickerPath = () => {
  const home = process.env.HOME || "";
  const userBins = [`${home}/.local/bin`, `${home}/.grok/bin`, `${home}/Library/pnpm`, `${home}/Library/pnpm/bin`];
  return [...userBins, "/usr/local/bin", "/opt/homebrew/bin", process.env.PATH || "/usr/bin:/bin"].join(":");
};

const runRefinePicker = (request: { readonly script: string; readonly gui: boolean }) =>
  Effect.try({
    // -B: refine_prompt.py imports sibling modules; a __pycache__ beside the installed script would be unowned.
    try: () =>
      spawnSync("python3", ["-B", request.script, "--pick-menu", ...(request.gui ? ["--gui"] : [])], {
        encoding: "utf8",
        env: { ...process.env, PATH: pickerPath() },
        stdio: ["inherit", "pipe", "inherit"],
      }),
    catch: (error) => new RefinePickerError({ issue: error instanceof Error ? error.message : String(error) }),
  }).pipe(
    Effect.flatMap((pickerProcess) =>
      pickerProcess.status === 0
        ? parsePickerOutput((pickerProcess.stdout || "").trim())
        : Either.left(
            new RefinePickerError({
              issue: (pickerProcess.stderr || pickerProcess.stdout || "").trim() || "pick-refine cancelled",
            }),
          ),
    ),
  );

/** Run the picker for one scope and save the chosen provider, model, and effort. */
export const pickRefineModel = (request: { readonly scope: Scope; readonly gui: boolean }) =>
  Effect.gen(function* () {
    const current = yield* readConfig(request.scope);
    const script = yield* findRefineScript(current.destination.root);
    const choice = yield* runRefinePicker({ script, gui: request.gui });
    const nextConfig = yield* decodeConfig({
      ...current.config,
      refineProvider: choice.backend,
      refineModel: choice.model,
      refineEffort: choice.reasoningEffort,
    });
    const owner = yield* saveConfig({ target: current, configuration: { _tag: "selected", config: nextConfig } });
    return { nextConfig, owner };
  });
