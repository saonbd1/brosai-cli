import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ToolContext {
  cwd: string;
  approve?: (cmd: string) => Promise<boolean> | boolean;
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
