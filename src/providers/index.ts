import type { ResolvedProvider } from "../secrets.ts";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; finishReason?: string }
  | { type: "error"; message: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
  finishReason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && i < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** i);
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/* ---------------- OpenAI-compatible ---------------- */

async function* openaiCompatStream(provider: ResolvedProvider, params: ChatParams): AsyncGenerator<StreamEvent> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const tools = params.tools.length
    ? params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      messages: params.messages,
      tools,
      tool_choice: tools ? "auto" : undefined,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens,
    }),
    signal: params.signal,
  });

  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          for (const [i, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
            yield { type: "tool_call", id: tc.id || `call_${i}`, name: tc.name, arguments: tc.args };
          }
          toolAcc.clear();
          return;
        }
        let payload: any;
        try { payload = JSON.parse(data); } catch { continue; }
        const choice = payload.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) yield { type: "text", delta: delta.content };
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i2 = tc.index ?? 0;
            const cur = toolAcc.get(i2) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(i2, cur);
          }
        }
        if (payload.usage) yield { type: "usage", input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 };
        if (choice?.finish_reason) yield { type: "done", finishReason: choice.finish_reason };
      }
    }
    for (const [i, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "tool_call", id: tc.id || `call_${i}`, name: tc.name, arguments: tc.args };
    }
  } finally {
    reader.releaseLock();
  }
}

/* ---------------- Anthropic ---------------- */

async function* anthropicStream(provider: ResolvedProvider, params: ChatParams): AsyncGenerator<StreamEvent> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const system = params.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n\n");
  const messages = params.messages.filter((m) => m.role !== "system").map((m) => {
    if (m.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" }] };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      return { role: "assistant", content: blocks };
    }
    return { role: m.role, content: m.content ?? "" };
  });

  const tools = params.tools.length
    ? params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    : undefined;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "tools-2024-04-04",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: params.maxTokens ?? 8192,
      system: system || undefined,
      messages,
      tools,
    }),
    signal: params.signal,
  });

  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolAcc = new Map<number, { id: string; name: string; json: string }>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev: any;
        try { ev = JSON.parse(data); } catch { continue; }
        switch (ev.type) {
          case "content_block_delta": {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text) yield { type: "text", delta: d.text };
            if (d?.type === "input_json_delta" && d.partial_json != null) {
              const cur = toolAcc.get(ev.index) ?? { id: "", name: "", json: "" };
              cur.json += d.partial_json;
              toolAcc.set(ev.index, cur);
            }
            break;
          }
          case "content_block_start": {
            const cb = ev.content_block;
            if (cb?.type === "tool_use") toolAcc.set(ev.index, { id: cb.id ?? "", name: cb.name ?? "", json: "" });
            break;
          }
          case "message_delta":
            if (ev.delta?.stop_reason) yield { type: "done", finishReason: ev.delta.stop_reason };
            if (ev.usage) yield { type: "usage", input: ev.usage.input_tokens ?? 0, output: ev.usage.output_tokens ?? 0 };
            break;
          case "message_start": {
            const u = ev.message?.usage;
            if (u) yield { type: "usage", input: u.input_tokens ?? 0, output: 0 };
            break;
          }
          case "error":
            yield { type: "error", message: ev.error?.message ?? "provider error" };
            break;
        }
      }
    }
    for (const [i, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "tool_call", id: tc.id || `toolu_${i}`, name: tc.name, arguments: tc.json };
    }
  } finally {
    reader.releaseLock();
  }
}

/* ---------------- Public API ---------------- */

export function chatStream(provider: ResolvedProvider, params: ChatParams): AsyncGenerator<StreamEvent> {
  return provider.def.api === "anthropic" ? anthropicStream(provider, params) : openaiCompatStream(provider, params);
}

export async function chatOnce(provider: ResolvedProvider, params: ChatParams): Promise<AssistantTurn> {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let usage: { input: number; output: number } | undefined;
  let finishReason: string | undefined;
  for await (const ev of chatStream(provider, params)) {
    if (ev.type === "text") content += ev.delta;
    else if (ev.type === "tool_call") toolCalls.push({ id: ev.id, type: "function", function: { name: ev.name, arguments: ev.arguments } });
    else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
    else if (ev.type === "done") finishReason = ev.finishReason;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return { content, toolCalls, usage, finishReason };
}
