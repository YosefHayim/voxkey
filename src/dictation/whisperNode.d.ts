/**
 * The part of @fugood/whisper.node voxkey uses. The package ships TypeScript sources without declarations,
 * so tsconfig `paths` points the import here instead of type-checking the package's own sources.
 */

export type TranscribeOptions = {
  readonly language?: string;
  readonly temperature?: number;
  readonly bestOf?: number;
  readonly maxContext?: number;
  readonly maxThreads?: number;
  readonly prompt?: string;
};

export type TranscribedSpeech = {
  readonly result: string;
  readonly segments: ReadonlyArray<{ readonly text: string; readonly t0: number; readonly t1: number }>;
  readonly isAborted: boolean;
};

export type WhisperContext = {
  readonly transcribeData: (
    pcm: ArrayBuffer,
    options?: TranscribeOptions,
  ) => { readonly stop: () => Promise<void>; readonly promise: Promise<TranscribedSpeech> };
  readonly release: () => Promise<void>;
};

export declare const initWhisper: (options: {
  readonly filePath: string;
  readonly useGpu?: boolean;
  readonly useFlashAttn?: boolean;
}) => Promise<WhisperContext>;

export declare const toggleNativeLog: (enable: boolean) => Promise<void>;
