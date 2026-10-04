/**
 * The keyboard through CoreGraphics, called with koffi: read Shift and other keys from HID state (works
 * without an event tap), and post key events the way enigo did for the Rust worker.
 */

import { Effect, Schema } from "effect";

export class KeyboardError extends Schema.TaggedError<KeyboardError>()("KeyboardError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Keyboard: ${this.issue}`;
  }
}

const HID_SYSTEM_STATE = 1;
const COMBINED_SESSION_STATE = 0;
const HID_EVENT_TAP = 0;
/** kVK_Shift and kVK_RightShift. */
const SHIFT_KEYS = [0x38, 0x3c];
/** kVK_CapsLock follows the lock light, not a press. */
const CAPS_LOCK_KEY = 0x39;
const RETURN_KEY = 0x24;
const TAB_KEY = 0x30;
/** kVK_ANSI_V: a Unicode "v" can lose the Command modifier and type a bare v. */
const V_KEY = 0x09;
const COMMAND_FLAG = 0x0010_0000n;
/** CGEventKeyboardSetUnicodeString truncates longer strings. */
const UNICODE_CHUNK_UNITS = 20;

const OTHER_KEYS = Array.from({ length: 0x80 }, (_unused, key) => key).filter(
  (key) => !SHIFT_KEYS.includes(key) && key !== CAPS_LOCK_KEY,
);

/** Text split into posting chunks of at most 20 UTF-16 units, never inside a surrogate pair. */
export const unicodeChunks = (text: string): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > UNICODE_CHUNK_UNITS) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  return current === "" ? chunks : [...chunks, current];
};

/** Every UTF-16 code unit of a chunk, so an emoji or other character outside the BMP keeps both surrogates. */
export const utf16Units = (chunk: string): Uint16Array =>
  Uint16Array.from({ length: chunk.length }, (_unused, index) => chunk.charCodeAt(index));

/** A chunk that starts with a newline is silently dropped by macOS, so it is led by a zero-width space. */
export const postableChunk = (chunk: string): string => (/^[\r\n]/u.test(chunk) ? `​${chunk}` : chunk);

/** Load koffi and the CoreGraphics functions once; the returned keyboard is used for the worker's lifetime. */
export const loadKeyboard = Effect.gen(function* () {
  const koffi = (yield* Effect.tryPromise({
    try: () => import("koffi"),
    catch: (error) => new KeyboardError({ issue: String(error) }),
  })).default;
  const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const applicationServices = koffi.load(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
  );
  const keyState = coreGraphics.func("bool CGEventSourceKeyState(int32_t state, uint16_t key)");
  const createSource = coreGraphics.func("void* CGEventSourceCreate(int32_t state)");
  const createKeyEvent = coreGraphics.func("void* CGEventCreateKeyboardEvent(void* source, uint16_t key, bool down)");
  const setUnicode = coreGraphics.func(
    "void CGEventKeyboardSetUnicodeString(void* event, unsigned long length, const uint16_t* text)",
  );
  const setFlags = coreGraphics.func("void CGEventSetFlags(void* event, uint64_t flags)");
  const postEvent = coreGraphics.func("void CGEventPost(uint32_t tap, void* event)");
  const listenAllowed = coreGraphics.func("bool CGPreflightListenEventAccess()");
  const postAllowed = coreGraphics.func("bool CGPreflightPostEventAccess()");
  const release = coreFoundation.func("void CFRelease(void* object)");
  const trusted = applicationServices.func("bool AXIsProcessTrusted()");
  const source = createSource(COMBINED_SESSION_STATE);

  const isKeyDown = (key: number): boolean => keyState(HID_SYSTEM_STATE, key) === true;

  const postKey = (request: { readonly key: number; readonly down: boolean; readonly flags: bigint }) => {
    const event = createKeyEvent(source, request.key, request.down);
    setFlags(event, request.flags);
    postEvent(HID_EVENT_TAP, event);
    release(event);
  };

  const pressKey = (key: number, flags: bigint) => {
    postKey({ key, down: true, flags });
    postKey({ key, down: false, flags });
  };

  // Flags are cleared, so a Shift still held by the hand cannot capitalize the typed text.
  const postUnicode = (chunk: string) => {
    const event = createKeyEvent(source, 0, true);
    const units = utf16Units(chunk);
    setUnicode(event, units.length, units);
    setFlags(event, 0n);
    postEvent(HID_EVENT_TAP, event);
    release(event);
  };

  const typeUnicode = (text: string) => {
    for (const chunk of unicodeChunks(text)) {
      if (chunk.startsWith("\t")) {
        pressKey(TAB_KEY, 0n);
      }
      postUnicode(postableChunk(chunk.replace(/^\t/u, "")));
    }
  };

  return {
    /** True while either Shift key is held. */
    shiftDown: (): boolean => SHIFT_KEYS.some(isKeyDown),
    /** Bit n is set while key code n (other than Shift and Caps Lock) is held. */
    otherKeysDown: (): bigint =>
      OTHER_KEYS.reduce((held, key) => (isKeyDown(key) ? held | (1n << BigInt(key)) : held), 0n),
    typeUnicode,
    pressReturn: () => pressKey(RETURN_KEY, 0n),
    pressCommandV: () => pressKey(V_KEY, COMMAND_FLAG),
    releaseShift: () => postKey({ key: SHIFT_KEYS[0] || 0x38, down: false, flags: 0n }),
    /** Accessibility lets voxkey type into other apps. */
    accessibilityAllowed: (): boolean => trusted() === true,
    /** Input Monitoring lets voxkey read the keyboard. */
    inputMonitoringAllowed: (): boolean => listenAllowed() === true,
    postingAllowed: (): boolean => postAllowed() === true,
  };
});

export type Keyboard = Effect.Effect.Success<typeof loadKeyboard>;
