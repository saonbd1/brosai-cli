import { readConfig, writeConfig } from "./config.ts";

export const VERSION = "0.6.2";
const REPO = "saonbd1/brosai-cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface LatestRelease { tag_name?: string }

async function fetchLatestTag(): Promise<string | null> {
  // /releases/latest 302-redirects to the tag — no API rate limit.
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
      headers: { "user-agent": "brosai" },
      signal: AbortSignal.timeout(8_000),
    });
    const loc = res.headers.get("location") ?? "";
    const m = /\/releases\/tag\/(v?[\d.]+[\w.-]*)/.exec(loc);
    if (m) return m[1].replace(/^v/, "");
  } catch {}
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "brosai", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as LatestRelease;
    return d.tag_name?.replace(/^v/, "") ?? null;
  } catch { return null; }
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/**
 * Check for a newer release at most once per 24h (cached in config).
 * Returns the newer version string, or null. Never throws.
 */
export async function pendingUpdate(): Promise<string | null> {
  const cfg = readConfig();
  const now = Date.now();
  if (cfg.updateCheck?.lastCheck && now - Date.parse(cfg.updateCheck.lastCheck) < CHECK_INTERVAL_MS) {
    return cfg.updateCheck.latest && cmpVer(cfg.updateCheck.latest, VERSION) > 0 ? cfg.updateCheck.latest : null;
  }
  const latest = await fetchLatestTag();
  if (latest == null) {
    // Don't cache failures for 24h — retry on next launch instead.
    cfg.updateCheck = { lastCheck: new Date(now - CHECK_INTERVAL_MS + 60_000).toISOString(), latest: cfg.updateCheck?.latest };
  } else {
    cfg.updateCheck = { lastCheck: new Date(now).toISOString(), latest };
  }
  writeConfig(cfg);
  return latest && cmpVer(latest, VERSION) > 0 ? latest : null;
}

/** Download and install the latest release binary over the running executable. */
export async function selfUpdate(): Promise<string> {
  const tag = await fetchLatestTag();
  if (!tag) throw new Error("could not fetch latest release");
  if (cmpVer(tag, VERSION) <= 0) return `already up to date (v${VERSION})`;
  const asset = process.platform === "win32" ? "brosai.exe" : "brosai-linux";
  const url = `https://github.com/${REPO}/releases/download/v${tag}/${asset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync, chmodSync, renameSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const target = resolve(process.argv[1] ?? "brosai");
  if (process.platform === "win32") {
    // Can't overwrite a running exe; write sibling and tell user to swap.
    const tmp = target + ".new";
    writeFileSync(tmp, buf);
    return `downloaded v${tag} to ${tmp} — close brosai and rename it to brosai.exe`;
  }
  const tmp = target + ".new";
  writeFileSync(tmp, buf, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  try { renameSync(tmp, target); }
  catch {
    writeFileSync(target, buf, { mode: 0o755 });
  }
  return `updated to v${tag}`;
}
