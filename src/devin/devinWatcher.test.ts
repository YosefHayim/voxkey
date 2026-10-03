import { describe, expect, it } from "vitest";

import { latestDevinTurn } from "./devinWatcher.js";

describe("latestDevinTurn", () => {
  it("joins the agent messages after the latest user step and names the turn by the last agent step", () => {
    expect(
      latestDevinTurn({
        steps: [
          { step_id: "old-user", source: "user", message: "Earlier request" },
          { step_id: "old-agent", source: "agent", message: "Earlier answer" },
          { step_id: "new-user", source: "user", message: "Current request" },
          { step_id: "new-agent-1", source: "agent", message: "First part" },
          { step_id: "tool", source: "tool", message: "ignored" },
          { step_id: "new-agent-2", source: "agent", message: "Second part" },
          { step_id: "blank", source: "agent", message: "  " },
        ],
      }),
    ).toEqual({ markdown: "First part\n\nSecond part", turnId: "new-agent-2" });
  });

  it("has no turn before the agent answers", () => {
    expect(latestDevinTurn({ steps: [{ step_id: "u", source: "user", message: "hi" }] })).toEqual({
      markdown: "",
      turnId: "",
    });
  });
});
