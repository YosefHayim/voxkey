/** Where voxkey keeps its files: one folder in HOME (default ~/.voxkey) for config, state, models, and logs. */

import { homedir } from "node:os";
import path from "node:path";

import { readEnvironment } from "../config/environmentVariables.js";

export const stateFileNames = [
  "status.json",
  "seen.json",
  "dictation.pid",
  "dictation.lock",
  "narration.pid",
  "narration.lock",
  "pill.pid",
  "narration-muted",
  "stop",
  "dictation.log",
  "dictation-worker.log",
  "narration-worker.log",
  "refine-choice.json",
  "refine-codex-last-good.txt",
  "refine-codex-failed.txt",
] as const;

export type StateFileName = (typeof stateFileNames)[number];

export type StateFolderName = "inbox" | "failed" | "models" | "backups" | "audio" | "prompts" | "devin";

export const voxkeyHome = (): string => {
  const override = readEnvironment().VOXKEY_HOME;
  return override === "" ? path.join(homedir(), ".voxkey") : path.resolve(override);
};

export const configFilePath = (): string => {
  const override = readEnvironment().VOXKEY_CONFIG_FILE;
  return override === "" ? path.join(voxkeyHome(), "config.json") : path.resolve(override);
};

export const stateFile = (name: StateFileName): string => path.join(voxkeyHome(), name);

export const stateFolder = (name: StateFolderName): string => path.join(voxkeyHome(), name);
