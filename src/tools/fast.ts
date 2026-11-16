/**
 * Performance helpers for the built-in tools. No imports from ./index.ts (avoids a cycle);
 * everything here works on absolute paths and the caller does the sandbox check.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

const tick = () => new Promise<void>((r) => setImmediate(r));

/* ------------------------------------------------------------------ */
/* File listing: `git ls-files` when possible (respects .gitignore, fast), else a stat-free walk */
/* ------------------------------------------------------------------ */

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "target", ".venv", "venv", "__pycache__", ".turbo", ".mypy_cache", ".pytest_cache"]);

const posix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

function gitFiles(base: string): Promise<string[] | null> {
  return new Promise((res) => {
    execFile(
      "git",
      ["-C", base, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 128 * 1024 * 1024, timeout: 15_000, windowsHide: true },
      (err, out) => res(err ? null : String(out).split("\0").filter(Boolean)),
    );
  });
}

async function walkFiles(base: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [base];
  let n = 0;
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let ents: Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name)); }
      else if (e.isFile()) out.push(posix(relative(base, join(dir, e.name))));
      if (++n % 4000 === 0) await tick(); // keep Ctrl+C / timers responsive on huge trees
    }
  }
  return out;
}

/** Files under `base`, as paths relative to `cwd` (posix separators), sorted. Includes dotfiles. */
export async function listWorkspaceFiles(cwd: string, base: string, maxFiles = 300_000): Promise<string[]> {
  const rel = (await gitFiles(base)) ?? (await walkFiles(base, maxFiles));
  const prefix = posix(relative(cwd, base));
  const out = prefix ? rel.map((f) => `${prefix}/${f}`) : rel;
  out.sort();
  return out;
}

/** gitignore-style glob rule: a pattern without "/" matches the basename anywhere. */
export function globMatcher(globToRegex: (g: string) => RegExp, pattern: string): (relPath: string) => boolean {
  const re = globToRegex(pattern);
  if (pattern.includes("/")) return (p) => re.test(p);
  return (p) => re.test(p.slice(p.lastIndexOf("/") + 1));
}

/* ------------------------------------------------------------------ */
/* Line-range reads that never load the whole file; binary detection */
/* ------------------------------------------------------------------ */

export class BinaryFileError extends Error {}

export interface LineRange { lines: string[]; first: number; more: boolean; size: number }

export function readLineRange(path: string, offset: number, limit: number, maxChars = 30_000, maxLineChars = 2000): LineRange {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(65536);
    const start = Math.max(1, offset);
    const end = start + Math.max(1, limit);
    const lines: string[] = [];
    let lineNo = 1, chars = 0, carry: Buffer = Buffer.alloc(0), more = false, firstChunk = true, stop = false;

    const take = (b: Buffer, from: number, to: number): boolean => {
      if (lineNo >= start && lineNo < end) {
        let s = b.toString("utf8", from, to);
        if (s.length > maxLineChars) s = s.slice(0, maxLineChars) + "…[line truncated]";
        if (chars + s.length > maxChars && lines.length) { more = true; return false; }
        lines.push(s); chars += s.length + 8;
      }
      lineNo++;
      return lineNo < end;
    };

    for (; !stop;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      if (firstChunk) {
        firstChunk = false;
        if (buf.subarray(0, Math.min(n, 8000)).includes(0)) throw new BinaryFileError(`binary file (${size} bytes)`);
      }
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0, nl: number;
      while ((nl = chunk.indexOf(10, from)) >= 0) {
        const cont = take(chunk, from, nl);
        from = nl + 1;
        if (!cont) { stop = true; if (!more) more = from < chunk.length || readSync(fd, buf, 0, 1, null) > 0; break; }
      }
      carry = from < chunk.length ? Buffer.from(chunk.subarray(from)) : Buffer.alloc(0);
    }
    if (!stop && carry.length) take(carry, 0, carry.length); // final line without trailing newline
    return { lines, first: start, more, size };
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* Shell runner: no login shell per call, closed stdin, process-group kill, bounded memory */
/* ------------------------------------------------------------------ */

let loginPath: Promise<string | null> | null = null;

/** Resolve the user's login-shell PATH once (so nvm/pyenv/brew tools still work) instead of paying a login shell per command. */
function getLoginPath(): Promise<string | null> {
  if (process.platform === "win32" || process.env.BROSAI_LOGIN_SHELL === "1") return Promise.resolve(null);
  loginPath ??= new Promise((res) => {
    execFile("/bin/bash", ["-lc", "printf '\\n__BROSAI_PATH__%s__END__' \"$PATH\""], { timeout: 6000, windowsHide: true }, (err, out) => {
      const m = /__BROSAI_PATH__([\s\S]*?)__END__/.exec(String(out));
      res(err || !m ? null : m[1].trim() || null);
    });
  });
  return loginPath;
}

class Capture {
  head = ""; tail = ""; dropped = 0; total = 0;
  headMax: number; tailMax: number;
  constructor(headMax: number, tailMax: number) { this.headMax = headMax; this.tailMax = tailMax; }
  push(s: string) {
    this.total += s.length;
    if (this.head.length < this.headMax) { const room = this.headMax - this.head.length; this.head += s.slice(0, room); s = s.slice(room); }
    if (s) {
      this.tail += s;
      if (this.tail.length > this.tailMax * 2) { const cut = this.tail.length - this.tailMax; this.dropped += cut; this.tail = this.tail.slice(cut); }
    }
  }
  text(): string {
    let tail = this.tail, dropped = this.dropped;
    if (tail.length > this.tailMax) { dropped += tail.length - this.tailMax; tail = tail.slice(-this.tailMax); }
    return dropped ? `${this.head}\n…[${dropped} chars omitted]…\n${tail}` : this.head + tail;
  }
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") { execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {}); return; }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  const pid = child.pid;
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 2000).unref();
}

