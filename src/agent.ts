import { chatStream, type ChatMessage, type ToolSpec } from "./providers/index.ts";
import { compactHistory } from "./compact.ts";
import { runTool, toolSpecs, TOOLS, type ToolContext, type ToolDef, type ToolResult } from "./tools/index.ts";
import type { ResolvedProvider } from "./secrets.ts";

export interface AgentEvents {
  onText?: (delta: string) => void;
  onToolStart?: (name: string, args: string) => void;
  onToolEnd?: (name: string, result: ToolResult) => void;
  onUsage?: (input: number, output: number) => void;
}

export interface AgentOptions {
  provider: ResolvedProvider;
  cwd: string;
  history?: ChatMessage[];
  systemPrompt?: string;
  maxSteps?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ToolSpec[];
  /** Static list, or a getter re-evaluated each step so hot-added tools (e.g. new MCP servers) become available mid-turn. */
  toolDefs?: ToolDef[] | (() => ToolDef[]);
  ctx?: Partial<ToolContext>;
  events?: AgentEvents;
  /** Data-URL images attached to this turn's user message. */
  images?: string[];
  /** Model context window; enables mid-turn compaction when history grows too large. */
  contextWindow?: number;
}

export interface AgentResult {
  messages: ChatMessage[];
  steps: number;
  usage: { input: number; output: number };
  cancelled: boolean;
}

const PARALLEL_SAFE = new Set(["read_file", "glob", "grep", "list_dir", "web_fetch"]);

/** True when a call cannot change workspace state and never prompts, so it may run alongside its neighbours. */
function parallelSafe(tc: { name: string; arguments: string }): boolean {
  if (PARALLEL_SAFE.has(tc.name)) return true;
  if (tc.name === "spawn_agent") { try { return JSON.parse(tc.arguments || "{}").read_only === true; } catch { return false; } }
  return false;
}

export async function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const resolveDefs = () => (typeof opts.toolDefs === "function" ? opts.toolDefs() : opts.toolDefs ?? TOOLS);
  const ctx: ToolContext = { cwd: opts.cwd, ...opts.ctx, signal: opts.signal };
  const maxSteps = opts.maxSteps ?? 100;

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? "" },
    ...(opts.history ?? []),
    { role: "user", content: prompt, images: opts.images?.length ? opts.images : undefined },
  ];

  const usage = { input: 0, output: 0 };
  let steps = 0;
  let cancelled = false;

  while (steps < maxSteps) {
    steps++;
    const defs = resolveDefs();
    ctx.toolDefs = defs;
    const tools = opts.tools ?? defs.map(({ name, description, parameters }) => ({ name, description, parameters }));
    let turnContent = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    // Mid-turn compaction: one turn can grow history far past the window (100 steps
    // × tool outputs), and turn-start compaction alone can't catch that. Check before
    // every model call; compactHistory early-returns cheaply when under budget.
    if (opts.contextWindow && steps > 1) {
      const rest = messages.slice(1);
      const compacted = await compactHistory(opts.provider, rest, Math.floor(opts.contextWindow * 0.8));
      if (compacted !== rest) {
        messages.splice(1, messages.length - 1, ...compacted);
        opts.events?.onText?.("\n\n_(context compacted)_\n\n");
      }
    }

    try {
      for await (const ev of chatStream(opts.provider, { messages, tools, signal: opts.signal, maxTokens: opts.maxTokens })) {
        if (ev.type === "text") { turnContent += ev.delta; opts.events?.onText?.(ev.delta); }
        else if (ev.type === "tool_call") toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
        else if (ev.type === "usage") { usage.input += ev.input; usage.output += ev.output; opts.events?.onUsage?.(ev.input, ev.output); }
        else if (ev.type === "error") throw new Error(ev.message);
      }
    } catch (e) {
      if (opts.signal?.aborted) { cancelled = true; break; }
      throw e;
    }
    if (opts.signal?.aborted) { cancelled = true; break; }

    messages.push({
      role: "assistant",
      content: turnContent || null,
      tool_calls: toolCalls.length
        ? toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } }))
        : undefined,
    });

    if (toolCalls.length === 0) break;

    // Read-only calls the model emitted together (e.g. 4x read_file, grep + glob) run concurrently;
    // anything that can change state keeps strict order. Results are appended in the original order.
    let i = 0;
    while (i < toolCalls.length) {
      // Every tool_call must get a tool message, even after Ctrl+C, or the saved history is invalid.
      if (cancelled || opts.signal?.aborted) {
        cancelled = true;
        for (; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: "Cancelled by user before this tool ran" });
        }
        break;
      }
      let j = i + 1;
      if (parallelSafe(toolCalls[i])) while (j < toolCalls.length && parallelSafe(toolCalls[j])) j++;
      const batch = toolCalls.slice(i, j);
      for (const tc of batch) opts.events?.onToolStart?.(tc.name, tc.arguments);
      const results = batch.length === 1
        ? [await runTool(batch[0].name, batch[0].arguments, ctx)]
        : await Promise.all(batch.map((tc) => runTool(tc.name, tc.arguments, ctx)));
      batch.forEach((tc, k) => {
        opts.events?.onToolEnd?.(tc.name, results[k]);
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: results[k].output });
      });
      i = j;
      if (opts.signal?.aborted) cancelled = true;
    }
    if (cancelled) break;
  }

  const newMessages = messages.slice(1 + (opts.history?.length ?? 0) + 1);
  return { messages: newMessages, steps, usage, cancelled };
}
