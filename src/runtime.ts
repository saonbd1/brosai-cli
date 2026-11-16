import { runAgent, type AgentEvents } from "./agent.ts";
import { SYSTEM_PROMPT, loadContextFiles } from "./prompt.ts";
import { TOOLS, type TodoItem, type ToolDef } from "./tools/index.ts";
import { readConfig } from "./config.ts";
import { getProvider, type ResolvedProvider } from "./secrets.ts";
import { recordUsage } from "./config.ts";
import { estimateCost } from "./pricing.ts";
import { compactHistory } from "./compact.ts";
import { saveSession } from "./session.ts";
import { createCheckpoint } from "./checkpoint.ts";
import type { ChatMessage } from "./providers/index.ts";

export const PLAN_PROMPT = `${SYSTEM_PROMPT}

PLAN MODE: You are in plan mode. You may ONLY use read_file, glob, and grep — no writes, edits, or commands. Investigate the codebase, then output a concrete step-by-step implementation plan. Do NOT make any changes. End your reply with the plan clearly formatted.`;

export const SUBAGENT_ACT_PROMPT = `${SYSTEM_PROMPT}\n\nYou are a sub-agent spawned by a parent agent. Complete the delegated task autonomously and report back concisely: what you did, key findings, files changed, and anything the parent must know. You cannot spawn further sub-agents.`;

export const SUBAGENT_EXPLORE_PROMPT = `You are a read-only exploration sub-agent. Investigate the workspace using read_file, glob, grep, and list_dir only — make NO changes. Report concise findings: relevant files, how things work, and answers to the delegated question.`;

export const READONLY_TOOLS = new Set(["read_file", "glob", "grep", "list_dir", "web_fetch", "todo_write"]);

export interface SessionState {
  provider: ResolvedProvider | null;
  cwd: string;
  mode: "act" | "plan";
  history: ChatMessage[];
  usage: { input: number; output: number };
  costUsd: number | null;
  steps: number;
  sessionFile?: string;
  approveState: { all: boolean; approved: Set<string> };
  todos: TodoItem[];
  mcpDefs?: ToolDef[];
}

export interface TurnOptions {
  maxSteps?: number;
  contextWindow?: number;
  noCheckpoint?: boolean;
  images?: string[];
  signal?: AbortSignal;
  approve: (cmd: string) => Promise<boolean> | boolean;
  events?: AgentEvents;
  onCompacted?: (before: number, after: number) => void;
}

export async function runRuntimeTurn(session: SessionState, prompt: string, opts: TurnOptions): Promise<string> {
  if (!session.provider) throw new Error("No provider configured");
  const provider = session.provider;
  const contextWindow = opts.contextWindow ?? 32768;

  if (!opts.noCheckpoint && session.mode !== "plan") {
    await createCheckpoint(session.cwd, prompt);
  }
  if (session.mode !== "plan" && session.history.length > 6) {
    const before = session.history.length;
    session.history = await compactHistory(provider, session.history, contextWindow);
    if (session.history.length !== before) opts.onCompacted?.(before, session.history.length);
  }

  const basePrompt = session.mode === "plan" ? PLAN_PROMPT : SYSTEM_PROMPT;
  const todoContext = session.todos.length
    ? `\n\nCurrent task list (use todo_write to update):\n${session.todos.map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n")}`
    : "";

  const allDefs = session.mode === "plan"
    ? TOOLS.filter((d) => READONLY_TOOLS.has(d.name))
    : [...TOOLS, ...(session.mcpDefs ?? [])];

  const result = await runAgent(prompt, {
    provider,
    cwd: session.cwd,
    history: session.history,
    systemPrompt: basePrompt + todoContext + loadContextFiles(session.cwd),
    toolDefs: allDefs,
    maxSteps: opts.maxSteps ?? 100,
    signal: opts.signal,
    ctx: {
      approve: opts.approve,
      todos: session.todos,
      subagent: async (sp: string, readOnly: boolean) => {
        const childDefs = readOnly
          ? TOOLS.filter((d) => READONLY_TOOLS.has(d.name))
          : TOOLS.filter((d) => d.name !== "spawn_agent");
        const res = await runAgent(sp, {
          provider,
          cwd: session.cwd,
          systemPrompt: readOnly ? SUBAGENT_EXPLORE_PROMPT : SUBAGENT_ACT_PROMPT,
          toolDefs: childDefs,
          maxSteps: 25,
          signal: opts.signal,
          ctx: { approve: opts.approve, todos: session.todos },
        });
        const cost = estimateCost(provider.def.id, provider.model, res.usage.input, res.usage.output);
        session.usage.input += res.usage.input;
        session.usage.output += res.usage.output;
        if (cost != null) session.costUsd = (session.costUsd ?? 0) + cost;
        recordUsage(res.usage.input, res.usage.output, cost);
        const last = res.messages.at(-1);
        return last?.role === "assistant" ? (last.content ?? "") : "";
      },
    },
    events: {
      ...opts.events,
      onUsage: (i, o) => {
        session.usage.input += i;
        session.usage.output += o;
        opts.events?.onUsage?.(i, o);
      },
    },
    images: opts.images?.length ? opts.images : undefined,
  });

  session.history.push({ role: "user", content: prompt, images: opts.images?.length ? opts.images : undefined });
  session.history.push(...result.messages);
  session.steps += result.steps;

  const turnCost = estimateCost(provider.def.id, provider.model, result.usage.input, result.usage.output);
  if (turnCost != null) session.costUsd = (session.costUsd ?? 0) + turnCost;
  recordUsage(result.usage.input, result.usage.output, turnCost);

  session.sessionFile = saveSession({
    file: session.sessionFile,
    provider: provider.def.id,
    model: provider.model,
    cwd: session.cwd,
    history: session.history,
  });

  const last = result.messages.at(-1);
  return last?.role === "assistant" ? (last.content ?? "") : "";
}

export async function fetchModelList(baseUrl: string): Promise<string[]> {
  try {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    for (const u of [`${baseUrl.replace(/\/+$/, "")}/models`, `${root}/api/tags`]) {
      const res = await fetch(u, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const d: any = await res.json();
      const names = (d.data ?? d.models ?? []).map((m: any) => String(m.id ?? m.name ?? "")).filter(Boolean);
      if (names.length) return names;
    }
  } catch {}
  return [];
}

export function ollamaApiRoot(): string {
  const cfgBase = readConfig().providers.ollama?.settings?.baseUrl;
  const defBase = getProvider("ollama")?.baseUrl ?? "http://localhost:11434/v1";
  const raw = (process.env.BROSAI_OLLAMA_URL?.trim() || process.env.OLLAMA_BASE_URL?.trim() || cfgBase || defBase).replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
}