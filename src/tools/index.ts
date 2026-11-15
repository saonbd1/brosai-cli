import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolContext {
  cwd: string;
  approve?: (cmd: string) => Promise<boolean> | boolean;
  todos?: TodoItem[];
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

function safePath(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
  const rel = relative(ctx.cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return abs;
}

function lineSlice(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n");
}

export const TOOLS = [
  {
    name: "read_file",
    description: "Read a text file from the workspace. Returns line-numbered content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        offset: { type: "integer", description: "1-based line to start from" },
        limit: { type: "integer", description: "Max lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const p = safePath(ctx, args.path);
      if (!existsSync(p)) return { ok: false, output: `File not found: ${args.path}` };
      return { ok: true, output: clip(lineSlice(readFileSync(p, "utf8"), args.offset, args.limit)) };
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
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, args.content, "utf8");
      renameSync(tmp, p);
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
      const count = content.split(args.old_string).length - 1;
      if (count === 0) return { ok: false, output: "old_string not found in file" };
      if (count > 1) return { ok: false, output: `old_string appears ${count} times; provide more context` };
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, content.replace(args.old_string, args.new_string), "utf8");
      renameSync(tmp, p);
      return { ok: true, output: `Edited ${relative(ctx.cwd, p)}` };
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace. Returns stdout+stderr and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "Default 120000" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.approve && !(await ctx.approve(args.command))) return { ok: false, output: "Command denied by user" };
      const timeout = Math.min(args.timeout_ms ?? 120_000, 600_000);
      const isWin = process.platform === "win32";
      const shell = isWin ? "cmd.exe" : "/bin/bash";
      const shellArgs = isWin ? ["/d", "/s", "/c", args.command] : ["-lc", args.command];
      return await new Promise((resolvePromise) => {
        execFile(shell, shellArgs, { cwd: ctx.cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          resolvePromise({ ok: code === 0, output: clip(`$ ${args.command}\n${stdout ?? ""}${stderr ? "\n[stderr]\n" + stderr : ""}\n[exit ${code}]`) });
        });
      });
    },
  },
  {
    name: "glob",
    description: "List files matching a glob pattern under the workspace (e.g. 'src/**/*.ts').",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const results: string[] = [];
      const regex = globToRegex(args.pattern);
      const skip = new Set(["node_modules", ".git", "dist", ".next", "target", ".venv", "__pycache__"]);
      const walk = (dir: string, depth: number) => {
        if (depth > 12 || results.length > 500) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (skip.has(name) || name.startsWith(".")) continue;
          const full = join(dir, name);
          try {
            if (statSync(full).isDirectory()) walk(full, depth + 1);
            else if (regex.test(relative(ctx.cwd, full))) results.push(relative(ctx.cwd, full));
          } catch {}
          if (results.length > 500) return;
        }
      };
      walk(ctx.cwd, 0);
      return { ok: true, output: results.length ? results.join("\n") : "No matches" };
    },
  },
  {
    name: "list_dir",
    description: "List directory contents (name, type, size). Optional recursive walk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace (default: root)" },
        recursive: { type: "boolean", description: "Recurse into subdirectories (default false)" },
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
      return { ok: true, output: clip(lines.length ? lines.join("\n") : "(empty directory)") };
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
        max_chars: { type: "integer", description: "Max characters to return (default 30000)" },
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
        let text = await res.text();
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
        return { ok: true, output: clip(text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text) };
      } catch (e) {
        return { ok: false, output: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
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
    description: "Search file contents for a regex under the workspace. Returns path:line:match.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Subdirectory to search (default: workspace root)" },
        glob: { type: "string", description: "Optional file glob filter e.g. '*.ts'" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      let re: RegExp;
      try { re = new RegExp(args.pattern); } catch (e) { return { ok: false, output: `Bad regex: ${e}` }; }
      const base = args.path ? safePath(ctx, args.path) : ctx.cwd;
      const globRe = args.glob ? globToRegex(args.glob) : null;
      const skip = new Set(["node_modules", ".git", "dist", ".next", "target"]);
      const hits: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 12 || hits.length > 300) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (skip.has(name)) continue;
          const full = join(dir, name);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) { walk(full, depth + 1); continue; }
          if (globRe && !globRe.test(relative(ctx.cwd, full))) continue;
          if (st.size > 2_000_000) continue;
          let text: string;
          try { text = readFileSync(full, "utf8"); } catch { continue; }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < 300; i++) {
            if (re.test(lines[i])) hits.push(`${relative(ctx.cwd, full)}:${i + 1}: ${lines[i].slice(0, 300)}`);
          }
          if (hits.length > 300) return;
        }
      };
      walk(base, 0);
      return { ok: true, output: clip(hits.length ? hits.join("\n") : "No matches") };
    },
  },
];

export function toolSpecs() {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
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
