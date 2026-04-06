"""Markdown preprocessor that substitutes {{ key }} with values from extra.

The `version` variable is automatically populated from pyproject.toml so the
release workflow never needs to touch this file or zensical.toml.
"""

import re
from pathlib import Path

from markdown import Extension
from markdown.preprocessors import Preprocessor
from zensical.config import get_config

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore[no-redef]

_VAR_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def _build_vars() -> dict:
    extra = dict(get_config().get("extra", {}))
    if "version" not in extra:
        # Read version from pyproject.toml (repo root is two levels above docs/extensions/)
        pyproject = Path(__file__).parent.parent.parent / "pyproject.toml"
        with open(pyproject, "rb") as f:
            extra["version"] = tomllib.load(f)["project"]["version"]
    return extra


class VarsPreprocessor(Preprocessor):
    def __init__(self, md, vars: dict):
        super().__init__(md)
        self._vars = vars

    def run(self, lines: list[str]) -> list[str]:
        return [_VAR_RE.sub(lambda m: str(self._vars.get(m.group(1), m.group(0))), line) for line in lines]


class VarsExtension(Extension):
    def extendMarkdown(self, md):
        md.preprocessors.register(VarsPreprocessor(md, _build_vars()), "vars", 175)


def makeExtension(**kwargs):
    return VarsExtension(**kwargs)
