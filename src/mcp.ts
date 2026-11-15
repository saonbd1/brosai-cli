import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readConfig, writeConfig } from "./config.ts";
import type { ToolDef, ToolResult } from "./tools/index.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";
const START_TIMEOUT = 15_000;
const CALL_TIMEOUT = 120_000;

class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private stderrTail = "";
  readonly name: string;

  private cfg: McpServerConfig;

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    // env values of the form "$(cmd)" are evaluated at spawn time (e.g. "$(gh auth token)")
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.env ?? {})) {
      const m = /^\$\((.+)\)$/.exec(v.trim());
      if (m) {
        try { resolvedEnv[k] = execSync(m[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim(); }
        catch { resolvedEnv[k] = v; }
      } else resolvedEnv[k] = v;
    }
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...resolvedEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (d) => this.onData(d));
    this.proc.stderr!.on("data", (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-4000);
    });
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" exited (code ${code})`));
      this.pending.clear();
    });
    this.proc.on("error", (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "brosai", version: "0.1.0" },
    }, START_TIMEOUT);
    this.notify("notifications/initialized");
  }

  private onData(d: Buffer): void {
    this.buf += d.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  private handle(msg: any): void {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server->client request (e.g. sampling, roots/list): reply method-not-found
    if (msg.id != null && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by brosai" } });
    }
    // notifications are ignored
  }

  private send(msg: object): void {
    try { this.proc?.stdin?.write(JSON.stringify(msg) + "\n"); } catch {}
  }

  private notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  private request(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
    });
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: any }[]> {
    const res = await this.request("tools/list");
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args });
    const parts: string[] = [];
    if (Array.isArray(res?.content)) {
      for (const c of res.content) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type === "resource" && c.resource?.text) parts.push(String(c.resource.text));
        else parts.push(JSON.stringify(c));
      }
    }
    if (res?.structuredContent != null) parts.push(JSON.stringify(res.structuredContent));
    if (!parts.length && res != null) parts.push(JSON.stringify(res));
    return { content: parts.join("\n") || "(empty result)", isError: Boolean(res?.isError) };
  }

  get stderr(): string { return this.stderrTail; }

  close(): void {
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

export interface McpBridge {
  toolDefs: ToolDef[];
  close: () => void;
  servers: string[];
}

/** Connect to all configured MCP servers and return bridged tool definitions. */
export async function connectMcpServers(onWarn?: (msg: string) => void): Promise<McpBridge> {
  const cfg = readConfig().mcpServers ?? {};
  const names = Object.keys(cfg);
  if (!names.length) return { toolDefs: [], close: () => {}, servers: [] };

  const clients: McpClient[] = [];
  const toolDefs: ToolDef[] = [];
  const connected: string[] = [];

  for (const name of names) {
    const c = new McpClient(name, cfg[name]);
    try {
      await c.start();
      const tools = await c.listTools();
      clients.push(c);
      connected.push(name);
      for (const t of tools) {
        const toolName = `mcp__${sanitize(name)}__${sanitize(t.name)}`;
        toolDefs.push({
          name: toolName,
          description: `[MCP:${name}] ${t.description ?? t.name}`,
          parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
          execute: async (args: any, ctx: any): Promise<ToolResult> => {
            const argObj = args && typeof args === "object" ? args : {};
            if (ctx.approve) {
              const ok = await ctx.approve(`mcp:${name}/${t.name} ${JSON.stringify(argObj).slice(0, 200)}`);
              if (!ok) return { ok: false, output: `MCP tool ${name}/${t.name} denied by user` };
            }
            try {
              const r = await c.callTool(t.name, argObj);
              const out = r.content.length > 30_000 ? r.content.slice(0, 30_000) + "\n…[truncated]" : r.content;
              return { ok: !r.isError, output: out };
            } catch (e) {
              return { ok: false, output: `MCP error (${name}/${t.name}): ${e instanceof Error ? e.message : String(e)}` };
            }
          },
        });
      }
    } catch (e) {
      onWarn?.(`MCP server "${name}" failed to start: ${e instanceof Error ? e.message : String(e)}${c.stderr ? ` — stderr: ${c.stderr.slice(-300)}` : ""}`);
      c.close();
    }
  }

  return {
    toolDefs,
    servers: connected,
    close: () => { for (const c of clients) c.close(); },
  };
}

/* ---------------- config helpers ---------------- */

export function listMcpServers(): Record<string, McpServerConfig> {
  return readConfig().mcpServers ?? {};
}

export function addMcpServer(name: string, cfg: McpServerConfig): void {
  const c = readConfig();
  c.mcpServers = { ...(c.mcpServers ?? {}), [name]: cfg };
  writeConfig(c);
}

export function removeMcpServer(name: string): void {
  const c = readConfig();
  if (c.mcpServers) {
    delete c.mcpServers[name];
    writeConfig(c);
  }
}
