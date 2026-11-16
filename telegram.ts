/**
 * Telegram integration (zero dependencies, plain Bot API over fetch).
 *
 *  1. Agent tools   telegram_send / telegram_send_file  -> the agent can message you
 *  2. Bot mode      `brosai telegram`                   -> you can chat with the agent from Telegram
 *  3. Pairing       `brosai telegram setup`             -> binds ONE private chat to this machine
 *
 * Security model: only the paired private chat id is ever obeyed. Everything else is ignored.
 * Commands that need approval are confirmed with inline buttons in that chat.
 * Note: bot messages are NOT end-to-end encrypted; prompts and answers pass through Telegram's servers.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { readConfig, writeConfig } from "./config.ts";
import { safePath, type ToolDef, type ToolResult } from "./tools/index.ts";
import { runRuntimeTurn, type SessionState } from "./runtime.ts";
import { isAllowlisted, isReadOnlyCommand } from "./allow.ts";
import { undoCheckpoint, workspaceDiff } from "./checkpoint.ts";
import { formatCost } from "./pricing.ts";

/* ---------------- settings ---------------- */

export interface TelegramSettings {
  token: string;
  chatId?: number;
}

export function telegramSettings(): TelegramSettings | null {
  const cfg = readConfig().telegram ?? {};
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || cfg.botToken;
  if (!token) return null;
  const envChat = Number(process.env.TELEGRAM_CHAT_ID);
  const chatId = Number.isFinite(envChat) && envChat !== 0 ? envChat : cfg.chatId;
  return { token, chatId };
}

export function saveTelegramConfig(t: { botToken: string; chatId: number; username?: string }): void {
  const cfg = readConfig();
  cfg.telegram = { botToken: t.botToken, chatId: t.chatId, username: t.username };
  writeConfig(cfg);
}

export function clearTelegramConfig(): void {
  const cfg = readConfig();
  delete cfg.telegram;
  writeConfig(cfg);
}

/* ---------------- Bot API client ---------------- */

const apiBase = () => (process.env.BROSAI_TELEGRAM_API?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

function redact(e: unknown, token: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(token).join("***");
}

async function tg(
  token: string,
  method: string,
  body?: Record<string, unknown> | FormData,
  timeoutMs = 20_000,
  signal?: AbortSignal,
  retried = false,
): Promise<any> {
  const isForm = body instanceof FormData;
  const sig = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? (body as FormData) : JSON.stringify(body ?? {}),
      signal: sig,
    });
  } catch (e) {
    throw new Error(`Telegram ${method} failed: ${redact(e, token)}`);
  }
  const data: any = await res.json().catch(() => null);
  if (!data?.ok) {
    const wait = Number(data?.parameters?.retry_after);
    if (res.status === 429 && !retried && wait > 0 && wait <= 30) {
      await sleep(wait * 1000, signal);
      return tg(token, method, body, timeoutMs, signal, true);
    }
    throw new Error(`Telegram ${method}: ${data?.description ?? `HTTP ${res.status}`}`);
  }
  return data.result;
}

export async function verifyToken(token: string): Promise<{ id: number; username: string }> {
  const me = await tg(token, "getMe");
  return { id: me.id, username: me.username };
}

export function chunkText(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

/** Plain text on purpose (no parse_mode): model output often breaks Markdown/HTML entity parsing. */
export async function sendText(s: TelegramSettings, chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<any> {
  const parts = chunkText(text.trim() || "(empty)");
  let last: any;
  for (let i = 0; i < parts.length; i++) {
    last = await tg(s.token, "sendMessage", {
      chat_id: chatId,
      text: parts[i],
      disable_web_page_preview: true,
      ...(i === parts.length - 1 ? extra : {}),
    });
  }
  return last;
}

const MAX_FILE = 50 * 1024 * 1024;

export async function sendFile(s: TelegramSettings, chatId: number, absPath: string, caption?: string): Promise<void> {
  const st = statSync(absPath);
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > MAX_FILE) throw new Error("file is larger than Telegram's 50 MB bot upload limit");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption.slice(0, 1000));
  form.set("document", new Blob([readFileSync(absPath)]), basename(absPath));
  await tg(s.token, "sendDocument", form, 120_000);
}

