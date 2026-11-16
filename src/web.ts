import { createServer, type Server } from "node:http";

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
}

export type WebEmit = (type: string, data: unknown) => void;

export interface WebBridge {
  server: Server;
  approvals: WebApproval[];
  /** Called for each user message; returns the agent's reply text.
   *  When the request asks for streaming, `emit` sends live agent events. */
  onMessage: (text: string, emit?: WebEmit) => Promise<{ reply: string; error?: string }>;
  close: () => void;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>BrosAi</title>
<style>
body{font-family:system-ui;max-width:860px;margin:1.5rem auto;padding:0 1rem;background:#0d1117;color:#e6edf3}
#log{white-space:pre-wrap;line-height:1.5;margin-top:.75rem}
.you{color:#58a6ff}.ai{color:#3fb950}.err{color:#f85149}.dim{color:#8b949e}
form{display:flex;gap:.5rem;margin-top:.75rem}
input,select,textarea{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:.5rem}
input[type=text],input:not([type]){flex:1}
button{padding:.5rem .9rem;background:#238636;border:0;border-radius:6px;color:#fff;cursor:pointer}
button.ghost{background:#21262d;border:1px solid #30363d}
button.danger{background:#da3633}
.appr{background:#161b22;border:1px solid #d29922;border-radius:8px;padding:.7rem;margin:.5rem 0}
.appr button{margin-right:.5rem}
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.toolbar select{max-width:280px}
.seg{display:inline-flex;border:1px solid #30363d;border-radius:6px;overflow:hidden}
.seg button{border-radius:0;background:#161b22;color:#8b949e;padding:.45rem .8rem}
.seg button.on{background:#238636;color:#fff}
#mcpPanel{display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.75rem;margin-top:.5rem}
#mcpPanel.open{display:block}
.mcp-row{display:flex;justify-content:space-between;align-items:center;padding:.3rem 0;border-bottom:1px solid #21262d}
.mcp-row .dim{font-size:.85em}
.mcp-form{display:grid;grid-template-columns:110px 1fr;gap:.4rem .6rem;margin-top:.6rem;align-items:center}
.mcp-form label{color:#8b949e;font-size:.85em}
.mcp-form input,.mcp-form select,.mcp-form textarea{grid-column:2}
.mcp-form textarea{min-height:44px;font-family:ui-monospace,monospace;font-size:.8em}
.hint{font-size:.78em}
</style></head><body>
<h2>BrosAi <span class=dim id=st>connecting…</span></h2>
<div class=toolbar>
  <select id=prov title="Provider"></select>
  <span class=seg id=modeSeg><button data-m="act">Act</button><button data-m="plan">Plan</button></span>
  <button class=ghost id=mcpBtn>MCP ▾</button>
</div>
<div id=mcpPanel>
  <div id=mcpList></div>
  <div class=mcp-form>
    <label>Name</label><input id=mName placeholder="my-server">
    <label>Type</label><select id=mType><option value=stdio>stdio (command)</option><option value=http>HTTP (url)</option></select>
    <label>Command</label><input id=mCmd placeholder="npx -y @modelcontextprotocol/server-filesystem /path">
    <label>URL</label><input id=mUrl placeholder="https://example.com/mcp" style="display:none">
    <label>Env / Headers</label><textarea id=mEnv placeholder='optional JSON, e.g. {"KEY":"value"}'></textarea>
    <div style="grid-column:2"><button id=mAdd>Add server</button> <span class=dim id=mMsg></span></div>
  </div>
  <div class=hint dim>stdio: command + args in one field (no quoting). http: url; headers sent as JSON object above.</div>
</div>
<div id=log></div>
<div id=appr></div>
<form id=f><input id=q placeholder="Ask BrosAi…" autocomplete="off"><button>Send</button></form>
<script>
const log=document.getElementById('log'),appr=document.getElementById('appr'),st=document.getElementById('st');
const prov=document.getElementById('prov'),modeSeg=document.getElementById('modeSeg'),mcpPanel=document.getElementById('mcpPanel');
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function add(cls,txt){const d=document.createElement('div');d.className=cls;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight}
async function j(u,o){const r=await fetch(u,o?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)}:undefined);return r.json()}
async function poll(){try{const a=await j('/api/approvals');
 appr.innerHTML=a.map(x=>'<div class=appr>run command? <b>'+esc(x.cmd)+'</b><br><button onclick="dec('+x.id+',true)">Once</button><button onclick="dec('+x.id+',true,true)">All session</button><button onclick="dec('+x.id+',false)">Deny</button></div>').join('');
}catch(e){}}
window.dec=async(id,ok,all)=>{await j('/api/approve',{id,ok,all});poll()};

let mcpNames=[];
async function refresh(){
 try{const s=await j('/api/state');
  prov.innerHTML=s.providers.map(p=>'<option value="'+esc(p.id)+'"'+(p.active?' selected':'')+'>'+esc(p.name)+(p.model?' · '+esc(p.model):'')+'</option>').join('');
  [...modeSeg.children].forEach(b=>b.classList.toggle('on',b.dataset.m===s.mode));
  mcpNames=s.mcp.map(m=>m.name);
  const ml=document.getElementById('mcpList');
  ml.innerHTML=s.mcp.length?s.mcp.map((m,i)=>'<div class=mcp-row><span><b>'+esc(m.name)+'</b> <span class=dim>'+(m.url?esc(m.url):esc((m.command||'')+' '+(m.args||[]).join(' ')))+'</span></span><button class=danger onclick="rmMcpIdx('+i+')">remove</button></div>').join(''):'<div class=dim>No MCP servers configured.</div>';
 }catch(e){}
}
window.rmMcpIdx=i=>rmMcp(mcpNames[i]);
window.rmMcp=async n=>{await j('/api/mcp/remove',{name:n});refresh()};

prov.onchange=async()=>{const r=await j('/api/provider',{id:prov.value});if(r.error){add('err','provider switch failed: '+r.error);refresh()}else{add('dim','provider → '+prov.selectedOptions[0].textContent);refresh()}};
[...modeSeg.children].forEach(b=>b.onclick=async()=>{await j('/api/mode',{mode:b.dataset.m});refresh()});
document.getElementById('mcpBtn').onclick=()=>mcpPanel.classList.toggle('open');
document.getElementById('mType').onchange=e=>{const http=e.target.value==='http';document.getElementById('mCmd').style.display=http?'none':'';document.getElementById('mUrl').style.display=http?'':'none'};
document.getElementById('mAdd').onclick=async()=>{
 const name=document.getElementById('mName').value.trim(),type=document.getElementById('mType').value;
 let body={name,transport:type};const raw=document.getElementById('mEnv').value.trim();
 if(raw){let kv;try{kv=JSON.parse(raw)}catch(e){document.getElementById('mMsg').textContent='bad JSON in env/headers';return}
  if(type==='http')body.headers=kv;else body.env=kv}
 if(type==='http'){body.url=document.getElementById('mUrl').value.trim();if(!body.url){document.getElementById('mMsg').textContent='url required';return}}
 else{const parts=document.getElementById('mCmd').value.trim().split(/\\s+/).filter(Boolean);if(!parts.length){document.getElementById('mMsg').textContent='command required';return}body.command=parts[0];body.args=parts.slice(1)}
 document.getElementById('mMsg').textContent='connecting…';
 const r=await j('/api/mcp/add',body);
 document.getElementById('mMsg').textContent=r.error||r.warning||'added';
 if(r.ok){document.getElementById('mName').value='';document.getElementById('mCmd').value='';document.getElementById('mUrl').value='';document.getElementById('mEnv').value=''}
 refresh()};

document.getElementById('f').onsubmit=async e=>{e.preventDefault();const q=document.getElementById('q');const t=q.value.trim();if(!t)return;q.value='';add('you','you: '+t);
 const ai=document.createElement('div');ai.className='ai';ai.textContent='';log.appendChild(ai);log.scrollTop=log.scrollHeight;
 const tool=d=>{const el=document.createElement('div');el.className='dim';el.textContent=d;log.insertBefore(el,ai);log.scrollTop=log.scrollHeight};
 try{
  const r=await fetch('/api/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t,stream:true})});
  if(!r.ok||!r.body){ai.remove();add('err','request failed: HTTP '+r.status);return}
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='',reply='';
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
   let i;while((i=buf.indexOf('\\n\\n'))>=0){const fr=buf.slice(0,i);buf=buf.slice(i+2);
    const ev=(fr.match(/^event: (.*)$/m)||[])[1],dt=(fr.match(/^data: (.*)$/m)||[])[1];if(!ev||dt===undefined)continue;
    let d={};try{d=JSON.parse(dt)}catch{continue}
    if(ev==='text'){reply+=d.delta||'';ai.textContent=reply;log.scrollTop=log.scrollHeight}
    else if(ev==='tool_start'){let a=d.args;try{a=JSON.stringify(d.args).slice(0,100)}catch{}tool('+ '+d.name+' '+a)}
    else if(ev==='tool_end'){tool('  |- '+(d.ok?'ok':'failed'))}
    else if(ev==='usage'){tool('  · '+d.input+'in/'+d.output+'out tok')}
    else if(ev==='error'){ai.className='err';ai.textContent='error: '+(d.error||'unknown')}
    else if(ev==='done'){if(d.reply&&!reply){ai.textContent=d.reply}else if(!reply){ai.textContent='(empty)'}ai.className='ai'}
   }}
 }catch(err){ai.remove();add('err','request failed: '+err)}
 poll()};
fetch('/api/ping').then(()=>st.textContent='ready').catch(()=>st.textContent='offline');
setInterval(poll,1500);poll();refresh();
</script></body></html>`;

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
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(200, ctl ? ctl.getState() : { mode: "act", provider: null, providers: [], mcp: [] });
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
            const r = await opts.onMessage(String(text).slice(0, 20_000), emit);
            emit(r.error ? "error" : "done", r.error ? { error: r.error } : { reply: r.reply });
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
