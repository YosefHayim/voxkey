/** Turn the local voice worker on and off: install or remove the voice feature, then drive the worker binary. */

import { FileSystem, Path, Command as PlatformCommand } from "@effect/platform";
import { Effect, Option, Schema } from "effect";

import { featureCatalog } from "../catalog/featureCatalog.js";
import { type Config, configSchema, decodeConfig } from "../config/configSchema.js";
import { readConfig, resolveConfigTarget, saveConfig } from "../config/configSettings.js";
import { install } from "../install/install.js";
import { hooksPath, receiptPath } from "../install/installPaths.js";
import { preparePackage } from "../install/preparePackage.js";
import { readReceipt, type Scope } from "../install/receipt.js";
import { update } from "../install/update.js";

const voiceFeatureId = "voice";

type ScopeConfig = Effect.Effect.Success<ReturnType<typeof readConfig>>;

class VoiceWorkerError extends Schema.TaggedError<VoiceWorkerError>()("VoiceWorkerError", {
  issue: Schema.NonEmptyString,
}) {
  get message(): string {
    return this.issue;
  }
}

export const nextVoiceFeatures = (selection: { current: ReadonlyArray<string>; enabled: boolean }) =>
  featureCatalog
    .map((feature) => feature.id)
    .filter((id) => (id === voiceFeatureId ? selection.enabled : selection.current.includes(id)));

export const normalizeVoiceId = (voice: string): string =>
  /^[MF][1-5]$/i.test(voice.trim()) ? voice.trim().toUpperCase() : "F4";

export const isTtsNarrationEnabled = (mode: Config["speechMode"]): boolean => mode !== "off";

/** `tts on` wakes speech-mode from off to auto and keeps a mode that already narrates. */
export const narratingSpeechMode = (mode: Config["speechMode"]): Config["speechMode"] =>
  isTtsNarrationEnabled(mode) ? mode : "auto";

// Effect Command inherits process.env only when extendEnv is set; voice needs PATH so Homebrew's `uv` resolves.
export const withProcessEnv = (command: PlatformCommand.Command) => PlatformCommand.env(command, process.env);

export const inheritedCommand = (executable: string, args: ReadonlyArray<string>) =>
  withProcessEnv(
    PlatformCommand.make(executable, ...args).pipe(
      PlatformCommand.stdin("inherit"),
      PlatformCommand.stdout("inherit"),
      PlatformCommand.stderr("inherit"),
    ),
  );

const requireSuccess = (command: PlatformCommand.Command, label: string) =>
  PlatformCommand.exitCode(command).pipe(
    Effect.mapError((error) => new VoiceWorkerError({ issue: `${label} could not start: ${error.message}` })),
    Effect.filterOrFail(
      (code) => code === 0,
      (code) => new VoiceWorkerError({ issue: `${label} exited with status ${String(code)}.` }),
    ),
    Effect.asVoid,
  );

/** Run a command on the user's terminal and fail unless it exits 0. */
export const runCommand = (invocation: { executable: string; args: ReadonlyArray<string>; label: string }) =>
  requireSuccess(inheritedCommand(invocation.executable, invocation.args), invocation.label);

// Suspended so the lookup uses PATH as it is when the check runs.
const requireUv = Effect.suspend(() => requireSuccess(withProcessEnv(PlatformCommand.make("uv", "--version")), "uv"));

const installedWorker = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worker = path.join(root, hooksPath, "voice", "dufflebag-voice");
    return (yield* fileSystem.exists(worker)) ? Option.some(worker) : Option.none();
  });

export const requireInstalledVoice = (root: string) =>
  Effect.gen(function* () {
    const worker = yield* installedWorker(root);
    if (Option.isNone(worker)) {
      return yield* new VoiceWorkerError({
        issue:
          "Voice is not installed here (missing dufflebag-voice). Run `dufflebag stt on` or `dufflebag voice on` first.",
      });
    }

    return worker.value;
  });

export const isVoiceInstalled = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const snapshot = yield* readReceipt(path.join(root, receiptPath));
    return snapshot._tag === "present" && snapshot.receipt.features.some((feature) => feature === voiceFeatureId);
  });

// Supertonic's TTS server runs under uv, so uv is required only while narration is on.
const restartWorker = (request: { readonly worker: string; readonly config: Config }) =>
  Effect.gen(function* () {
    if (isTtsNarrationEnabled(request.config.speechMode)) {
      yield* requireUv;
    }
    yield* runCommand({ executable: request.worker, args: ["prepare"], label: "Voice preparation" });
    yield* runCommand({ executable: request.worker, args: ["stop"], label: "Previous voice worker" });
    yield* runCommand({ executable: request.worker, args: ["start"], label: "Voice worker" });
  });

