/**
 * Judging an agent CLI's refine reply: it is rejected when it is empty, a CLI help dump, an auth or
 * quota error, an error envelope, or when it dropped a protected literal (code, path, URL, quoted text).
 */

import { Either, Option, Schema } from "effect";

export const REFINE_INSTRUCTIONS = `You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text.`;

export const refinePromptFor = (draft: string): string =>
  `${REFINE_INSTRUCTIONS}\n\nDraft to refine:\n---\n${draft}\n---\nReturn only the revised prompt text.`;

// Agent CLIs that print auth or help failures with exit code 0.
const AUTH_OR_CONFIG_MARKERS = [
  "no api key found",
  "use /login",
  "not logged in",
  "not signed in",
  "no models available",
  "please log in",
  "authentication required",
  "unauthorized",
  "login required",
];

const MODEL_UNAVAILABLE_MARKERS = [
  "model is not supported",
  "model not found",
  "unknown model",
  "invalid model",
  "unsupported model",
  "does not exist",
  "not available for",
  "not supported when using",
  "model_not_found",
  "invalid_model",
  "no such model",
  "the requested model is not supported",
  "model_not_supported",
];

const QUOTA_OR_LIMIT_MARKERS = [
  "quota",
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  'status":429',
  "status code 429",
  "http 429",
  " 429",
  " 402",
  'status":402',
  "usage limit",
  "usage_limit",
  "insufficient_quota",
  "exceeded your current quota",
  "billing",
  "limit reached",
  "tokens per min",
  "requests per min",
  "tpm",
  "rpm",
  "out of credits",
  "requires more credits",
  "can only afford",
  "openrouter.ai/settings/credits",
  "payment required",
  "spending limit",
  "budget",
  "credit balance",
  "insufficient credits",
];

const containsAny = (text: string, markers: ReadonlyArray<string>): boolean => {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
};

/** A CLI `--help` dump (e.g. OpenCode's yargs help printed with exit 0), not a refined prompt. */
export const looksLikeCliHelp = (text: string): boolean => {
  const blob = text.trim().toLowerCase();
  if (blob === "") {
    return false;
  }

  const helpAnchors = ["positionals:", "options:", "show help", "[boolean]"].filter((anchor) => blob.includes(anchor));
  return (
    helpAnchors.length >= 3 ||
    (blob.includes("run opencode with a message") && blob.includes("positionals:")) ||
    blob.startsWith("opencode run [message") ||
    blob.includes("opencode run [message..]")
  );
};

export const looksLikeAuthFailure = (text: string): boolean => containsAny(text.trim(), AUTH_OR_CONFIG_MARKERS);

export const isModelUnavailableError = (message: string): boolean => containsAny(message, MODEL_UNAVAILABLE_MARKERS);

export const isQuotaOrLimitError = (message: string): boolean => containsAny(message, QUOTA_OR_LIMIT_MARKERS);

/**
 * True when CLI output is an error envelope rather than a prompt. Several agents (pi, OpenRouter
 * wrappers) print 402 or JSON errors with exit code 0, and those must never be typed at the caret.
 */
export const looksLikeFailedModelOutput = (text: string): boolean => {
  const blob = text.trim();
  const lower = blob.toLowerCase();
  return (
    blob === "" ||
    looksLikeCliHelp(blob) ||
    looksLikeAuthFailure(blob) ||
    isQuotaOrLimitError(blob) ||
    isModelUnavailableError(blob) ||
    lower.startsWith("402") ||
    lower.includes('"code":402') ||
    lower.includes('"code": 402') ||
    lower.includes("invalid_request_error") ||
    (blob.startsWith("{") &&
      (lower.includes('"error"') ||
        (lower.includes('"code"') && (lower.includes("message") || lower.includes("credits")))))
  );
};

const NOT_WORD_CHARACTER_BEFORE = "(?<![\\p{L}\\p{N}_])";

const LITERAL_PATTERNS = [
  /```[\s\S]*?```/gu,
  /`[^`\n]+`/gu,
  /https?:\/\/[^\s<>()]+/gu,
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:\\.{0,2}/)[^\\s,;:!?]+`, "gu"),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+`, "gu"),
  new RegExp(`${NOT_WORD_CHARACTER_BEFORE}(?:'[^'\\n]+'|"[^"\\n]+")`, "gu"),
];

/** Code, URLs, paths, and quoted text in the draft, each counted once (earlier patterns win overlaps). */
export const promptLiterals = (text: string): ReadonlyArray<string> => {
  const candidates = LITERAL_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      literal: match[0],
    })),
  );
  const kept: Array<(typeof candidates)[number]> = [];
  for (const candidate of candidates) {
    if (!kept.some((taken) => candidate.start < taken.end && taken.start < candidate.end)) {
      kept.push(candidate);
    }
  }
  return kept.map((candidate) => candidate.literal);
};

