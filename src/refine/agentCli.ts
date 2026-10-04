/** Finding and running agent CLIs (codex, claude, grok, …) with argument arrays and a hard timeout. */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

export const cliRunSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

export type CliRun = Schema.Schema.Type<typeof cliRunSchema>;

export class CliRunError extends Schema.TaggedError<CliRunError>()("CliRunError", {
  executable: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `${path.basename(this.executable)}: ${this.issue}`;
  }
}

// GUI launchers and agent hooks often start with a minimal PATH that hides user-local CLIs.
const extraBinFolders = (): ReadonlyArray<string> => {
  const home = homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".grok", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, "Library", "pnpm", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "share", "pnpm", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
};

/** PATH for child processes: the inherited PATH followed by the usual user and Homebrew bin folders. */
export const searchPath = (): string =>
  [...new Set([...(process.env.PATH || "/usr/bin:/bin").split(":"), ...extraBinFolders()])]
    .filter((folder) => folder !== "")
    .join(":");

const isExecutableFile = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const findCli = (name: string): Option.Option<string> =>
  Option.fromNullable(
    searchPath()
      .split(":")
      .map((folder) => path.join(folder, name))
      .find(isExecutableFile),
  );

/** The first of `names` that is installed, e.g. `gemini` before `agy`. */
export const findFirstCli = (
  names: ReadonlyArray<string>,
): Option.Option<{ readonly name: string; readonly path: string }> =>
  Option.firstSomeOf(names.map((name) => Option.map(findCli(name), (found) => ({ name, path: found }))));

/**
 * Run a CLI with stdin closed (several agent CLIs block on "reading additional input from stdin"
 * when a pipe is inherited), from HOME, with colors off, killed after `timeoutMs`.
 */
export const runCli = (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
}): Effect.Effect<CliRun, CliRunError> =>
  Effect.async<CliRun, CliRunError>((resume) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: homedir(),
      env: { ...process.env, ...request.environment, NO_COLOR: "1", PATH: searchPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resume(Effect.fail(new CliRunError({ executable: request.executable, issue: "timed out" })));
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(Effect.fail(new CliRunError({ executable: request.executable, issue: error.message })));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resume(
        Effect.succeed({
          exitCode: code === null ? 1 : code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

/** Trimmed stdout, else trimmed stderr. */
export const cliOutputText = (run: CliRun): string => run.stdout.trim() || run.stderr.trim();

/** Both streams of a failed run, stderr first: partial stdout must never hide the error that explains the exit. */
export const cliFailureText = (run: CliRun): string =>
  [run.stderr.trim(), run.stdout.trim()].filter((text) => text !== "").join("\n");

/** Non-blank lines of stdout and stderr; a CLI that is missing, fails to start, or times out has none. */
export const runCliLines = (request: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): Effect.Effect<ReadonlyArray<string>> =>
  runCli(request).pipe(
    Effect.map((run) =>
      `${run.stdout}\n${run.stderr}`
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
    Effect.orElseSucceed(() => []),
  );

/** Stripped, non-empty names in first-seen order. */
export const dedupe = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(names.map((name) => name.trim()))].filter((name) => name !== "");
