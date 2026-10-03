import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const voiceDirectory = path.dirname(fileURLToPath(import.meta.url));
const refinePromptScript = path.join(voiceDirectory, "refine_prompt.py");
const inheritedPythonPath = process.env.PYTHONPATH;
// The refine modules import each other by name; a script run puts its own folder on sys.path,
// and tests that import the modules directly get the same folder through PYTHONPATH.
const pythonModulePath =
  inheritedPythonPath === undefined ? voiceDirectory : [voiceDirectory, inheritedPythonPath].join(path.delimiter);
const pythonExecutable = process.platform === "win32" ? "python" : "python3";

// Refinement reads ~/.codex caches and the voice state folder; point both at a throwaway
// home so tests never see (or write) the developer's real state.
let refineHome = "";

const refineEnvironment = () => ({
  ...process.env,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONPATH: pythonModulePath,
  HOME: refineHome,
  DUFFLEBAG_VOICE_DIR: path.join(refineHome, "voice"),
  DUFFLEBAG_REFINE_PICKER: "off",
});

/** Run Python lines (with `json` and `sys` imported); `args` arrive as sys.argv[1:]. */
const runRefinePython = (lines: ReadonlyArray<string>, args: ReadonlyArray<string> = []): string =>
  execFileSync(pythonExecutable, ["-c", ["import json, sys", ...lines].join("\n"), ...args], {
    encoding: "utf8",
    env: refineEnvironment(),
    timeout: 15_000,
  });