export interface ShellResult { code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }

export async function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  const isWin = process.platform === "win32";
  const lp = await getLoginPath();
  const env = { ...process.env };
  if (lp) {
    const have = new Set((process.env.PATH ?? "").split(":"));
    env.PATH = [...lp.split(":"), ...[...have]].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
  }
  const useLogin = process.env.BROSAI_LOGIN_SHELL === "1";
  const shell = isWin ? "cmd.exe" : "/bin/bash";
  const args = isWin ? ["/d", "/s", "/c", command] : [useLogin ? "-lc" : "-c", command];

  return await new Promise<ShellResult>((resolve) => {
    const child = spawn(shell, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: !isWin, windowsHide: true });
    const out = new Capture(14_000, 14_000), err = new Capture(4_000, 6_000);
    let timedOut = false, cancelled = false, done = false;
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => out.push(d));
    child.stderr!.on("data", (d: string) => err.push(d));

    const finish = (code: number) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      child.stdout!.destroy(); child.stderr!.destroy(); // a leftover background process must not hold us hostage
      resolve({ code, stdout: out.text(), stderr: err.text(), timedOut, cancelled });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => { err.push(String(e.message)); finish(127); });
    // 'exit' fires when the shell ends; give the pipes a moment to drain, then stop waiting (background children keep them open)
    child.on("exit", (code, sig) => { const c = code ?? (sig ? 128 : 1); setTimeout(() => finish(c), 150).unref(); });
    child.on("close", (code, sig) => finish(code ?? (sig ? 128 : 1)));
  });
}

/* ------------------------------------------------------------------ */
/* HTTP body with a byte cap (a 60 MB page must not stall or exhaust memory) */
/* ------------------------------------------------------------------ */

export async function readBodyCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= maxBytes) { truncated = true; await reader.cancel().catch(() => {}); break; }
  }
  return { text: Buffer.concat(parts).subarray(0, maxBytes).toString("utf8"), truncated };
}

/* ------------------------------------------------------------------ */
/* grep: ripgrep when installed (parallel, mmap, gitignore-aware), else an async JS engine */
/* ------------------------------------------------------------------ */

let rgOk: boolean | null = null;
export function hasRipgrep(): boolean {
  if (process.env.BROSAI_NO_RG === "1") return false;
  if (rgOk === null) {
    try { execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 3000 }); rgOk = true; } catch { rgOk = false; }
  }
  return rgOk;
}

