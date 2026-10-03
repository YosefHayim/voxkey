/** Download one model file over HTTPS to `<file>.partial`, then rename it into place. */

import { once } from "node:events";
import { createWriteStream, mkdirSync, renameSync, rmSync, type WriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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

const copyWithProgress = async (request: {
  readonly source: Readable;
  readonly output: WriteStream;
  readonly onProgress: (receivedBytes: number) => void;
}): Promise<number> => {
  let received = 0;
  let reported = 0;
  for await (const chunk of request.source) {
    received += Buffer.byteLength(chunk);
    if (received - reported >= PROGRESS_STEP_BYTES) {
      reported = received;
      request.onProgress(received);
    }
    if (!request.output.write(chunk)) {
      await once(request.output, "drain");
    }
  }
  request.output.end();
  await finished(request.output);
  return received;
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

      const output = createWriteStream(partial);
      let received = 0;
      try {
        // The web stream type from fetch and node:stream/web describe the same object (external type).
        received = await copyWithProgress({
          source: Readable.fromWeb(reply.body as ReadableStream<Uint8Array>),
          output,
          onProgress: request.onProgress,
        });
      } catch (error) {
        output.destroy();
        rmSync(partial, { force: true });
        throw error;
      }
      request.onProgress(received);
      renameSync(partial, request.destination);
    },
    catch: (error) =>
      new ModelDownloadError({ url: request.url, issue: error instanceof Error ? error.message : String(error) }),
  });
