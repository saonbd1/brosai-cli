import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brosDir } from "./config.ts";

export const SYSTEM_PROMPT = `You are BrosAi, a personal coding agent running in the user's terminal.

You help the user with software engineering tasks by reading, writing, and running code in their workspace.

Rules:
- Work only inside the current workspace directory.
- Use tools to inspect before editing; prefer edit_file over rewriting whole files.
- After making changes, verify them (run tests/build/lint) when feasible.
- Keep final answers concise: what you did, what changed, how to verify.
- If a task is ambiguous, state assumptions briefly and proceed with the most reasonable interpretation.
- Never expose secrets, API keys, or credentials in output.
- Use run_command for shell work; commands run via bash -lc in the workspace root.
- Tool outputs are truncated at ~30k chars; paginate with read_file offset/limit when needed.`;

const MAX_CONTEXT_CHARS = 24_000;
const MAX_FILE_CHARS = 12_000;

function readSafe(p: string): string | null {
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    const t = readFileSync(p, "utf8");
    return t.length > MAX_FILE_CHARS ? t.slice(0, MAX_FILE_CHARS) + "\n…[truncated]" : t;
  } catch {
    return null;
  }
}

function collectMarkdown(dir: string, suffix = ""): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") || (suffix && f === suffix))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Load project/global instructions and skills into the system prompt.
 * Sources (all optional):
 *   <cwd>/AGENTS.md, CLAUDE.md, .brosai/rules/*.md, .brosai/skills/<name>/SKILL.md
 *   ~/.brosai/rules/*.md, ~/.brosai/skills/<name>/SKILL.md
 */
export function loadContextFiles(cwd: string): string {
  const sections: string[] = [];

  const rootFiles = ["AGENTS.md", "CLAUDE.md", ".cursorrules"].map((f) => join(cwd, f));
  for (const p of rootFiles) {
    const t = readSafe(p);
    if (t) sections.push(`### ${p.replace(cwd + "/", "")}\n${t}`);
  }

  const ruleDirs = [join(cwd, ".brosai", "rules"), join(brosDir(), "rules")];
  for (const d of ruleDirs) {
    for (const p of collectMarkdown(d)) {
      const t = readSafe(p);
      if (t) sections.push(`### rules/${p.split("/").pop()}\n${t}`);
    }
  }

  const skillDirs = [join(cwd, ".brosai", "skills"), join(brosDir(), "skills")];
  for (const base of skillDirs) {
    try {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const sk = join(base, entry, "SKILL.md");
        const t = readSafe(sk);
        if (t) sections.push(`### skill: ${entry}\n${t}`);
      }
    } catch {}
  }

  if (!sections.length) return "";
  let out = "\n\n## Project instructions & skills\n\n";
  for (const s of sections) {
    if (out.length + s.length > MAX_CONTEXT_CHARS) { out += "\n…[context truncated]"; break; }
    out += s + "\n\n";
  }
  return out;
}
