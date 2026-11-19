#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { runAgent, type AgentEvents } from "./agent.ts";
import { SYSTEM_PROMPT, loadContextFiles } from "./prompt.ts";
import { TOOLS, MCP_MANAGE_TOOLS, type TodoItem, type ToolDef, type ToolContext } from "./tools/index.ts";
import { connectMcpServers, listMcpServers, addMcpServer, removeMcpServer } from "./mcp.ts";
import { resolveProvider, storeKey, getProvider, PROVIDERS, type ResolvedProvider } from "./secrets.ts";
import { readConfig, saveProviderSettings, setLastUsedProvider, recordUsage, lifetimeUsage } from "./config.ts";
import { estimateCost, formatCost } from "./pricing.ts";
import { VERSION, pendingUpdate } from "./update.ts";
import type { WebApproval } from "./web.ts";
import { compactHistory, estimateTokens } from "./compact.ts";
import { MarkdownRenderer } from "./markdown.ts";
import { saveSession, loadSession, listSessions } from "./session.ts";
import { createCheckpoint, undoCheckpoint, listCheckpoints, workspaceDiff } from "./checkpoint.ts";
import { isAllowlisted, isReadOnlyCommand, addAllowedCommand, removeAllowedCommand, allowedCommands } from "./allow.ts";
import type { ChatMessage } from "./providers/index.ts";
import type { SessionState } from "./runtime.ts";
import { telegramToolDefs, runTelegramBot, pairChat, saveTelegramConfig, clearTelegramConfig, telegramSettings, verifyToken, sendText } from "./telegram.ts";
import { listSkills, getSkill, saveSkill, removeSkill, readSkillFile, projectSkillsDir, globalSkillsDir } from "./skills.ts";

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
  raw: boolean;
  images?: string[];
  approveFn?: (cmd: string) => Promise<boolean>;
}

function parseArgs(argv: string[]): { opts: CliOpts; positional: string[]; command?: string } {
  const opts: CliOpts = { cwd: process.cwd(), yes: false, json: false, maxSteps: 100, noCheckpoint: false, mode: "act", contextWindow: Number(process.env.BROSAI_CONTEXT_WINDOW) || 32768, raw: false };
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
      case "--raw": opts.raw = true; break;
      case "--port": next(); break; // consumed by `brosai web`
      case "--image": case "-i": {
        try { opts.images = [...(opts.images ?? []), imageDataUrl(next())]; }
        catch (e) { console.error(C.red(String(e instanceof Error ? e.message : e))); process.exit(2); }
        break;
      }
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

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageDataUrl(path: string): string {
  const p = resolve(path);
  const st = statSync(p);
  if (!st.isFile()) throw new Error(`not a file: ${path}`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`image too large (${(st.size / 1e6).toFixed(1)}MB > 8MB): ${path}`);
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`unsupported image type .${ext} (png/jpg/gif/webp/bmp): ${path}`);
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
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
  -i, --image <path>     Attach an image (png/jpg/gif/webp/bmp, <=8MB); repeatable
  brosai sessions        List saved sessions
  brosai checkpoints     List checkpoints for this workspace
  brosai undo [n]        Restore workspace to before the last n turns
  brosai allow           List auto-approved command patterns
  brosai allow add <pat> Always approve commands matching pattern (* wildcard)
  brosai allow rm <pat>  Remove an approved pattern
  brosai diff            Show changes since the last checkpoint
  brosai doctor [--deep] Diagnose config, provider, MCP, and environment
  brosai mcp             List configured MCP servers
  brosai mcp add <n> -- <cmd> [args]   Add an MCP server (stdio)
  brosai mcp rm <n>      Remove an MCP server
  brosai models          List Ollama models on the configured server
  brosai models use <m>  Select an Ollama model (sets ollama as provider)
  brosai models url <u>  Set Ollama server URL (e.g. http://vm-ip:11434)
  brosai telegram setup [token]   Connect a Telegram bot to this machine (one-time pairing)
  brosai telegram        Chat with the agent from Telegram (bot mode; approvals via buttons)
  brosai telegram status|test|logout
  brosai skills                List installed skills (global + project)
  brosai skills add <name> <file.md> [--project]  Install a SKILL.md as a skill
  brosai skills rm <name>          Remove a skill
  brosai skills show <name>        Print a skill's content

${C.bold("Providers:")} ${PROVIDERS.map((p) => p.id).join(", ")}
${C.bold("Env vars:")} BROSAI_PROVIDER, BROSAI_MODEL, BROSAI_API_KEY, BROS_DIR, BROS_CONFIG_PATH, BROS_WEB_TOKEN, BROS_NO_BROWSER

${C.bold("REPL commands:")} /status  /provider(s)  /model  /mode  /allow  /sessions  /cost  /diff  /undo  /checkpoints  /clear  /help  /exit`);
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

async function githubAuthFlow(): Promise<void> {
  const { connectGitHub } = await import("./services.ts");
  try {
    console.log(await connectGitHub());
  } catch (e) {
    console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

async function fetchModelList(baseUrl: string): Promise<string[]> {
  try {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const urls = [`${baseUrl.replace(/\/+$/, "")}/models`, `${root}/api/tags`];
    for (const u of urls) {
      const res = await fetch(u, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const d: any = await res.json();
      const names = (d.data ?? d.models ?? []).map((m: any) => String(m.id ?? m.name ?? "")).filter(Boolean);
      if (names.length) return names;
    }
  } catch {}
  return [];
}

async function pickFromList(title: string, items: string[], allowCustom = true): Promise<string> {
  if (items.length) {
    console.log(C.bold(`\n${title}:`));
    items.slice(0, 20).forEach((it, i) => console.log(`  ${i + 1}) ${it}`));
    const ans = await ask(`Choose [1-${Math.min(items.length, 20)}${allowCustom ? " or type a model name" : ""}]: `);
    const n = Number(ans);
    if (n >= 1 && n <= items.length) return items[n - 1];
    if (ans.trim()) return ans.trim();
  }
  return (await ask(`${title} (model name): `)).trim();
}

async function setupCmd(): Promise<void> {
  console.log(C.bold("\nBrosAi setup — connect a model provider\n"));
  const list = PROVIDERS.filter((p) => p.id !== "custom");
  list.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}${p.noKey ? " (no key needed)" : ""}`));
  console.log(`  ${list.length + 1}) Custom OpenAI-compatible endpoint`);
  const sel = await ask(`Choose [1-${list.length + 1}]: `);
  const n = Number(sel);
  const def = n >= 1 && n <= list.length ? list[n - 1] : getProvider("custom")!;

  let apiKey: string | undefined;
  let baseUrl = def.baseUrl;
  let model: string | undefined;

  if (def.id === "ollama") {
    baseUrl = (await ask(`Ollama server URL [${def.baseUrl}]: `)).trim() || def.baseUrl;
  } else if (def.id === "custom") {
    baseUrl = (await ask("Base URL (e.g. http://host:11434/v1 or http://localhost:8000/v1): ")).trim();
    if (!baseUrl) { console.error(C.red("Base URL required")); process.exit(2); }
    apiKey = (await ask("API key (leave empty if none): ")).trim() || undefined;
  } else {
    apiKey = await promptHidden(`API key for ${def.name}: `);
    if (!apiKey?.trim()) { console.error(C.red("Empty key")); process.exit(2); }
    apiKey = apiKey.trim();
  }

  const discovered = await fetchModelList(baseUrl!);
  const fallbacks = def.models ?? [];
  const choices = [...new Set([...discovered, ...fallbacks])];
  if (choices.length) model = await pickFromList("Select model", choices);
  else model = (await ask("Model name: ")).trim();
  if (!model) { console.error(C.red("Model required")); process.exit(2); }

  saveProviderSettings(def.id, { apiKey, model, baseUrl }, { setLastUsed: true });
  console.log(C.dim(`\nSaved ${def.id}/${model} — testing connection...`));

  try {
    const p = resolveProvider({ providerId: def.id });
    const { chatOnce } = await import("./providers/index.ts");
    const r = await chatOnce(p, { messages: [{ role: "user", content: "Reply with exactly: OK" }], tools: [], maxTokens: 16 });
    console.log(C.green(`Connected! Model says: ${(r.content ?? "").trim().slice(0, 80) || "(empty)"}`));
    console.log(C.dim(`Default provider is now ${def.id}. Run 'brosai' to start.`));
  } catch (e) {
    console.log(C.yellow(`Saved, but test failed: ${e instanceof Error ? e.message : String(e)}`));
    console.log(C.dim("You can still try: brosai -p " + def.id + ' "your task"'));
  }
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

