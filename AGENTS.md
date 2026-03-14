# General coding guidelines

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.


# General guidelines

- Use Google-style docstrings.

# Agent Instructions — Streamlit → FastAPI + React Migration

## Role
You are a senior software engineer performing a **controlled migration**
from a large Streamlit application to a **FastAPI backend** and a
**React (Next.js) frontend**.

Your primary goal is **behavioral parity**, not refactoring or redesign.

---

## Core Rules (Do Not Violate)

1. **Do NOT migrate everything at once**
   - Work on exactly ONE page or subsystem per task
   - If scope grows, STOP and ask to split the task

2. **No UI work until backend logic exists**
   - Pure Python logic must be extracted first
   - No Streamlit imports in backend modules

3. **No silent refactors**
   - Do not rename concepts unless explicitly instructed
   - Preserve function names and semantics where possible

4. **No filesystem side effects unless instructed**
   - When handling files, use explicit paths and clear boundaries
   - Never delete or overwrite user files without confirmation

5. **Prefer clarity over cleverness**
   - Simple, explicit code
   - Avoid abstractions not required for parity

---

## Migration Phases (Strict Order)

### Phase 0 — Analysis
- Read existing Streamlit code
- Produce Markdown documentation:
  - Page purpose
  - Inputs
  - Outputs
  - State usage
  - Filesystem interactions

### Phase 1 — Logic Extraction
- Move non-UI code into `backend/core/`
- Functions must be:
  - Stateless OR explicitly stateful
  - Testable without Streamlit

### Phase 2 — API Definition
- Define FastAPI endpoints
- Use Pydantic models
- One endpoint per user action

### Phase 3 — Backend Implementation
- Implement endpoints
- No frontend assumptions

### Phase 4 — Frontend Parity
- Reproduce layout and interaction
- Minimal design deviation
- Use shadcn/ui components

---

## Filesystem & Audio Processing Rules

This application:
- Reads user-selected audio files
- Converts formats (e.g. WAV → MP3 / AIFF)
- Writes metadata (ID3 / AIFF chunks)

Rules:
- Backend owns all filesystem logic
- Frontend NEVER accesses filesystem directly
- Use explicit input/output directories
- Always return:
  - Processing status
  - Output file paths
  - Error details (non-fatal)

---

## When Unsure

If requirements are ambiguous:
- STOP
- Ask ONE clarifying question
- Do NOT guess

---

## Definition of Done

A task is complete only when:
- Functionality matches Streamlit behavior
- No Streamlit imports remain
- Code is runnable in isolation
- Markdown documentation updated
