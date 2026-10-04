import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

let home = "";
let sleeper: ChildProcess | undefined;

beforeEach(() => {
  mkdirSync(path.join(repositoryRoot, ".scratch"), { recursive: true });
  home = mkdtempSync(path.join(repositoryRoot, ".scratch", "config-cli-"));
});

// The only process signalled is the stand-in narration worker this test started.
afterEach(() => {
  sleeper?.kill("SIGKILL");
  sleeper = undefined;
  rmSync(home, { recursive: true, force: true });
});

const voxkey = (args: ReadonlyArray<string>) => {
  const { VOXKEY_CONFIG_FILE: _ignored, ...environment } = process.env;
  return spawnSync(process.execPath, ["--import", "tsx", mainScript, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...environment, HOME: home, VOXKEY_HOME: path.join(home, ".voxkey") },
  });
};

describe("voxkey config errors", () => {
  it("go to stderr, so stdout carries only the command's own output", () => {
    const get = voxkey(["config", "get", "no-such-setting"]);

    expect(get.status).toBe(2);
    expect(get.stdout).toBe("");
    expect(get.stderr).toContain('Unknown setting "no-such-setting"');
  });
});

describe("voxkey config set narration-mode off", () => {
  it("stops the reply being read now instead of after it ends", async () => {
    const marker = path.join(home, "stopped");
    const listener = `process.on("SIGUSR2", () => { require("node:fs").writeFileSync(process.argv[1], "stopped"); process.exit(0); }); setInterval(() => {}, 1 << 30);`;
    sleeper = spawn(process.execPath, ["-e", listener, marker, "worker", "narration"], { stdio: "ignore" });
    await new Promise((resolve) => sleeper?.once("spawn", resolve));
    mkdirSync(path.join(home, ".voxkey"));
    writeFileSync(path.join(home, ".voxkey", "narration.pid"), String(sleeper.pid));

    const set = voxkey(["config", "set", "narration-mode", "off"]);

    expect(set.status).toBe(0);
    expect(set.stdout).toContain("Narration stops");
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(marker) && readFileSync(marker, "utf8")).toBe("stopped");
  });
});
