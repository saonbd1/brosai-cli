import { readConfig, writeConfig } from "./config.ts";

export function allowedCommands(): string[] {
  return readConfig().allowedCommands ?? [];
}

export function addAllowedCommand(pattern: string): void {
  const cfg = readConfig();
  const list = cfg.allowedCommands ?? [];
  if (!list.includes(pattern)) {
    cfg.allowedCommands = [...list, pattern];
    writeConfig(cfg);
  }
}

export function removeAllowedCommand(pattern: string): void {
  const cfg = readConfig();
  cfg.allowedCommands = (cfg.allowedCommands ?? []).filter((p) => p !== pattern);
  writeConfig(cfg);
}

function patternToRegex(pattern: string): RegExp {
  // escape every regex metachar (including * and ?), then turn the escaped wildcards back into regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\*?]/g, "\\$&")
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Shell metacharacters that let one approved prefix smuggle in a second command. */
const SHELL_META = /[;&|`<>\n\r]|\$\(|\$\{/;

export function isAllowlisted(cmd: string): boolean {
  // An allowlist pattern like "npm test*" must never approve "npm test; rm -rf ~".
  if (SHELL_META.test(cmd)) return false;
  return allowedCommands().some((p) => patternToRegex(p).test(cmd.trim()));
}

const SAFE_BINARIES = new Set([
  "ls", "cat", "pwd", "echo", "head", "tail", "wc", "grep", "rg", "which", "whoami",
  "uname", "date", "file", "stat", "du", "df", "basename", "dirname",
  "realpath", "readlink", "uniq", "tr", "cut", "diff", "comm",
  "jq", "yq", "tree", "type", "true", "false", "test", "[",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog"]);

/** True when the command is a simple read-only invocation with no shell metacharacters. */
export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c) return false;
  // reject compound/expansive commands — first-token matching is meaningless otherwise
  if (/[;&|`$<>\\\n]/.test(c) || c.includes("$(")) return false;
  const tokens = c.split(/\s+/);
  const bin = tokens[0].replace(/^.*\//, "");
  if ((bin === "rg" || bin === "grep") && tokens.some((t) => t.startsWith("--pre"))) return false;
  // reading the agent's own config would leak provider API keys to the model
  if (/\.brosai|config\.json|\.env|\.ssh|\.aws|id_rsa/i.test(c)) return false;
  if (SAFE_BINARIES.has(bin)) return true;
  if (bin === "git") {
    const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
    // git global flags like -c key=val or --exec-path can execute arbitrary commands
    if (tokens.slice(1).some((t) => t === "-c" || t.startsWith("--exec") || t === "-C" || t.startsWith("--git-dir") || t.startsWith("--work-tree"))) return false;
    if (tokens.some((t) => t === "--output" || t.startsWith("--output="))) return false;
    return SAFE_GIT_SUBCOMMANDS.has(args[0] ?? "");
  }
  return false;
}
