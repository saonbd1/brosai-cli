import { existsSync, statSync, readdirSync, readFileSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { brosDir, configPath, readConfig, lifetimeUsage, type BrosConfig } from "./config.ts";
import { getProvider, resolveApiKey, resolveProvider, type ResolvedProvider } from "./secrets.ts";
import { VERSION, pendingUpdate } from "./update.ts";

const PLAIN = !process.stdout.isTTY || Boolean(process.env.NO_COLOR);
const C = PLAIN
  ? { dim: (s: string) => s, bold: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s }
  : {
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    };

interface Check {
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
  hint?: string;
}

const checks: Check[] = [];
const ok = (label: string, detail?: string) => checks.push({ status: "ok", label, detail });
const warn = (label: string, detail?: string, hint?: string) => checks.push({ status: "warn", label, detail, hint });
const fail = (label: string, detail?: string, hint?: string) => checks.push({ status: "fail", label, detail, hint });

function modeStr(p: string): string {
  try { return (statSync(p).mode & 0o777).toString(8); } catch { return "?"; }
}

function ping(url: string, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; status?: number; error?: string }> {
  return new Promise((res) => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, redirect: "follow" })
      .then((r) => { clearTimeout(timer); res({ ok: true, ms: Date.now() - t0, status: r.status }); })
      .catch((e) => { clearTimeout(timer); res({ ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }); });
  });
}

function checkRuntime() {
  const bun = typeof process.versions.bun !== "undefined";
  ok("runtime", `${bun ? "bun" : "node"} ${process.version} · ${process.platform}/${process.arch}`);
  ok("version", `brosai ${VERSION}`);
}

async function checkDirs() {
  const dir = brosDir();
  if (!existsSync(dir)) { fail("config dir", `${dir} missing`, "run 'brosai setup'"); return; }
  const mode = modeStr(dir);
  const badPerms = process.platform !== "win32" && mode !== "700";
  (badPerms ? warn : ok)("config dir", `${dir} (perms ${mode})`, badPerms ? "should be 700 — run: chmod 700 ~/.brosai" : undefined);

  const cp = configPath();
  if (!existsSync(cp)) { warn("config file", "not found — first run will offer setup"); return; }
  let cfg: BrosConfig;
  try {
    cfg = JSON.parse(readFileSync(cp, "utf8"));
    ok("config file", `valid JSON (perms ${modeStr(cp)})`);
  } catch (e) {
    fail("config file", `invalid JSON: ${e instanceof Error ? e.message : e}`, `fix or delete ${cp}`);
    return;
  }
  await checkProviders(cfg);
  checkStorage(cfg);
  void pendingUpdate().then((u) => {
    if (u) warn("update", `v${u} available — run 'brosai update'`);
    else ok("update", "up to date");
  });
}

async function checkProviders(cfg: BrosConfig) {
  const provs = Object.keys(cfg.providers ?? {});
  if (!provs.length) {
    warn("providers", "none configured", "run 'brosai setup' or set BROSAI_API_KEY");
  } else {
    for (const id of provs) {
      const stored = cfg.providers[id]?.settings;
      const def = getProvider(id);
      const { apiKey, source } = resolveApiKey(id, stored);
      const model = stored?.model ?? def?.models[0];
      const line = `${id}: model=${model ?? "?"} key=${source ?? "none"}${stored?.baseUrl ? ` url=${stored.baseUrl}` : def?.baseUrl ? ` url=${def.baseUrl}` : ""}`;
      if (apiKey || def?.noKey) ok(`provider ${id}`, line);
      else warn(`provider ${id}`, `${line} — no API key`, `run 'brosai setup' or 'brosai auth ${id}'`);
    }
  }

  const last = cfg.lastUsedProvider ?? process.env.BROSAI_PROVIDER?.trim() ?? "openrouter";
  try {
    const r = resolveProvider({});
    await checkConnectivity(r);
  } catch (e) {
    fail("provider resolution", `${last}: ${e instanceof Error ? e.message : e}`, `pick another: brosai -p <provider>`);
  }
}

