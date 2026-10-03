import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const checkerPath = path.resolve("src/scripts/checkPythonNames.py");

const createPythonRepository = (source: string): string => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "dufflebag-python-names-"));
  temporaryRoots.push(repositoryRoot);
  const sourceRoot = path.join(repositoryRoot, "src");
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, "example.py"), source);
  return repositoryRoot;
};

const checkPythonRepository = (repositoryRoot: string) =>
  spawnSync("uv", ["run", "--python", "3.10", checkerPath, repositoryRoot], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

afterEach(() => {
  for (const repositoryRoot of temporaryRoots.splice(0)) rmSync(repositoryRoot, { recursive: true, force: true });
});

describe("Python declaration names", () => {
  it("accepts names that state their domain job", () => {
    const execution = checkPythonRepository(
      createPythonRepository("def render_receipt(receipt):\n    return receipt\n"),
    );
    expect(execution.status).toBe(0);
    expect(execution.stdout).toContain("domain-specific names");
  });

  it("rejects a forbidden token in a declaration", () => {
    const execution = checkPythonRepository(
      createPythonRepository("def parse_payload(payload):\n    return payload\n"),
    );
    expect(execution.status).toBe(1);
    expect(execution.stdout).toContain('Rename "parse_payload"');
    expect(execution.stdout).toContain('Rename "payload"');
  });
});
