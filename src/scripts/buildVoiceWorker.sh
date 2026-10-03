#!/usr/bin/env bash
# Build the voice feature's native worker and place it beside the voice hook.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VOICE_CRATE="$ROOT/src/hooks/voice/worker"
OUT="$ROOT/src/hooks/voice/dufflebag-voice"

export PATH="/opt/homebrew/bin:${PATH:-}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build dufflebag-voice" >&2
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required to build whisper.cpp (brew install cmake)" >&2
  exit 1
fi

cd "$VOICE_CRATE"
cargo build --release
cp -f "$VOICE_CRATE/target/release/dufflebag-voice" "$OUT"
chmod +x "$OUT"
# cp breaks the linker-signed adhoc signature; without re-sign macOS SIGKILLs the binary (exit 137).
if command -v codesign >/dev/null 2>&1; then
  codesign --force -s - "$OUT" >/dev/null 2>&1 || true
fi
echo "Built $OUT"