const parseJsonObject = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected JSON object, got: ${text.slice(0, 200)}`);
  }
  const document: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    document[key] = entry;
  }
  return document;
};

const runRefineJson = (lines: ReadonlyArray<string>): Record<string, unknown> =>
  parseJsonObject(runRefinePython(lines));

const stringArray = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`expected a string array, got: ${JSON.stringify(value)}`);
  }
  return value;
};

const validateRefinedPrompt = (original: string, refined: string): unknown =>
  JSON.parse(
    runRefinePython(
      [
        "from refine_providers import validate_refined_prompt",
        "print(json.dumps(validate_refined_prompt(sys.argv[1], sys.argv[2])))",
      ],
      [original, refined],
    ),
  );

const openCodeHelpDump =
  "opencode run [message..]\n\nrun opencode with a message\n\nPositionals:\n  message  message to send\n\nOptions:\n  -h, --help  show help  [boolean]";

// [refine_providers function, text, expected verdict]
const replyVerdicts: ReadonlyArray<readonly [string, string, boolean]> = [
  [
    "is_model_unavailable_error",
    "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
    true,
  ],
  ["is_model_unavailable_error", "rate limited try again", false],
  ["is_quota_or_limit_error", "ERROR: exceeded your current quota / rate_limit 429", true],
  ["is_quota_or_limit_error", "can only afford 100 tokens", true],
  ["is_quota_or_limit_error", "connection refused", false],
  ["_looks_like_cli_auth_or_config_failure", "No API key found for the selected model.\nUse /login", true],
  ["looks_like_failed_model_output", "Not signed in. To authenticate without a browser, run:\n  grok login", true],
  ["_looks_like_cli_auth_or_config_failure", "Ship the fix for STT refine", false],
  ["looks_like_failed_model_output", '402: {"message":"requires more credits","code":402}', true],
  ["looks_like_failed_model_output", "Fix the STT refine help paste bug.", false],
  ["_looks_like_cli_help", openCodeHelpDump, true],
  ["_looks_like_cli_help", "Ship the fix for STT refine", false],
];

describe("refine_prompt.py", () => {
  beforeAll(() => {
    refineHome = mkdtempSync(path.join(tmpdir(), "dufflebag-refine-home-"));
  });

  afterAll(() => {
    rmSync(refineHome, { recursive: true, force: true });
  });

  it("starts as a script from any folder, the way the voice worker and the CLI run it", () => {
    const { PYTHONPATH: _pythonPath, ...environmentWithoutPythonPath } = refineEnvironment();
    const help = execFileSync(pythonExecutable, [refinePromptScript, "--help"], {
      cwd: refineHome,
      encoding: "utf8",
      env: environmentWithoutPythonPath,
      timeout: 15_000,
    });
    expect(help).toContain("--pick-menu");
    expect(help).toContain("--list-providers");
  });

  it("keeps code, paths, URLs, and quoted literals and rejects drafts that drop them or are CLI help", () => {
    const original = 'Please run `pnpm verify` for /srv/app and keep "exact value" from https://example.com/docs';

    expect(validateRefinedPrompt(original, `Precisely ${original}`)).toBe(`Precisely ${original}`);
    expect(() => validateRefinedPrompt(original, "Please verify it.")).toThrow(/protected literal/);
    expect(() => validateRefinedPrompt("uh fix the thing", openCodeHelpDump)).toThrow(/CLI help text/);
  });

  it("classifies unavailable models, quota and auth errors, error envelopes, and CLI help dumps", () => {
    const verdicts = JSON.parse(
      runRefinePython(
        [
          "import refine_providers",
          "print(json.dumps([[name, text, getattr(refine_providers, name)(text)] for name, text, _ in json.loads(sys.argv[1])]))",
        ],
        [JSON.stringify(replyVerdicts)],
      ),
    );
    expect(verdicts).toEqual(replyVerdicts);
  });

  it("defaults to codex, gpt-5.3-codex-spark, and low effort, and knows the backend aliases", () => {
    const parsed = runRefineJson([
      "import refine_prompt",
      "from refine_choices import DEFAULT_BACKEND, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT",
      "from refine_providers import CODEX_MODEL_FALLBACKS",
      "print(json.dumps({'backend': DEFAULT_BACKEND, 'model': DEFAULT_MODEL, 'effort': DEFAULT_REASONING_EFFORT, 'fallbacks': list(CODEX_MODEL_FALLBACKS), 'known': list(refine_prompt.KNOWN_BACKENDS)}))",
    ]);
    expect(parsed.backend).toBe("codex");
    expect(parsed.model).toBe("gpt-5.3-codex-spark");
    expect(parsed.effort).toBe("low");
    const fallbacks = stringArray(parsed.fallbacks);
    expect(fallbacks[0]).toBe("gpt-5.3-codex-spark");
    expect(fallbacks).toContain("gpt-5.4-mini");
    expect(stringArray(parsed.known)).toEqual(expect.arrayContaining(["agy", "gemini", "pi"]));
  });

  it("tries the preferred Codex model first, then the fallbacks", () => {
    const parsed = runRefineJson([
      "import refine_providers",
      "print(json.dumps({'candidates': refine_providers.codex_model_candidates('my-preferred')}))",
    ]);
    const candidates = stringArray(parsed.candidates);
    expect(candidates[0]).toBe("my-preferred");
    expect(candidates).toContain("gpt-5.4-mini");
  });

  it("offers the picker's model list with excluded models left out and skip last", () => {
    const parsed = runRefineJson([
      "import builtins",
      "import mac_picker",
      // The picker must not depend on which agent CLIs this machine has installed.
      "codex = {'id': 'codex', 'binary': 'codex', 'path': '/fake/bin/codex', 'effort': True, 'models': []}",
      "mac_picker.discover_providers = lambda: [codex]",
      "models = mac_picker._picker_models_for_backend('codex', preferred='gpt-5.4-mini', exclude={'o4-mini'}, providers=[codex])",
      // Pick provider 1, then the entry after the last model: the skip choice.
      "answers = iter(['1', str(len(models) + 1)])",
      "builtins.input = lambda _prompt='': next(answers)",
      "picked = mac_picker.pick_refine_target(preferred_model='gpt-5.4-mini', exclude_models={'o4-mini'}, use_gui=False)",
      "print(json.dumps({'models': models, 'picked': picked['model'], 'skip': mac_picker.SKIP_REFINE_LABEL}))",
    ]);
    const models = stringArray(parsed.models);
    expect(models[0]).toBe("gpt-5.4-mini");
    expect(models).toContain("gpt-5.3-codex-spark");
    expect(models).not.toContain("o4-mini");
    expect(parsed.picked).toBe(parsed.skip);
  });

  it("lists discovered providers as JSON from --list-providers", () => {
    const parsed = runRefineJson([
      "import refine_prompt, refine_providers",
      // Stand in for PATH: only a fake ollama exists, and its model listing is canned.
      "refine_providers.find_cli_or_none = lambda name: '/fake/bin/ollama' if name == 'ollama' else None",
      "refine_providers._run_lines = lambda command, timeout=20: ['NAME ID SIZE', 'llama3.2:latest abc 2.0 GB'] if command[:2] == ['ollama', 'list'] else []",
      "raise SystemExit(refine_prompt.main(['--list-providers']))",
    ]);
    expect(parsed.providers).toEqual([
      {
        id: "ollama",
        binary: "ollama",
        path: "/fake/bin/ollama",
        effort: false,
        models: ["llama3.2:latest"],
      },
    ]);
  });

  it("keeps a refine pick in the DUFFLEBAG_VOICE_DIR state and never writes config.json", () => {
    // Where an installed global config lives; the CLI owns it through the receipt.
    const configPath = path.join(refineHome, ".claude", "dufflebag", "config.json");
    const configText = `${JSON.stringify({ refineModel: "gpt-5.3-codex-spark" }, null, 2)}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, configText);

    const printed = runRefineJson([
      "import refine_prompt",
      "refine_prompt.pick_refine_target = lambda **_options: {'backend': 'grok', 'model': 'grok-4.5', 'reasoningEffort': 'medium'}",
      "raise SystemExit(refine_prompt.main(['--pick-menu']))",
    ]);

    expect(printed).toEqual({ backend: "grok", model: "grok-4.5", reasoningEffort: "medium" });
    expect(readFileSync(configPath, "utf8")).toBe(configText);
    const savedChoice = parseJsonObject(
      readFileSync(path.join(refineHome, "voice", "refine-user-choice.json"), "utf8"),
    );
    expect(savedChoice).toMatchObject({ backend: "grok", model: "grok-4.5", reasoningEffort: "medium" });
  });

  it("puts the preferred provider first in the attempt queue, then other launchable providers", () => {
    const parsed = runRefineJson([
      "import refine_prompt",
      // Stub host CLIs so CI (no pi/codex/opencode) still builds a deterministic queue.
      "refine_prompt.backend_is_launchable = lambda backend: backend in ('pi', 'codex', 'opencode')",
      "refine_prompt._model_candidates_for_backend = lambda backend, preferred='': (",
      "  ['openai-codex/gpt-5.4-mini', 'openrouter/slow'] if backend == 'pi'",
      "  else (['gpt-5.4-mini'] if backend == 'codex' else ['opencode/big-pickle'])",
      ")",
      "print(json.dumps({'queue': [list(item) for item in refine_prompt._build_attempt_queue('pi', 'default')]}))",
    ]);
    if (!Array.isArray(parsed.queue)) {
      throw new Error("expected a queue array");
    }
    expect(parsed.queue.length).toBeGreaterThan(1);
    expect(parsed.queue[0]).toEqual(["pi", "openai-codex/gpt-5.4-mini"]);
    const backends = parsed.queue.map((attempt: unknown) => (Array.isArray(attempt) ? attempt[0] : undefined));
    expect(backends).toContain("codex");
    expect(backends).toContain("opencode");
  });

  it("extracts the reply text from OpenCode JSONL events", () => {
    const parsed = runRefineJson([
      "import refine_providers",
      "jsonl = '\\n'.join([",
      '  \'{"type":"step_start","part":{"type":"step-start"}}\',',
      '  \'{"type":"text","part":{"type":"text","text":"Ship the fix for STT refine"}}\',',
      '  \'{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}\',',
      "])",
      "print(json.dumps({'extracted': refine_providers._extract_json_text(jsonl)}))",
    ]);
    expect(parsed.extracted).toBe("Ship the fix for STT refine");
  });
});