function skillsCmd(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0];
  if (sub === "add") {
    const name = args[1];
    const file = args[2];
    const project = args.includes("--project");
    if (!name || !file) { console.error(C.red("Usage: brosai skills add <name> <file.md> [--project]")); process.exit(2); }
    let content: string;
    try { content = readFileSync(resolve(file), "utf8"); }
    catch { console.error(C.red(`cannot read ${file}`)); process.exit(1); }
    try {
      const info = saveSkill(cwd, name, content, project ? "project" : "global");
      console.log(C.green(`skill "${info.name}" installed (${info.scope}) -> ${info.path}`));
      console.log(C.dim("Loaded into the system prompt on the next brosai run."));
    } catch (e) { console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`)); process.exit(1); }
    return;
  }
  if (sub === "rm" || sub === "remove") {
    const name = args[1];
    if (!name) { console.error(C.red("Usage: brosai skills rm <name>")); process.exit(2); }
    if (removeSkill(cwd, name)) console.log(C.green(`removed skill "${name}"`));
    else { console.error(C.red(`no skill named "${name}"`)); process.exit(1); }
    return;
  }
  if (sub === "show") {
    const name = args[1];
    if (!name) { console.error(C.red("Usage: brosai skills show <name>")); process.exit(2); }
    const sk = getSkill(cwd, name);
    if (!sk) { console.error(C.red(`no skill named "${name}"`)); process.exit(1); }
    console.log(readSkillFile(sk.path));
    return;
  }
  const skills = listSkills(cwd);
  if (!skills.length) {
    console.log("No skills installed.");
    console.log(C.dim(`Global dir:   ${globalSkillsDir()}`));
    console.log(C.dim(`Project dir:  ${projectSkillsDir(cwd)}`));
    console.log(C.dim("Add one: brosai skills add <name> <file.md> [--project]"));
    return;
  }
  console.log(C.bold("Skills:\n"));
  for (const sk of skills) {
    const tag = sk.scope === "project" ? C.cyan("project") : C.dim("global");
    console.log(`  ${C.bold(sk.name.padEnd(20))} ${tag}  ${sk.description || C.dim("(no description)")}`);
  }
  console.log(C.dim(`\n${skills.length} skill(s). Global: ${globalSkillsDir()}  Project: ${projectSkillsDir(cwd)}`));
}

async function telegramCmd(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args);
  const sub = positional[0] ?? "start";

  if (sub === "setup") {
    let token = (positional[1] ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token) {
      if (!process.stdin.isTTY) { console.error(C.red("No token. Usage: brosai telegram setup <bot-token>")); process.exit(2); }
      console.log("1. In Telegram open @BotFather and send /newbot\n2. Copy the token it gives you\n");
      token = (await promptHidden("Bot token (hidden): ")).trim();
    }
    if (!token) { console.error(C.red("Empty token")); process.exit(2); }
    let me;
    try { me = await verifyToken(token); }
    catch (e) { console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`)); process.exit(1); }
    console.log(C.green(`bot found: @${me.username}`));
    let paired;
    try {
      paired = await pairChat(token, (code) => {
        console.log(`\nNow open https://t.me/${me.username} in Telegram and send this message:\n\n  ${C.bold(`/start ${code}`)}\n`);
        console.log(C.dim("Waiting up to 5 minutes (Ctrl+C to cancel)..."));
      });
    } catch (e) { console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`)); process.exit(1); }
    saveTelegramConfig({ botToken: token, chatId: paired.chatId, username: me.username });
    await sendText({ token }, paired.chatId, "BrosAi is connected. Run `brosai telegram` on your computer to chat with the agent from here.").catch(() => {});
    console.log(C.green(`paired with ${paired.name} (chat ${paired.chatId}). Saved to config (0600).`));
    console.log(C.dim("Agent tools telegram_send / telegram_send_file are now enabled. Start bot mode with: brosai telegram"));
    return;
  }

  if (sub === "status") {
    const s = telegramSettings();
    if (!s) { console.log("Telegram: not configured. Run: brosai telegram setup"); return; }
    console.log(`Telegram: token ...${s.token.slice(-4)}  chat: ${s.chatId ?? "not paired"}`);
    return;
  }
  if (sub === "logout") { clearTelegramConfig(); console.log(C.green("Telegram config removed (revoke the token in @BotFather to be thorough).")); return; }
  if (sub === "test") {
    const s = telegramSettings();
    if (!s?.chatId) { console.error(C.red("Not set up. Run: brosai telegram setup")); process.exit(1); }
    await sendText(s, s.chatId, "Test message from brosai").then(() => console.log(C.green("sent"))).catch((e) => { console.error(C.red(e.message)); process.exit(1); });
    return;
  }
  if (sub !== "start") { console.error(C.red(`Unknown telegram command: ${sub}`)); process.exit(2); }

  const s = telegramSettings();
  if (!s?.chatId) { console.error(C.red("Telegram is not set up. Run: brosai telegram setup")); process.exit(1); }
  let provider: ResolvedProvider;
  try { provider = resolveProvider({ providerId: opts.provider, model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey }); }
  catch (e) { console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`)); process.exit(1); }
  let mcp = await connectMcpServers((m) => console.error(C.dim(`warn: ${m}`)));
  const tgToolDefs = telegramToolDefs();
  const session: SessionState = {
    provider, cwd: opts.cwd, mode: opts.mode, history: [], usage: { input: 0, output: 0 }, costUsd: null, steps: 0,
    approveState: { all: false, approved: new Set() }, todos: [], mcpDefs: [...mcp.toolDefs, ...tgToolDefs],
  };
  const reconnectMcp = async () => {
    mcp.close();
    mcp = await connectMcpServers((m) => console.error(C.dim(`warn: ${m}`)));
    session.mcpDefs = [...mcp.toolDefs, ...tgToolDefs];
  };
  session.mcpCtl = {
    list: () => Object.entries(listMcpServers()).map(([name, s]) => ({ name, transport: s.url ? "http" : "stdio" })),
    add: async (name, cfg) => {
      try {
        addMcpServer(name, cfg);
        await reconnectMcp();
        const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}__`;
        return { ok: true, tools: mcp.toolDefs.filter((d) => d.name.startsWith(prefix)).length };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    remove: async (name) => {
      try {
        if (!listMcpServers()[name]) return { ok: false, error: `no MCP server named "${name}"` };
        removeMcpServer(name);
        await reconnectMcp();
        return { ok: true };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
  };
  const wantResume = opts.resume ?? (opts.continueSession ? "__latest__" : undefined);
  if (wantResume) {
    const saved = loadSession(wantResume === "__latest__" ? undefined : wantResume);
    if (saved) { session.history = saved.history; session.sessionFile = opts.resume ?? listSessions()[0]?.file; console.log(C.dim(`resumed session (${saved.history.length} messages)`)); }
  }
  if (opts.yes) console.error(C.red("WARNING: --yes in Telegram mode lets anyone with access to your Telegram account run shell commands here without approval."));
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  console.log(C.dim(`${C.bold("BrosAi")} telegram bot - ${provider.def.name}/${provider.model} mode=${opts.mode} cwd=${opts.cwd} - Ctrl+C to stop`));
  try {
    await runTelegramBot({ session, yes: opts.yes, maxSteps: opts.maxSteps, contextWindow: opts.contextWindow, noCheckpoint: opts.noCheckpoint, log: (m) => console.log(C.dim(m)), signal: ac.signal });
  } catch (e) {
    console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
  } finally {
    mcp.close();
  }
}

let activeRepl: ReturnType<typeof createInterface> | null = null;

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const stdin = process.stdin;
  // Detach the REPL's keypress listener so keys aren't echoed/buffered twice.
  const priorKeypress = stdin.listeners("keypress");
  activeRepl?.pause();
  const rl = createInterface({ input: stdin, output: process.stdout });
  for (const l of priorKeypress) stdin.removeListener("keypress", l);
  try {
    return await new Promise<string>((r) => rl.question(question, r)).then((a) => a.trim());
  } finally {
    rl.close();
    for (const l of priorKeypress) stdin.on("keypress", l);
    activeRepl?.resume();
    activeRepl?.prompt();
  }
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
  mcpCtl?: ToolContext["mcp"];
  pendingImages?: string[];
}

function makeEvents(session: Session, jsonMode: boolean, raw = false) {
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
  const md = new MarkdownRenderer();
  return {
    onText: (d: string) => process.stdout.write(raw ? d : md.push(d)),
    onToolStart: (name: string, args: string) => {
      if (!raw) process.stdout.write(md.flush());
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
    flush: () => { if (!raw) process.stdout.write(md.flush()); },
  };
}

const PLAN_PROMPT = `${SYSTEM_PROMPT}

PLAN MODE: You are in plan mode. You may ONLY use read_file, glob, and grep — no writes, edits, or commands. Investigate the codebase, then output a concrete step-by-step implementation plan. Do NOT make any changes. End your reply with the plan clearly formatted.`;

const SUBAGENT_ACT_PROMPT = `${SYSTEM_PROMPT}\n\nYou are a sub-agent spawned by a parent agent. Complete the delegated task autonomously and report back concisely: what you did, key findings, files changed, and anything the parent must know. You cannot spawn further sub-agents.`;

const SUBAGENT_EXPLORE_PROMPT = `You are a read-only exploration sub-agent. Investigate the workspace using read_file, glob, grep, and list_dir only — make NO changes. Report concise findings: relevant files, how things work, and answers to the delegated question.`;

const READONLY_TOOLS = new Set(["read_file", "glob", "grep", "list_dir", "web_fetch", "todo_write"]);

async function runTurn(session: Session, prompt: string, opts: CliOpts, extraImages: string[] = [], hooks?: { events?: AgentEvents; signal?: AbortSignal }): Promise<string> {
  const images = [...(opts.images ?? []), ...extraImages];
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
  const allDefs = () => opts.mode === "plan"
    ? TOOLS.filter((d) => READONLY_TOOLS.has(d.name))
    : [...TOOLS, ...MCP_MANAGE_TOOLS, ...(session.mcpDefs ?? [])];
  const events = hooks?.events ?? makeEvents(session, opts.json, opts.raw);
  const result = await runAgent(prompt, {
    provider: session.provider,
    cwd: opts.cwd,
    history: session.history,
    systemPrompt: basePrompt + todoContext + loadContextFiles(opts.cwd),
    toolDefs: allDefs,
    maxSteps: opts.maxSteps,
    signal: hooks?.signal,
    ctx: {
      approve: opts.approveFn ?? (opts.yes ? () => true : makeApprover(session.approveState)),
      todos: session.todos,
      mcp: session.mcpCtl,
      subagent: async (sp: string, readOnly: boolean) => {
        const childDefs = readOnly
          ? TOOLS.filter((d) => READONLY_TOOLS.has(d.name))
          : TOOLS.filter((d) => d.name !== "spawn_agent");
        const res = await runAgent(sp, {
          provider: session.provider,
          cwd: opts.cwd,
          systemPrompt: readOnly ? SUBAGENT_EXPLORE_PROMPT : SUBAGENT_ACT_PROMPT,
          toolDefs: childDefs,
          maxSteps: 25,
          signal: hooks?.signal,
          ctx: { approve: opts.approveFn ?? (opts.yes ? () => true : makeApprover(session.approveState)), todos: session.todos },
        });
        const cost = estimateCost(session.provider.def.id, session.provider.model, res.usage.input, res.usage.output);
        session.usage.input += res.usage.input;
        session.usage.output += res.usage.output;
        if (cost != null) session.costUsd = (session.costUsd ?? 0) + cost;
        recordUsage(res.usage.input, res.usage.output, cost);
        const last = res.messages.at(-1);
        return last?.role === "assistant" ? (last.content ?? "") : "";
      },
    },
    events,
    images: images.length ? images : undefined,
  });
  (events as any).flush?.();
  session.history.push({ role: "user", content: prompt, images: images.length ? images : undefined });
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

const SLASH_COMMANDS = ["/provider", "/providers", "/model", "/mode", "/image", "/clear", "/cost", "/diff", "/undo", "/checkpoints", "/allow", "/sessions", "/status", "/context", "/compact", "/doctor", "/help", "/exit"];

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
      if (head === "/provider" || head === "/providers") candidates = PROVIDERS.map((p) => p.id);
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
  // One-shot -i/--image flags become pending attachments for the first prompt.
  if (opts.images?.length) { session.pendingImages = [...(session.pendingImages ?? []), ...opts.images]; opts.images = undefined; }
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.green("brosai> "), completer: makeCompleter(() => session.provider.def.id) });
  activeRepl = rl;
  const reprompt = () => { if (!rl.closed) rl.prompt(); };

  type Picker = { title: string; options: string[]; allowCustom?: boolean; onPick: (sel: string) => void | Promise<void> };
  let picker: Picker | null = null;
  let textAsk: { prompt: string; onAnswer: (v: string) => void | Promise<void> } | null = null;

  const applyProvider = async (id: string) => {
    try {
      session.provider = resolveProvider({ providerId: id });
      setLastUsedProvider(id);
      console.log(C.green(`provider -> ${id} (${session.provider.def.name}, model ${session.provider.model})`));
    } catch (e) { console.log(C.red(String(e instanceof Error ? e.message : e))); }
  };

  const showModelPicker = async (providerId: string, then?: (m: string) => void | Promise<void>) => {
    const def = getProvider(providerId);
    const stored = readConfig().providers[providerId]?.settings;
    const baseUrl = stored?.baseUrl ?? def?.baseUrl;
    const fetched = baseUrl ? await fetchModelList(baseUrl) : [];
    const options = [...new Set([...(def?.models ?? []), ...fetched])];
    const cur = session.provider.def.id === providerId ? session.provider.model : stored?.model;
    const displayName = stored?.name ?? def?.name ?? providerId;
    console.log(C.bold(`\n${displayName} — select model${cur ? ` (current: ${cur})` : ""}:`));
    options.slice(0, 30).forEach((m, i) => console.log(`  ${i + 1}) ${m}`));
    if (options.length > 30) console.log(C.dim(`  ... and ${options.length - 30} more`));
    if (!options.length) console.log(C.dim("  (none discovered — type a model name)"));
    picker = {
      title: "model",
      options,
      allowCustom: true,
      onPick: async (m) => {
        const merged = { ...readConfig().providers[providerId]?.settings, model: m };
        saveProviderSettings(providerId, merged, { setLastUsed: false });
        if (session.provider.def.id === providerId) session.provider = { ...session.provider, model: m };
        console.log(C.green(`model -> ${m}`));
        if (then) await then(m);
      },
    };
  };

  const askText = (prompt: string, onAnswer: (v: string) => void | Promise<void>) => {
    console.log(C.bold(`? ${prompt}`));
    textAsk = { prompt, onAnswer };
  };

  const configureCustom = async () => {
    const stored = readConfig().providers.custom?.settings;
    const afterUrl = async (baseUrl: string, name: string) => {
      saveProviderSettings("custom", { ...stored, baseUrl, name }, { setLastUsed: false });
      const pickModel = () => showModelPicker("custom", () => applyProvider("custom"));
      if (!stored?.apiKey && !process.env.BROSAI_API_KEY) {
        askText("API key (leave empty if the endpoint needs none): ", async (k) => {
          if (k.trim()) { storeKey("custom", k.trim()); console.log(C.green("key saved")); }
          await pickModel();
        });
      } else await pickModel();
    };
    askText(`Base URL [${stored?.baseUrl ?? "http://localhost:8000/v1"}]: `, (v) => {
      const baseUrl = (v.trim() || stored?.baseUrl || "http://localhost:8000/v1").replace(/\/+$/, "");
      askText(`Display name [${stored?.name ?? "Custom"}]: `, (nv) =>
        afterUrl(baseUrl, nv.trim() || stored?.name || "Custom"));
    });
  };

  const selectProvider = async (id: string) => {
    if (!getProvider(id)) { console.log(C.red(`unknown provider: ${id}`)); return; }
    if (id === "custom") {
      const stored = readConfig().providers.custom?.settings;
      if (!stored?.baseUrl || !stored?.model) { await configureCustom(); return; }
    }
    await applyProvider(id);
  };

  const showProviderPicker = () => {
    const cur = session.provider.def.id;
    console.log(C.bold("\nProviders:"));
    PROVIDERS.forEach((p, i) => {
      const mark = p.id === cur ? C.cyan(" <- current") : "";
      const name = readConfig().providers[p.id]?.settings?.name ?? p.name;
      console.log(`  ${i + 1}) ${p.id.padEnd(12)} ${name.padEnd(26)} key: ${keyStatus(p.id)}${mark}`);
    });
    console.log(C.dim("Enter a number or provider id. 'custom' = any OpenAI-compatible endpoint."));
    picker = { title: "provider", options: PROVIDERS.map((p) => p.id), allowCustom: false, onPick: selectProvider };
  };

  reprompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { reprompt(); continue; }
    if (textAsk) {
      const t = textAsk; textAsk = null;
      await t.onAnswer(input);
      reprompt(); continue;
    }
    if (picker) {
      const p = picker; picker = null;
      const n = Number(input);
      let sel = "";
      if (Number.isInteger(n) && n >= 1 && n <= p.options.length) sel = p.options[n - 1];
      else sel = p.options.find((o) => o === input || o.startsWith(input)) ?? (p.allowCustom ? input : "");
      if (sel) await p.onPick(sel);
      else console.log(C.dim("(cancelled)"));
      reprompt(); continue;
    }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") { session.history = []; console.log(C.dim("history cleared")); reprompt(); continue; }
    if (input === "/cost") {
      const life = lifetimeUsage();
      console.log(`session: steps=${session.steps} tokens in=${session.usage.input} out=${session.usage.output} est=${formatCost(session.costUsd)}`);
      if (life) console.log(`lifetime: tokens in=${life.input} out=${life.output} est=${formatCost(life.costUsd)}`);
      reprompt(); continue;
    }
    if (input === "/provider" || input === "/providers" || input.startsWith("/provider ") || input.startsWith("/providers ")) {
      const id = input.split(/\s+/)[1];
      if (!id) { showProviderPicker(); reprompt(); continue; }
      await selectProvider(id);
      reprompt(); continue;
    }
    if (input === "/model" || input.startsWith("/model ")) {
      const m = input.split(/\s+/)[1];
      if (!m) { await showModelPicker(session.provider.def.id); reprompt(); continue; }
      session.provider = { ...session.provider, model: m };
      saveProviderSettings(session.provider.def.id, { ...readConfig().providers[session.provider.def.id]?.settings, model: m }, { setLastUsed: false });
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
    if (input === "/context" || input === "/ctx") {
      const sysTokens = estimateTokens([{ role: "system", content: (opts.mode === "plan" ? PLAN_PROMPT : SYSTEM_PROMPT) + loadContextFiles(opts.cwd) }]);
      const histTokens = estimateTokens(session.history);
      const total = sysTokens + histTokens;
      const pct = opts.contextWindow > 0 ? Math.min(999, Math.round((total / opts.contextWindow) * 100)) : 0;
      const filled = Math.min(30, Math.round((pct / 100) * 30));
      console.log(C.bold(" context"));
      console.log(`  system prompt : ~${sysTokens} tokens`);
      console.log(`  history       : ~${histTokens} tokens across ${session.history.length} messages`);
      console.log(`  pending images: ${session.pendingImages?.length ?? 0}`);
      console.log(`  total         : ~${total} / ${opts.contextWindow} tokens  [${"#".repeat(filled)}${"-".repeat(30 - filled)}] ${pct}%`);
      console.log(C.dim("  (/compact forces summarization; auto-compaction kicks in at 80%)"));
      reprompt(); continue;
    }
    if (input === "/compact") {
      const before = session.history.length;
      const beforeTok = estimateTokens(session.history);
      console.log(C.dim("compacting context (this calls the model)…"));
      try {
        session.history = await compactHistory(session.provider, session.history, opts.contextWindow, true);
        const afterTok = estimateTokens(session.history);
        console.log(session.history.length !== before || afterTok < beforeTok
          ? C.green(`context compacted: ${before} -> ${session.history.length} messages (~${beforeTok} -> ~${afterTok} tokens)`)
          : C.yellow("nothing to compact — history is already minimal"));
      } catch (e) {
        console.log(C.red(`compact failed: ${e instanceof Error ? e.message : String(e)}`));
      }
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
    if (input === "/doctor" || input.startsWith("/doctor ")) {
      const { runDoctor } = await import("./doctor.ts");
      await runDoctor(input.split(/\s+/)[1] === "deep");
      reprompt(); continue;
    }
    if (input === "/checkpoints") {
      const cps = listCheckpoints(opts.cwd);
      if (!cps.length) console.log(C.dim("no checkpoints for this workspace"));
      for (const cp of cps.slice(-10).reverse()) console.log(`  ${cp.hash.slice(0, 7)}  ${cp.time}  ${cp.label.slice(0, 60)}`);
      reprompt(); continue;
    }
    if (input === "/image" || input.startsWith("/image ")) {
      const p = input.split(/\s+/).slice(1).join(" ").trim();
      if (!p) {
        const n = session.pendingImages?.length ?? 0;
        console.log(n ? C.green(`${n} image(s) attached to next message`) : C.dim("usage: /image <path> — attaches to your next message"));
      } else {
        try {
          session.pendingImages = [...(session.pendingImages ?? []), imageDataUrl(p)];
          console.log(C.green(`attached ${p} (${session.pendingImages.length} pending)`));
        } catch (e) { console.log(C.red(String(e instanceof Error ? e.message : e))); }
      }
      reprompt(); continue;
    }
    try {
      const imgs = session.pendingImages?.splice(0) ?? [];
      await runTurn(session, input, opts, imgs);
      console.log("");
    } catch (e) {
      console.log("\n" + C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    }
    reprompt();
  }
  rl.close();
  if (activeRepl === rl) activeRepl = null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "auth") { await authCmd(argv[1], argv[2]); return; }
  if (argv[0] === "providers") { providersCmd(); return; }
  if (argv[0] === "models" || argv[0] === "ollama") { await modelsCmd(argv.slice(1)); return; }
  if (argv[0] === "setup") { await setupCmd(); return; }
  if (argv[0] === "telegram") { await telegramCmd(argv.slice(1)); return; }
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
      const urlIdx = rest.indexOf("--url");
      if (urlIdx >= 0) {
        const url = rest[urlIdx + 1];
        const headers: Record<string, string> = {};
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--header" && rest[i + 1]) {
            const kv = rest[i + 1]; const eq = kv.indexOf("=");
            if (eq > 0) headers[kv.slice(0, eq)] = kv.slice(eq + 1);
            i++;
          }
        }
        if (!name || !url) { console.error(C.red("Usage: brosai mcp add <name> --url <http-url> [--header K=V]")); process.exit(2); }
        addMcpServer(name, { url, headers: Object.keys(headers).length ? headers : undefined });
        console.log(C.green(`MCP server "${name}" added (HTTP): ${url}`));
        console.log(C.dim("It will connect on next brosai run."));
        return;
      }
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

  if (argv[0] === "skills") { skillsCmd(argv.slice(1)); return; }
  const { opts, positional, command } = parseArgs(argv);
  if (command === "help") { usage(); return; }
  if (command === "version") { console.log(`brosai ${VERSION}`); return; }
  if (argv[0] === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    await runDoctor(argv.includes("--deep"));
    return;
  }
  if (argv[0] === "update") {
    const { selfUpdate } = await import("./update.ts");
    try { console.log(await selfUpdate()); }
    catch (e) { console.error(C.red(`update failed: ${e instanceof Error ? e.message : String(e)}`)); process.exit(1); }
    return;
  }

  // First-run guide: no providers configured and nothing overridden -> wizard
  if (!Object.keys(readConfig().providers).length && !opts.provider && !opts.apiKey && process.stdin.isTTY) {
    await setupCmd();
  }

  let provider: ResolvedProvider;
  try {
    provider = resolveProvider({ providerId: opts.provider, model: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  } catch (e) {
    console.error(C.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  const session: Session = { provider, history: [], usage: { input: 0, output: 0 }, costUsd: null, steps: 0, approveState: { all: false, approved: new Set() }, todos: [], pendingImages: [] };

  let mcp = await connectMcpServers((m) => console.error(C.dim(`warn: ${m}`)));
  if (mcp.servers.length) {
    const nTools = mcp.toolDefs.length;
    console.error(C.dim(`mcp: connected ${mcp.servers.join(", ")} (${nTools} tools)`));
    session.mcpDefs = mcp.toolDefs;
  }
  const tgDefs = telegramToolDefs();
  if (tgDefs.length) session.mcpDefs = [...(session.mcpDefs ?? []), ...tgDefs];
  process.on("exit", () => mcp.close());
  const reconnectMcp = async () => {
    mcp.close();
    mcp = await connectMcpServers((m) => console.error(C.dim(`warn: ${m}`)));
    session.mcpDefs = [...mcp.toolDefs, ...tgDefs];
    console.error(C.dim(`mcp: reconnected ${mcp.servers.join(", ") || "(none)"} (${mcp.toolDefs.length} tools)`));
  };
  session.mcpCtl = {
    list: () => Object.entries(listMcpServers()).map(([name, s]) => ({ name, transport: s.url ? "http" : "stdio" })),
    add: async (name, cfg) => {
      try {
        addMcpServer(name, cfg);
        await reconnectMcp();
        const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}__`;
        return { ok: true, tools: mcp.toolDefs.filter((d) => d.name.startsWith(prefix)).length };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    remove: async (name) => {
      try {
        if (!listMcpServers()[name]) return { ok: false, error: `no MCP server named "${name}"` };
        removeMcpServer(name);
        await reconnectMcp();
        return { ok: true };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
  };
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

  if (argv[0] === "web") {
    const pi = argv.indexOf("--port");
    const port = Number(pi >= 0 ? argv[pi + 1] : 0) || Number(process.env.BROS_WEB_PORT) || 8420;
    const { startWebServer, makeWebApprover } = await import("./web.ts");
    const approvals: WebApproval[] = [];
    opts.approveFn = makeWebApprover(approvals, { all: false });
    const control = {
      getState: () => ({
        mode: opts.mode,
        cwd: opts.cwd,
        sessionFile: session.sessionFile ?? null,
        provider: { id: provider.def.id, name: provider.def.name, model: provider.model },
        providers: PROVIDERS.map((d) => {
          const s = readConfig().providers[d.id]?.settings;
          return { id: d.id, name: s?.name ?? d.name, model: s?.model ?? d.models[0], active: d.id === provider.def.id };
        }),
        mcp: Object.entries(listMcpServers()).map(([name, s]) => ({ name, command: s.command, args: s.args, url: s.url, headers: s.headers })),
        context: (() => {
          const systemTokens = estimateTokens([{ role: "system", content: (opts.mode === "plan" ? PLAN_PROMPT : SYSTEM_PROMPT) + loadContextFiles(opts.cwd) }]);
          const historyTokens = estimateTokens(session.history);
          return { tokens: systemTokens + historyTokens, systemTokens, historyTokens, window: opts.contextWindow, messages: session.history.length };
        })(),
      }),
      setMode: (mode: "act" | "plan") => { opts.mode = mode; },
      setProvider: async (id: string) => {
        try {
          provider = resolveProvider({ providerId: id });
          session.provider = provider;
          setLastUsedProvider(id);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      addMcp: async (input: any) => {
        const name = String(input?.name ?? "").trim();
        if (!name) return { ok: false, error: "name required" };
        try {
          if (input.transport === "http") {
            if (!input.url) return { ok: false, error: "url required" };
            addMcpServer(name, { url: String(input.url), headers: input.headers });
          } else {
            if (!input.command) return { ok: false, error: "command required" };
            addMcpServer(name, { command: String(input.command), args: input.args, env: input.env });
          }
          await reconnectMcp();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      removeMcp: async (name: string) => {
        try {
          if (!listMcpServers()[String(name)]) return { ok: false, error: `no MCP server named "${name}"` };
          removeMcpServer(String(name));
          await reconnectMcp();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      getDiff: async () => {
        try {
          const diff = await workspaceDiff(opts.cwd);
          return { diff: diff ?? "no changes since last checkpoint" };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      undo: async () => {
        try {
          const cp = await undoCheckpoint(opts.cwd, 1);
          return cp ? { message: `undid: ${cp.label}` } : { error: "nothing to undo" };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      listSessions: () => listSessions(),
      getHistory: () => session.history
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
        .map((m) => ({ role: m.role, content: m.content ?? "", images: m.images?.length ?? 0 })),
      newSession: () => { session.history = []; session.sessionFile = undefined; session.todos = []; },
      loadSession: async (file: string) => {
        const saved = loadSession(file);
        if (!saved) return { ok: false, error: "session not found" };
        session.history = saved.history;
        session.sessionFile = file;
        try { session.provider = { ...session.provider, model: saved.model }; provider = session.provider; } catch {}
        const history = saved.history
          .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
          .map((m) => ({ role: m.role, content: m.content ?? "", images: m.images?.length ?? 0 }));
        return { ok: true, history };
      },
      addImage: async (data: string, name: string) => {
        if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(data)) {
          return { ok: false, error: `unsupported image type (png/jpg/gif/webp/bmp): ${name}` };
        }
        if (data.length > 11_500_000) return { ok: false, error: `${name}: over 8MB` };
        session.pendingImages = [...(session.pendingImages ?? []), data];
        return { ok: true, count: session.pendingImages.length };
      },
      listSkills: () => listSkills(opts.cwd).map((sk) => ({ name: sk.name, scope: sk.scope, description: sk.description, chars: sk.chars })),
      saveSkill: async (input) => {
        try {
          const scope = input.scope === "project" ? "project" : "global";
          const info = saveSkill(opts.cwd, input.name, input.content, scope);
          return { ok: true };
        } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      },
      compact: async () => {
        const before = session.history.length;
        try {
          session.history = await compactHistory(session.provider, session.history, opts.contextWindow, true);
          session.sessionFile = saveSession({
            file: session.sessionFile,
            provider: session.provider.def.id,
            model: session.provider.model,
            cwd: opts.cwd,
            history: session.history,
          });
          return { ok: true, before, after: session.history.length };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      removeSkill: async (name) => {
        try {
          if (!removeSkill(opts.cwd, name)) return { ok: false, error: `no skill named "${name}"` };
          return { ok: true };
        } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      },
    };
    const bridge = startWebServer({
      port,
      approvals,
      control,
      onMessage: async (text, emit, signal) => {
        const events: AgentEvents | undefined = emit
          ? {
              onText: (d) => emit("text", { delta: d }),
              onToolStart: (name, args) => {
                let parsed: unknown = args;
                try { parsed = JSON.parse(args); } catch {}
                emit("tool_start", { name, args: parsed });
              },
              onToolEnd: (name, result) => {
                emit("tool_end", { name, ok: result.ok, output: String(result.output ?? "").slice(0, 4000) });
                if (name === "todo_write") {
                  emit("todos", { todos: session.todos.map((t) => ({ text: t.content, done: t.status === "completed", active: t.status === "in_progress" })) });
                }
              },
              onUsage: (i, o) => {
                session.usage.input += i;
                session.usage.output += o;
                emit("usage", { input: i, output: o });
              },
            }
          : undefined;
        try {
          const imgs = session.pendingImages?.splice(0) ?? [];
          const reply = await runTurn(session, text, opts, imgs, { events, signal });
          return { reply, usage: { input: session.usage.input, output: session.usage.output, cost: session.costUsd } };
        } catch (e) {
          return { reply: "", error: e instanceof Error ? e.message : String(e) };
        }
      },
    });
    const webUrl = `http://localhost:${port}`;
    const tokenQ = process.env.BROS_WEB_TOKEN ? `?token=${encodeURIComponent(process.env.BROS_WEB_TOKEN)}` : "";
    console.log(C.green(`BrosAi web UI → ${webUrl}${tokenQ}  (${provider.def.name}/${provider.model}, cwd ${opts.cwd})`));
    if (process.env.BROS_WEB_TOKEN) console.log(C.dim("auth: BROS_WEB_TOKEN enabled — open the URL above once to set the session cookie"));
    console.log(C.dim("Ctrl+C to stop. Approvals appear as buttons in the page."));
    if (!process.env.BROS_NO_BROWSER) {
      try {
        const openUrl = `${webUrl}${tokenQ}`;
        const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", openUrl]]
          : process.platform === "darwin" ? ["open", [openUrl]]
          : ["xdg-open", [openUrl]];
        spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      } catch {}
    }
    await new Promise<void>((r) => { process.on("SIGINT", () => r()); bridge.server.on("close", () => r()); });
    bridge.close();
    mcp.close();
    return;
  }

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

  pendingUpdate().then((v) => {
    if (v) console.log(C.yellow(`\nupdate available: v${v} — run 'brosai update'`));
  }).catch(() => {});
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
