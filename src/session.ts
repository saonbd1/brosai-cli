import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { brosDir } from "./config.ts";
import type { ChatMessage } from "./providers/index.ts";

export interface SavedSession {
  version: 1;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  cwd: string;
  history: ChatMessage[];
}

export function sessionDir(): string {
  const d = join(brosDir(), "sessions");
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function sessionFile(name: string): string {
  return join(sessionDir(), name.endsWith(".json") ? name : `${name}.json`);
}

export function saveSession(s: Omit<SavedSession, "version" | "createdAt" | "updatedAt"> & { file?: string }): string {
  const dir = sessionDir();
  const now = new Date().toISOString();
  let file = s.file;
  let createdAt = now;
  if (file && existsSync(sessionFile(file))) {
    try {
      const prev = JSON.parse(readFileSync(sessionFile(file), "utf8"));
      createdAt = prev.createdAt ?? now;
    } catch {}
  } else {
    const stamp = now.replace(/[:.]/g, "-");
    file = `${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
  }
  const data: SavedSession = { version: 1, createdAt, updatedAt: now, provider: s.provider, model: s.model, cwd: s.cwd, history: s.history };
  const p = sessionFile(file);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, p);
  return file;
}

export function loadSession(file?: string): SavedSession | null {
  try {
    let p: string;
    if (file) {
      p = sessionFile(file);
      if (!existsSync(p)) return null;
    } else {
      const files = readdirSync(sessionDir()).filter((f) => f.endsWith(".json")).sort();
      if (!files.length) return null;
      p = join(sessionDir(), files[files.length - 1]);
    }
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (d?.version !== 1 || !Array.isArray(d.history)) return null;
    return d as SavedSession;
  } catch {
    return null;
  }
}

export function listSessions(): { file: string; updatedAt: string; provider: string; model: string; cwd: string; turns: number }[] {
  try {
    return readdirSync(sessionDir())
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((f) => {
        try {
          const d = JSON.parse(readFileSync(join(sessionDir(), f), "utf8"));
          return { file: f, updatedAt: d.updatedAt ?? "", provider: d.provider ?? "", model: d.model ?? "", cwd: d.cwd ?? "", turns: d.history?.length ?? 0 };
        } catch { return null; }
      })
      .filter(Boolean) as any;
  } catch {
    return [];
  }
}
