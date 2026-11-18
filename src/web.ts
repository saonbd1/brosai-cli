import { createServer, type Server } from "node:http";
import { DASHBOARD_HTML } from "./dashboard.ts";

export interface WebApproval {
  id: number;
  cmd: string;
  resolve: (ok: boolean, all?: boolean) => void;
}

export interface McpServerInfo {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface WebState {
  mode: "act" | "plan";
  provider: { id: string; name: string; model: string };
  providers: { id: string; name: string; model?: string; active: boolean }[];
  mcp: McpServerInfo[];
  cwd?: string;
  sessionFile?: string | null;
}

export interface McpAddInput {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface WebControl {
  getState(): WebState;
  setMode(mode: "act" | "plan"): void;
  setProvider(id: string): Promise<{ ok: boolean; error?: string }>;
  addMcp(input: McpAddInput): Promise<{ ok: boolean; error?: string }>;
  removeMcp(name: string): Promise<{ ok: boolean; error?: string }>;
  getDiff?(): Promise<{ diff?: string; error?: string }>;
  undo?(): Promise<{ message?: string; error?: string }>;
  listSessions?(): { file: string; updatedAt: string; provider: string; model: string; cwd: string; turns: number }[];
  newSession?(): void;
  loadSession?(file: string): Promise<{ ok: boolean; error?: string; history?: { role: string; content: string; images?: number }[] }>;
  getHistory?(): { role: string; content: string; images?: number }[];
  addImage?(data: string, name: string): Promise<{ ok: boolean; count?: number; error?: string }>;
  listSkills?(): { name: string; scope: string; description: string; chars: number }[];
  saveSkill?(input: { name: string; content: string; scope?: string }): Promise<{ ok: boolean; error?: string }>;
  removeSkill?(name: string): Promise<{ ok: boolean; error?: string }>;
}

export type WebEmit = (type: string, data: unknown) => void;

export interface WebBridge {
  server: Server;
  approvals: WebApproval[];
  /** Called for each user message; returns the agent's reply text.
   *  When the request asks for streaming, `emit` sends live agent events. */
  onMessage: (text: string, emit?: WebEmit, signal?: AbortSignal) => Promise<{ reply: string; error?: string; usage?: { input: number; output: number; cost: number | null } }>;
  close: () => void;
}


export function startWebServer(opts: {
  port: number;
  approvals: WebApproval[];
  onMessage: WebBridge["onMessage"];
  control?: WebControl;
}): WebBridge {
  const approvals = opts.approvals;
  const ctl = opts.control;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      let body = "";
      for await (const c of req) body += c;
      return body ? JSON.parse(body) : {};
    };
    const WEB_TOKEN = process.env.BROS_WEB_TOKEN;
    if (WEB_TOKEN) {
      const cookieToken = decodeURIComponent((req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith("brosai_token="))?.slice(13) ?? "");
      const provided = req.headers["x-bros-token"] ?? url.searchParams.get("token") ?? cookieToken;
      if (provided !== WEB_TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // Token via query param on a page load: persist as cookie and strip it from the URL
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") && !cookieToken) {
        res.writeHead(302, {
          location: url.pathname,
          "set-cookie": `brosai_token=${encodeURIComponent(WEB_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
    }
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ping") return json(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/approvals") {
        return json(200, approvals.map((a) => ({ id: a.id, cmd: a.cmd })));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(200, ctl ? ctl.getState() : { mode: "act", provider: null, providers: [], mcp: [] });
      }
      if (req.method === "GET" && url.pathname === "/api/diff" && ctl?.getDiff) {
        return json(200, await ctl.getDiff());
      }
      if (req.method === "POST" && url.pathname === "/api/undo" && ctl?.undo) {
        return json(200, await ctl.undo());
      }
      if (req.method === "GET" && url.pathname === "/api/sessions" && ctl?.listSessions) {
        return json(200, { sessions: ctl.listSessions() });
      }
      if (req.method === "POST" && url.pathname === "/api/session" && ctl) {
        const { action, file } = await readBody();
        if (action === "new") { ctl.newSession?.(); return json(200, { ok: true }); }
        if (action === "load" && file) {
          if (!ctl.loadSession) return json(400, { error: "session loading unavailable" });
          return json(200, await ctl.loadSession(String(file)));
        }
        return json(400, { error: "action must be new or load" });
      }
      if (req.method === "GET" && url.pathname === "/api/history" && ctl?.getHistory) {
        return json(200, { history: ctl.getHistory() });
      }
      if (req.method === "GET" && url.pathname === "/api/skills" && ctl?.listSkills) {
        return json(200, { skills: ctl.listSkills() });
      }
      if (req.method === "POST" && url.pathname === "/api/skill" && ctl?.saveSkill) {
        const { name, content, scope } = await readBody();
        if (!name || !content) return json(400, { error: "name and content required" });
        return json(200, await ctl.saveSkill({ name: String(name), content: String(content), scope: scope ? String(scope) : undefined }));
      }
      if (req.method === "POST" && url.pathname === "/api/skill/rm" && ctl?.removeSkill) {
        const { name } = await readBody();
        if (!name) return json(400, { error: "name required" });
        return json(200, await ctl.removeSkill(String(name)));
      }
      if (req.method === "POST" && url.pathname === "/api/image" && ctl?.addImage) {
        const { data, name } = await readBody();
        if (!data) return json(400, { error: "data required" });
        return json(200, await ctl.addImage(String(data), String(name ?? "image")));
      }
      if (req.method === "POST" && url.pathname === "/api/mode" && ctl) {
        const { mode } = await readBody();
        if (mode !== "act" && mode !== "plan") return json(400, { error: "mode must be act or plan" });
        ctl.setMode(mode);
        return json(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/provider" && ctl) {
        const { id } = await readBody();
        if (!id) return json(400, { error: "id required" });
        return json(200, await ctl.setProvider(String(id)));
      }
      if (req.method === "POST" && url.pathname === "/api/mcp/add" && ctl) {
        const input = await readBody();
        if (!input?.name) return json(400, { error: "name required" });
        return json(200, await ctl.addMcp(input));
      }
      if (req.method === "POST" && url.pathname === "/api/mcp/remove" && ctl) {
        const { name } = await readBody();
        if (!name) return json(400, { error: "name required" });
        return json(200, await ctl.removeMcp(String(name)));
      }
      if (req.method === "POST" && url.pathname === "/api/approve") {
        const { id, ok, all } = await readBody();
        const a = approvals.find((x) => x.id === id);
        if (a) { approvals.splice(approvals.indexOf(a), 1); a.resolve(Boolean(ok), Boolean(all)); }
        return json(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/message") {
        const { text, stream } = await readBody();
        if (!text?.trim()) return json(400, { error: "empty message" });
        if (stream) {
          const ac = new AbortController();
          res.on("close", () => { if (!res.writableFinished) ac.abort(); });
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          const emit: WebEmit = (type, data) => {
            try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
          };
          emit("start", { ts: Date.now() });
          try {
            const r = await opts.onMessage(String(text).slice(0, 20_000), emit, ac.signal);
            emit(r.error ? "error" : "done", r.error ? { error: r.error } : { reply: r.reply, aborted: ac.signal.aborted, usage: r.usage });
          } catch (e) {
            emit("error", { error: e instanceof Error ? e.message : String(e) });
          }
          res.end();
          return;
        }
        try {
          const r = await opts.onMessage(String(text).slice(0, 20_000));
          return json(200, r);
        } catch (e) {
          return json(200, { reply: "", error: e instanceof Error ? e.message : String(e) });
        }
      }
      json(404, { error: "not found" });
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(opts.port, "127.0.0.1");
  return {
    server,
    approvals,
    onMessage: opts.onMessage,
    close: () => server.close(),
  };
}

/** Approver that queues requests for the web UI instead of prompting on a TTY. */
export function makeWebApprover(approvals: WebApproval[], state: { all: boolean }) {
  return (cmd: string) =>
    new Promise<{ ok: boolean; all?: boolean }>((resolve) => {
      if (state.all) return resolve({ ok: true, all: true });
      const id = approvals.length ? Math.max(...approvals.map((a) => a.id)) + 1 : 1;
      approvals.push({
        id,
        cmd,
        resolve: (ok, all) => {
          if (all) state.all = true;
          resolve({ ok, all });
        },
      });
    }).then((r) => r.ok);
}
