/** `voxkey devin`: queue each finished Devin turn from its official ATIF export for narration. */

import { Effect, Option, Schema } from "effect";

import { queueReply } from "../narration/inbox.js";
import { readJsonFile } from "../state/stateFiles.js";

const atifExportSchema = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      step_id: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      message: Schema.optional(Schema.Unknown),
    }),
  ),
});

export type AtifExport = Schema.Schema.Type<typeof atifExportSchema>;

export const devinTurnSchema = Schema.Struct({ markdown: Schema.String, turnId: Schema.String });

export type DevinTurn = Schema.Schema.Type<typeof devinTurnSchema>;

const noTurn: DevinTurn = { markdown: "", turnId: "" };

/** The agent messages after the latest user step, joined; the turn ID is the last agent step's ID. */
export const latestDevinTurn = (atif: AtifExport): DevinTurn => {
  const lastUser = atif.steps.map((step) => step.source).lastIndexOf("user");
  const agentSteps = atif.steps
    .slice(lastUser + 1)
    .filter((step) => step.source === "agent")
    .flatMap((step) => {
      const message = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(step.message), () => "").trim();
      return message === "" ? [] : [{ message, turnId: step.step_id || "" }];
    });
  return {
    markdown: agentSteps.map((step) => step.message).join("\n\n"),
    turnId: [...agentSteps].reverse().find((step) => step.turnId !== "")?.turnId || "",
  };
};

const readTurn = (exportFile: string): DevinTurn =>
  Option.getOrElse(
    Option.map(readJsonFile({ path: exportFile, schema: atifExportSchema }), latestDevinTurn),
    () => noTurn,
  );

/** Queue the pending turn when it is still the latest; returns the turn now spoken. */
const confirmTurn = (request: {
  readonly exportFile: string;
  readonly pendingTurn: string;
  readonly spokenTurn: string;
}) => {
  const confirmed = readTurn(request.exportFile);
  if (confirmed.turnId !== request.pendingTurn || confirmed.markdown === "") {
    return request.spokenTurn;
  }

  queueReply({
    markdown: confirmed.markdown,
    source: "devin",
    agentReplyId: confirmed.turnId,
    origin: { kind: "terminal" },
  });
  return confirmed.turnId;
};

/** Debounced: a turn is queued only once its ID has been stable for 800 ms. Runs until interrupted. */
export const watchDevinExport = (exportFile: string): Effect.Effect<never> =>
  Effect.gen(function* () {
    let spokenTurn = readTurn(exportFile).turnId;
    let pendingTurn = "";
    let changedAt = Date.now();
    while (true) {
      const turnId = readTurn(exportFile).turnId;
      if (turnId !== "" && turnId !== spokenTurn && turnId !== pendingTurn) {
        pendingTurn = turnId;
        changedAt = Date.now();
      }
      if (pendingTurn !== "" && Date.now() - changedAt >= 800) {
        spokenTurn = confirmTurn({ exportFile, pendingTurn, spokenTurn });
        pendingTurn = "";
      }
      yield* Effect.sleep("200 millis");
    }
  });
