import { describe, expect, it } from "vitest";

import {
  classifyTap,
  debounceShift,
  doubleTapAction,
  type HoldAction,
  type HoldEvent,
  type HoldState,
  holdTransition,
  initialShiftDebounce,
  newlyPressed,
} from "./holdKey.js";

const replay = (events: ReadonlyArray<HoldEvent>) =>
  events.reduce<readonly [HoldState, HoldAction]>(([state], event) => holdTransition(state, event), ["idle", "none"]);

type HoldCase = {
  readonly name: string;
  readonly events: ReadonlyArray<HoldEvent>;
  readonly state: HoldState;
  readonly action: HoldAction;
};

const holdCases: ReadonlyArray<HoldCase> = [
  { name: "Shift down schedules the hold", events: ["shiftDown"], state: "waiting", action: "schedule" },
  { name: "a long hold starts listening", events: ["shiftDown", "holdElapsed"], state: "listening", action: "start" },
  { name: "a short press is a tap", events: ["shiftDown", "shiftUp"], state: "idle", action: "tap" },
  { name: "typing a capital letter cancels", events: ["shiftDown", "otherDown"], state: "shortcut", action: "cancel" },
  {
    name: "releasing after a cancel does nothing",
    events: ["shiftDown", "otherDown", "shiftUp"],
    state: "idle",
    action: "none",
  },
  {
    name: "a key pressed while listening drops the clip",
    events: ["shiftDown", "holdElapsed", "otherDown"],
    state: "shortcut",
    action: "cancel",
  },
  {
    name: "releasing while listening stops and keeps the clip",
    events: ["shiftDown", "holdElapsed", "shiftUp"],
    state: "idle",
    action: "stop",
  },
  { name: "a stray hold timer while idle does nothing", events: ["holdElapsed"], state: "idle", action: "none" },
];

describe("holdTransition", () => {
  it.each(holdCases)("$name", ({ events, state, action }) => {
    expect(replay(events)).toEqual([state, action]);
  });
});

describe("newlyPressed", () => {
  const stuckKey = 1n;
  const letter = 1n << 12n;

  it("ignores a key held before Shift went down", () => {
    expect(newlyPressed(stuckKey, stuckKey)).toBe(false);
  });

  it("counts a new key pressed while Shift is held", () => {
    expect(newlyPressed(stuckKey, stuckKey | letter)).toBe(true);
  });

  it("sees no typing when no key is held", () => {
    expect(newlyPressed(0n, 0n)).toBe(false);
  });
});

describe("debounceShift", () => {
  const run = (samples: ReadonlyArray<boolean>) => {
    let debounce = initialShiftDebounce;
    const edges: Array<string> = [];
    for (const sample of samples) {
      const [next, edge] = debounceShift(debounce, sample ? "down" : "up");
      debounce = next;
      edges.push(edge);
    }
    return edges.filter((edge) => edge !== "none");
  };

  it("reports Shift down after two samples and up after four", () => {
    expect(run([true, true, true, false, false, false, false])).toEqual(["shiftDown", "shiftUp"]);
  });

  it("ignores a one-sample blip in either direction", () => {
    expect(run([true, false, false, false, false])).toEqual([]);
    expect(run([true, true, false, true, true, false, false, false, false])).toEqual(["shiftDown", "shiftUp"]);
  });
});

describe("taps", () => {
  it("treats a second tap within 400 ms as a double tap", () => {
    expect(classifyTap({ lastTapAt: 1_000, now: 1_300 })).toEqual({ double: true, rememberedTapAt: undefined });
    expect(classifyTap({ lastTapAt: 1_000, now: 1_500 })).toEqual({ double: false, rememberedTapAt: 1_500 });
    expect(classifyTap({ lastTapAt: undefined, now: 10 })).toEqual({ double: false, rememberedTapAt: 10 });
  });

  it("stops speech first, then refines the clipboard, else toggles the mute", () => {
    expect(doubleTapAction({ narrationSpeaking: true, clipboardRefine: true })).toBe("stopNarration");
    expect(doubleTapAction({ narrationSpeaking: false, clipboardRefine: true })).toBe("refineClipboard");
    expect(doubleTapAction({ narrationSpeaking: false, clipboardRefine: false })).toBe("toggleMute");
  });
});
