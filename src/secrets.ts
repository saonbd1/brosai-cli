import { readConfig, saveProviderSettings, type ProviderSettings } from "./config.ts";

export type ProviderApi = "openai-compat" | "anthropic";

export interface ProviderDef {
  id: string;
  name: string;
  api: ProviderApi;
  apiKeyEnv: string[];
  baseUrl?: string;
  models: string[];
}

export const PROVIDERS: ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", api: "anthropic", apiKeyEnv: ["ANTHROPIC_API_KEY"], baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"] },
  { id: "openai", name: "OpenAI", api: "openai-compat", apiKeyEnv: ["OPENAI_API_KEY"], baseUrl: "https://api.openai.com/v1", models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  { id: "openrouter", name: "OpenRouter", api: "openai-compat", apiKeyEnv: ["OPENROUTER_API_KEY"], baseUrl: "https://openrouter.ai/api/v1", models: ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-v4", "openai/gpt-5"] },
  { id: "vercel-gateway", name: "Vercel AI Gateway", api: "openai-compat", apiKeyEnv: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"], baseUrl: "https://ai-gateway.vercel.sh/v1", models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"] },
  { id: "deepseek", name: "DeepSeek", api: "openai-compat", apiKeyEnv: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "cerebras", name: "Cerebras", api: "openai-compat", apiKeyEnv: ["CEREBRAS_API_KEY"], baseUrl: "https://api.cerebras.ai/v1", models: ["gpt-oss-120b", "qwen-3.8-27b"] },
  { id: "groq", name: "Groq", api: "openai-compat", apiKeyEnv: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] },
  { id: "custom", name: "Custom (OpenAI-compatible)", api: "openai-compat", apiKeyEnv: ["BROSAI_API_KEY", "CUSTOM_API_KEY"], models: [] },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ResolvedProvider {
  def: ProviderDef;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function resolveApiKey(providerId: string, stored?: ProviderSettings): { apiKey?: string; source?: string } {
  if (typeof stored?.apiKey === "string" && stored.apiKey.trim()) {
    return { apiKey: stored.apiKey.trim(), source: "config" };
  }
  const def = getProvider(providerId);
  for (const envName of def?.apiKeyEnv ?? []) {
    const v = process.env[envName]?.trim();
    if (v) return { apiKey: v, source: `env:${envName}` };
  }
  const generic = process.env.BROSAI_API_KEY?.trim();
  if (generic) return { apiKey: generic, source: "env:BROSAI_API_KEY" };
  return {};
}

export function resolveProvider(opts: {
  providerId?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}): ResolvedProvider {
  const cfg = readConfig();
  const providerId =
    opts.providerId ??
    cfg.lastUsedProvider ??
    (process.env.BROSAI_PROVIDER?.trim() || "openrouter");

  const def = getProvider(providerId);
  if (!def) throw new Error(`Unknown provider "${providerId}". Known: ${PROVIDERS.map((p) => p.id).join(", ")}`);

  const stored = cfg.providers[providerId]?.settings;
  const { apiKey } = opts.apiKey ? { apiKey: opts.apiKey } : resolveApiKey(providerId, stored);

  if (!apiKey) {
    const envHint = def.apiKeyEnv.length ? `Set ${def.apiKeyEnv.join(" or ")}` : "Set BROSAI_API_KEY";
    throw new Error(`No API key for provider "${providerId}". ${envHint}, or run: brosai auth ${providerId}`);
  }

  const model = opts.model ?? stored?.model ?? process.env.BROSAI_MODEL?.trim() ?? def.models[0];
  if (!model) throw new Error(`No model for provider "${providerId}". Pass --model <id>`);

  const baseUrl = opts.baseUrl ?? stored?.baseUrl ?? def.baseUrl;
  if (!baseUrl) throw new Error(`Provider "${providerId}" needs a baseUrl (--base-url or config)`);

  return { def, apiKey, model, baseUrl };
}

export function storeKey(providerId: string, apiKey: string, extra: ProviderSettings = {}): void {
  const def = getProvider(providerId);
  if (!def) throw new Error(`Unknown provider "${providerId}"`);
  saveProviderSettings(providerId, { ...extra, apiKey }, { setLastUsed: true });
}