export class RefineReplyRejected extends Schema.TaggedError<RefineReplyRejected>()("RefineReplyRejected", {
  reason: Schema.Literal("empty", "cliHelp", "droppedLiteral"),
  literal: Schema.optional(Schema.String),
}) {
  get message(): string {
    return {
      empty: "The model returned an empty prompt",
      cliHelp: "The model returned CLI help text instead of a refined prompt",
      droppedLiteral: `The model changed a protected literal: ${this.literal || ""}`,
    }[this.reason];
  }
}

const withoutWholeReplyFence = (text: string): string => {
  const lines = text.split("\n");
  return text.startsWith("```") && text.endsWith("```") && lines.length >= 2
    ? lines.slice(1, -1).join("\n").trim()
    : text;
};

/** The refined prompt with a whole-reply code fence removed, or why it cannot replace the draft. */
export const checkRefinedPrompt = (request: {
  readonly draft: string;
  readonly refined: string;
}): Either.Either<string, RefineReplyRejected> => {
  const clean = withoutWholeReplyFence(request.refined.trim());
  if (clean === "") {
    return Either.left(new RefineReplyRejected({ reason: "empty" }));
  }

  if (looksLikeCliHelp(clean)) {
    return Either.left(new RefineReplyRejected({ reason: "cliHelp" }));
  }

  const dropped = promptLiterals(request.draft).find((literal) => !clean.includes(literal));
  return dropped === undefined
    ? Either.right(clean)
    : Either.left(new RefineReplyRejected({ reason: "droppedLiteral", literal: dropped }));
};

const recordOf = Schema.decodeUnknownOption(Schema.Record({ key: Schema.String, value: Schema.Unknown }));

const textOf = (value: unknown): Option.Option<string> =>
  Option.filter(
    Option.map(Schema.decodeUnknownOption(Schema.String)(value), (text) => text.trim()),
    (text) => text !== "",
  );

const textBlocks = (value: unknown): ReadonlyArray<string> =>
  Option.match(Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(value), {
    onNone: () => [],
    onSome: (blocks) =>
      blocks.flatMap((block) =>
        Option.toArray(Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(block)).map(
          (decoded) => decoded.text,
        ),
      ),
  });

const joinedBlocks = (value: unknown): Option.Option<string> => textOf(textBlocks(value).join("\n"));

/** Text of an OpenCode-style `{type, part: {type, text}}` event. */
const partText = (event: Readonly<Record<string, unknown>>): Option.Option<string> =>
  Option.flatMap(recordOf(event.part), (part) => {
    const partType = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(part.type), () => "");
    const eventType = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(event.type), () => "");
    return partType !== "" && partType !== "text" && eventType !== "text" ? Option.none() : textOf(part.text);
  });

const nestedText = (value: unknown): Option.Option<string> =>
  Option.flatMap(recordOf(value), (nested) => Option.orElse(textOf(nested.text), () => textOf(nested.content)));

/** The text of one whole JSON reply, or none so the JSONL scan runs. */
const documentText = (document: Readonly<Record<string, unknown>>): Option.Option<string> => {
  for (const key of ["result", "text", "content", "message", "output", "response"]) {
    const found = Option.orElse(textOf(document[key]), () => nestedText(document[key]));
    if (Option.isSome(found)) {
      return found;
    }
  }

  return Option.orElse(partText(document), () => joinedBlocks(document.content));
};

const eventText = (event: Readonly<Record<string, unknown>>): Option.Option<string> => {
  const direct = ["result", "text", "content", "message", "output"].flatMap((key) =>
    Option.toArray(textOf(event[key])),
  );
  const message = recordOf(event.message);
  const messageText = Option.flatMap(message, (decoded) =>
    Option.orElse(textOf(decoded.content), () => joinedBlocks(decoded.content)),
  );
  return Option.orElse(
    Option.orElse(messageText, () => partText(event)),
    () => Option.fromNullable(direct.at(-1)),
  );
};

const parseJsonOption = Schema.decodeUnknownOption(Schema.parseJson());

/** Best-effort final text from an agent's JSON or JSONL output. */
export const replyTextFromJson = (output: string): string => {
  const blob = output.trim();
  const whole = parseJsonOption(blob);
  const wholeText = Option.orElse(Option.flatMap(whole, textOf), () =>
    Option.flatMap(Option.flatMap(whole, recordOf), documentText),
  );
  if (blob === "" || Option.isSome(wholeText)) {
    return Option.getOrElse(wholeText, () => "");
  }

  const events = blob
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => Option.toArray(Option.flatMap(parseJsonOption(line), recordOf)));
  const parts = events.flatMap((event) => Option.toArray(partText(event)));
  const longest = parts.reduce((best, part) => (part.length > best.length ? part : best), "");
  if (parts.length > 0) {
    // Streamed parts are often cumulative: prefer the longest when it already holds the rest.
    return parts.every((part) => longest.startsWith(part) || longest.includes(part))
      ? longest
      : parts.join("\n").trim();
  }

  return events.flatMap((event) => Option.toArray(eventText(event))).at(-1) || "";
};
