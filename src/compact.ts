import { chatOnce, type ChatMessage } from "./providers/index.ts";
import type { ResolvedProvider } from "./secrets.ts";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4);
}

const SUMMARIZE_PROMPT = `You are compressing a coding-agent conversation to save context. Summarize the conversation so far, preserving:
- the user's goal and requirements
- decisions made and why
- files created/modified and key contents or diffs
- commands run and their outcomes
- current state and next steps
Be dense and factual. Output only the summary.`;

/**
 * If history exceeds ~80% of maxTokens, summarize the older portion via the
 * provider and keep the most recent messages verbatim. Returns history unchanged
 * when under the threshold or when compaction isn't possible.
 */
export async function compactHistory(
  provider: ResolvedProvider,
  history: ChatMessage[],
  maxTokens: number,
): Promise<ChatMessage[]> {
  const budget = Math.floor(maxTokens * 0.8);
  if (estimateTokens(history) <= budget) return history;

  // Keep the last ~10 messages, cut only at a user-message boundary so
  // tool_call/tool_result pairs are never split.
  let cut = Math.max(0, history.length - 10);
  while (cut > 0 && history[cut].role !== "user") cut--;
  if (cut === 0) return history; // can't find a safe split

  const older = history.slice(0, cut);
  const tail = history.slice(cut);

  // Serialize older messages, capped so the summarization call itself fits
  let serialized = "";
  for (const m of older) {
    const line = `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}${m.tool_calls ? " [tool_calls]" : ""}\n`;
    if (serialized.length + line.length > 120_000) { serialized += "…[truncated]"; break; }
    serialized += line;
  }

  try {
    const res = await chatOnce(provider, {
      messages: [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: `Conversation to summarize:\n\n${serialized}` },
      ],
      tools: [],
      maxTokens: 2048,
    });
    const summary = res.content?.trim();
    if (!summary) return history;
    return [
      { role: "user", content: `[Summary of earlier conversation — details may be compressed]\n${summary}` },
      { role: "assistant", content: "Understood. Continuing from the summary." },
      ...tail,
    ];
  } catch {
    return history;
  }
}