export interface GrepOptions {
  pattern: string; cwd: string; target: string /* path relative to cwd or "." */; glob?: string;
  ignoreCase: boolean; context: number; filesOnly: boolean; maxResults: number; signal?: AbortSignal;
}

function runRg(o: GrepOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["--no-heading", "--line-number", "--color", "never", "--hidden", "--no-require-git", "--max-columns", "300", "--max-columns-preview", "-m", "200"];
  for (const d of [".git", ...SKIP_DIRS]) args.push("-g", `!${d}`);
  if (o.glob) args.push("-g", o.glob);
  if (o.ignoreCase) args.push("-i");
  if (o.filesOnly) args.push("--files-with-matches");
  else if (o.context > 0) args.push("-C", String(Math.min(o.context, 10)));
  args.push("-e", o.pattern, "--", o.target);
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", killed = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; if (out.length > 600_000 && !killed) { killed = true; child.kill(); } });
    child.stderr.on("data", (d: string) => { err += d; });
    const to = setTimeout(() => child.kill(), 30_000);
    const ab = () => child.kill();
    o.signal?.addEventListener("abort", ab, { once: true });
    child.on("error", () => { clearTimeout(to); resolve({ code: 2, stdout: out, stderr: "spawn failed" }); });
    child.on("close", (code) => { clearTimeout(to); o.signal?.removeEventListener("abort", ab); resolve({ code: killed ? 0 : (code ?? 2), stdout: out, stderr: err }); });
  });
}

async function jsGrep(o: GrepOptions, files: string[]): Promise<string[]> {
  let re: RegExp, pre: RegExp;
  const flags = o.ignoreCase ? "i" : "";
  re = new RegExp(o.pattern, flags);
  pre = new RegExp(o.pattern, flags + "m"); // whole-file prefilter: rejects non-matching files with one regex call
  const out: string[] = [];
  const ctx = Math.min(o.context, 10);
  let n = 0;
  for (const rel of files) {
    if (out.length >= o.maxResults || o.signal?.aborted) break;
    if (++n % 150 === 0) await tick();
    const abs = join(o.cwd, rel);
    let text: string;
    try {
      const st = statSync(abs);
      if (st.size > 1_500_000 || st.size === 0) continue;
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      text = buf.toString("utf8");
    } catch { continue; }
    if (!pre.test(text)) continue;
    const lines = text.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { hits.push(i); if (o.filesOnly) break; if (hits.length >= 200) break; }
    if (!hits.length) continue;
    if (o.filesOnly) { out.push(rel); continue; }
    const hitSet = new Set(hits);
    let next = 0, first = true;
    for (const h of hits) {
      const from = Math.max(0, h - ctx), to = Math.min(lines.length - 1, h + ctx);
      if (to < next) continue;
      const start = Math.max(from, next);
      if (ctx && !first && start > next) out.push("--");
      for (let i = start; i <= to; i++) {
        const sepc = hitSet.has(i) ? ":" : "-";
        out.push(`${rel}${sepc}${i + 1}${sepc}${lines[i].slice(0, 300)}`);
      }
      next = to + 1; first = false;
    }
  }
  return out;
}

export async function grepWorkspace(o: GrepOptions, globToRegex: (g: string) => RegExp, abs: string): Promise<string> {
  const cap = (lines: string[]) => {
    const shown = lines.slice(0, o.maxResults);
    return shown.join("\n") + (lines.length > o.maxResults ? `\n…[more results omitted; narrow the pattern, path or glob]` : "");
  };
  if (hasRipgrep()) {
    const r = await runRg(o);
    if (r.code === 0 || r.code === 1) {
      const lines = r.stdout.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
      return lines.length && lines[0] !== "" ? cap(lines) : "No matches";
    }
    // exit 2 = e.g. regex syntax rg doesn't support (lookahead, backrefs): fall through to the JS engine
  }
  const files = await listWorkspaceFiles(o.cwd, abs);
  const match = o.glob ? globMatcher(globToRegex, o.glob) : null;
  const lines = await jsGrep(o, match ? files.filter(match) : files);
  return lines.length ? cap(lines) : "No matches";
}
