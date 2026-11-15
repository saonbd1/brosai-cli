#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { runAgent } from "./agent.ts";
import { SYSTEM_PROMPT, loadContextFiles } from "./prompt.ts";
import { TOOLS, type TodoItem, type ToolDef } from "./tools/index.ts";
import { connectMcpServers, listMcpServers, addMcpServer, removeMcpServer } from "./mcp.ts";
import { resolveProvider, storeKey, getProvider, PROVIDERS, type ResolvedProvider } from "./secrets.ts";
import { readConfig, saveProviderSettings, recordUsage, lifetimeUsage } from "./config.ts";
import { estimateCost, formatCost } from "./pricing.ts";
import { compactHistory } from "./compact.ts";
import { saveSession, loadSession, listSessions } from "./session.ts";
import { createCheckpoint, undoCheckpoint, listCheckpoints, workspaceDiff } from "./checkpoint.ts";
import { isAllowlisted, isReadOnlyCommand, addAllowedCommand, removeAllowedCommand, allowedCommands } from "./allow.ts";
import type { ChatMessage } from "./providers/index.ts";

const PLAIN = !process.stdout.isTTY || Boolean(process.env.NO_COLOR);
const C = PLAIN
  ? { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s }
  : {
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
      cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    };

interface CliOpts {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  cwd: string;
  yes: boolean;
  json: boolean;
  maxSteps: number;
  continueSession?: boolean;
  resume?: string;
  noCheckpoint: boolean;
  mode: "act" | "plan";
  contextWindow: number;
}

function parseArgs(argv: string[]): { opts: CliOpts; positional: string[]; command?: string } {
  const opts: CliOpts = { cwd: process.cwd(), yes: false, json: false, maxSteps: 100, noCheckpoint: false, mode: "act", contextWindow: Number(process.env.BROSAI_CONTEXT_WINDOW) || 32768 };
  const positional: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--provider": case "-p": opts.provider = next(); break;
      case "--model": case "-m": opts.model = next(); break;
      case "--base-url": opts.baseUrl = next(); break;
      case "--api-key": case "-k": opts.apiKey = next(); break;
      case "--cwd": opts.cwd = resolve(next()); break;
      case "--yes": case "-y": opts.yes = true; break;
      case "--json": opts.json = true; break;
      case "--max-steps": opts.maxSteps = Number(next()) || 100; break;
      case "--continue": case "-c": opts.continueSession = true; break;
      case "--resume": opts.resume = next(); break;
      case "--no-checkpoint": opts.noCheckpoint = true; break;
      case "--plan": opts.mode = "plan"; break;
      case "--context-window": opts.contextWindow = Number(next()) || opts.contextWindow; break;
      case "--mode": {
        const m = next();
        if (m !== "act" && m !== "plan") { console.error(C.red(`Unknown mode: ${m}`)); process.exit(2); }
        opts.mode = m;
        break;
      }
      case "--help": case "-h": command = "help"; break;
      case "--version": case "-v": command = "version"; break;
      default:
        if (a.startsWith("-")) { console.error(C.red(`Unknown flag: ${a}`)); process.exit(2); }
        positional.push(a);
    }
  }
  return { opts, positional, command };
}

