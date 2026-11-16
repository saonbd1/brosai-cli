import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BinaryFileError, grepWorkspace, globMatcher, listWorkspaceFiles, readBodyCapped, readLineRange, runShell } from "./fast.ts";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  approve?: (cmd: string) => Promise<boolean> | boolean;
  todos?: TodoItem[];
  /** When set, only these tool defs may execute (plan mode, MCP bridge). */
  toolDefs?: ToolDef[];
  /** Spawn a child agent (fresh context). Injected by the CLI; absent in plan mode/children. */
  subagent?: (prompt: string, readOnly: boolean) => Promise<string>;
  /** Aborts long-running tools (shell, fetch) when the user cancels. */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

const MAX_OUTPUT = 30_000;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} chars]`;
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Resolve symlinks on the deepest existing ancestor so links can't point out of the workspace. */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
      cur = parent;
    }
  }
}

export function safePath(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
  if (!isInside(ctx.cwd, abs)) throw new Error(`Path escapes workspace: ${p}`);
  if (!isInside(realish(ctx.cwd), realish(abs))) throw new Error(`Path escapes workspace via symlink: ${p}`);
  return abs;
}

/** Atomic write that keeps the existing file's permission bits (e.g. the +x on scripts). */
function writeAtomic(p: string, content: string): void {
  let mode = 0o666;
  try { mode = statSync(p).mode & 0o777; } catch {}
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  renameSync(tmp, p);
}

function lineSlice(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n");
}

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a text file with line numbers (max 2000 lines per call; page with offset/limit). Rejects binary files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "1-based start line" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const p = safePath(ctx, args.path);
      if (!existsSync(p)) return { ok: false, output: `File not found: ${args.path}` };
      if (statSync(p).isDirectory()) return { ok: false, output: `${args.path} is a directory; use list_dir` };
      try {
        const r = readLineRange(p, Number(args.offset) || 1, Number(args.limit) || 2000);
        if (!r.lines.length) return { ok: true, output: r.size === 0 ? "(empty file)" : `(no lines in range; file has fewer than ${r.first} lines)` };
        const body = r.lines.map((l, i) => `${r.first + i}\t${l}`).join("\n");
        const next = r.first + r.lines.length;
        return { ok: true, output: r.more ? `${body}\n…[more lines available; continue with offset=${next}]` : body };
      } catch (e) {
        if (e instanceof BinaryFileError) return { ok: false, output: `${args.path}: ${e.message}; not read` };
        throw e;
      }
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const p = safePath(ctx, args.path);
      mkdirSync(dirname(p), { recursive: true });
      writeAtomic(p, args.content);
      return { ok: true, output: `Wrote ${relative(ctx.cwd, p)} (${args.content.length} bytes)` };
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file. Fails if old_string is missing or not unique.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const p = safePath(ctx, args.path);
      if (!existsSync(p)) return { ok: false, output: `File not found: ${args.path}` };
      const content = readFileSync(p, "utf8");
      let oldS: string = args.old_string, newS: string = args.new_string;
      // CRLF files: the model sees/produces LF-only text, so match and write in the file's own line endings
      if (content.includes("\r\n") && !oldS.includes("\r\n") && oldS.includes("\n")) {
        oldS = oldS.replace(/\n/g, "\r\n"); newS = newS.replace(/\r?\n/g, "\r\n");
      }
      if (!oldS) return { ok: false, output: "old_string must not be empty" };
      const first = content.indexOf(oldS);
      if (first < 0) return { ok: false, output: "old_string not found in file" };
      if (content.indexOf(oldS, first + oldS.length) >= 0) {
        let count = 2, at = content.indexOf(oldS, first + oldS.length);
        while ((at = content.indexOf(oldS, at + oldS.length)) >= 0) count++;
        return { ok: false, output: `old_string appears ${count} times; provide more context` };
      }
      // slice-splice: no regex/replacement-pattern semantics at all
      writeAtomic(p, content.slice(0, first) + newS + content.slice(first + oldS.length));
      return { ok: true, output: `Edited ${relative(ctx.cwd, p)}` };
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace (stdin closed). Returns output and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.approve && !(await ctx.approve(args.command))) return { ok: false, output: "Command denied by user" };
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120_000, 1000), 600_000);
      const r = await runShell(String(args.command), ctx.cwd, timeout, ctx.signal);
      const notes = [r.timedOut ? `[timed out after ${Math.round(timeout / 1000)}s and killed]` : "", r.cancelled ? "[cancelled]" : ""].filter(Boolean).join("\n");
      return {
        ok: r.code === 0 && !r.timedOut && !r.cancelled,
        output: `$ ${args.command}\n${r.stdout}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}\n${notes ? notes + "\n" : ""}[exit ${r.code}]`,
      };
    },
  },
  {
    name: "glob",
    description: "Find workspace files by glob, e.g. 'src/**/*.ts' or '*.ts' (any depth). Respects .gitignore.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const files = await listWorkspaceFiles(ctx.cwd, ctx.cwd);
      const match = globMatcher(globToRegex, String(args.pattern));
      const hits: string[] = [];
      let total = 0;
      for (const f of files) if (match(f)) { total++; if (hits.length < 500) hits.push(f); }
      if (!total) return { ok: true, output: "No matches" };
      return { ok: true, output: hits.join("\n") + (total > hits.length ? `\n…[${total - hits.length} more matches; narrow the pattern]` : "") };
    },
  },
  {
    name: "list_dir",
    description: "List directory contents (name, type, size). Optional recursive walk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const p = safePath(ctx, args.path ?? ".");
      if (!existsSync(p)) return { ok: false, output: `Not found: ${args.path ?? "."}` };
      const st = statSync(p);
      if (!st.isDirectory()) return { ok: true, output: `${relative(ctx.cwd, p)}  (${st.size} bytes)` };
      const lines: string[] = [];
      const walk = (dir: string, depth: number, prefix: string) => {
        if (lines.length > 500 || depth > 8) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (e.name === ".git" || (e.name.startsWith(".") && e.name !== ".env.example")) continue;
          const full = join(dir, e.name);
          const rel = relative(ctx.cwd, full);
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`);
            if (args.recursive) walk(full, depth + 1, prefix + "  ");
          } else {
            let size = "";
            try { size = `  ${statSync(full).size}B`; } catch {}
            lines.push(`${prefix}${e.name}${size}`);
          }
          if (lines.length > 500) return;
        }
      };
      walk(p, 0, "");
      const more = lines.length > 500 ? "\n…[listing truncated at 500 entries; list a subdirectory]" : "";
      return { ok: true, output: clip(lines.length ? lines.slice(0, 500).join("\n") + more : "(empty directory)") };
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file/dir within the workspace.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const src = safePath(ctx, args.from);
      const dst = safePath(ctx, args.to);
      if (!existsSync(src)) return { ok: false, output: `Not found: ${args.from}` };
      if (existsSync(dst)) return { ok: false, output: `Destination exists: ${args.to}` };
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      return { ok: true, output: `Moved ${relative(ctx.cwd, src)} -> ${relative(ctx.cwd, dst)}` };
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its text content (HTML stripped). Read-only.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "integer" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      let u: URL;
      try { u = new URL(args.url); } catch { return { ok: false, output: `Bad URL: ${args.url}` }; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, output: "Only http/https URLs allowed" };
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
        if (!res.ok) return { ok: false, output: `HTTP ${res.status} for ${u}` };
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml") && !ct.includes("html")) {
          return { ok: false, output: `Unsupported content-type: ${ct} (only text-like content)` };
        }
        const body = await readBodyCapped(res, 2_000_000);
        let text = body.text;
        if (ct.includes("html") || /<html|<body|<div/i.test(text.slice(0, 2000))) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
        }
        const max = Math.min(args.max_chars ?? 30_000, 100_000);
        const note = body.truncated ? "\n…[page larger than 2 MB; only the beginning was read]" : "";
        return { ok: true, output: clip(text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text + note) };
      } catch (e) {
        return { ok: false, output: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
  {
    name: "apply_patch",
    description: "Apply a Codex-style patch to files in the workspace. Format:\n*** Begin Patch\n*** Add File: path\n+line\n*** Update File: path\n@@ optional context\n context_line\n-old_line\n+new_line\n*** Delete File: path\n*** Move to: newpath (after Update File)\n*** End Patch",
    parameters: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const r = applyPatch(String(args.patch ?? ""), ctx);
        return { ok: r.errors.length === 0, output: [...r.applied, ...r.errors].join("\n") || "Patch applied (no changes)" };
      } catch (e) {
        return { ok: false, output: `Patch failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
  {
    name: "connect_service",
    description: "Connect an external service via OAuth device flow (currently 'github'); shows the user a code to authorize.",
    parameters: {
      type: "object",
      properties: { service: { type: "string", enum: ["github"], description: "Service to connect" } },
      required: ["service"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (args.service !== "github") return { ok: false, output: `Unsupported service: ${args.service}` };
      try {
        const { connectGitHub } = await import("../services.ts");
        const msg = await connectGitHub();
        return { ok: true, output: msg };
      } catch (e) {
        return { ok: false, output: `Connect failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
  {
    name: "todo_write",
    description: "Replace the session task list. Use to plan multi-step work and track progress.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const next: TodoItem[] = (Array.isArray(args.todos) ? args.todos : []).slice(0, 50).map((t: any) => ({
        content: String(t?.content ?? "").slice(0, 300),
        status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
      })).filter((t: TodoItem) => t.content);
      if (ctx.todos) { ctx.todos.length = 0; ctx.todos.push(...next); }
      else ctx.todos = next;
      const todos = ctx.todos;
      const done = todos.filter((t) => t.status === "completed").length;
      const active = todos.find((t) => t.status === "in_progress");
      return { ok: true, output: `Todos updated: ${done}/${todos.length} completed${active ? `, active: ${active.content}` : ""}` };
    },
  },
  {
    name: "grep",
    description: "Regex search of file contents (ripgrep if installed). Returns path:line:text.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string", description: "e.g. '*.ts'" },
        ignore_case: { type: "boolean" },
        context: { type: "integer", description: "Context lines (max 10)" },
        files_only: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      try { new RegExp(args.pattern); } catch (e) {
        // JS regex rejected it; ripgrep may still accept it (e.g. (?i) flags), so only fail when rg is unavailable
        if (!(await import("./fast.ts")).hasRipgrep()) return { ok: false, output: `Bad regex: ${e}` };
      }
      const abs = args.path ? safePath(ctx, args.path) : ctx.cwd;
      if (!existsSync(abs)) return { ok: false, output: `Not found: ${args.path}` };
      const target = relative(ctx.cwd, abs) || ".";
      const out = await grepWorkspace({
        pattern: String(args.pattern), cwd: ctx.cwd, target, glob: args.glob ? String(args.glob) : undefined,
        ignoreCase: args.ignore_case === true, context: Math.max(0, Number(args.context) || 0), filesOnly: args.files_only === true,
        maxResults: 300, signal: ctx.signal,
      }, globToRegex, abs);
      return { ok: true, output: clip(out) };
    },
  },
  {
    name: "spawn_agent",
    description: "Delegate a self-contained subtask to a sub-agent with fresh context; returns its final report.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instructions" },
        read_only: { type: "boolean", description: "Read-only tools (explore/research)" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.subagent) return { ok: false, output: "Sub-agents are not available here" };
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { ok: false, output: "spawn_agent requires a prompt" };
      const out = await ctx.subagent(prompt, args.read_only === true);
      return { ok: true, output: clip(out || "(sub-agent returned no output)") };
    },
  },
];

