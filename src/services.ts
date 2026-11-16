import { readConfig, writeConfig } from "./config.ts";

const GH_CLIENT_ID = "178c6fc778ccc68e1d6a"; // GitHub CLI's public OAuth app client id
const GH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function ghRequest(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

/**
 * GitHub device-flow OAuth. Prints the verification link + code to the
 * terminal (visible to the user mid-agent-run), polls until authorized,
 * and stores the token in the github MCP server env (config, 0600).
 */
export async function connectGitHub(): Promise<string> {
  const dc = await ghRequest(GH_DEVICE_CODE_URL, { client_id: GH_CLIENT_ID, scope: "repo read:org gist workflow" });
  if (!dc.device_code) throw new Error(`device flow failed: ${JSON.stringify(dc).slice(0, 200)}`);

  console.log(`\nTo connect your GitHub account:\n`);
  console.log(`  1. Open: ${dc.verification_uri}`);
  console.log(`  2. Enter code: ${dc.user_code}\n`);
  console.log("Waiting for authorization (expires in 15 min, Ctrl+C to cancel)...");

  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
  const interval = Math.max(5, dc.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tok = await ghRequest(GH_ACCESS_TOKEN_URL, {
      client_id: GH_CLIENT_ID,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (tok.access_token) {
      const cfg = readConfig();
      const srv = cfg.mcpServers?.github ?? { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
      srv.env = { ...(srv.env ?? {}), GITHUB_PERSONAL_ACCESS_TOKEN: tok.access_token };
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), github: srv };
      writeConfig(cfg);
      return "GitHub connected! Token saved to config (0600). github MCP tools are active on the next brosai run.";
    }
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") { await new Promise((r) => setTimeout(r, 5000)); continue; }
    throw new Error(`authorization failed: ${tok.error_description ?? tok.error ?? "unknown"}`);
  }
  throw new Error("device code expired — try again");
}
