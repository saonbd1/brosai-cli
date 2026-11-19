---
name: deep-research
description: Systematic multi-source research. Decompose a question, run parallel web searches, fetch and cross-check sources, and produce a cited report. Use for "research X", "deep dive", "find out about", comparisons, or anything needing more than one source.
---

# Deep Research

Produce thorough, cited research — not a quick answer. Follow this workflow:

## 1. Decompose
Break the user's question into 3–6 distinct sub-questions or angles (definitions, history, current state, comparisons, controversies, practical implications). State the plan briefly, then execute — don't ask permission unless genuinely ambiguous.

## 2. Search broadly
Run `web_search` for each angle with varied phrasings (at least 2–3 queries per angle for important topics). Prefer recent sources for fast-moving subjects; include primary sources (docs, papers, official sites) over blogs when possible.

## 3. Fetch and verify
Use `web_fetch` on the most promising results (aim for 5–15 sources total). Skip paywalls/JS-heavy pages that fail. Extract concrete facts, numbers, dates, and quotes — note which source says what.

## 4. Cross-check
Flag contradictions between sources explicitly. Prefer primary > reputable secondary > community sources. If sources disagree, present both positions with attribution.

## 5. Synthesize
Write the final report:
- **Summary** — 2–3 sentence direct answer up front
- **Findings** — organized by theme/sub-question, dense and factual
- **Sources** — every claim traceable; cite as [n] with a source list at the end (title + URL)
- **Gaps/uncertainty** — what couldn't be verified, conflicting evidence, or missing data

## Rules
- Never invent citations — only cite URLs you actually fetched or saw in search results.
- Distinguish fact from opinion/speculation clearly.
- Keep it dense: facts and structure over filler. Tables for comparisons.
- If the user asked for a file, save the report to the workspace with `write_file`.
