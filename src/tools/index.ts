import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  /** MCP server management with hot-reload. Present in act mode on hosts that support it. */
  mcp?: {
    list(): { name: string; transport: string }[];
    add(name: string, cfg: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): Promise<{ ok: boolean; error?: string; tools?: number }>;
    remove(name: string): Promise<{ ok: boolean; error?: string }>;
  };
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

export function safePath(ctx: ToolContext, p: string): string {
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

export const TOOLS: ToolDef[] = [
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
    name: "web_search",
    description: "Search the web (DuckDuckGo). Returns result titles, URLs, and snippets. Read-only. Use for research, then web_fetch promising URLs for full content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "Max results (default 8, max 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, output: "web_search requires a query" };
      const max = Math.min(Math.max(1, Number(args.max_results) || 8), 20);
      const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
      try {
        const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${max}&setlang=en-us&cc=us&mkt=en-US`, {
          signal: AbortSignal.timeout(20_000),
          headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36", "accept-language": "en-US,en;q=0.9" },
        });
        if (!res.ok) return { ok: false, output: `Search failed: HTTP ${res.status}` };
        const html = await res.text();
        const results: { title: string; url: string; snippet: string }[] = [];
        const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
        let bm: RegExpExecArray | null;
        while ((bm = blockRe.exec(html)) && results.length < max) {
          const block = bm[0];
          const am = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
          if (!am) continue;
          let url = am[1].replace(/&amp;/g, "&");
          const um = url.match(/[?&]u=a1([^&]+)/);
          if (um) { try { url = Buffer.from(um[1], "base64").toString("utf8"); } catch {} }
          const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          results.push({ title: strip(am[2]), url, snippet: pm ? strip(pm[1]) : "" });
        }
        if (!results.length) return { ok: false, output: "No results parsed — try rephrasing the query" };
        return { ok: true, output: clip(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")) };
      } catch (e) {
        return { ok: false, output: `Search failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
  {
    name: "apply_patch",
    description: "Apply a Codex-style patch to files in the workspace. Format:\n*** Begin Patch\n*** Add File: path\n+line\n*** Update File: path\n@@ optional context\n context_line\n-old_line\n+new_line\n*** Delete File: path\n*** Move to: newpath (after Update File)\n*** End Patch",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", description: "The full patch text between Begin Patch and End Patch markers" } },
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
    description: "Connect an external account/service via OAuth device flow. Currently supports 'github'. Prints a verification link + code for the user to authorize, then waits.",
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
  {
    name: "spawn_agent",
    description: "Delegate a task to a sub-agent with fresh context. Use for parallelizable or self-contained subtasks (exploration, research, implementation). Returns the sub-agent's final report.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete, self-contained instructions for the sub-agent" },
        read_only: { type: "boolean", description: "If true, sub-agent gets read-only tools (explore/research). Default false." },
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

/** Agent-facing MCP server management. Not part of TOOLS — injected only in act mode on the main agent. */
export const MCP_MANAGE_TOOLS: ToolDef[] = [
  {
    name: "mcp_list",
    description: "List MCP servers configured for BrosAi. Their tools appear as mcp__<server>__<tool>.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args: any, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.mcp) return { ok: false, output: "MCP management is not available in this context" };
      const list = ctx.mcp.list();
      return { ok: true, output: list.length ? list.map((s) => `${s.name} (${s.transport})`).join("\n") : "No MCP servers configured" };
    },
  },
  {
    name: "mcp_add",
    description: "Install/connect an MCP server for BrosAi. stdio: provide command + args (e.g. command=\"npx\", args=[\"-y\",\"@modelcontextprotocol/server-memory\"]). HTTP: provide url (+ optional headers). Requires user approval. On success its tools become available immediately as mcp__<name>__<tool>.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name (used in mcp__<name>__ tool prefix)" },
        command: { type: "string", description: "stdio: executable, e.g. npx, uvx, node" },
        args: { type: "array", items: { type: "string" }, description: "stdio: arguments for the command" },
        env: { type: "object", description: "stdio: extra environment variables" },
        url: { type: "string", description: "http: server URL" },
        headers: { type: "object", description: "http: request headers" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.mcp) return { ok: false, output: "MCP management is not available in this context" };
      const name = String(args.name ?? "").trim();
      if (!name) return { ok: false, output: "mcp_add requires a name" };
      const cfg = {
        command: args.command ? String(args.command) : undefined,
        args: Array.isArray(args.args) ? args.args.map(String) : undefined,
        env: args.env && typeof args.env === "object" ? args.env : undefined,
        url: args.url ? String(args.url) : undefined,
        headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
      };
      if (!cfg.command && !cfg.url) return { ok: false, output: "Provide either command (stdio) or url (http)" };
      if (cfg.command && cfg.url) return { ok: false, output: "Provide either command or url, not both" };
      const desc = cfg.url ? `mcp add ${name} (http: ${cfg.url})` : `mcp add ${name} (stdio: ${[cfg.command, ...(cfg.args ?? [])].join(" ")})`;
      if (ctx.approve && !(await ctx.approve(desc))) return { ok: false, output: "Denied by user" };
      const r = await ctx.mcp.add(name, cfg);
      if (!r.ok) return { ok: false, output: r.error ?? "failed to add MCP server" };
      return { ok: true, output: `MCP server "${name}" connected — ${r.tools ?? 0} tool(s) now available as mcp__${name}__*` };
    },
  },
  {
    name: "mcp_remove",
    description: "Remove a configured MCP server and disconnect it. Its mcp__<name>__* tools stop working.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Server name to remove" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args: any, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.mcp) return { ok: false, output: "MCP management is not available in this context" };
      const name = String(args.name ?? "").trim();
      if (!name) return { ok: false, output: "mcp_remove requires a name" };
      const desc = `mcp remove ${name}`;
      if (ctx.approve && !(await ctx.approve(desc))) return { ok: false, output: "Denied by user" };
      const r = await ctx.mcp.remove(name);
      return r.ok ? { ok: true, output: `MCP server "${name}" removed` } : { ok: false, output: r.error ?? "failed to remove" };
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
          const tmp = `${p}.tmp-${process.pid}`;
          writeFileSync(tmp, content, "utf8");
          renameSync(tmp, p);
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
