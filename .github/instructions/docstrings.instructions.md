---
applyTo: "**/*.py"
---

# Python Docstrings Instructions

When generating or updating Python docstrings, follow these guidelines:

## Docstring Style
- Use **Google-style docstrings**.
- Always use **triple double quotes** (`"""`).
- Place the docstring immediately after the function, method, or class definition.

## Content Rules
- Start with a **one-line summary** in the imperative mood (e.g. “Compute”, “Return”, “Load”).
- Leave a blank line after the summary before additional details.
- Keep descriptions clear, concise, and implementation-agnostic.

## Functions and Methods
Include the following sections when applicable:
- `Args:` list parameter names and descriptions **without types**
- `Returns:` describe the return value **without types**
- `Raises:` only if the function explicitly raises exceptions

Example:
```python
def add(a: int, b: int) -> int:
    """Add two integers.

    Args:
        a: First integer.
        b: Second integer.

    Returns:
        The sum of the two integers.
    """
```

## Classes

- Describe the purpose and responsibility of the class.
- Document constructor parameters in the class docstring if they define the public API.
- Do not include attribute types in docstrings.

## General Guidelines

- Do not include types in docstrings; rely on Python type hints instead.
- Do not restate obvious information from the function signature.
- Avoid redundancy and overly verbose explanations.
- Keep formatting consistent and PEP 257–compliant.
- Prefer clarity over cleverness.