function usage(): void {
  console.log(`${C.bold("BrosAi")} — personal CLI coding agent

${C.bold("Usage:")}
  brosai "your task"          Run a one-shot task
  brosai                     Interactive REPL
  brosai auth <provider>     Save an API key for a provider
  brosai providers           List providers and key status

${C.bold("Flags:")}
  -p, --provider <id>   Provider id
  -m, --model <id>      Model override
  -k, --api-key <key>   Per-run API key (not saved)
  --base-url <url>      Custom OpenAI-compatible base URL
  --cwd <path>          Workspace directory (default: cwd)
  -y, --yes             Auto-approve all commands
                        (read-only commands and allowlisted patterns never prompt)
  --json                Emit JSON events (for scripting)
  --max-steps <n>       Max agent steps (default 100)
  -c, --continue         Resume the most recent session
  --resume <file>        Resume a specific session file
  --no-checkpoint        Disable git shadow-repo checkpoints
  --plan                 Plan mode: read-only tools, outputs a plan only
  --mode <act|plan>      Agent mode (default: act)
  --context-window <n>   Context window in tokens for auto-compaction (default 32768)
  brosai sessions        List saved sessions
  brosai checkpoints     List checkpoints for this workspace
  brosai undo [n]        Restore workspace to before the last n turns
  brosai allow           List auto-approved command patterns
  brosai allow add <pat> Always approve commands matching pattern (* wildcard)
  brosai allow rm <pat>  Remove an approved pattern
  brosai diff            Show changes since the last checkpoint
  brosai mcp             List configured MCP servers
  brosai mcp add <n> -- <cmd> [args]   Add an MCP server (stdio)
  brosai mcp rm <n>      Remove an MCP server
  brosai models          List Ollama models on the configured server
  brosai models use <m>  Select an Ollama model (sets ollama as provider)
  brosai models url <u>  Set Ollama server URL (e.g. http://vm-ip:11434)

${C.bold("Providers:")} ${PROVIDERS.map((p) => p.id).join(", ")}
${C.bold("Env vars:")} BROSAI_PROVIDER, BROSAI_MODEL, BROSAI_API_KEY, BROS_DIR, BROS_CONFIG_PATH

${C.bold("REPL commands:")} /status  /provider  /model  /mode  /allow  /sessions  /cost  /diff  /undo  /checkpoints  /clear  /help  /exit`);
}

function keyStatus(providerId: string): string {
  const cfg = readConfig();
  const stored = cfg.providers[providerId]?.settings?.apiKey;
  const def = getProvider(providerId);
  if (def?.noKey) return C.dim("not needed");
  const envHit = def?.apiKeyEnv.find((e) => process.env[e]);
  if (stored) return C.green("config") + C.dim(" (saved)");
  if (envHit) return C.green(envHit);
  return C.red("none");
}

function providersCmd(): void {
  console.log(C.bold("Providers:\n"));
  const last = readConfig().lastUsedProvider;
  for (const p of PROVIDERS) {
    const cur = last === p.id ? C.cyan(" <- last used") : "";
    console.log(`  ${C.bold(p.id.padEnd(16))} ${p.name.padEnd(24)} key: ${keyStatus(p.id)}${cur}`);
  }
}

async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolveP) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString()) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolveP(buf);
          return;
        } else if (ch === "") { process.exit(130); }
        else if (ch === "\b" || ch === "") { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        else { buf += ch; process.stdout.write("*"); }
      }
    };
    stdin.on("data", onData);
  });
}

function ollamaApiRoot(): string {
  const cfgBase = readConfig().providers.ollama?.settings?.baseUrl;
  const defBase = getProvider("ollama")?.baseUrl ?? "http://localhost:11434/v1";
  const raw = (process.env.BROSAI_OLLAMA_URL?.trim() || process.env.OLLAMA_BASE_URL?.trim() || cfgBase || defBase).replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
}

