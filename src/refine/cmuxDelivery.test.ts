import { describe, expect, it } from "vitest";

import { expandCommandTemplate, shellSingleQuote, surfaceParams, workspaceTitle } from "./cmuxDelivery.js";

describe("cmux delivery", () => {
  it("quotes apostrophes for a single-quoted shell string", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it("expands the command template placeholders", () => {
    expect(
      expandCommandTemplate({
        template: 'cd {{cwd}} && codex --yolo -- "$(cat {{prompt_file}})" {{prompt}}',
        prompt: "it's",
        promptFile: "/x/p.txt",
        folder: "/cwd",
      }),
    ).toBe(`cd /cwd && codex --yolo -- "$(cat /x/p.txt)" 'it'\\''s'`);
  });

  it("addresses a surface by ref or by ID", () => {
    expect(surfaceParams("surface:3", { key: "enter" })).toEqual({ surface_ref: "surface:3", key: "enter" });
    expect(surfaceParams("ab-12", {})).toEqual({ surface_id: "ab-12" });
  });

  it("titles a new workspace with the first line of the prompt", () => {
    expect(workspaceTitle("Fix the login bug\nand more")).toBe("refine: Fix the login bug");
    expect(workspaceTitle("")).toBe("refine");
  });
});
