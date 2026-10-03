import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { defaultConfig } from "../config/configSchema.js";
import { hooksPath } from "../install/installPaths.js";
import {
  isTtsNarrationEnabled,
  narratingSpeechMode,
  nextVoiceFeatures,
  normalizeVoiceId,
  reloadVoiceWorker,
  stopNarration,
} from "./voiceWorker.js";

// A stand-in executable that logs `<name> <args>` and exits with `exitCode`.
const writeFakeExecutable = (request: { path: string; name: string; log: string; exitCode: number }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(request.path), { recursive: true });
    yield* fileSystem.writeFileString(
      request.path,
      `#!/bin/sh\necho "${request.name} $*" >> "${request.log}"\nexit ${String(request.exitCode)}\n`,
    );
    yield* fileSystem.chmod(request.path, 0o755);
  });

// An install root with a fake voice worker, and a failing `uv` first on PATH so a test sees whether uv was asked for.
const makeVoiceRoot = (request: { readonly workerInstalled: boolean; readonly workerExitCode: number }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dufflebag-voice-worker-" });
    const log = path.join(root, "calls.log");
    if (request.workerInstalled) {
      const worker = path.join(root, hooksPath, "voice", "dufflebag-voice");
      yield* writeFakeExecutable({ path: worker, name: "worker", log, exitCode: request.workerExitCode });
    }
    yield* writeFakeExecutable({ path: path.join(root, "bin", "uv"), name: "uv", log, exitCode: 1 });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previousPath = process.env.PATH;
        process.env.PATH = `${path.join(root, "bin")}:${previousPath}`;
        return previousPath;
      }),
      (previousPath) =>
        Effect.sync(() => {
          process.env.PATH = previousPath;
        }),
    );
    const calls = fileSystem.readFileString(log).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed(() => []),
    );
    return { root, calls };
  });

describe("nextVoiceFeatures", () => {
  it.each([
    {
      current: ["duplicate-code-guard", "context-guard"],
      enabled: true,
      next: ["context-guard", "voice", "duplicate-code-guard"],
    },
    { current: ["context-guard", "voice"], enabled: true, next: ["context-guard", "voice"] },
    {
      current: ["context-guard", "voice", "duplicate-code-guard"],
      enabled: false,
      next: ["context-guard", "duplicate-code-guard"],
    },
  ])("keeps catalog order and toggles only voice ($enabled)", ({ current, enabled, next }) => {
    expect(nextVoiceFeatures({ current, enabled })).toEqual(next);
  });
});

describe("normalizeVoiceId", () => {
  it.each([
    ["m2", "M2"],
    ["Samantha", "F4"],
    ["", "F4"],
  ])("keeps Supertonic IDs and maps anything else to F4: %j → %s", (voice, normalized) => {
    expect(normalizeVoiceId(voice)).toBe(normalized);
  });
});

describe("isTtsNarrationEnabled", () => {
  it.each([
    ["off", false],
    ["auto", true],
    ["immediate", true],
  ] as const)("speech-mode %s narrates: %s", (mode, enabled) => {
    expect(isTtsNarrationEnabled(mode)).toBe(enabled);
  });
});

describe("narratingSpeechMode", () => {
  it.each([
    ["off", "auto"],
    ["auto", "auto"],
    ["immediate", "immediate"],
  ] as const)("tts on turns speech-mode %s into %s", (mode, next) => {
    expect(narratingSpeechMode(mode)).toBe(next);
  });
});

layer(NodeContext.layer)("reloadVoiceWorker", (it) => {
  it.scoped("restarts the worker without asking for uv while narration is off", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceRoot({ workerInstalled: true, workerExitCode: 0 });

      const reloaded = yield* reloadVoiceWorker({ root: voice.root, config: { ...defaultConfig, speechMode: "off" } });

      expect(reloaded).toBe(true);
      expect(yield* voice.calls).toEqual(["worker prepare", "worker stop", "worker start"]);
    }),
  );

  it.scoped("requires uv before touching the worker while narration is on", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceRoot({ workerInstalled: true, workerExitCode: 0 });

      const failure = yield* Effect.flip(
        reloadVoiceWorker({ root: voice.root, config: { ...defaultConfig, speechMode: "auto" } }),
      );

      expect(failure.message).toBe("uv exited with status 1.");
      expect(yield* voice.calls).toEqual(["uv --version"]);
    }),
  );

  it.scoped("returns false when voice is not installed", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceRoot({ workerInstalled: false, workerExitCode: 0 });

      expect(yield* reloadVoiceWorker({ root: voice.root, config: defaultConfig })).toBe(false);
      expect(yield* voice.calls).toEqual([]);
    }),
  );
});

layer(NodeContext.layer)("stopNarration", (it) => {
  it.scoped("asks the installed worker to stop narration only", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceRoot({ workerInstalled: true, workerExitCode: 0 });

      expect(yield* stopNarration(voice.root)).toBe(true);
      expect(yield* voice.calls).toEqual(["worker stop-narration"]);
    }),
  );

  it.scoped.each([
    { case: "the worker fails", workerInstalled: true, workerExitCode: 1 },
    { case: "voice is not installed", workerInstalled: false, workerExitCode: 0 },
  ])("returns false when $case", ({ workerInstalled, workerExitCode }) =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceRoot({ workerInstalled, workerExitCode });

      expect(yield* stopNarration(voice.root)).toBe(false);
    }),
  );
});
