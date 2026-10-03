/** `voxkey reply --agent <id>`: the agent Stop hook that `voxkey on` registers. */

import { Command, Options } from "@effect/cli";

import { runReplyHook } from "../agentHooks/replyHook.js";

const agentOption = Options.choice("agent", ["claude-code", "codex", "grok"] as const).pipe(
  Options.withDescription("Which agent ran the hook"),
);

export const replyCommand = Command.make("reply", { agent: agentOption }, (args) => runReplyHook(args.agent)).pipe(
  Command.withDescription(
    "Agent Stop hook: queue the agent's finished reply for narration. Prints nothing and always exits 0.",
  ),
);
