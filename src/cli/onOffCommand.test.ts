import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const mainScript = path.join(repositoryRoot, "src", "cli", "main.ts");

let home = "";

const claudeSettings =
  '{\n  // keep this comment\n  "model": "opus",\n  "hooks": {\n    "Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]\n  }\n}\n';

const codexHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"guard"}]}]}}\n';

beforeEach(() => {
  mkdirSync(path.join(repositoryRoot, ".scratch"), { recursive: true });
  home = mkdtempSync(path.join(repositoryRoot, ".scratch", "on-off-"));
  mkdirSync(path.join(home, ".claude"));
  mkdirSync(path.join(home, ".codex"));
  mkdirSync(path.join(home, ".grok"));
  writeFileSync(path.join(home, ".claude", "settings.json"), claudeSettings);
  writeFileSync(path.join(home, ".codex", "hooks.json"), codexHooks);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const voxkey = (args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--import", "tsx", mainScript, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home, VOXKEY_HOME: path.join(home, ".voxkey") },
  });

const read = (relative: string) => readFileSync(path.join(home, relative), "utf8");

describe("voxkey on --hooks-only and voxkey off in a scratch HOME", () => {
  it("adds one reply hook per installed agent, backs files up, and removes exactly what it added", () => {
    const on = voxkey(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(read(".claude/settings.json")).toContain("// keep this comment");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".grok/hooks/voxkey.json")).toContain("reply --agent grok");
    expect(readdirSync(path.join(home, ".voxkey", "backups"))).toHaveLength(2);

    const again = voxkey(["on", "--hooks-only"]);
    expect(again.stdout).toContain("already registered");
    expect(read(".claude/settings.json").match(/reply --agent claude-code/gu)).toHaveLength(1);

    const status = JSON.parse(voxkey(["status", "--json"]).stdout);
    expect(status.hooks).toEqual(["claude-code", "codex", "grok"]);

    const off = voxkey(["off"]);
    expect(off.status).toBe(0);
    expect(read(".claude/settings.json")).toBe(claudeSettings);
    expect(read(".codex/hooks.json")).toBe(codexHooks);
    expect(existsSync(path.join(home, ".grok", "hooks", "voxkey.json"))).toBe(false);
  });

  it("deletes a settings file voxkey created once it is empty again, and keeps an empty file that was there before", () => {
    rmSync(path.join(home, ".codex", "hooks.json"));
    rmSync(path.join(home, ".claude", "settings.json"));
    writeFileSync(path.join(home, ".grok", "other.json"), "{}\n");

    expect(voxkey(["on", "--hooks-only"]).status).toBe(0);
    expect(read(".codex/hooks.json")).toContain("reply --agent codex");
    expect(read(".claude/settings.json")).toContain("reply --agent claude-code");

    expect(voxkey(["off"]).status).toBe(0);
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
    expect(read(".grok/other.json")).toBe("{}\n");

    writeFileSync(path.join(home, ".codex", "hooks.json"), "{}\n");
    expect(voxkey(["on", "--hooks-only"]).status).toBe(0);
    expect(voxkey(["off"]).status).toBe(0);
    expect(read(".codex/hooks.json")).toBe("{}\n");
  });

  it("skips agents that are not installed and leaves a broken settings file alone", () => {
    rmSync(path.join(home, ".grok"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "hooks.json"), "{ not json");

    const on = voxkey(["on", "--hooks-only"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("Grok: not installed, skipped");
    expect(on.stdout).toContain("left unchanged");
    expect(read(".codex/hooks.json")).toBe("{ not json");
  });
});
