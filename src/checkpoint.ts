import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { brosDir } from "./config.ts";

export interface Checkpoint {
  hash: string;
  parent: string | null;
  label: string;
  time: string;
}

interface CheckpointMeta {
  cwd: string;
  commits: Checkpoint[];
}

let gitOk: boolean | null = null;

function gitAvailable(): boolean {
  if (gitOk !== null) return gitOk;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  return gitOk;
}

function checkpointRoot(): string {
  const d = join(brosDir(), "checkpoints");
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function slugFor(cwd: string): string {
  return createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
}

function gitDirFor(cwd: string): string {
  return join(checkpointRoot(), "repos", `${slugFor(cwd)}.git`);
}

function metaPath(cwd: string): string {
  return join(checkpointRoot(), `${slugFor(cwd)}.json`);
}

function readMeta(cwd: string): CheckpointMeta {
  try {
    const d = JSON.parse(readFileSync(metaPath(cwd), "utf8"));
    if (d && Array.isArray(d.commits)) return d as CheckpointMeta;
  } catch {}
  return { cwd: resolve(cwd), commits: [] };
}

function writeMeta(cwd: string, meta: CheckpointMeta): void {
  const p = metaPath(cwd);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function gitEnv(gitdir: string, cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: gitdir,
    GIT_WORK_TREE: cwd,
    GIT_AUTHOR_NAME: "brosai",
    GIT_AUTHOR_EMAIL: "brosai@local",
    GIT_COMMITTER_NAME: "brosai",
    GIT_COMMITTER_EMAIL: "brosai@local",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(gitdir: string, cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile("git", args, { env: gitEnv(gitdir, cwd), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function ensureRepo(cwd: string): string | null {
  if (!gitAvailable()) return null;
  const gitdir = gitDirFor(cwd);
  if (!existsSync(join(gitdir, "HEAD"))) {
    mkdirSync(join(checkpointRoot(), "repos"), { recursive: true, mode: 0o700 });
    const init = execFileSyncSafe("git", ["init", "--bare", gitdir]);
    if (init !== 0) return null;
    // Allow work-tree operations against this dir via GIT_WORK_TREE
    execFileSyncSafe("git", ["--git-dir", gitdir, "config", "core.bare", "false"]);
    // Default excludes on top of the workspace's own .gitignore files
    const excludeDir = join(gitdir, "info");
    mkdirSync(excludeDir, { recursive: true });
    writeFileSync(
      join(excludeDir, "exclude"),
      ["node_modules/", ".git/", "dist/", "build/", ".next/", "target/", "*.tmp-*"].join("\n") + "\n",
    );
  }
  return gitdir;
}

function execFileSyncSafe(cmd: string, args: string[]): number {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return 0;
  } catch {
    return 1;
  }
}

/** Snapshot the workspace before a turn. Returns commit hash or null if unavailable. */
export async function createCheckpoint(cwd: string, label: string): Promise<Checkpoint | null> {
  const gitdir = ensureRepo(cwd);
  if (!gitdir) return null;
  const add = await git(gitdir, cwd, ["add", "-A"]);
  if (add.code !== 0) return null;
  const tree = await git(gitdir, cwd, ["write-tree"]);
  if (tree.code !== 0 || !tree.stdout.trim()) return null;
  const meta = readMeta(cwd);
  const parent = meta.commits.at(-1)?.hash ?? null;
  const args = ["commit-tree", tree.stdout.trim(), "-m", label.slice(0, 200)];
  if (parent) args.push("-p", parent);
  const commit = await git(gitdir, cwd, args);
  if (commit.code !== 0 || !commit.stdout.trim()) return null;
  const cp: Checkpoint = { hash: commit.stdout.trim(), parent, label, time: new Date().toISOString() };
  meta.commits.push(cp);
  writeMeta(cwd, meta);
  return cp;
}

export function listCheckpoints(cwd: string): Checkpoint[] {
  return readMeta(cwd).commits;
}

const DIFF_MAX = 30_000;

/** Diff of the worktree against the most recent checkpoint (all changes since last turn began). */
export async function workspaceDiff(cwd: string): Promise<string | null> {
  const gitdir = ensureRepo(cwd);
  if (!gitdir) return null;
  const last = readMeta(cwd).commits.at(-1);
  if (!last) return null;
  await git(gitdir, cwd, ["add", "-A"]);
  const d = await git(gitdir, cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", last.hash]);
  if (d.code !== 0) return `git diff failed: ${d.stderr.trim()}`;
  const out = d.stdout.trim();
  if (!out) return "no changes since last checkpoint";
  return out.length > DIFF_MAX ? out.slice(0, DIFF_MAX) + `\n…[truncated ${out.length - DIFF_MAX} chars]` : out;
}

/**
 * Restore workspace to the state captured by the most recent checkpoint.
 * Repeats `steps` times to undo multiple turns. Returns restored checkpoint or null.
 */
export async function undoCheckpoint(cwd: string, steps = 1): Promise<Checkpoint | null> {
  const gitdir = ensureRepo(cwd);
  if (!gitdir) return null;
  const meta = readMeta(cwd);
  let last: Checkpoint | null = null;
  for (let i = 0; i < steps; i++) {
    const cp = meta.commits.pop();
    if (!cp) break;
    last = cp;
    // index := checkpoint tree, then write all files back, then remove anything untracked
    await git(gitdir, cwd, ["read-tree", cp.hash]);
    await git(gitdir, cwd, ["checkout-index", "-f", "-a"]);
    await git(gitdir, cwd, ["clean", "-fd"]);
  }
  writeMeta(cwd, meta);
  return last;
}