/**
 * Install voice with `target.config` as config.json, then restart the workers.
 * The config is written before the restart because `prepare` and `start` read speechMode from disk.
 */
export const turnVoiceOn = (target: ScopeConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const snapshot = yield* readReceipt(path.join(target.destination.root, receiptPath));
    const current = snapshot._tag === "present" ? snapshot.receipt.features : [];
    const config = { ...target.config, speechVoice: normalizeVoiceId(target.config.speechVoice) };
    const request = {
      destination: target.destination,
      host: { homeRoot: target.host.homeRoot },
      preparedPackage: yield* preparePackage,
      features: { _tag: "selected" as const, ids: nextVoiceFeatures({ current, enabled: true }) },
      agents: { _tag: "detected" as const, evidence: target.host.agentEvidence },
      interaction: { _tag: "scripted" as const },
      configuration: { _tag: "selected" as const, config },
    };
    if (snapshot._tag === "present") {
      yield* update(request);
    } else {
      yield* install(request);
    }

    yield* restartWorker({ worker: yield* requireInstalledVoice(target.destination.root), config });
  });

/** Restart the installed worker so it loads a new model or language; false when voice is not installed. */
export const reloadVoiceWorker = (request: { readonly root: string; readonly config: Config }) =>
  Effect.gen(function* () {
    const worker = yield* installedWorker(request.root);
    if (Option.isNone(worker)) {
      return false;
    }

    yield* restartWorker({ worker: worker.value, config: request.config });
    return true;
  });

/** Stop narration and the TTS server, leaving dictation running; false when voice is not installed or the stop failed. */
export const stopNarration = (root: string) =>
  Effect.gen(function* () {
    const worker = yield* installedWorker(root);
    if (Option.isNone(worker)) {
      return false;
    }

    const stopNarrationCommand = withProcessEnv(PlatformCommand.make(worker.value, "stop-narration"));
    return (yield* PlatformCommand.exitCode(stopNarrationCommand).pipe(Effect.orElseSucceed(() => 1))) === 0;
  });

// `reset` kills the workers, overlays, and TTS and clears the pid locks, which a soft stop leaves behind.
const resetWorker = (root: string) =>
  Effect.gen(function* () {
    const worker = yield* installedWorker(root);
    if (Option.isSome(worker)) {
      yield* runCommand({ executable: worker.value, args: ["reset"], label: "Voice worker" });
    }
  });

const removeVoiceFiles = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.remove(path.join(root, hooksPath, "voice"), { recursive: true, force: true });
  });

/** Stop the worker and remove only the voice feature. */
export const turnVoiceOff = (scope: Scope) =>
  Effect.gen(function* () {
    const target = yield* resolveConfigTarget(scope);
    const root = target.destination.root;
    const path = yield* Path.Path;
    // Kill the workers first so no hook keeps a live process around.
    yield* resetWorker(root);

    const snapshot = yield* readReceipt(path.join(root, receiptPath));
    if (snapshot._tag === "missing" || !snapshot.receipt.features.some((feature) => feature === voiceFeatureId)) {
      // Already deselected, but an upgrade can leave orphan voice files (or a stale binary) behind.
      yield* removeVoiceFiles(root);
      return { alreadyOff: true };
    }

    yield* update({
      destination: target.destination,
      host: { homeRoot: target.host.homeRoot },
      preparedPackage: yield* preparePackage,
      features: { _tag: "selected", ids: nextVoiceFeatures({ current: snapshot.receipt.features, enabled: false }) },
      agents: { _tag: "detected", evidence: target.host.agentEvidence },
      interaction: { _tag: "scripted" },
      configuration: { _tag: "automatic" },
    });
    // A Stop hook can race the update and respawn a worker while the binary still exists.
    yield* resetWorker(root);
    // The receipt restores only receipted paths; an upgrade can leave files it never listed (e.g. dufflebag-voice).
    yield* removeVoiceFiles(root);
    return { alreadyOff: false };
  });

const configsEqual = Schema.equivalence(configSchema);

/** Save voice settings without changing the feature selection; an unchanged config is not rewritten. */
export const saveVoiceSettings = (request: { readonly scope: Scope; readonly settings: Partial<Config> }) =>
  Effect.gen(function* () {
    const { config, ...target } = yield* readConfig(request.scope);
    const nextConfig = yield* decodeConfig({ ...config, ...request.settings });
    if (configsEqual(config, nextConfig)) {
      return { ...target, config, changed: false };
    }

    yield* saveConfig({ target, configuration: { _tag: "selected", config: nextConfig } });
    return { ...target, config: nextConfig, changed: true };
  });