export function toolSpecs() {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = (ctx.toolDefs ?? TOOLS).find((t) => t.name === name);
  if (!tool) return { ok: false, output: `Unknown tool: ${name}` };
  let args: any;
  try { args = JSON.parse(argsJson || "{}"); } catch (e) {
    return { ok: false, output: `Invalid JSON arguments: ${e}` };
  }
  try {
    return await tool.execute(args, ctx);
  } catch (e) {
    return { ok: false, output: `Tool error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

interface PatchResult {
  applied: string[];
  errors: string[];
}

/** Parse and apply a Codex-style patch. All paths are sandboxed to ctx.cwd. */
function applyPatch(patch: string, ctx: ToolContext): PatchResult {
  const applied: string[] = [];
  const errors: string[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");

  if (!lines.some((l) => l.trim() === "*** Begin Patch")) {
    return { applied, errors: ["Missing '*** Begin Patch' marker"] };
  }

  type Op = { kind: "add" | "del" | "ctx"; text: string };
  interface Section { action: "add" | "update" | "delete"; path: string; moveTo?: string; hunks: Op[][] }
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Op[] | null = null;
  let inHunks = false;

  const flushHunk = () => { if (cur && curHunk) { cur.hunks.push(curHunk); curHunk = null; } };

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (t === "*** Begin Patch" || t === "*** End Patch") continue;
    const m = t.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/);
    if (m) {
      flushHunk();
      cur = { action: m[1].toLowerCase() as Section["action"], path: m[2].trim(), hunks: [] };
      sections.push(cur);
      inHunks = false;
      continue;
    }
    const mv = t.match(/^\*\*\* Move to:\s*(.+)$/);
    if (mv && cur) { cur.moveTo = mv[1].trim(); continue; }
    if (!cur) continue;
    if (cur.action === "add") {
      if (t.startsWith("***")) continue;
      if (!cur.hunks.length && !curHunk) cur.hunks.push([]);
      const h = cur.hunks[cur.hunks.length - 1];
      if (line.startsWith("+")) h.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith(" ")) h.push({ kind: "ctx", text: line.slice(1) });
      else h.push({ kind: "add", text: line }); // tolerate unprefixed lines in Add File
      continue;
    }
    if (cur.action === "delete") continue;
    // update file
    if (t.startsWith("@@")) {
      flushHunk();
      curHunk = [];
      inHunks = true;
      continue;
    }
    if (inHunks && curHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) curHunk.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-") && !line.startsWith("---")) curHunk.push({ kind: "del", text: line.slice(1) });
      else if (line.startsWith(" ")) curHunk.push({ kind: "ctx", text: line.slice(1) });
      else if (line === "") curHunk.push({ kind: "ctx", text: "" });
      else if (t.startsWith("***")) { flushHunk(); inHunks = false; }
    } else if (!inHunks && cur.hunks.length === 0 && line.trim() !== "") {
      // update section without @@ markers: treat whole body as one hunk
      curHunk = curHunk ?? [];
      inHunks = true;
      if (line.startsWith("+")) curHunk.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-")) curHunk.push({ kind: "del", text: line.slice(1) });
      else if (line.startsWith(" ")) curHunk.push({ kind: "ctx", text: line.slice(1) });
      else curHunk.push({ kind: "ctx", text: line });
    }
  }
  flushHunk();

  // First pass: validate all paths before touching anything
  for (const s of sections) {
    try {
      safePath(ctx, s.path);
      if (s.moveTo) safePath(ctx, s.moveTo);
    } catch (e) {
      errors.push(`${s.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length) return { applied, errors };

  // Second pass: apply
  for (const s of sections) {
    try {
      const p = safePath(ctx, s.path);
      if (s.action === "add") {
        if (existsSync(p)) { errors.push(`${s.path}: already exists`); continue; }
        const content = s.hunks.flat().filter((o) => o.kind !== "del").map((o) => o.text).join("\n") + "\n";
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, "utf8");
        applied.push(`+ ${relative(ctx.cwd, p)}`);
      } else if (s.action === "delete") {
        if (!existsSync(p)) { errors.push(`${s.path}: not found`); continue; }
        
        unlinkSync(p);
        applied.push(`- ${relative(ctx.cwd, p)}`);
      } else {
        if (!existsSync(p)) { errors.push(`${s.path}: not found`); continue; }
        const orig = readFileSync(p, "utf8").split("\n");
        const out: string[] = [];
        let pos = 0;
        let failed = false;
        for (const hunk of s.hunks) {
          // find anchor: first ctx/del op must match somewhere at/after pos
          const anchorIdx = hunk.findIndex((o) => o.kind !== "add");
          const anchor = anchorIdx >= 0 ? hunk[anchorIdx] : null;
          let start = pos;
          if (anchor) {
            // scan forward for a position where anchor matches
            let found = -1;
            for (let i = pos; i <= orig.length; i++) {
              if (orig[i] === anchor.text) {
                // verify the full expected ctx/del sequence matches consecutively
                let ok = true, j = i;
                for (const o of hunk) {
                  if (o.kind === "add") continue;
                  if (j >= orig.length || orig[j] !== o.text) { ok = false; break; }
                  j++;
                }
                if (ok) { found = i; break; }
              }
            }
            if (found < 0) { errors.push(`${s.path}: hunk context not found`); failed = true; break; }
            start = found;
          }
          // emit everything up to start, then apply hunk
          out.push(...orig.slice(pos, start));
          let filePos = start;
          for (const o of hunk) {
            if (o.kind === "ctx") {
              if (orig[filePos] !== o.text) { errors.push(`${s.path}: context mismatch near line ${filePos + 1}`); failed = true; break; }
              out.push(o.text); filePos++;
            } else if (o.kind === "del") {
              if (orig[filePos] !== o.text) { errors.push(`${s.path}: delete mismatch near line ${filePos + 1}`); failed = true; break; }
              filePos++;
            } else {
              out.push(o.text);
            }
          }
          if (failed) break;
          pos = filePos;
        }
        if (failed) continue;
        out.push(...orig.slice(pos));
        let content = out.join("\n");
        if (orig.at(-1) === "" && !content.endsWith("\n")) content += "\n";
        const dst = s.moveTo ? safePath(ctx, s.moveTo) : p;
        if (s.moveTo) {
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, content, "utf8");
          
          unlinkSync(p);
          applied.push(`${relative(ctx.cwd, p)} -> ${relative(ctx.cwd, dst)}`);
        } else {
          writeAtomic(p, content);
          applied.push(`~ ${relative(ctx.cwd, p)}`);
        }
      }
    } catch (e) {
      errors.push(`${s.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, errors };
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
