/** The one failure that means "the command line was wrong", which main.ts maps to exit code 2. */

import { Schema } from "effect";

export class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  issue: Schema.NonEmptyString,
}) {
  get message(): string {
    return this.issue;
  }
}
