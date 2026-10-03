/** The two background workers (dictation, narration): pid and lock files, spawning, stopping, and reset. */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";

import { removeInboxFiles } from "../narration/inbox.js";
import { readTextIfPresent, removeIfPresent, touchFile } from "../state/stateFiles.js";
import { stateFile, voxkeyHome } from "../state/statePaths.js";
import { readWorkerStatus, writeWorkerStatus } from "./workerStatus.js";

export type WorkerKind = "dictation" | "narration";

type PidFileName = "dictation.pid" | "narration.pid" | "pill.pid";

export class WorkerStartError extends Schema.TaggedError<WorkerStartError>()("WorkerStartError", {
  worker: Schema.String,
  logFile: Schema.String,
  lastLines: Schema.String,
}) {
  get message(): string {
    const tail = this.lastLines === "" ? "" : `\n${this.lastLines}`;
    return `The ${this.worker} worker did not start. See ${this.logFile}.${tail}`;
  }
}

const pidFile = (kind: WorkerKind): PidFileName => (kind === "dictation" ? "dictation.pid" : "narration.pid");

const lockFile = (kind: WorkerKind) =>
  kind === "dictation" ? stateFile("dictation.lock") : stateFile("narration.lock");

const logFile = (kind: WorkerKind) =>
  kind === "dictation" ? stateFile("dictation-worker.log") : stateFile("narration-worker.log");

export const readPid = (name: PidFileName): Option.Option<number> =>
  Option.filter(
    Option.flatMap(readTextIfPresent(stateFile(name)), (text) =>
      Schema.decodeUnknownOption(Schema.NumberFromString)(text.trim()),
    ),
    (pid) => Number.isInteger(pid) && pid > 1,
  );

export const writePid = (name: PidFileName, pid: number): void => {
  mkdirSync(voxkeyHome(), { recursive: true });
  writeFileSync(stateFile(name), String(pid));
};

// A zombie still answers signal 0 until it is reaped, so it is checked by its ps state.
const isZombie = (pid: number): boolean =>
  spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.trim()
    .startsWith("Z");

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
};

export const isWorkerRunning = (kind: WorkerKind): boolean => Option.exists(readPid(pidFile(kind)), isProcessAlive);

const processGroupOf = (pid: number): number =>
  Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());

/** Never signal pid 0 or 1, this process, or this process's own group (the CLI and its shell). */
const isSafeTarget = (pid: number): boolean => pid > 1 && pid !== process.pid && pid !== processGroupOf(process.pid);

/** Signal a process group (workers are group leaders, so their pill and players go too), else the process. */
export const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  if (!isSafeTarget(pid)) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

/**
 * Exclusive create of the lock file is the mutex across spawn races; a lock left by a dead owner is
 * reclaimed. False when another live worker of this kind already runs.
 */
export const claimWorkerLock = (kind: WorkerKind): boolean => {
  mkdirSync(voxkeyHome(), { recursive: true });
  const ownerAlive = () => Option.exists(readPid(pidFile(kind)), (pid) => pid !== process.pid && isProcessAlive(pid));
  if (ownerAlive()) {
    return false;
  }

  const createLock = () => closeSync(openSync(lockFile(kind), "wx", 0o600));
  try {
    createLock();
  } catch {
    if (ownerAlive()) {
      return false;
    }
    removeIfPresent(lockFile(kind));
    createLock();
  }
  writePid(pidFile(kind), process.pid);
  return true;
};

export const releaseWorkerLock = (kind: WorkerKind): void => {
  if (Option.exists(readPid(pidFile(kind)), (pid) => pid === process.pid)) {
    removeIfPresent(stateFile(pidFile(kind)));
  }
  removeIfPresent(lockFile(kind));
};

/** The script that is voxkey's CLI: the built main.js, or main.ts when running from source with tsx. */
const entryScript = (): string => {
  const built = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("../cli/main.ts", import.meta.url));
};

/** How to run voxkey again from here: this Node, its loader flags (tsx in development), and the entry script. */
export const voxkeyInvocation = (): {
  readonly executable: string;
  readonly scriptArguments: ReadonlyArray<string>;
} => ({
  executable: process.execPath,
  scriptArguments: [...process.execArgv, entryScript()],
});

