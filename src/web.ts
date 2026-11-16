import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface WebApproval {
  id: number;
  cmd: string;
  resolve: (ok: boolean, all?: boolean) => void;
}

export interface WebBridge {
  server: Server;
  approvals: WebApproval[];
  /** Called for each user message; returns the agent's reply text. */
  onMessage: (text: string) => Promise<{ reply: string; error?: string }>;
  close: () => void;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>BrosAi</title>
<style>
body{font-family:system-ui;max-width:820px;margin:2rem auto;padding:0 1rem;background:#0d1117;color:#e6edf3}
#log{white-space:pre-wrap;line-height:1.5}
.you{color:#58a6ff}.ai{color:#3fb950}.err{color:#f85149}.dim{color:#8b949e}
form{display:flex;gap:.5rem;margin-top:1rem}
input{flex:1;padding:.6rem;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3}
button{padding:.6rem 1rem;background:#238636;border:0;border-radius:6px;color:#fff;cursor:pointer}
.appr{background:#161b22;border:1px solid #d29922;border-radius:8px;padding:.7rem;margin:.5rem 0}
.appr button{margin-right:.5rem}
</style></head><body>
<h2>BrosAi <span class=dim id=st>connecting…</span></h2>
<div id=log></div>
<div id=appr></div>
<form id=f><input id=q placeholder="Ask BrosAi…" autocomplete="off"><button>Send</button></form>
<script>
const log=document.getElementById('log'),appr=document.getElementById('appr'),st=document.getElementById('st');
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function add(cls,txt){const d=document.createElement('div');d.className=cls;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight}
async function poll(){try{const a=await(await fetch('/api/approvals')).json();
 appr.innerHTML=a.map(x=>'<div class=appr>run command? <b>'+esc(x.cmd)+'</b><br><button onclick="dec('+x.id+',true)">Once</button><button onclick="dec('+x.id+',true,true)">All session</button><button onclick="dec('+x.id+',false)">Deny</button></div>').join('');
}catch(e){}}
window.dec=async(id,ok,all)=>{await fetch('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,ok,all})});poll()};
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const q=document.getElementById('q');const t=q.value.trim();if(!t)return;q.value='';add('you','you: '+t);add('dim','…thinking');
 try{const r=await(await fetch('/api/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})})).json();
  log.lastChild.remove();add(r.error?'err':'ai',(r.error?'error: ':'')+r.reply||'(empty)');}catch(err){log.lastChild.remove();add('err','request failed: '+err)}
 poll()};
fetch('/api/ping').then(()=>st.textContent='ready').catch(()=>st.textContent='offline');
setInterval(poll,1500);poll();
</script></body></html>`;

export function startWebServer(opts: {
  port: number;
  approvals: WebApproval[];
  onMessage: WebBridge["onMessage"];
}): WebBridge {
  const approvals = opts.approvals;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ping") return json(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/approvals") {
        return json(200, approvals.map((a) => ({ id: a.id, cmd: a.cmd })));
      }
      if (req.method === "POST" && url.pathname === "/api/approve") {
        let body = "";
        for await (const c of req) body += c;
        const { id, ok, all } = JSON.parse(body || "{}");
        const a = approvals.find((x) => x.id === id);
        if (a) { approvals.splice(approvals.indexOf(a), 1); a.resolve(Boolean(ok), Boolean(all)); }
        return json(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/message") {
        let body = "";
        for await (const c of req) body += c;
        const { text } = JSON.parse(body || "{}");
        if (!text?.trim()) return json(400, { error: "empty message" });
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
