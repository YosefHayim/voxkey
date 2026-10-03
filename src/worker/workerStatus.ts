/** `status.json`: the dictation worker's stage, read by the pill every 80 ms and by `voxkey status`. */

import { Option, Schema } from "effect";
import { readJsonFile, writeJsonAtomically } from "../state/stateFiles.js";
import { stateFile } from "../state/statePaths.js";

export const dictationStageSchema = Schema.Literal(
  "starting",
  "inactive",
  "listening",
  "finishing",
  "refining",
  "done",
  "unavailable",
);

export type DictationStage = Schema.Schema.Type<typeof dictationStageSchema>;

export const workerStatusSchema = Schema.Struct({
  stage: dictationStageSchema,
  detail: Schema.String.annotations({ description: "Short text for the pill and `voxkey status`." }),
  preview: Schema.String.annotations({ description: "Live caption while Shift is held; never typed." }),
  model: Schema.String,
  backend: Schema.String,
  updatedAt: Schema.Number,
});

export type WorkerStatus = Schema.Schema.Type<typeof workerStatusSchema>;

export const readWorkerStatus = (): Option.Option<WorkerStatus> =>
  readJsonFile({ path: stateFile("status.json"), schema: workerStatusSchema });

export const writeWorkerStatus = (status: Omit<WorkerStatus, "updatedAt">): void =>
  writeJsonAtomically({ path: stateFile("status.json"), value: { ...status, updatedAt: Date.now() / 1_000 } });

/** Status writes for the loaded model, so callers pass only the stage and the detail. */
export const makeStatusWriter = (request: { readonly model: string; readonly backend: string }) => ({
  write: (stage: DictationStage, detail: string) => writeWorkerStatus({ ...request, stage, detail, preview: "" }),
  writePreview: (caption: string) =>
    writeWorkerStatus({ ...request, stage: "listening", detail: "", preview: caption }),
  stage: (): Option.Option<DictationStage> => Option.map(readWorkerStatus(), (status) => status.stage),
});

export type StatusWriter = ReturnType<typeof makeStatusWriter>;

/** The mic is open while the worker is starting or listening, so narration waits. */
export const dictationOwnsAudio = (): boolean =>
  Option.exists(readWorkerStatus(), (status) => status.stage === "starting" || status.stage === "listening");
