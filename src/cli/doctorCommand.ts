/** `voxkey doctor [--json]`: check the Mac, the native modules, the tools, the models, the permissions, and the hooks. */

import { Command, Options } from "@effect/cli";
import { Effect, Schema } from "effect";

import { runDoctorChecks } from "../doctor/doctorChecks.js";
import * as TerminalUI from "./TerminalUI.js";

class DoctorChecksFailed extends Schema.TaggedError<DoctorChecksFailed>()("DoctorChecksFailed", {
  failed: Schema.Number,
}) {
  get message(): string {
    return `${String(this.failed)} check(s) failed.`;
  }
}

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

export const doctorCommand = Command.make("doctor", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const checks = yield* runDoctorChecks;
    if (args.json) {
      yield* TerminalUI.json(checks);
    } else {
      yield* TerminalUI.intro("doctor");
      yield* Effect.forEach(checks, (check) => {
        switch (check.status) {
          case "ok":
            return TerminalUI.success(`${check.name}: ${check.detail}`);
          case "warn":
            return TerminalUI.warn(`${check.name}: ${check.detail} — ${check.fix || ""}`);
          case "fail":
            return TerminalUI.fail(`${check.name}: ${check.detail} — ${check.fix || ""}`);
        }
      });
    }
    const failed = checks.filter((check) => check.status === "fail").length;
    if (failed > 0) {
      return yield* new DoctorChecksFailed({ failed });
    }
  }),
).pipe(Command.withDescription("Check macOS, native modules, system tools, models, permissions, and agent hooks"));
