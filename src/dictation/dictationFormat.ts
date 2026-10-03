/** Spoken formatting for one dictated phrase: "comma", "new line", "bullet", "literal …", and replacements. */

type FormatCommand =
  | { readonly kind: "punctuation"; readonly mark: string }
  | { readonly kind: "newLine" }
  | { readonly kind: "newParagraph" }
  | { readonly kind: "bullet" }
  | { readonly kind: "numberedList" }
  | { readonly kind: "nextItem" };

const punctuation = (mark: string): FormatCommand => ({ kind: "punctuation", mark });

// Longer phrases come first, so "new bullet point" wins over "new bullet" and "bullet".
const SPOKEN_COMMANDS: ReadonlyArray<readonly [ReadonlyArray<string>, FormatCommand]> = [
  [["exclamation", "mark"], punctuation("!")],
  [["exclamation", "point"], punctuation("!")],
  [["next", "bullet", "point"], { kind: "bullet" }],
  [["new", "bullet", "point"], { kind: "bullet" }],
  [["numbered", "list"], { kind: "numberedList" }],
  [["new", "paragraph"], { kind: "newParagraph" }],
  [["question", "mark"], punctuation("?")],
  [["bullet", "list"], { kind: "bullet" }],
  [["bullet", "point"], { kind: "bullet" }],
  [["next", "bullet"], { kind: "bullet" }],
  [["new", "bullet"], { kind: "bullet" }],
  [["next", "item"], { kind: "nextItem" }],
  [["next", "line"], { kind: "newLine" }],
  [["full", "stop"], punctuation(".")],
  [["new", "line"], { kind: "newLine" }],
  [["semicolon"], punctuation(";")],
  [["newline"], { kind: "newLine" }],
  [["period"], punctuation(".")],
  [["comma"], punctuation(",")],
  [["colon"], punctuation(":")],
  [["bullet"], { kind: "bullet" }],
  [["dot"], punctuation(".")],
];

/** `heard=written;…` as a map; blank or one-sided pairs are skipped and a later pair wins. */
export const parseReplacements = (replacementText: string): ReadonlyMap<string, string> =>
  new Map(
    replacementText.split(";").flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        return [];
      }

      const heard = entry.slice(0, separator).trim();
      const written = entry.slice(separator + 1).trim();
      return heard === "" || written === "" ? [] : [[heard, written] as const];
    }),
  );

/** Whisper's initial prompt: every replacement term, both sides, so names are spelled right. */
export const promptBoost = (replacements: ReadonlyMap<string, string>): string =>
  [...new Set([...replacements].flat())].sort().join(", ");

const canonicalWord = (word: string): string => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();

type Phrase = { readonly words: ReadonlyArray<string>; readonly written: string };

// Replacement phrases in canonical words, longest first so the longest match wins.
const replacementPhrases = (replacements: ReadonlyMap<string, string>): ReadonlyArray<Phrase> =>
  [...replacements]
    .map(([heard, written]) => ({
      words: heard
        .split(/\s+/u)
        .map(canonicalWord)
        .filter((word) => word !== ""),
      written: written.trim(),
    }))
    .filter((phrase) => phrase.words.length > 0 && phrase.written !== "")
    .sort((left, right) => right.words.length - left.words.length);

const matchesAt = (request: {
  readonly words: ReadonlyArray<string>;
  readonly index: number;
  readonly phrase: ReadonlyArray<string>;
}): boolean =>
  request.words.length >= request.index + request.phrase.length &&
  request.phrase.every((word, offset) => request.words[request.index + offset] === word);

const commandAt = (words: ReadonlyArray<string>, index: number) =>
  SPOKEN_COMMANDS.find(([phrase]) => matchesAt({ words, index, phrase }));

const capitalizeFirstLetter = (text: string): string => text.replace(/[A-Za-z]/u, (letter) => letter.toUpperCase());

/** The text being built, plus what the next word needs: a space, a capital, or a fresh line. */
const makeFormatter = () => {
  let text = "";
  let atLineStart = true;
  let capitalizeNext = true;
  let needsSpace = false;
  let nextNumber = 0;

  const pushWords = (words: string) => {
    const rendered = capitalizeNext ? capitalizeFirstLetter(words) : words;
    text += `${needsSpace ? " " : ""}${rendered}`;
    atLineStart = false;
    // A sentence end (ignoring closing quotes) capitalizes the next word.
    capitalizeNext = /[.!?]["']*$/u.test(rendered);
    needsSpace = true;
  };

  const startListItem = (marker: string) => {
    text += `${atLineStart ? "" : "\n"}${marker}`;
    atLineStart = false;
    capitalizeNext = true;
    needsSpace = false;
  };

  const pushCommand = (command: FormatCommand) => {
    switch (command.kind) {
      case "punctuation":
        text += command.mark;
        atLineStart = false;
        capitalizeNext = [".", "!", "?"].includes(command.mark);
        needsSpace = true;
        return;
      case "newLine":
      case "newParagraph":
        text += command.kind === "newParagraph" ? "\n\n" : "\n";
        atLineStart = true;
        capitalizeNext = true;
        needsSpace = false;
        return;
      case "bullet":
        nextNumber = 0;
        startListItem("- ");
        return;
      case "numberedList":
      case "nextItem": {
        const number = command.kind === "numberedList" || nextNumber < 1 ? 1 : nextNumber;
        nextNumber = number + 1;
        startListItem(`${String(number)}. `);
        return;
      }
    }
  };

  const finish = () => (text !== "" && needsSpace ? `${text} ` : text);

  return { pushWords, pushCommand, finish };
};

/**
 * Format one utterance for the caret. It ends with a space when the next utterance should start a
 * new word, and is empty when nothing should be typed.
 */
export const formatDictation = (transcript: string, replacements: ReadonlyMap<string, string>): string => {
  const words = transcript.split(/\s+/u).filter((word) => word !== "");
  const canonical = words.map(canonicalWord);
  const phrases = replacementPhrases(replacements);
  const replacementAt = (index: number) =>
    phrases.find((phrase) => matchesAt({ words: canonical, index, phrase: phrase.words }));
  const formatter = makeFormatter();
  let index = 0;
  while (index < words.length) {
    const command = commandAt(canonical, index);
    const replacement = replacementAt(index);
    if (canonical[index] === "literal" && index + 1 < words.length) {
      // "literal" types the next command or replacement phrase (or one word) as plain words.
      const length = commandAt(canonical, index + 1)?.[0].length || replacementAt(index + 1)?.words.length || 1;
      formatter.pushWords(words.slice(index + 1, index + 1 + length).join(" "));
      index += 1 + length;
    } else if (command !== undefined) {
      formatter.pushCommand(command[1]);
      index += command[0].length;
    } else if (replacement !== undefined) {
      formatter.pushWords(replacement.written);
      index += replacement.words.length;
    } else {
      formatter.pushWords(words.slice(index, index + 1).join(""));
      index += 1;
    }
  }

  return formatter.finish();
};
