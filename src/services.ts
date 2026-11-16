import { readConfig, writeConfig } from "./config.ts";

const GH_CLIENT_ID = "178c6fc778ccc68e1d6a";
const GH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

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

export async function startGitHubDeviceFlow(): Promise<DeviceFlowStart> {
  const dc = await ghRequest(GH_DEVICE_CODE_URL, {
    client_id: GH_CLIENT_ID,
    scope: "repo read:org gist workflow",
  });
  if (!dc.device_code) throw new Error(`device flow failed: ${JSON.stringify(dc).slice(0, 200)}`);
  return {
    deviceCode: dc.device_code,
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    expiresIn: dc.expires_in ?? 900,
    interval: Math.max(5, dc.interval ?? 5),
  };
}

export async function pollGitHubDeviceFlow(flow: DeviceFlowStart, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + flow.expiresIn * 1000;
  let intervalMs = flow.interval * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("GitHub login cancelled");
    await new Promise((r) => setTimeout(r, intervalMs));
    const tok = await ghRequest(GH_ACCESS_TOKEN_URL, {
      client_id: GH_CLIENT_ID,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (tok.access_token) {
      const cfg = readConfig();
      const srv = cfg.mcpServers?.github ?? { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
      srv.env = { ...(srv.env ?? {}), GITHUB_PERSONAL_ACCESS_TOKEN: tok.access_token };
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), github: srv };
      writeConfig(cfg);
      return "GitHub connected! Token saved to config (0600).";
    }
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") { intervalMs += 5000; continue; }
    throw new Error(`authorization failed: ${tok.error_description ?? tok.error ?? "unknown"}`);
  }
  throw new Error("device code expired — try again");
}

export async function connectGitHub(): Promise<string> {
  const flow = await startGitHubDeviceFlow();
  console.log(`\nTo connect your GitHub account:\n`);
  console.log(`  1. Open: ${flow.verificationUri}`);
  console.log(`  2. Enter code: ${flow.userCode}\n`);
  console.log("Waiting for authorization (expires in 15 min, Ctrl+C to cancel)...");
  const msg = await pollGitHubDeviceFlow(flow);
  return `${msg} github MCP tools are active on the next brosai run.`;
}