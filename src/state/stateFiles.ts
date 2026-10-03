/** Small state files: written through a temporary sibling and a rename, so readers never see half a file. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export const readTextIfPresent = (filePath: string): Option.Option<string> => {
  if (!existsSync(filePath)) {
    return Option.none();
  }

  try {
    return Option.some(readFileSync(filePath, "utf8"));
  } catch {
    // A file removed between the check and the read is simply absent.
    return Option.none();
  }
};

/** The decoded JSON file, or none when it is missing, unreadable, not JSON, or the wrong shape. */
export const readJsonFile = <Value, Encoded>(request: {
  readonly path: string;
  readonly schema: Schema.Schema<Value, Encoded>;
}): Option.Option<Value> =>
  Option.flatMap(readTextIfPresent(request.path), Schema.decodeUnknownOption(Schema.parseJson(request.schema)));

export const removeIfPresent = (filePath: string): void => rmSync(filePath, { force: true });

export const touchFile = (filePath: string): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
};
