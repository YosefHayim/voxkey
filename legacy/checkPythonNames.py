"""Reject forbidden generic tokens in authored Python declarations."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

FORBIDDEN_NAME_TOKENS = {
    "body",
    "data",
    "final",
    "info",
    "outcome",
    "payload",
    "raw",
    "response",
    "result",
    "results",
    "temp",
    "tmp",
}


def identifier_words(identifier: str) -> list[str]:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", identifier)
    return [word.casefold() for word in re.split(r"[^A-Za-z0-9]+", separated) if word]


def declaration_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return [node.name]
    if isinstance(node, ast.arg):
        return [node.arg]
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
        return [node.id]
    if isinstance(node, ast.alias) and node.asname is not None:
        return [node.asname]
    return []


def python_sources(repository_root: Path) -> list[Path]:
    # Skip build trees (e.g. whisper.cpp under worker/target) even when present on disk.
    skip_parts = {"target", "node_modules", ".venv", "__pycache__"}
    return sorted(
        source_path
        for source_path in (repository_root / "src").rglob("*.py")
        if not any(part in skip_parts for part in source_path.parts)
    )


def forbidden_declarations(repository_root: Path) -> list[str]:
    violations: list[str] = []
    for source_path in python_sources(repository_root):
        module = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(module):
            for declaration_name in declaration_names(node):
                forbidden = FORBIDDEN_NAME_TOKENS.intersection(identifier_words(declaration_name))
                if not forbidden:
                    continue
                relative_path = source_path.relative_to(repository_root)
                line = getattr(node, "lineno", 1)
                violations.append(
                    f'{relative_path}:{line} name.domain-specific Rename "{declaration_name}" for its domain job.'
                )
    return violations


def main() -> int:
    repository_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    violations = forbidden_declarations(repository_root)
    if violations:
        print("\n".join(violations))
        print(f"\n{len(violations)} Python naming violation(s)")
        return 1
    print("Authored Python declarations use domain-specific names.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
