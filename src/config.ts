import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function homeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

/** Root config dir: $BROS_DIR or ~/.brosai */
export function brosDir(): string {
  const override = process.env.BROS_DIR?.trim();
  return override ? resolve(override) : join(homeDir(), ".brosai");
}

export function configPath(): string {
  const override = process.env.BROS_CONFIG_PATH?.trim();
  return override ? resolve(override) : join(brosDir(), "config.json");
}

export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Display-name override, e.g. "Colibri" for a custom endpoint. */
  name?: string;
}

export interface BrosConfig {
  version: 1;
  lastUsedProvider?: string;
  providers: Record<string, { settings: ProviderSettings; updatedAt: string }>;
  allowedCommands?: string[];
  telegram?: { botToken?: string; chatId?: number; username?: string };
  usage?: { input: number; output: number; costUsd: number; updatedAt: string };
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
  updateCheck?: { lastCheck: string; latest?: string };
}

export function emptyConfig(): BrosConfig {
  return { version: 1, providers: {} };
}

export function ensureBrosDir(): void {
  const dir = brosDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
}

export function readConfig(): BrosConfig {
  const p = configPath();
  if (!existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw?.version !== 1 || typeof raw.providers !== "object" || raw.providers === null) {
      return emptyConfig();
    }
    return raw as BrosConfig;
  } catch {
    return emptyConfig();
  }
}

/** Atomic write with 0600 perms. */
export function writeConfig(cfg: BrosConfig): void {
  ensureBrosDir();
  const p = configPath();
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, p);
}

export function recordUsage(input: number, output: number, costUsd: number | null): void {
  const cfg = readConfig();
  const u = cfg.usage ?? { input: 0, output: 0, costUsd: 0, updatedAt: "" };
  u.input += input;
  u.output += output;
  u.costUsd += costUsd ?? 0;
  u.updatedAt = new Date().toISOString();
  cfg.usage = u;
  writeConfig(cfg);
}

export function setLastUsedProvider(providerId: string): void {
  const cfg = readConfig();
  cfg.lastUsedProvider = providerId;
  writeConfig(cfg);
}

export function lifetimeUsage(): { input: number; output: number; costUsd: number } | null {
  return readConfig().usage ?? null;
}

export function saveProviderSettings(
  providerId: string,
  settings: ProviderSettings,
  opts: { setLastUsed?: boolean } = {},
): BrosConfig {
  const cfg = readConfig();
  cfg.providers[providerId] = {
    settings,
    updatedAt: new Date().toISOString(),
  };
  if (opts.setLastUsed !== false) cfg.lastUsedProvider = providerId;
  writeConfig(cfg);
  return cfg;
}
