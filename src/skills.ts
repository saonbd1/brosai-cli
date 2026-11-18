// Skill management: list/add/remove skills stored as <dir>/SKILL.md.
// Global skills live in ~/.brosai/skills, project skills in <cwd>/.brosai/skills.
// Both are auto-loaded into the system prompt by loadContextFiles() in prompt.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brosDir } from "./config.ts";

export interface SkillInfo {
  name: string;
  scope: "global" | "project";
  path: string;
  description: string;
  chars: number;
}

export function globalSkillsDir(): string {
  return join(brosDir(), "skills");
}

export function projectSkillsDir(cwd: string): string {
  return join(resolve(cwd), ".brosai", "skills");
}

function sanitizeName(name: string): string {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!n || n === "." || n === "..") throw new Error("Invalid skill name");
  return n;
}

/** Extract a one-line description from SKILL.md: frontmatter `description:` or first prose line. */
function describe(content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (d) return d[1].slice(0, 120);
  }
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith("---") && !t.startsWith("name:") && !t.startsWith("description:")) {
      return t.slice(0, 120);
    }
  }
  return "";
}

function scanDir(dir: string, scope: "global" | "project"): SkillInfo[] {
  const out: SkillInfo[] = [];
  try {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const skillFile = join(dir, entry, "SKILL.md");
      try {
        if (!statSync(skillFile).isFile()) continue;
        const content = readFileSync(skillFile, "utf8");
        out.push({ name: entry, scope, path: skillFile, description: describe(content), chars: content.length });
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(cwd: string): SkillInfo[] {
  return [...scanDir(globalSkillsDir(), "global"), ...scanDir(projectSkillsDir(cwd), "project")];
}

export function getSkill(cwd: string, name: string): SkillInfo | null {
  const n = sanitizeName(name);
  for (const s of listSkills(cwd)) if (s.name === n) return s;
  return null;
}

export function readSkillFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Write a skill. `content` is the SKILL.md body; frontmatter is added if absent.
 * scope "project" writes under <cwd>/.brosai/skills, "global" under ~/.brosai/skills.
 */
export function saveSkill(cwd: string, name: string, content: string, scope: "global" | "project" = "global"): SkillInfo {
  const n = sanitizeName(name);
  let body = content.trim();
  if (!body) throw new Error("Skill content is empty");
  if (!/^---\s*\n/.test(body)) {
    body = `---\nname: ${n}\ndescription: ${describe(body) || n}\n---\n\n${body}`;
  }
  const dir = scope === "project" ? projectSkillsDir(cwd) : globalSkillsDir();
  const skillDir = join(dir, n);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, body, { mode: 0o600 });
  return { name: n, scope, path, description: describe(body), chars: body.length };
}

export function removeSkill(cwd: string, name: string): boolean {
  const s = getSkill(cwd, name);
  if (!s) return false;
  rmSync(join(s.path, ".."), { recursive: true, force: true });
  return true;
}