/** Start a worker detached in its own process group, logging to its own file. */
export const spawnWorker = (kind: WorkerKind): void => {
  mkdirSync(voxkeyHome(), { recursive: true });
  const log = openSync(logFile(kind), "a");
  const invocation = voxkeyInvocation();
  const child = spawn(invocation.executable, [...invocation.scriptArguments, "worker", kind], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
};

export const stopRequested = (): boolean => existsSync(stateFile("stop"));

const lastLogLines = (kind: WorkerKind): string =>
  Option.getOrElse(readTextIfPresent(logFile(kind)), () => "")
    .trimEnd()
    .split("\n")
    .slice(-6)
    .join("\n");

const waitUntil = (request: { readonly done: () => boolean; readonly timeoutMs: number }) =>
  Effect.gen(function* () {
    const deadline = Date.now() + request.timeoutMs;
    while (!request.done() && Date.now() < deadline) {
      yield* Effect.sleep("50 millis");
    }
    return request.done();
  });

/** Ask both workers to stop, then force any survivor, and clear their pid, lock, and stop files. */
export const stopWorkers: Effect.Effect<void> = Effect.gen(function* () {
  touchFile(stateFile("stop"));
  const pids = (["dictation", "narration"] as const).flatMap((kind) => Option.toArray(readPid(pidFile(kind))));
  for (const pid of pids) {
    signalGroup(pid, "SIGTERM");
  }
  yield* waitUntil({ done: () => pids.every((pid) => !isProcessAlive(pid)), timeoutMs: 4_000 });
  for (const pid of [...pids, ...Option.toArray(readPid("pill.pid"))]) {
    signalGroup(pid, "SIGKILL");
  }
  for (const name of [
    "dictation.pid",
    "dictation.lock",
    "narration.pid",
    "narration.lock",
    "pill.pid",
    "stop",
  ] as const) {
    removeIfPresent(stateFile(name));
  }
  removeInboxFiles([".speaking"]);
});

const PS_LINE = /^\s*(\d+)\s+(.*)$/u;

/** Every voxkey worker or pill process on this Mac, found by its command line. */
const strayVoxkeyProcesses = (): ReadonlyArray<number> =>
  spawnSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8" })
    .stdout.split("\n")
    .flatMap((line) => {
      const match = PS_LINE.exec(line);
      const args = match?.[2] || "";
      const isWorker = args.includes("voxkey") && / worker (?:dictation|narration)$/u.test(args);
      const isPill = args.includes("osascript -l JavaScript") && args.includes(voxkeyHome());
      return isWorker || isPill ? [Number(match?.[1])] : [];
    });

/** A clean slate: stop the workers, kill any stray voxkey worker or pill, clear every lock, and unmute. */
export const resetWorkers: Effect.Effect<void> = Effect.gen(function* () {
  yield* stopWorkers;
  for (const pid of strayVoxkeyProcesses()) {
    signalGroup(pid, "SIGKILL");
  }
  removeIfPresent(stateFile("narration-muted"));
});

/** Start the dictation worker (which starts narration) and wait until it reports ready or fails. */
export const startWorkers: Effect.Effect<"started" | "already running", WorkerStartError> = Effect.gen(function* () {
  if (isWorkerRunning("dictation")) {
    return "already running";
  }

  removeIfPresent(stateFile("stop"));
  writeWorkerStatus({ stage: "starting", detail: "Loading the dictation model", preview: "", model: "", backend: "" });
  spawnWorker("dictation");
  const spawnedAt = Date.now();
  // Ready once the worker leaves "starting"; failed once it is gone after having had time to start.
  const settled = () =>
    Option.exists(readWorkerStatus(), (status) => status.stage !== "starting") ||
    (Date.now() - spawnedAt > 3_000 && !isWorkerRunning("dictation"));
  yield* waitUntil({ done: settled, timeoutMs: 120_000 });
  const status = readWorkerStatus();
  if (isWorkerRunning("dictation") && Option.exists(status, (current) => current.stage !== "unavailable")) {
    return "started";
  }

  return yield* new WorkerStartError({
    worker: "dictation",
    logFile: logFile("dictation"),
    lastLines:
      Option.getOrElse(
        Option.map(status, (current) => current.detail),
        () => "",
      ) || lastLogLines("dictation"),
  });
});

/** Start the narration worker unless it already runs; the dictation worker calls this at startup. */
export const startNarrationWorker = (): void => {
  if (!isWorkerRunning("narration")) {
    spawnWorker("narration");
  }
};

/** The last bytes of a worker's log, for `voxkey status` and failures. */
export const workerLogFile = (kind: WorkerKind): string => logFile(kind);
