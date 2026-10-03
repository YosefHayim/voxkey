/** Timestamped lines in ~/.voxkey/dictation.log: decode, refine, and typing timings for every hold. */

import { appendFileSync, mkdirSync } from "node:fs";

import { stateFile, voxkeyHome } from "../state/statePaths.js";

/** Logging must never take a worker down, so a failed write is dropped. */
export const appendDictationLog = (line: string): void => {
  try {
    mkdirSync(voxkeyHome(), { recursive: true });
    appendFileSync(stateFile("dictation.log"), `${(Date.now() / 1_000).toFixed(3)} ${line}\n`);
  } catch {
    // A full disk or a removed folder only costs this one log line.
  }
};
