---
name: commit-style
description: Write git commits in the BrosAi repo style — concise, why-focused, Devin trailer
---

# BrosAi commit style

Use when creating commits in the BrosAi repository (or repos following the same convention).

## Format

```
<type>: <short imperative summary>

<optional body — explain WHY, not what>

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
```

## Rules

- Subject line ≤ 72 chars, imperative mood, lowercase after the type prefix.
- Common prefixes seen in this repo: plain summaries work too (`Add ...`, `Fix ...`, `docs: ...`). Match `git log --oneline -10` before committing.
- Body only when the "why" is non-obvious — bug fixes, behavior changes, design decisions.
- Never commit secrets, API keys, or `~/.brosai/` contents.
- Never force-push or rewrite history.
- Do not commit unless the user asked for a commit (or the task implies it, e.g. a release).
- If pre-commit hooks modify files and the commit fails, re-stage and retry once.

## Before committing

Run in parallel: `git status`, `git diff`, `git log -5` to match style and confirm only intended files are staged.
