import { chatStream, type ChatMessage, type ToolSpec } from "./providers/index.ts";
import { runTool, toolSpecs, type ToolContext, type ToolResult } from "./tools/index.ts";
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
  ctx?: Partial<ToolContext>;
  events?: AgentEvents;
}

export interface AgentResult {
  messages: ChatMessage[];
  steps: number;
  usage: { input: number; output: number };
  cancelled: boolean;
}

export async function runAgent(prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const tools = opts.tools ?? toolSpecs();
  const ctx: ToolContext = { cwd: opts.cwd, approve: opts.ctx?.approve };
  const maxSteps = opts.maxSteps ?? 100;

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? "" },
    ...(opts.history ?? []),
    { role: "user", content: prompt },
  ];

  const usage = { input: 0, output: 0 };
  let steps = 0;
  let cancelled = false;

  while (steps < maxSteps) {
    steps++;
    let turnContent = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

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

    for (const tc of toolCalls) {
      opts.events?.onToolStart?.(tc.name, tc.arguments);
      const result = await runTool(tc.name, tc.arguments, ctx);
      opts.events?.onToolEnd?.(tc.name, result);
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: result.output });
      if (opts.signal?.aborted) { cancelled = true; break; }
    }
    if (cancelled) break;
  }

  const newMessages = messages.slice(1 + (opts.history?.length ?? 0) + 1);
  return { messages: newMessages, steps, usage, cancelled };
}
