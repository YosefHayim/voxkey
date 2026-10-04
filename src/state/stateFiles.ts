/** Small state files: written through a temporary sibling and a rename, so readers never see half a file. */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

export const writeFileAtomically = (request: { readonly path: string; readonly text: string }): void => {
  mkdirSync(path.dirname(request.path), { recursive: true });
  const staging = path.join(path.dirname(request.path), `.${path.basename(request.path)}.${randomUUID()}.partial`);
  writeFileSync(staging, request.text, { encoding: "utf8", mode: 0o600 });
  renameSync(staging, request.path);
};

export const writeJsonAtomically = (request: { readonly path: string; readonly value: unknown }): void =>
  writeFileAtomically({ path: request.path, text: `${JSON.stringify(request.value)}\n` });

const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

/**
 * The file's text, or none when it does not exist. Any other read failure is thrown: a caller that writes the
 * file back must never mistake an unreadable file for a missing one.
 */
export const readTextIfPresent = (filePath: string): Option.Option<string> => {
  try {
    return Option.some(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return Option.none();
    }

    throw error;
  }
};

/** The file's text, or none when it is missing or cannot be read: for files voxkey only reads, never writes back. */
export const readTextIfReadable = (filePath: string): Option.Option<string> => {
  try {
    return readTextIfPresent(filePath);
  } catch {
    return Option.none();
  }
};

/** The decoded JSON file, or none when it is missing, unreadable, not JSON, or the wrong shape. */
export const readJsonFile = <Value, Encoded>(request: {
  readonly path: string;
  readonly schema: Schema.Schema<Value, Encoded>;
}): Option.Option<Value> =>
  Option.flatMap(readTextIfReadable(request.path), Schema.decodeUnknownOption(Schema.parseJson(request.schema)));

export const removeIfPresent = (filePath: string): void => rmSync(filePath, { force: true });

export const touchFile = (filePath: string): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
};