async function checkConnectivity(r: ResolvedProvider) {
  const base = r.baseUrl.replace(/\/+$/, "");
  // /models exists on most OpenAI-compatible servers; for Anthropic the root still proves reachability
  const probe = r.def.api === "anthropic" ? base : `${base}/models`;
  const res = await ping(probe);
  if (res.ok) {
    const authNote = res.status === 401 || res.status === 403 ? " (auth required — expected for /models)" : "";
    const grade = res.ms < 800 ? ok : res.ms < 3000 ? warn : fail;
    grade("provider connectivity", `${r.def.id}/${r.model} → HTTP ${res.status} in ${res.ms}ms${authNote}`,
      res.ms >= 3000 ? "reachable but slow — prefill on CPU models can take minutes" : undefined);
  } else {
    fail("provider connectivity", `${probe} → ${res.error}`, "check network/VPN/tunnel; for Colibri verify the VM service is up");
  }
}

function checkStorage(cfg: BrosConfig) {
  const dir = brosDir();
  const sessDir = join(dir, "sessions");
  if (existsSync(sessDir)) {
    try { ok("sessions", `${readdirSync(sessDir).filter((f) => f.endsWith(".json")).length} saved`); } catch { warn("sessions", "unreadable"); }
  }
  const cpDir = join(dir, "checkpoints");
  if (existsSync(cpDir)) {
    try { ok("checkpoints", `${readdirSync(cpDir).length} workspace(s) tracked`); } catch { warn("checkpoints", "unreadable"); }
  }
  const u = lifetimeUsage();
  if (u) ok("usage totals", `${u.input + u.output} tokens · $${u.costUsd.toFixed(4)}`);

  const mcp = cfg.mcpServers ?? {};
  const names = Object.keys(mcp);
  if (!names.length) warn("mcp servers", "none configured");
  else {
    const transports = names.map((n) => `${n}(${mcp[n].url ? "http" : "stdio"})`).join(", ");
    ok("mcp servers", `${names.length} configured: ${transports}`);
  }

  try {
    ok("git", execSync("git --version", { encoding: "utf8" }).trim());
  } catch { warn("git", "not found — checkpoints/undo unavailable", "install git"); }

  const cwd = resolve(process.cwd());
  try {
    accessSync(cwd, constants.W_OK);
    ok("workspace", `${cwd} writable`);
  } catch { warn("workspace", `${cwd} may not be writable`); }
}

export async function runDoctor(deep: boolean) {
  checks.length = 0;
  console.log(C.bold("\nbrosai doctor\n"));
  checkRuntime();
  await checkDirs();

  if (deep) {
    console.log(C.dim("\n-- deep checks (may take a while) --"));
    try {
      const r = resolveProvider({});
      const { chatOnce } = await import("./providers/index.ts");
      const t0 = Date.now();
      const turn = await chatOnce(r, { messages: [{ role: "user", content: "Reply with exactly: OK" }], tools: [], maxTokens: 8, signal: AbortSignal.timeout(120000) });
      ok("provider completion", `${r.def.id}/${r.model} replied in ${Date.now() - t0}ms: "${turn.content.slice(0, 40)}"`);
    } catch (e) {
      fail("provider completion", e instanceof Error ? e.message : String(e), "provider may be slow or unreachable");
    }
    try {
      const { connectMcpServers } = await import("./mcp.ts");
      const warns: string[] = [];
      const mcp = await connectMcpServers((m) => warns.push(m));
      if (mcp.servers.length) ok("mcp connect", `${mcp.servers.join(", ")} — ${mcp.toolDefs.length} tools`);
      else warn("mcp connect", "no servers connected");
      for (const w of warns) warn("mcp", w);
      mcp.close();
    } catch (e) {
      fail("mcp connect", e instanceof Error ? e.message : String(e));
    }
  }

  // let the async update check land
  await new Promise((r) => setTimeout(r, 2500));

  let fails = 0, warns = 0;
  for (const c of checks) {
    const icon = c.status === "ok" ? C.green("✓") : c.status === "warn" ? C.yellow("!") : C.red("✗");
    console.log(` ${icon} ${c.label}${c.detail ? C.dim(` — ${c.detail}`) : ""}`);
    if (c.hint) console.log(C.dim(`     → ${c.hint}`));
    if (c.status === "fail") fails++;
    if (c.status === "warn") warns++;
  }
  console.log(`\n ${fails} failed, ${warns} warnings, ${checks.length - fails - warns} ok`);
  if (fails) process.exitCode = 1;
}