async function ollamaModelList(): Promise<{ name: string; size: number }[]> {
  const root = ollamaApiRoot();
  const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Ollama API returned HTTP ${res.status} at ${root}`);
  const d = (await res.json()) as any;
  return (d.models ?? []).map((m: any) => ({ name: String(m.name ?? ""), size: Number(m.size ?? 0) })).filter((m) => m.name);
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  return `${(bytes / 1e9).toFixed(1)}GB`;
}

async function modelsCmd(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "use" || sub === "select") {
    const model = args.slice(1).join(" ").trim();
    if (!model) { console.error(C.red("Usage: brosai models use <model>")); process.exit(2); }
    saveProviderSettings("ollama", { model }, { setLastUsed: true });
    console.log(C.green(`ollama model -> ${model} (saved, set as default provider)`));
    return;
  }
  if (sub === "url") {
    const url = args.slice(1).join(" ").trim();
    if (!url) { console.error(C.red("Usage: brosai models url <base-url> e.g. http://192.168.1.10:11434")); process.exit(2); }
    let base = url.replace(/\/+$/, "");
    if (!/\/v1$/.test(base)) base += "/v1";
    saveProviderSettings("ollama", { baseUrl: base }, { setLastUsed: false });
    console.log(C.green(`ollama server -> ${base}`));
    return;
  }
  // list
  try {
    const models = await ollamaModelList();
    const cur = readConfig().providers.ollama?.settings;
    console.log(C.bold(`Ollama server: ${ollamaApiRoot()}\n`));
    if (!models.length) { console.log(C.dim("No models installed. Install one: ollama pull qwen2.5:7b-instruct")); return; }
    for (const m of models) {
      const mark = cur?.model === m.name ? C.cyan(" <- current") : "";
      console.log(`  ${m.name.padEnd(40)} ${fmtSize(m.size)}${mark}`);
    }
    if (!cur?.model) console.log(C.dim("\nSelect one: brosai models use <name>"));
  } catch (e) {
    console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    console.error(C.dim("Tip: set server with 'brosai models url http://<host>:11434' or BROSAI_OLLAMA_URL env"));
    process.exit(1);
  }
}

const GH_CLIENT_ID = "178c6fc778ccc68e1d6a"; // GitHub CLI's public OAuth app client id
const GH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function githubAuthFlow(): Promise<void> {
  const req = async (url: string, body: Record<string, string>) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };

  const dc = await req(GH_DEVICE_CODE_URL, { client_id: GH_CLIENT_ID, scope: "repo read:org gist workflow" });
  if (!dc.device_code) throw new Error(`device flow failed: ${JSON.stringify(dc).slice(0, 200)}`);

  console.log(`\nTo connect your GitHub account:\n`);
  console.log(`  1. Open: ${C.bold(dc.verification_uri)}`);
  console.log(`  2. Enter code: ${C.bold(dc.user_code)}\n`);
  console.log(C.dim("Waiting for authorization (expires in 15 min, Ctrl+C to cancel)..."));

  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
  const interval = Math.max(5, dc.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tok = await req(GH_ACCESS_TOKEN_URL, {
      client_id: GH_CLIENT_ID,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (tok.access_token) {
      // store into the github MCP server env (create the server entry if missing)
      const { readConfig, writeConfig } = await import("./config.ts");
      const cfg = readConfig();
      const srv = cfg.mcpServers?.github ?? { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
      srv.env = { ...(srv.env ?? {}), GITHUB_PERSONAL_ACCESS_TOKEN: tok.access_token };
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), github: srv };
      writeConfig(cfg);
      console.log(C.green("\nGitHub connected! Token saved to ~/.brosai/config.json (0600)."));
      console.log(C.dim("The github MCP tools are active on your next brosai run."));
      return;
    }
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") { await new Promise((r) => setTimeout(r, 5000)); continue; }
    throw new Error(`authorization failed: ${tok.error_description ?? tok.error ?? "unknown"}`);
  }
  throw new Error("device code expired — run 'brosai auth github' again");
}

async function authCmd(providerId: string | undefined, key: string | undefined): Promise<void> {
  if (providerId === "github" && !key) { await githubAuthFlow(); return; }
  if (!providerId) {
    console.log("Usage: brosai auth <provider> [api-key]");
    console.log("Providers:", PROVIDERS.map((p) => p.id).join(", "));
    process.exit(2);
  }
  if (!getProvider(providerId)) { console.error(C.red(`Unknown provider: ${providerId}`)); process.exit(2); }
  const apiKey = key ?? (await promptHidden(`API key for ${providerId}: `));
  if (!apiKey?.trim()) { console.error(C.red("Empty key")); process.exit(2); }
  storeKey(providerId, apiKey.trim());
  console.log(C.green(`Saved key for ${providerId} -> ~/.brosai/config.json (0600)`));
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  return ans.trim();
}

function makeApprover(state: { all: boolean; approved: Set<string> }) {
  return async (cmd: string) => {
    if (state.all || state.approved.has(cmd) || isAllowlisted(cmd) || isReadOnlyCommand(cmd)) return true;
    const ans = await ask(`${C.yellow(`run command? ${cmd}`)}\n  [y=once n=deny a=all-session] `);
    if (/^a/i.test(ans)) { state.all = true; return true; }
    if (!/^y/i.test(ans)) { console.log(C.dim("  denied")); return false; }
    state.approved.add(cmd);
    return true;
  };
}

interface Session {
  provider: ResolvedProvider;
  history: ChatMessage[];
  usage: { input: number; output: number };
  costUsd: number | null;
  steps: number;
  sessionFile?: string;
  approveState: { all: boolean; approved: Set<string> };
  todos: TodoItem[];
  mcpDefs?: ToolDef[];
}

function makeEvents(session: Session, jsonMode: boolean) {
  if (jsonMode) {
    return {
      onText: (d: string) => console.log(JSON.stringify({ type: "text", delta: d })),
      onToolStart: (name: string, args: string) => {
        let parsed: any = args;
        try { parsed = JSON.parse(args); } catch {}
        console.log(JSON.stringify({ type: "tool_start", name, args: parsed }));
      },
      onToolEnd: (name: string, result: any) => {
        console.log(JSON.stringify({ type: "tool_end", name, ok: result.ok, output: result.output.slice(0, 2000) }));
      },
      onUsage: (i: number, o: number) => {
        session.usage.input += i; session.usage.output += o;
        console.log(JSON.stringify({ type: "usage", input: i, output: o }));
      },
    };
  }
  return {
    onText: (d: string) => process.stdout.write(d),
    onToolStart: (name: string, args: string) => {
      let short = args;
      try { const p = JSON.parse(args); short = p.command ?? p.path ?? p.pattern ?? JSON.stringify(p).slice(0, 80); } catch {}
      console.log(`\n${C.dim("+")} ${C.cyan(name)} ${C.dim(String(short).slice(0, 120))}`);
    },
    onToolEnd: (name: string, result: any) => {
      console.log(C.dim(`  |- ${result.ok ? "ok" : "failed"}`));
    },
    onUsage: (i: number, o: number) => {
      session.usage.input += i; session.usage.output += o;
    },
  };
}

const PLAN_PROMPT = `${SYSTEM_PROMPT}

PLAN MODE: You are in plan mode. You may ONLY use read_file, glob, and grep — no writes, edits, or commands. Investigate the codebase, then output a concrete step-by-step implementation plan. Do NOT make any changes. End your reply with the plan clearly formatted.`;

const READONLY_TOOLS = new Set(["read_file", "glob", "grep", "list_dir", "web_fetch", "todo_write"]);

async function runTurn(session: Session, prompt: string, opts: CliOpts): Promise<string> {
  if (!opts.noCheckpoint && opts.mode !== "plan") await createCheckpoint(opts.cwd, prompt);
  if (opts.mode !== "plan" && session.history.length > 6) {
    const before = session.history.length;
    session.history = await compactHistory(session.provider, session.history, opts.contextWindow);
    if (session.history.length !== before && !opts.json) console.log(C.dim(`(context compacted: ${before} -> ${session.history.length} messages)`));
  }
  const basePrompt = opts.mode === "plan" ? PLAN_PROMPT : SYSTEM_PROMPT;
  const todoContext = session.todos.length
    ? `\n\nCurrent task list (use todo_write to update):\n${session.todos.map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n")}`
    : "";
  const allDefs = opts.mode === "plan" ? TOOLS.filter((d) => READONLY_TOOLS.has(d.name)) : [...TOOLS, ...(session.mcpDefs ?? [])];
  const result = await runAgent(prompt, {
    provider: session.provider,
    cwd: opts.cwd,
    history: session.history,
    systemPrompt: basePrompt + todoContext + loadContextFiles(opts.cwd),
    toolDefs: allDefs,
    maxSteps: opts.maxSteps,
    ctx: { approve: opts.yes ? () => true : makeApprover(session.approveState), todos: session.todos },
    events: makeEvents(session, opts.json),
  });
  session.history.push({ role: "user", content: prompt });
  session.history.push(...result.messages);
  session.steps += result.steps;
  const turnCost = estimateCost(session.provider.def.id, session.provider.model, result.usage.input, result.usage.output);
  if (turnCost != null) session.costUsd = (session.costUsd ?? 0) + turnCost;
  recordUsage(result.usage.input, result.usage.output, turnCost);
  session.sessionFile = saveSession({
    file: session.sessionFile,
    provider: session.provider.def.id,
    model: session.provider.model,
    cwd: opts.cwd,
    history: session.history,
  });
  const last = result.messages.at(-1);
  return last?.role === "assistant" ? (last.content ?? "") : "";
}

const SLASH_COMMANDS = ["/provider", "/model", "/mode", "/clear", "/cost", "/diff", "/undo", "/checkpoints", "/allow", "/sessions", "/status", "/help", "/exit"];

function makeCompleter(getProviderId: () => string) {
  return (line: string): [string[], string] => {
    if (!line.startsWith("/")) return [[], line];
    const parts = line.split(" ");
    const head = parts[0];
    const argPrefix = parts.length > 1 ? parts[parts.length - 1] : "";
    let candidates: string[] = [];
    if (parts.length === 1 || (parts.length === 2 && line.endsWith(" "))) {
      candidates = SLASH_COMMANDS;
    } else {
      if (head === "/provider") candidates = PROVIDERS.map((p) => p.id);
      else if (head === "/model") candidates = getProvider(getProviderId())?.models ?? [];
      else if (head === "/mode") candidates = ["act", "plan"];
      else if (head === "/undo") candidates = ["1", "2", "3"];
    }
    const hits = candidates.filter((c) => c.startsWith(argPrefix));
    const completions = hits.map((h) => (parts.length > 1 ? parts.slice(0, -1).concat(h).join(" ") : h));
    return [completions, completions.length === 1 ? completions[0] : line];
  };
}

async function repl(session: Session, opts: CliOpts): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.green("brosai> "), completer: makeCompleter(() => session.provider.def.id) });
  const reprompt = () => { if (!rl.closed) rl.prompt(); };
  reprompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { reprompt(); continue; }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") { session.history = []; console.log(C.dim("history cleared")); reprompt(); continue; }
    if (input === "/cost") {
      const life = lifetimeUsage();
      console.log(`session: steps=${session.steps} tokens in=${session.usage.input} out=${session.usage.output} est=${formatCost(session.costUsd)}`);
      if (life) console.log(`lifetime: tokens in=${life.input} out=${life.output} est=${formatCost(life.costUsd)}`);
      reprompt(); continue;
    }
    if (input === "/provider" || input.startsWith("/provider ")) {
      const id = input.split(/\s+/)[1];
      if (!id) { console.log("providers:", PROVIDERS.map((p) => p.id).join(", ")); reprompt(); continue; }
      try {
        session.provider = resolveProvider({ providerId: id });
        console.log(C.green(`provider -> ${id} (${session.provider.model})`));
      } catch (e) { console.log(C.red(String(e instanceof Error ? e.message : e))); }
      reprompt(); continue;
    }
    if (input === "/model" || input.startsWith("/model ")) {
      const m = input.split(/\s+/)[1];
      if (!m) { console.log("current:", session.provider.model); reprompt(); continue; }
      session.provider = { ...session.provider, model: m };
      saveProviderSettings(session.provider.def.id, { model: m }, { setLastUsed: false });
      console.log(C.green(`model -> ${m}`));
      reprompt(); continue;
    }
    if (input === "/help") { usage(); reprompt(); continue; }
    if (input === "/undo" || input.startsWith("/undo ")) {
      const n = Math.max(1, Number(input.split(/\s+/)[1]) || 1);
      const cp = await undoCheckpoint(opts.cwd, n);
      console.log(cp ? C.green(`undone ${cp.label} (${cp.hash.slice(0, 7)})`) : C.yellow("no checkpoints to undo"));
      reprompt(); continue;
    }
    if (input === "/status" || input === "/state") {
      const life = lifetimeUsage();
      const cps = listCheckpoints(opts.cwd).length;
      console.log(C.bold(" session status"));
      console.log(`  provider : ${session.provider.def.name} (${session.provider.def.id})`);
      console.log(`  model    : ${session.provider.model}`);
      console.log(`  mode     : ${opts.mode}`);
      console.log(`  cwd      : ${opts.cwd}`);
      console.log(`  session  : ${session.sessionFile ?? "(new)"}  history=${session.history.length} msgs`);
      console.log(`  steps    : ${session.steps}   tokens: ${session.usage.input} in / ${session.usage.output} out   est ${formatCost(session.costUsd)}`);
      if (life) console.log(`  lifetime : ${life.input} in / ${life.output} out   est ${formatCost(life.costUsd)}`);
      console.log(`  todos    : ${session.todos.length} (${session.todos.filter((t) => t.status === "completed").length} done)`);
      console.log(`  checkpoints: ${cps}`);
      reprompt(); continue;
    }
    if (input === "/sessions") {
      const list = listSessions();
      if (!list.length) console.log(C.dim("no saved sessions"));
      for (const s of list.slice(0, 10)) console.log(`  ${s.file}  ${s.updatedAt.slice(0, 19)}  ${s.provider}/${s.model}  ${s.cwd}`);
      reprompt(); continue;
    }
    if (input === "/mode" || input.startsWith("/mode ")) {
      const m = input.split(/\s+/)[1];
      if (m === "plan" || m === "act") { opts.mode = m; console.log(C.green(`mode -> ${m}`)); }
      else console.log(`current mode: ${opts.mode} (usage: /mode act|plan)`);
      reprompt(); continue;
    }
    if (input === "/allow" || input.startsWith("/allow ")) {
      const parts = input.split(/\s+/);
      const sub = parts[1];
      const pat = parts.slice(2).join(" ");
      if (sub === "add" && pat) { addAllowedCommand(pat); console.log(C.green(`allowed: ${pat}`)); }
      else if ((sub === "rm" || sub === "remove") && pat) { removeAllowedCommand(pat); console.log(C.green(`removed: ${pat}`)); }
      else {
        const list = allowedCommands();
        if (!list.length) console.log(C.dim("no allowlisted patterns (usage: /allow add <pattern>, * wildcard)"));
        else for (const p of list) console.log(`  ${p}`);
      }
      reprompt(); continue;
    }
    if (input === "/diff") {
      const d = await workspaceDiff(opts.cwd);
      console.log(d ? `\n${d}\n` : C.yellow("no checkpoints yet — run a task first"));
      reprompt(); continue;
    }
    if (input === "/checkpoints") {
      const cps = listCheckpoints(opts.cwd);
      if (!cps.length) console.log(C.dim("no checkpoints for this workspace"));
      for (const cp of cps.slice(-10).reverse()) console.log(`  ${cp.hash.slice(0, 7)}  ${cp.time}  ${cp.label.slice(0, 60)}`);
      reprompt(); continue;
    }
    try {
      await runTurn(session, input, opts);
      console.log("");
    } catch (e) {
      console.log("\n" + C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    }
    reprompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "auth") { await authCmd(argv[1], argv[2]); return; }
  if (argv[0] === "providers") { providersCmd(); return; }
  if (argv[0] === "models" || argv[0] === "ollama") { await modelsCmd(argv.slice(1)); return; }
  if (argv[0] === "sessions") {
    const list = listSessions();
    if (!list.length) console.log("No saved sessions.");
    for (const s of list) console.log(`  ${s.file}  ${s.updatedAt}  ${s.provider}/${s.model}  turns=${s.turns}  ${s.cwd}`);
    return;
  }
  if (argv[0] === "checkpoints" || argv[0] === "undo" || argv[0] === "diff") {
    const { opts, positional } = parseArgs(argv.slice(1));
    if (argv[0] === "diff") {
      const d = await workspaceDiff(opts.cwd);
      console.log(d ?? "no checkpoints for this workspace");
      return;
    }
    if (argv[0] === "checkpoints") {
      const cps = listCheckpoints(opts.cwd);
      if (!cps.length) console.log("No checkpoints for this workspace.");
      for (const cp of cps.slice(-20).reverse()) console.log(`  ${cp.hash.slice(0, 7)}  ${cp.time}  ${cp.label.slice(0, 60)}`);
      return;
    }
    const n = Math.max(1, Number(positional[0]) || 1);
    const cp = await undoCheckpoint(opts.cwd, n);
    if (cp) console.log(C.green(`restored workspace to before: ${cp.label} (${cp.hash.slice(0, 7)})`));
    else console.log(C.yellow("no checkpoints to undo (is git installed? has brosai run here before?)"));
    return;
  }
  if (argv[0] === "mcp") {
    const sub = argv[1];
    if (sub === "add") {
      const name = argv[2];
      const rest = argv.slice(3);
      const sep = rest.indexOf("--");
      const env: Record<string, string> = {};
      let cmdParts: string[];
      if (sep >= 0) {
        const optsPart = rest.slice(0, sep);
        for (let i = 0; i < optsPart.length; i++) {
          if (optsPart[i] === "--env" && optsPart[i + 1]) {
            const kv = optsPart[i + 1];
            const eq = kv.indexOf("=");
            if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
            i++;
          }
        }
        cmdParts = rest.slice(sep + 1);
      } else {
        cmdParts = rest;
      }
      if (!name || !cmdParts.length) { console.error(C.red("Usage: brosai mcp add <name> [--env KEY=VAL] -- <command> [args...]")); process.exit(2); }
      addMcpServer(name, { command: cmdParts[0], args: cmdParts.slice(1), env: Object.keys(env).length ? env : undefined });
      console.log(C.green(`MCP server "${name}" added: ${cmdParts.join(" ")}`));
      console.log(C.dim("It will connect on next brosai run."));
      return;
    }
    if (sub === "rm" || sub === "remove") {
      const name = argv[2];
      if (!name) { console.error(C.red("Usage: brosai mcp rm <name>")); process.exit(2); }
      removeMcpServer(name);
      console.log(C.green(`MCP server "${name}" removed`));
      return;
    }
    const servers = listMcpServers();
    const names = Object.keys(servers);
    if (!names.length) { console.log("No MCP servers configured. Add one: brosai mcp add <name> -- <command> [args...]"); return; }
    for (const n of names) {
      const s = servers[n];
      console.log(`  ${C.bold(n)}  ${s.command} ${(s.args ?? []).join(" ")}`);
    }
    return;
  }
  if (argv[0] === "allow") {
    const sub = argv[1];
    const pat = argv.slice(2).join(" ").trim();
    if (sub === "add" && pat) { addAllowedCommand(pat); console.log(C.green(`allowed: ${pat}`)); return; }
    if ((sub === "rm" || sub === "remove") && pat) { removeAllowedCommand(pat); console.log(C.green(`removed: ${pat}`)); return; }
    const list = allowedCommands();
    if (!list.length) console.log("No allowlisted patterns. Usage: brosai allow add \"npm test*\"");
    else for (const p of list) console.log(`  ${p}`);
    return;
  }

  const { opts, positional, command } = parseArgs(argv);
  if (command === "help") { usage(); return; }
  if (command === "version") { console.log("brosai 0.1.0"); return; }

  let provider: ResolvedProvider;
  try {
    provider = resolveProvider({ providerId: opts.provider, model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  } catch (e) {
    console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  const session: Session = { provider, history: [], usage: { input: 0, output: 0 }, costUsd: null, steps: 0, approveState: { all: false, approved: new Set() }, todos: [] };

  const mcp = await connectMcpServers((m) => console.error(C.dim(`warn: ${m}`)));
  if (mcp.servers.length) {
    const nTools = mcp.toolDefs.length;
    console.error(C.dim(`mcp: connected ${mcp.servers.join(", ")} (${nTools} tools)`));
    session.mcpDefs = mcp.toolDefs;
  }
  process.on("exit", () => mcp.close());
  const wantResume = opts.resume ?? (opts.continueSession ? "__latest__" : undefined);
  if (wantResume) {
    const saved = loadSession(wantResume === "__latest__" ? undefined : wantResume);
    if (saved) {
      session.history = saved.history;
      session.sessionFile = opts.resume ?? listSessions()[0]?.file;
      console.log(C.dim(`resumed session (${saved.history.length} messages, ${saved.provider}/${saved.model})`));
      try { provider = { ...provider, model: saved.model }; session.provider = provider; } catch {}
    } else {
      console.log(C.yellow(`no session found${opts.resume ? ` for ${opts.resume}` : ""}`));
    }
  }
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  const prompt = positional.join(" ");
  if (prompt) {
    if (opts.json) {
      const text = await runTurn(session, prompt, opts);
      console.log(JSON.stringify({ type: "final", text, usage: session.usage, steps: session.steps }));
    } else {
      await runTurn(session, prompt, opts);
      console.log("");
      console.log(C.dim(`-- ${provider.def.name}/${provider.model} - ${session.steps} steps - ${session.usage.input}+${session.usage.output} tokens - est ${formatCost(session.costUsd)}`));
    }
    mcp.close();
    return;
  }

  console.log(C.dim(`${C.bold("BrosAi")} ${provider.def.name}/${provider.model} mode=${opts.mode} cwd=${opts.cwd} - /help for commands`));
  try {
    await repl(session, opts);
  } finally {
    mcp.close();
  }
}

main().catch((e) => {
  console.error(C.red(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.exit(1);
});
