/** Approximate list prices in USD per 1M tokens. Longest/most-specific match wins. */
interface Price {
  input: number;
  output: number;
}

const TABLE: { match: RegExp; price: Price }[] = [
  // Cerebras
  { match: /gpt-oss-120b/i, price: { input: 0.25, output: 0.69 } },
  { match: /qwen.*27b/i, price: { input: 0.6, output: 1.2 } },
  // Anthropic
  { match: /claude.*opus/i, price: { input: 15, output: 75 } },
  { match: /claude.*sonnet/i, price: { input: 3, output: 15 } },
  { match: /claude.*haiku/i, price: { input: 0.8, output: 4 } },
  // OpenAI
  { match: /gpt-4o-mini/i, price: { input: 0.15, output: 0.6 } },
  { match: /gpt-4o/i, price: { input: 2.5, output: 10 } },
  { match: /o1-mini/i, price: { input: 1.1, output: 4.4 } },
  { match: /o3-mini/i, price: { input: 1.1, output: 4.4 } },
  // DeepSeek
  { match: /deepseek/i, price: { input: 0.27, output: 1.1 } },
  // Groq (approximate llama-3.3-70b)
  { match: /llama.*70b/i, price: { input: 0.59, output: 0.79 } },
  { match: /llama.*8b/i, price: { input: 0.05, output: 0.08 } },
];

const PROVIDER_DEFAULTS: Record<string, Price> = {
  cerebras: { input: 0.5, output: 1.0 },
  deepseek: { input: 0.27, output: 1.1 },
  groq: { input: 0.3, output: 0.5 },
};

/** Returns USD cost for a call, or null when pricing is unknown. */
export function estimateCost(providerId: string, model: string, inputTokens: number, outputTokens: number): number | null {
  const hit = TABLE.find((t) => t.match.test(model));
  const price = hit?.price ?? PROVIDER_DEFAULTS[providerId];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function formatCost(usd: number | null): string {
  if (usd == null) return "cost n/a";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
