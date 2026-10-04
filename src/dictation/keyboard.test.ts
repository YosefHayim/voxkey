import { describe, expect, it } from "vitest";

import { unicodeChunks, utf16Units } from "./keyboard.js";

describe("utf16Units", () => {
  it("keeps both halves of a surrogate pair, so a dictated emoji is posted whole", () => {
    expect([...utf16Units("a😀")]).toEqual([0x61, 0xd83d, 0xde00]);
  });

  it("posts every unit of every chunk", () => {
    const text = `${"x".repeat(19)}😀 done`;
    expect(unicodeChunks(text).flatMap((chunk) => [...utf16Units(chunk)])).toEqual([...utf16Units(text)]);
  });
});
