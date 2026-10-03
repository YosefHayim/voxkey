/** `voxkey reply`: the agent Stop hook. Queue the finished reply for narration and wake the workers; never fail. */

import { readFileSync } from "node:fs";

import { Effect, Option, Schema } from "effect";

import { readConfigOrDefaults } from "../config/configFile.js";
import { queueReply, type ReplyOrigin } from "../narration/inbox.js";
import { isWorkerRunning, spawnWorker, startNarrationWorker } from "../worker/workerProcesses.js";
import type { AgentId } from "./agentCatalog.js";
import {
  agentReplyIdOf,
  directReply,
  isFinishedTurn,
  replyFromTranscript,
  stopHookInputSchema,
  transcriptPathOf,
} from "./agentReply.js";

const optionalVariable = Schema.optionalWith(Schema.Trim, { default: () => "" });

const cmuxEnvironmentSchema = Schema.Struct({
  CMUX_WORKSPACE_ID: optionalVariable,
  CMUX_SURFACE_ID: optionalVariable,
  CMUX_SOCKET_PATH: optionalVariable,
});

/** A reply from inside Cmux is bound to its workspace and surface; only the socket path is kept, never a capability. */
export const replyOrigin = (): ReplyOrigin => {
  const cmux = Schema.decodeUnknownSync(cmuxEnvironmentSchema)(process.env);
  if (cmux.CMUX_WORKSPACE_ID === "" || cmux.CMUX_SURFACE_ID === "") {
    return { kind: "terminal" };
  }

  return {
    kind: "cmux",
    socketPath: cmux.CMUX_SOCKET_PATH || "/tmp/cmux.sock",
    workspaceId: cmux.CMUX_WORKSPACE_ID,
    surfaceId: cmux.CMUX_SURFACE_ID,
  };
};

const readStandardInput = Effect.tryPromise(async () => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
});

const decodeHookInput = Schema.decodeUnknownOption(Schema.parseJson(stopHookInputSchema));

const transcriptReply = (transcriptPath: string): string =>
  transcriptPath === "" ? "" : replyFromTranscript(readFileSync(transcriptPath, "utf8").split("\n"));

// After a reboot the hook is what brings dictation and narration back.
const wakeWorkers = (): void => {
  if (isWorkerRunning("dictation")) {
    startNarrationWorker();
    return;
  }

  spawnWorker("dictation");
};

const queueAgentReply = (agent: AgentId) =>
  Effect.gen(function* () {
    const config = yield* readConfigOrDefaults;
    if (config.narrationMode === "off") {
      return;
    }

    const input = decodeHookInput(yield* readStandardInput);
    if (Option.isNone(input) || !isFinishedTurn(input.value, agent)) {
      return;
    }

    const markdown = directReply(input.value) || transcriptReply(transcriptPathOf(input.value));
    if (markdown.trim() === "") {
      return;
    }

    queueReply({ markdown, source: agent, agentReplyId: agentReplyIdOf(input.value), origin: replyOrigin() });
    wakeWorkers();
  });

/** The reply hook prints nothing and succeeds whatever happens, so it can never block or confuse the agent. */
export const runReplyHook = (agent: AgentId): Effect.Effect<void> =>
  queueAgentReply(agent).pipe(Effect.catchAllCause(() => Effect.void));
