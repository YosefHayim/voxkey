/**
 * Saved refine choices in ~/.voxkey: the sticky provider/model/effort pick, and the Codex last-good and
 * failed-model lists, so the next dictation skips models that already failed for this account.
 */

import { Option, Schema } from "effect";
import { readJsonFile, readTextIfPresent, writeFileAtomically, writeJsonAtomically } from "../state/stateFiles.js";
import { stateFile } from "../state/statePaths.js";

export const DEFAULT_REFINE_MODEL = "gpt-5.3-codex-spark";

/** Low effort keeps dictation refine fast; Codex reasoning models otherwise default to xhigh. */
export const DEFAULT_REFINE_EFFORT = "low";

export const savedChoiceSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  updatedAt: Schema.Number,
});

export type SavedChoice = Schema.Schema.Type<typeof savedChoiceSchema>;

export const readSavedChoice = (): Option.Option<SavedChoice> =>
  readJsonFile({ path: stateFile("refine-choice.json"), schema: savedChoiceSchema });

export const codexLastGoodModel = (): string =>
  Option.getOrElse(readTextIfPresent(stateFile("refine-codex-last-good.txt")), () => "").trim();

export const codexFailedModels = (): ReadonlySet<string> =>
  new Set(
    Option.getOrElse(readTextIfPresent(stateFile("refine-codex-failed.txt")), () => "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

const writeCodexFailedModels = (failed: ReadonlySet<string>): void =>
  writeFileAtomically({
    path: stateFile("refine-codex-failed.txt"),
    text: [...failed].sort().join("\n") + (failed.size > 0 ? "\n" : ""),
  });

export const markCodexModelFailed = (model: string): void => {
  const failed = codexFailedModels();
  if (model.trim() !== "" && !failed.has(model.trim())) {
    writeCodexFailedModels(new Set([...failed, model.trim()]));
  }
};

/** Remember the pick for the next refine; a Codex model also becomes last-good and loses its failed mark. */
export const saveRefineChoice = (request: {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}): void => {
  const model = request.model.trim();
  if (model === "") {
    return;
  }

  writeJsonAtomically({
    path: stateFile("refine-choice.json"),
    value: {
      provider: request.provider,
      model,
      effort: request.effort || DEFAULT_REFINE_EFFORT,
      updatedAt: Date.now() / 1_000,
    },
  });
  if (request.provider !== "codex") {
    return;
  }

  writeFileAtomically({ path: stateFile("refine-codex-last-good.txt"), text: `${model}\n` });
  const failed = codexFailedModels();
  if (failed.has(model)) {
    writeCodexFailedModels(new Set([...failed].filter((name) => name !== model)));
  }
};
