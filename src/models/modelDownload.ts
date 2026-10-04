/** Download one model file over HTTPS to `<file>.partial`, then rename it into place. */

import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import { Effect, Schema } from "effect";

export class ModelDownloadError extends Schema.TaggedError<ModelDownloadError>()("ModelDownloadError", {
  url: Schema.String,
  issue: Schema.String,
}) {
  get message(): string {
    return `Could not download ${this.url}: ${this.issue}`;
  }
}

const PROGRESS_STEP_BYTES = 20_000_000;

/** Copy the download into `partial`, reporting progress every PROGRESS_STEP_BYTES and once at the end. */
const copyToFile = async (request: {
  readonly source: Readable;
  readonly partial: string;
  readonly onProgress: (receivedBytes: number) => void;
}): Promise<void> => {
  let received = 0;
  let reported = 0;
  // pipeline listens for errors on every stream before data flows, so a file that cannot be opened or written
  // rejects here instead of raising an unhandled stream error.
  const copied = pipeline(request.source, createWriteStream(request.partial));
  request.source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received - reported >= PROGRESS_STEP_BYTES) {
      reported = received;
      request.onProgress(received);
    }
  });
  await copied;
  request.onProgress(received);
};

export const downloadFile = (request: {
  readonly url: string;
  readonly destination: string;
  readonly onProgress: (receivedBytes: number) => void;
}): Effect.Effect<void, ModelDownloadError> =>
  Effect.tryPromise({
    try: async (signal) => {
      mkdirSync(path.dirname(request.destination), { recursive: true });
      const partial = `${request.destination}.partial`;
      const reply = await fetch(request.url, { signal, redirect: "follow" });
      if (!reply.ok || reply.body === null) {
        throw new Error(`HTTP ${String(reply.status)}`);
      }

      try {
        // The web stream type from fetch and node:stream/web describe the same object (external type).
        await copyToFile({
          source: Readable.fromWeb(reply.body as ReadableStream<Uint8Array>),
          partial,
          onProgress: request.onProgress,
        });
      } catch (error) {
        rmSync(partial, { force: true });
        throw error;
      }
      renameSync(partial, request.destination);
    },
    catch: (error) =>
      new ModelDownloadError({ url: request.url, issue: error instanceof Error ? error.message : String(error) }),
  });
