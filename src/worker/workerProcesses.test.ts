import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isWorkerRunning, stopWorkers } from "./workerProcesses.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let home = "";
const started: Array<ChildProcess> = [];

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
  home = mkdtempSync(path.join(scratchRoot, "workers-"));
  process.env.VOXKEY_HOME = home;
});

// Only processes this test started are ever signalled, here or by voxkey.
afterEach(() => {
  for (const child of started.splice(0)) {
    child.kill("SIGKILL");
  }
  delete process.env.VOXKEY_HOME;
  rmSync(home, { recursive: true, force: true });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A sleeping Node process whose command line ends with `trailing`, e.g. ["worker", "dictation"]. */
const startSleeper = async (trailing: ReadonlyArray<string>): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", ...trailing], {
    stdio: "ignore",
    detached: true,
  });
  started.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child.pid || 0;
};

const writePidFile = (name: string, pid: number) => writeFileSync(path.join(home, name), String(pid));

const eventually = async (check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 3_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

describe("worker pid files", () => {
  it("trust a pid only while it still runs that worker's command line (a pid reused after a reboot is not a worker)", async () => {
    writePidFile("dictation.pid", process.pid);
    expect(isWorkerRunning("dictation")).toBe(false);

    const worker = await startSleeper(["worker", "dictation"]);
    writePidFile("dictation.pid", worker);
    writePidFile("narration.pid", worker);
    expect(await eventually(() => isWorkerRunning("dictation"))).toBe(true);
    expect(isWorkerRunning("narration")).toBe(false);
  });

  it("stopWorkers never signals a process its pid file does not name, and stops one it does", async () => {
    const stranger = await startSleeper([]);
    for (const name of ["dictation.pid", "pill.pid"]) {
      writePidFile(name, stranger);
    }
    const narration = await startSleeper(["worker", "narration"]);
    writePidFile("narration.pid", narration);
    await eventually(() => isWorkerRunning("narration"));

    await Effect.runPromise(stopWorkers);

    expect(await eventually(() => !isAlive(narration))).toBe(true);
    expect(isAlive(stranger)).toBe(true);
    expect(existsSync(path.join(home, "dictation.pid"))).toBe(false);
  });
});
