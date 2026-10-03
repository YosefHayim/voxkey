import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

const hookSource = fileURLToPath(new URL("./speakReply.ts", import.meta.url));
const hooksRoot = path.resolve(path.dirname(hookSource), "../..");
const packageRoot = path.resolve(hooksRoot, "../..");

// Run a copy of the hook with no dufflebag-voice binary beside it, so no test ever starts a real worker.
const hookCopyRoot = mkdtempSync(path.join(tmpdir(), "dufflebag-voice-hook-code-"));
const hookPath = path.join(hookCopyRoot, "voice/hooks/speakReply.ts");
cpSync(path.join(hooksRoot, "lib"), path.join(hookCopyRoot, "lib"), {
  recursive: true,
  filter: (source) => !source.endsWith(".test.ts"),
});
mkdirSync(path.dirname(hookPath), { recursive: true });
cpSync(hookSource, hookPath);
afterAll(() => rmSync(hookCopyRoot, { recursive: true, force: true }));

const temporaryHomes: Array<string> = [];

const stateHome = () => {
  const home = mkdtempSync(path.join(tmpdir(), "dufflebag-voice-hook-"));
  temporaryHomes.push(home);
  return home;
};

const configFileForSpeechMode = (home: string, speechMode: "off" | "auto") => {
  const configPath = path.join(home, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ speechMode })}\n`);
  return configPath;
};

const runHook = (request: {
  readonly input: unknown;
  readonly agentId: string;
  readonly home: string;
  readonly speechMode?: "off" | "auto";
  readonly environment?: Record<string, string>;
}) =>
  spawnSync(process.execPath, ["--import", "tsx", hookPath], {
    cwd: packageRoot,
    input: JSON.stringify(request.input),
    encoding: "utf8",
    env: {
      ...process.env,
      CMUX_SOCKET_PATH: "",
      CMUX_SURFACE_ID: "",
      CMUX_WORKSPACE_ID: "",
      DUFFLEBAG_AGENT_ID: request.agentId,
      DUFFLEBAG_VOICE_DIR: request.home,
      // Isolate from the machine's real config.json (often speechMode=off).
      DUFFLEBAG_VOICE_CONFIG_FILE: configFileForSpeechMode(
        request.home,
        request.speechMode === undefined ? "auto" : request.speechMode,
      ),
      PATH: "",
      ...request.environment,
    },
  });

const queued = (home: string) => {
  const inbox = path.join(home, "inbox");
  const names = readdirSync(inbox);
  expect(names).toHaveLength(1);
  const queuedName = names.at(0);
  if (queuedName === undefined) throw new Error("Expected one queued narration file.");
  const candidate: unknown = JSON.parse(readFileSync(path.join(inbox, queuedName), "utf8"));
  return candidate;
};

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("speakReply hook", () => {
  it("queues Claude's complete final response without rewriting Markdown", () => {
    const home = stateHome();
    const markdown = "# Release\n\n| Item | State |\n| --- | --- |\n| Voice | Ready |\n\n```ts\nconst count = 2;\n```";

    const execution = runHook({ input: { last_assistant_message: markdown }, agentId: "claude-code", home });

    expect(execution.status).toBe(0);
    expect(execution.stderr).toBe("");
    expect(queued(home)).toMatchObject({ markdown, origin: { kind: "terminal" }, source: "claude-code" });
  });

  it("skips queueing when speechMode is off (dictation only)", () => {
    const home = stateHome();
    const execution = runHook({
      input: { last_assistant_message: "Should stay silent" },
      agentId: "claude-code",
      home,
      speechMode: "off",
    });

    expect(execution.status).toBe(0);
    expect(execution.stderr).toBe("");
    expect(existsSync(path.join(home, "inbox"))).toBe(false);
  });

  it("binds a Cmux response to its originating surface without persisting socket capabilities", () => {
    const home = stateHome();

    expect(
      runHook({
        input: { last_assistant_message: "Focused response" },
        agentId: "codex",
        home,
        environment: {
          CMUX_SOCKET_CAPABILITY: "must-not-leak",
          CMUX_SOCKET_PATH: "/tmp/cmux-test.sock",
          CMUX_SURFACE_ID: "surface-uuid",
          CMUX_WORKSPACE_ID: "workspace-uuid",
        },
      }).status,
    ).toBe(0);

    expect(queued(home)).toMatchObject({
      origin: {
        kind: "cmux",
        socket_path: "/tmp/cmux-test.sock",
        surface_id: "surface-uuid",
        workspace_id: "workspace-uuid",
      },
    });
    expect(JSON.stringify(queued(home))).not.toContain("must-not-leak");
  });

  it("queues a Grok end-turn response and ignores non-final hook events", () => {
    const resolvedHome = stateHome();
    const partialHome = stateHome();

    expect(
      runHook({
        input: { lastAssistantMessage: "Complete answer", reason: "end_turn" },
        agentId: "grok",
        home: resolvedHome,
      }).status,
    ).toBe(0);
    expect(queued(resolvedHome)).toMatchObject({ markdown: "Complete answer", source: "grok" });

    expect(
      runHook({
        input: { lastAssistantMessage: "Still working", reason: "tool_use" },
        agentId: "grok",
        home: partialHome,
      }).status,
    ).toBe(0);
    expect(() => readdirSync(path.join(partialHome, "inbox"))).toThrow();
  });

  it("falls back to every assistant text block after the latest genuine user prompt", () => {
    const home = stateHome();
    const transcript = path.join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", message: { content: "old prompt" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Old answer" }] } },
        { type: "user", message: { content: "new prompt" } },
        { type: "assistant", message: { content: [{ type: "text", text: "First section" }, { type: "tool_use" }] } },
        { type: "user", message: { content: [{ type: "tool_result", content: "result" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Second section\n\n- complete" }] } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    expect(runHook({ input: { transcript_path: transcript }, agentId: "codex", home }).status).toBe(0);
    expect(queued(home)).toMatchObject({ markdown: "First section\n\nSecond section\n\n- complete", source: "codex" });
  });
});
