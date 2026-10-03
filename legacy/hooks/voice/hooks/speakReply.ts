#!/usr/bin/env node
/** Queue one complete final response for Dufflebag's local voice worker. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installRoot } from "../../lib/hookConfig.js";
import { decodeTranscriptLine, readTranscriptLines, type TranscriptEntry } from "../../lib/transcriptReader.js";

type JsonRecord = Record<string, unknown>;

type AgentReplyOrigin =
  | { kind: "cmux"; socket_path: string; surface_id: string; workspace_id: string }
  | { kind: "terminal" };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: JsonRecord, names: ReadonlyArray<string>) => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
};

const blockType = (value: unknown) => (isRecord(value) && typeof value.type === "string" ? value.type : "");

const isGenuineUser = (entry: TranscriptEntry) => {
  if (entry.type !== "user" && entry.role !== "user") {
    return false;
  }
  const content = entry.content;
  if (typeof content === "string") {
    return true;
  }
  return Array.isArray(content) && content.every((block) => blockType(block) !== "tool_result");
};

const assistantText = (entry: TranscriptEntry) => {
  if (entry.type !== "assistant" && entry.role !== "assistant") {
    return [];
  }
  const content = entry.content;
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() ? [block.text] : [],
  );
};

const agentReplyFromTranscript = (transcriptPath: string) => {
  const entries = readTranscriptLines(transcriptPath).flatMap((line) => {
    const entry = decodeTranscriptLine(line);
    return entry ? [entry] : [];
  });
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries.at(index);
    if (entry && isGenuineUser(entry)) {
      start = index + 1;
      break;
    }
  }
  return entries.slice(start).flatMap(assistantText).join("\n\n");
};

// Install writes DUFFLEBAG_AGENT_ID=<agent> in front of this hook's command.
const agentId = () => process.env.DUFFLEBAG_AGENT_ID?.trim() || "unknown-agent";

const isCompletedGrokEvent = (input: JsonRecord) => {
  const reason = stringField(input, ["reason", "hook_reason", "hookReason"]);
  return !reason || ["complete", "completed", "end_turn", "stop"].includes(reason) || reason.endsWith(":end_turn");
};

const directAgentReply = (input: JsonRecord) =>
  stringField(input, ["last_assistant_message", "lastAssistantMessage", "last_agent_message", "lastAgentMessage"]);

const voiceStateHome = () => {
  const override = process.env.DUFFLEBAG_VOICE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "dufflebag", "voice");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "dufflebag", "voice");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "dufflebag", "voice");
};

const configPaths = () => {
  const override = process.env.DUFFLEBAG_VOICE_CONFIG_FILE?.trim();
  // Explicit override wins alone (tests + alternate installs).
  if (override) {
    return [path.resolve(override)];
  }
  // This install's config.json first, then the global install's.
  return [path.join(installRoot, "config.json"), path.join(homedir(), ".claude", "dufflebag", "config.json")];
};

const speechModeAt = (configPath: string) => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return isRecord(parsed) && typeof parsed.speechMode === "string" ? parsed.speechMode : undefined;
  } catch {
    return undefined;
  }
};

/** The first config.json that sets speechMode decides; with speechMode off nothing is queued or started. */
const narrationEnabled = () => {
  for (const configPath of configPaths()) {
    const speechMode = speechModeAt(configPath);
    if (speechMode !== undefined) {
      return speechMode !== "off";
    }
  }
  return true;
};

const agentReplyOrigin = (): AgentReplyOrigin => {
  const workspaceId = process.env.CMUX_WORKSPACE_ID?.trim() || "";
  const surfaceId = process.env.CMUX_SURFACE_ID?.trim() || "";
  if (!workspaceId || !surfaceId) {
    return { kind: "terminal" };
  }
  return {
    kind: "cmux",
    socket_path: process.env.CMUX_SOCKET_PATH?.trim() || "/tmp/cmux.sock",
    surface_id: surfaceId,
    workspace_id: workspaceId,
  };
};

const contentToken = (markdown: string) => {
  // Stable FNV-1a 64-bit — matches the Rust worker, so a reply without a response_id is still queued once.
  let hash = 0xcbf29ce484222325n;
  const bytes = Buffer.from(markdown, "utf8");
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${hash.toString(16).padStart(16, "0")}:${markdown.length}`;
};

const queueAgentReply = (request: {
  readonly markdown: string;
  readonly source: string;
  readonly agentReplyId: string;
}) => {
  const inbox = path.join(voiceStateHome(), "inbox");
  mkdirSync(inbox, { recursive: true });
  const token = contentToken(request.markdown);
  // Prefer a stable reply id; fall back to content so repeated Stop hooks don't re-queue.
  const agentReplyId = request.agentReplyId.trim() || token;
  const id = `${Date.now()}-${randomUUID()}`;
  const destination = path.join(inbox, `${id}.json`);
  const temporary = path.join(inbox, `.${id}.tmp`);
  writeFileSync(
    temporary,
    JSON.stringify({
      markdown: request.markdown,
      origin: agentReplyOrigin(),
      received_at: Date.now() / 1_000,
      agent_reply_id: agentReplyId,
      source: request.source,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, destination);
};

const startWorker = () => {
  const featureRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const binaryPath = path.join(featureRoot, "dufflebag-voice");
  const worker = spawn(binaryPath, ["start"], {
    cwd: featureRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  worker.on("error", () => undefined);
  worker.unref();
};

const main = () => {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!isRecord(input)) {
    return;
  }
  if (!narrationEnabled()) {
    return;
  }
  const source = agentId();
  if (source === "grok" && !isCompletedGrokEvent(input)) {
    return;
  }

  const transcriptPath = stringField(input, ["transcript_path", "transcriptPath"]);
  const markdown = directAgentReply(input) || (transcriptPath ? agentReplyFromTranscript(transcriptPath) : "");
  if (!markdown.trim()) {
    return;
  }

  const agentReplyId = stringField(input, ["response_id", "responseId", "turn_id", "turnId"]);
  queueAgentReply({ markdown, source, agentReplyId });
  startWorker();
};

try {
  main();
} catch {
  // Agent hooks must never block the coding session.
}
