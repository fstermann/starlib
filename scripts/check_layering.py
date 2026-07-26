#!/usr/bin/env python
"""Fail if a backend module imports across a layer boundary.

The backend is layered ``api -> services -> domain``, with ``infra`` holding
the adapters. Dependencies point inward only:

- ``domain`` is pure: no ``api``/``services``/``infra``, and none of the
  frameworks that imply I/O.
- ``infra`` adapts the outside world: it may use ``domain`` types, never
  ``services`` or ``api``.
- ``services`` orchestrates: it may use ``domain`` and ``infra``, never ``api``.

``backend.schemas`` is layer-neutral — it is the shared contract vocabulary and
imports nothing but itself, so every layer may depend on it.

Without this check the layers erode silently: the previous layout ended up
with an empty domain package and a twenty-module services grab bag.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# layer -> module prefixes it must not import
FORBIDDEN: dict[str, tuple[str, ...]] = {
    "backend/domain": (
        "backend.api",
        "backend.services",
        "backend.infra",
        "backend.config",
        "backend.main",
        "fastapi",
        "starlette",
        "sqlmodel",
        "sqlalchemy",
        "httpx",
        "keyring",
        "watchdog",
        "anthropic",
        "alembic",
        "pydantic_settings",
    ),
    "backend/infra": ("backend.api", "backend.services"),
    "backend/services": ("backend.api",),
}


def _imported_modules(tree: ast.AST) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend((alias.name, node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.append((node.module, node.lineno))
    return out


def check(paths: list[Path]) -> list[str]:
    violations: list[str] = []
    for path in paths:
        posix = path.as_posix()
        layer = next((lay for lay in FORBIDDEN if posix.startswith(lay)), None)
        if layer is None:
            continue
        try:
            tree = ast.parse(path.read_text(), filename=posix)
        except SyntaxError as exc:  # let ruff/mypy report the real problem
            violations.append(f"{posix}: could not parse ({exc})")
            continue
        for module, lineno in _imported_modules(tree):
            for bad in FORBIDDEN[layer]:
                if module == bad or module.startswith(bad + "."):
                    violations.append(f"{posix}:{lineno}: {layer.split('/')[-1]} may not import {module}")
    return violations


def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv[1:]] or sorted(Path("backend").rglob("*.py"))
    violations = check([p for p in paths if p.suffix == ".py"])
    if violations:
        print("Layering violations (see scripts/check_layering.py for the rules):")
        for v in violations:
            print(f"  {v}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
