/** The CLI's only presentation layer: every line printed and every prompt asked goes through here. */

import { Prompt } from "@effect/cli";
import { Terminal } from "@effect/platform";
import { Effect } from "effect";

const display = (text: string) => Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display(text));

const writeLine = (message: string) => display(`${message}\n`);

export const isInteractiveTerminal = Effect.flatMap(Terminal.Terminal, (terminal) => terminal.isTTY);

export const intro = (title: string) => writeLine(`\n  voxkey · ${title}\n`);

export const outro = (message: string) => writeLine(`\n  ${message}\n`);

export const step = (message: string) => writeLine(`  → ${message}`);

export const success = (message: string) => writeLine(`  ✓ ${message}`);

export const warn = (message: string) => writeLine(`  ! ${message}`);

export const fail = (message: string) => writeLine(`  ✗ ${message}`);

export const detail = (message: string) => writeLine(`  · ${message}`);

export const json = (document: unknown) => writeLine(JSON.stringify(document));

/** Exactly this text and a newline, for output other programs read (a refined prompt, rendered speech). */
export const text = (message: string) => writeLine(message);

export const note = (message: string, title?: string) =>
  Effect.gen(function* () {
    if (title !== undefined) {
      yield* writeLine(`\n  ${title}`);
      yield* writeLine(`  ${"─".repeat(Math.min(title.length, 40))}`);
    }
    for (const line of message.split("\n")) {
      yield* writeLine(`  ${line}`);
    }
  });

export const showError = (error: unknown) => fail(error instanceof Error ? error.message : String(error));

// Every prompt answers with its fallback when there is no terminal, so non-TTY runs never block.
export const confirm = (input: { message: string; initialValue: boolean }) =>
  Effect.gen(function* () {
    if (!(yield* isInteractiveTerminal)) {
      return input.initialValue;
    }

    return yield* Prompt.run(Prompt.confirm({ message: input.message, initial: input.initialValue }));
  });

export const selectOne = <Value>(input: {
  message: string;
  choices: ReadonlyArray<{ title: string; value: Value; description?: string }>;
  initial?: Value;
}) =>
  Effect.gen(function* () {
    if (yield* isInteractiveTerminal) {
      return yield* Prompt.run(Prompt.select({ message: input.message, choices: input.choices }));
    }

    const fallback = input.initial === undefined ? input.choices.at(0)?.value : input.initial;
    if (fallback === undefined) {
      return yield* Effect.fail(new Error("No choices available for non-interactive select."));
    }

    return fallback;
  });

export const optionalText = (input: { message: string; fallback: string }) =>
  Effect.gen(function* () {
    if (!(yield* isInteractiveTerminal)) {
      return input.fallback;
    }

    const value = (yield* Prompt.run(Prompt.text({ message: input.message, default: input.fallback }))).trim();
    return value === "" ? input.fallback : value;
  });