/* ---------------- agent tools ---------------- */

export function telegramToolDefs(): ToolDef[] {
  const s = telegramSettings();
  if (!s?.chatId) return [];
  const chatId = s.chatId;
  return [
    {
      name: "telegram_send",
      description:
        "Send a text message to the user's paired Telegram chat. Use it to report that a long task finished, or to ping the user. Never include secrets.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Message text (long messages are split automatically)" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(args: any): Promise<ToolResult> {
        const text = String(args?.text ?? "").trim();
        if (!text) return { ok: false, output: "text is required" };
        try {
          await sendText(s, chatId, text);
          return { ok: true, output: "Message sent to Telegram" };
        } catch (e) {
          return { ok: false, output: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "telegram_send_file",
      description:
        "Send a file from the workspace to the user's paired Telegram chat (max 50 MB). The user is asked to approve each upload.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root" },
          caption: { type: "string", description: "Optional caption" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(args: any, ctx): Promise<ToolResult> {
        try {
          const abs = safePath(ctx, String(args?.path ?? ""));
          if (ctx.approve && !(await ctx.approve(`telegram: upload file ${args.path} to your Telegram chat`))) {
            return { ok: false, output: "Upload denied by user" };
          }
          await sendFile(s, chatId, abs, args.caption ? String(args.caption) : undefined);
          return { ok: true, output: `Sent ${args.path} to Telegram` };
        } catch (e) {
          return { ok: false, output: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}

/* ---------------- pairing ---------------- */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no look-alikes -> 40 bits for 8 chars

export function makePairCode(): string {
  const b = randomBytes(8);
  return [...b].map((x) => CODE_ALPHABET[x % 32]).join("");
}

async function skipBacklog(token: string): Promise<number> {
  const ups: any[] = await tg(token, "getUpdates", { offset: -1, timeout: 0 });
  return ups.length ? ups[ups.length - 1].update_id + 1 : 0;
}

/** Wait for `/start <code>` from a private chat. Only a sender who knows the one-time code can pair. */
export async function pairChat(
  token: string,
  onCode: (code: string) => void,
  timeoutMs = 5 * 60_000,
  signal?: AbortSignal,
): Promise<{ chatId: number; name: string }> {
  const code = makePairCode();
  let offset = await skipBacklog(token);
  onCode(code);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const ups: any[] = await tg(token, "getUpdates", { offset, timeout: 10, allowed_updates: ["message"] }, 25_000, signal);
    for (const u of ups) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || m.chat?.type !== "private" || typeof m.text !== "string") continue;
      const txt = m.text.trim().toUpperCase();
      if (txt === code || txt === `/START ${code}`) {
        await tg(token, "getUpdates", { offset, timeout: 0 }); // acknowledge
        const name = m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? String(m.chat.id));
        return { chatId: m.chat.id, name };
      }
    }
  }
  throw new Error("pairing timed out (no matching /start message received)");
}

/* ---------------- bot mode ---------------- */

export interface BotOptions {
  session: SessionState;
  yes: boolean;
  maxSteps: number;
  contextWindow: number;
  noCheckpoint: boolean;
  log: (msg: string) => void;
  signal: AbortSignal;
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE = 8 * 1024 * 1024;

async function downloadPhoto(s: TelegramSettings, fileId: string): Promise<string> {
  const f = await tg(s.token, "getFile", { file_id: fileId });
  if (f.file_size && f.file_size > MAX_IMAGE) throw new Error("photo larger than 8 MB");
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/file/bot${s.token}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`photo download failed: ${redact(e, s.token)}`);
  }
  if (!res.ok) throw new Error(`photo download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error("photo larger than 8 MB");
  const mime = IMAGE_MIME[extname(String(f.file_path)).toLowerCase()] ?? "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function toolLabel(name: string, args: string): string {
  let short = "";
  try {
    const p = JSON.parse(args);
    short = String(p.command ?? p.path ?? p.pattern ?? p.url ?? p.text ?? "");
  } catch {}
  short = short.replace(/\s+/g, " ").slice(0, 60);
  return short ? `${name}: ${short}` : name;
}

const HELP = [
  "BrosAi on Telegram. Send a task as a normal message (photos work too if your model has vision).",
  "",
  "/stop    cancel the running task",
  "/status  provider, mode, usage",
  "/mode act|plan",
  "/diff    changes since the last checkpoint",
  "/undo [n]  restore the workspace to before the last n turns",
  "/clear   start a fresh conversation",
  "/help",
].join("\n");

export async function runTelegramBot(o: BotOptions): Promise<void> {
  const s = telegramSettings();
  if (!s?.chatId) throw new Error("Telegram is not set up. Run: brosai telegram setup");
  const chatId = s.chatId;
  const { session, log, signal } = o;

  const me = await verifyToken(s.token);
  let offset = await skipBacklog(s.token); // never replay messages sent while the bot was offline
  log(`telegram: connected as @${me.username}, obeying chat ${chatId}`);
  await sendText(s, chatId, `BrosAi online\n${session.provider.def.name}/${session.provider.model} · mode=${session.mode}\n${session.cwd}\n\nSend a task, or /help.`);

  let running: AbortController | null = null;
  const pending = new Map<string, (v: "y" | "a" | "n") => void>();
  const denyAllPending = () => { for (const r of [...pending.values()]) r("n"); };
  signal.addEventListener("abort", () => { running?.abort(); denyAllPending(); }, { once: true });

  const reply = (text: string) => sendText(s, chatId, text).catch((e) => log(`telegram: send failed: ${e.message}`));

  const approve = async (cmd: string): Promise<boolean> => {
    const st = session.approveState;
    if (o.yes || st.all || st.approved.has(cmd) || isAllowlisted(cmd) || isReadOnlyCommand(cmd)) return true;
    const id = randomBytes(4).toString("hex");
    const shown = `Run command?\n\n${cmd.slice(0, 1500)}`;
    const msg = await sendText(s, chatId, shown, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Once", callback_data: `ap:${id}:y` },
          { text: "✅ All session", callback_data: `ap:${id}:a` },
          { text: "⛔ Deny", callback_data: `ap:${id}:n` },
        ]],
      },
    });
    const decision = await new Promise<"y" | "a" | "n">((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve("n"); }, 5 * 60_000);
      pending.set(id, (v) => { clearTimeout(t); pending.delete(id); resolve(v); });
    });
    const label = decision === "n" ? "⛔ denied" : decision === "a" ? "✅ approved for session" : "✅ approved";
    tg(s.token, "editMessageText", { chat_id: chatId, message_id: msg.message_id, text: `${shown}\n\n${label}` }).catch(() => {});
    if (decision === "a") st.all = true;
    if (decision === "y") st.approved.add(cmd);
    return decision !== "n";
  };

  async function runPrompt(prompt: string, images: string[]): Promise<void> {
    const ac = new AbortController();
    running = ac;
    const typing = setInterval(() => tg(s!.token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4000);
    tg(s!.token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    // one status message, edited (throttled) as tools run, deleted at the end
    let statusId: number | null = null;
    const labels: string[] = [];
    let lastEdit = 0;
    const onToolStart = (name: string, args: string) => {
      labels.push(toolLabel(name, args));
      const text = "Working…\n" + labels.slice(-6).map((l) => `• ${l}`).join("\n");
      const now = Date.now();
      if (statusId == null) {
        statusId = -1; // reserve
        sendText(s!, chatId, text).then((m) => { statusId = m.message_id; lastEdit = Date.now(); }).catch(() => { statusId = null; });
      } else if (statusId > 0 && now - lastEdit > 2500) {
        lastEdit = now;
        tg(s!.token, "editMessageText", { chat_id: chatId, message_id: statusId, text }).catch(() => {});
      }
    };

    const stepsBefore = session.steps;
    try {
      const out = await runRuntimeTurn(session, prompt, {
        maxSteps: o.maxSteps,
        contextWindow: o.contextWindow,
        noCheckpoint: o.noCheckpoint,
        images: images.length ? images : undefined,
        signal: ac.signal,
        approve,
        events: { onToolStart },
      });
      if (statusId && statusId > 0) tg(s!.token, "deleteMessage", { chat_id: chatId, message_id: statusId }).catch(() => {});
      if (ac.signal.aborted) await reply("Cancelled.");
      else await reply(`${out || "(no output)"}\n\n— ${session.steps - stepsBefore} steps · est ${formatCost(session.costUsd)}`);
    } catch (e) {
      if (statusId && statusId > 0) tg(s!.token, "deleteMessage", { chat_id: chatId, message_id: statusId }).catch(() => {});
      await reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearInterval(typing);
      running = null;
    }
  }

  async function handleCommand(text: string): Promise<void> {
    const [rawCmd, ...rest] = text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, "");
    const arg = rest.join(" ");
    const busy = () => reply("A task is running. Send /stop to cancel it first.");
    switch (cmd) {
      case "/start":
      case "/help":
        return void (await reply(HELP));
      case "/stop":
        if (!running) return void (await reply("Nothing is running."));
        running.abort();
        denyAllPending();
        return;
      case "/status":
        return void (await reply(
          `${session.provider.def.name}/${session.provider.model}\nmode=${session.mode} · ${running ? "busy" : "idle"}\ncwd=${session.cwd}\nsteps=${session.steps} · tokens=${session.usage.input}+${session.usage.output} · est ${formatCost(session.costUsd)}`,
        ));
      case "/mode":
        if (running) return void (await busy());
        if (arg !== "act" && arg !== "plan") return void (await reply(`mode is ${session.mode}. Usage: /mode act|plan`));
        session.mode = arg;
        return void (await reply(`mode = ${arg}`));
      case "/clear":
        if (running) return void (await busy());
        session.history = [];
        session.todos.length = 0;
        session.sessionFile = undefined;
        session.approveState = { all: false, approved: new Set() };
        return void (await reply("Started a fresh conversation."));
      case "/diff": {
        const d = await workspaceDiff(session.cwd);
        return void (await reply(d ?? "No checkpoints yet (or git is not installed)."));
      }
      case "/undo": {
        if (running) return void (await busy());
        const n = Math.max(1, Number(arg) || 1);
        const cp = await undoCheckpoint(session.cwd, n);
        return void (await reply(cp ? `Restored workspace to before: ${cp.label}` : "No checkpoints to undo."));
      }
      default:
        return void (await reply(`Unknown command ${cmd}. Try /help.`));
    }
  }

  async function handleUpdate(u: any): Promise<void> {
    const cb = u.callback_query;
    if (cb) {
      const ok = cb.from?.id === chatId && cb.message?.chat?.id === chatId;
      const m = /^ap:([0-9a-f]+):([yan])$/.exec(String(cb.data ?? ""));
      if (ok && m) {
        const resolver = pending.get(m[1]);
        resolver?.(m[2] as "y" | "a" | "n");
        tg(s!.token, "answerCallbackQuery", { callback_query_id: cb.id, text: resolver ? "Got it" : "Expired" }).catch(() => {});
      } else {
        tg(s!.token, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      }
      return;
    }
    const m = u.message;
    if (!m) return;
    if (m.chat?.type !== "private" || m.chat.id !== chatId || m.from?.id !== chatId) {
      log(`telegram: ignored message from unauthorized chat ${m.chat?.id}`);
      return;
    }
    const text: string = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
    if (typeof m.text === "string" && text.startsWith("/")) return handleCommand(text);
    const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null;
    if (!text && !photo) return void (await reply("I can handle text and photos. Send a task as text."));
    if (running) return void (await reply("A task is running. Send /stop to cancel it, or wait for it to finish."));
    let images: string[] = [];
    if (photo) {
      try { images = [await downloadPhoto(s!, photo.file_id)]; }
      catch (e) { return void (await reply(`Could not read the photo: ${e instanceof Error ? e.message : String(e)}`)); }
    }
    void runPrompt(text || "Describe this image.", images); // NOT awaited: polling must continue so approval buttons work
  }

  while (!signal.aborted) {
    let updates: any[];
    try {
      updates = await tg(s.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40_000, signal);
    } catch (e) {
      if (signal.aborted) break;
      const msg = e instanceof Error ? e.message : String(e);
      log(`telegram: poll error: ${msg}${/409|Conflict/.test(msg) ? " (is another brosai telegram instance running with this bot?)" : ""}`);
      await sleep(3000, signal);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try { await handleUpdate(u); } catch (e) { log(`telegram: handler error: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  await sendText(s, chatId, "BrosAi offline.").catch(() => {});
}
