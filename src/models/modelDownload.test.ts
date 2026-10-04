import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { downloadFile } from "./modelDownload.js";

const scratchRoot = fileURLToPath(new URL("../../.scratch/", import.meta.url));

let folder = "";
let server: Server | undefined;
let url = "";

const MODEL_BYTES = 1_024;

// A local server stands in for Hugging Face; nothing leaves the Mac. The second half arrives later, so a file error
// lands while the download waits for more bytes (a small first chunk is buffered without waiting for "drain").
beforeEach(async () => {
  mkdirSync(scratchRoot, { recursive: true });
  folder = mkdtempSync(path.join(scratchRoot, "download-"));
  server = createServer((_request, served) => {
    served.write(Buffer.alloc(MODEL_BYTES / 2, 7));
    setTimeout(() => served.end(Buffer.alloc(MODEL_BYTES / 2, 7)), 200);
  });
  await new Promise((resolve) => server?.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address());
  url = `http://127.0.0.1:${String(port)}/model.bin`;
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  chmodSync(folder, 0o700);
  rmSync(folder, { recursive: true, force: true });
});

describe("downloadFile", () => {
  it("writes the file through a .partial file and reports the bytes received", async () => {
    const destination = path.join(folder, "model.bin");
    const progress: Array<number> = [];

    await Effect.runPromise(downloadFile({ url, destination, onProgress: (bytes) => progress.push(bytes) }));

    expect(readFileSync(destination).length).toBe(MODEL_BYTES);
    expect(progress.at(-1)).toBe(MODEL_BYTES);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it("fails with a download error, instead of crashing, when the file cannot be written", async () => {
    chmodSync(folder, 0o500);

    const failure = await Effect.runPromise(
      Effect.flip(downloadFile({ url, destination: path.join(folder, "model.bin"), onProgress: () => undefined })),
    );

    expect(failure._tag).toBe("ModelDownloadError");
    expect(failure.issue).toContain("EACCES");
  });
});
