# BrosAi Web Dashboard — Design Brief

> A complete design instruction for building a high-quality web dashboard for **BrosAi**,
> a personal CLI coding agent. This document inventories every feature the agent has,
> the data the backend can expose, and the UI/UX requirements for a polished dashboard.
> It is written to be handed directly to a designer or AI frontend tool (v0, Figma AI, etc.).

---

## 1. Product context

**BrosAi** is a personal, privacy-first coding agent that runs on the user's own machine
(or their own self-hosted model server). It is distributed as a single binary — no
runtime dependencies — and is configured entirely through local files under `~/.brosai`.

The **web dashboard** (`brosai web`, currently `http://localhost:8420`) is the browser
companion to the terminal REPL. It exposes the same agent — same tools, same MCP servers,
same provider, same session history — through a chat UI with graphical controls.

### Design constraints (hard requirements)

- **Localhost-only.** The server binds to `127.0.0.1`. This is a personal tool, not a
  multi-tenant SaaS. Security model = the user's own machine.
- **Zero build tooling preferred.** Today the UI is a single embedded HTML page with
  vanilla JS. A redesign may use any stack *if* it can still be embedded/served by the
  same zero-dependency Node/Bun binary — i.e. compiled assets inlined or served as static
  files, no external CDN dependencies at runtime.
- **Dark theme.** The audience is developers; the current UI is GitHub-dark inspired.
- **Real-time feel.** Chat responses stream token-by-token; tool calls appear live;
  approvals must be actionable within ~1s of appearing.
- **Keyboard-first.** Users live in terminals — `/` commands, `Esc` to stop, `↑/↓` history,
  `Ctrl+K` command palette are expected.
- **No secrets in the UI.** API keys are stored server-side only; the UI may show
  "key configured ✓" but never the key itself.

---

## 2. Users

- **Primary:** the developer who owns the machine — technical, wants density and speed,
  allergic to bloat.
- **Secondary:** the same user on their phone/another machine later (responsive matters,
  but desktop-first).

---

## 3. Complete feature inventory

Everything below exists in the agent today and should be represented (or intentionally
de-emphasized) in the dashboard.

### 3.1 Chat & agent loop

- Streaming chat with markdown rendering (code blocks with syntax highlighting, tables,
  lists).
- **Act mode** (default): full tool access — read/write/edit files, run shell commands,
  fetch web pages, spawn sub-agents.
- **Plan mode**: read-only tools only (`read_file`, `glob`, `grep`, `list_dir`,
  `web_fetch`, `todo_write`); the agent investigates and outputs a step-by-step plan
  without changing anything. Must be visually distinct (badge/color).
- Multi-turn sessions with persistent history (saved to disk, resumable).
- Image attachments (png/jpg/gif/webp/bmp, ≤8 MB) — vision-capable providers.
- Context auto-compaction when history grows (should be surfaced subtly, e.g.
  "context compacted 24 → 8 messages").
- Token/cost accounting per session and lifetime.

### 3.2 Tools the agent can invoke (displayed live during a turn)

Built-in tools — each should render as a distinct activity card:

| Tool | What it does | Card should show |
|---|---|---|
| `read_file` | Read file contents (with line ranges) | file path, line count, maybe preview |
| `write_file` | Create/overwrite a file | path, bytes written, diff if existing |
| `edit_file` | Targeted string replacement | path, old→new snippet |
| `apply_patch` | Multi-hunk patch | unified diff view |
| `run_command` | Shell command execution | command, exit code, duration, capped output |
| `glob` | File pattern search | pattern, match count, file list |
| `list_dir` | Directory listing | path, entries |
| `grep` | Content search (ripgrep-backed) | pattern, match count, file:line hits |
| `move_file` | Rename/move | from → to |
| `web_fetch` | Fetch a URL | URL, status, content size |
| `todo_write` | Task list management | todo list widget (see §5.4) |
| `connect_service` | OAuth device flow (GitHub) | verification link + code display |
| `spawn_agent` | Delegate to a sub-agent | prompt, mode (read-only/act), nested result |

Plus **MCP tools** — dynamically discovered from connected MCP servers, named
`mcp__<server>__<tool>`. There may be dozens (e.g. GitHub MCP = 26 tools). They should
be grouped/collapsible under their server name.

### 3.3 Approvals (critical UX)

- When the agent wants to run a shell command (or mutating MCP tool), execution **pauses**
  until the user approves.
- Approval card shows: the exact command, and three actions:
  - **Once** — approve this command only
  - **All session** — auto-approve everything for the rest of the session (dangerous;
    should be visually distinct/warned)
  - **Deny** — refuse; agent receives denial and continues
- Read-only commands and allowlisted commands auto-pass (no card).
- Plan mode never triggers approvals (read-only).
- Multiple pending approvals can queue — show them as a stack, newest on top.

### 3.4 Providers & models

- **9 built-in providers** + unlimited custom OpenAI-compatible endpoints:
  Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, DeepSeek, Cerebras, Groq,
  Ollama/local, Custom.
- Each provider: display name (user-overridable, e.g. "Colibri"), model, base URL,
  API key status (configured via config file or env var — never shown).
- **Provider picker** in the dashboard: dropdown showing `name · model` for each;
  switching is instant and persists as default.
- Model override per provider (`/model` in CLI); custom providers can discover models
  live from `/models`.
- Provider status indicators: active provider highlighted; unconfigured providers
  (no key) should be visibly disabled or marked.

### 3.5 MCP (Model Context Protocol) servers

- Two transports: **stdio** (local command + args + env) and **HTTP** (URL + headers).
- Add/remove servers from the dashboard; changes **reconnect live** (no restart).
- Each server shows: name, connection command/URL, tool count when connected,
  connection status (connected / failed / connecting).
- Failed servers should show stderr tail for debugging.

### 3.6 Sessions & history

- Conversations persist server-side; multiple sessions per working directory.
- Session list: provider/model used, cwd, turn count, last-updated time.
- Resume/switch sessions from the dashboard.
- `/clear` equivalent — start fresh history.
- Checkpoints: before each act-mode turn the workspace state is snapshotted;
  **undo** rolls back file changes. Dashboard should expose checkpoint list + undo.

### 3.7 Workspace awareness

- The agent operates in a **cwd** (working directory). Dashboard should display it.
- **Diff view**: workspace changes vs. checkpoint — file-level diff summary.
- Todos: the agent maintains a task list (`todo_write`) — render as a live widget.

### 3.8 Cost & usage

- Per-turn and per-session: input tokens, output tokens, step count, estimated USD cost.
- Lifetime totals across all sessions.
- Provider pricing table exists (`src/pricing.ts`) — cost is `null` for unknown models.

### 3.9 Other surfaces (context, may inspire dashboard features)

- **Telegram bot**: same agent via chat app, approvals as inline buttons.
- **CLI REPL commands** the dashboard should match or exceed:
  `/status /provider(s) /model /mode /allow /sessions /cost /diff /undo
   /checkpoints /clear /image /help /exit`
- `/allow` — manage command allowlist (auto-approve patterns).
- Sub-agent spawning (nested agent runs with own context).
- Self-update notifications (`brosai update`).

---

## 4. Information architecture — proposed layout

```
┌──────────────────────────────────────────────────────────────────┐
│ TOP BAR:  [logo] BrosAi   [provider picker] [Act|Plan] [⚙ MCP]   │
│           status dot · cwd · session name · cost/token counter   │
├────────────┬─────────────────────────────────────┬───────────────┤
│  LEFT      │  CENTER: CHAT                        │  RIGHT        │
│  SIDEBAR   │  ┌───────────────────────────────┐  │  ACTIVITY     │
│            │  │ messages (streaming markdown) │  │  PANEL        │
│  ▸ Sessions│  │ tool-call cards               │  │               │
│    list    │  │ approval cards (inline)       │  │  ▸ Live turn  │
│  ▸ New chat│  │ todo widget                   │  │    activity   │
│            │  └───────────────────────────────┘  │  ▸ Todos      │
│  ▸ Workspace│  [ attachment 📎 ] [ input… ] [⏹] │  ▸ Diff/checkpts│
│    diff    │                                     │  ▸ Usage/cost │
│  ▸ Settings│                                     │               │
└────────────┴─────────────────────────────────────┴───────────────┘
```

Three-column on desktop; collapses to chat + slide-over panels on narrow screens.

---

## 5. Component specifications

### 5.1 Top bar

- **Provider picker**: searchable dropdown; each row = provider display name, model id,
  status dot (● configured / ○ no key / ◐ active). Active provider pinned on top.
- **Mode toggle**: `Act | Plan` segmented control. Plan mode = accent color shift
  (e.g. amber) + banner "Plan mode — read-only".
- **MCP button**: badge with connected-server count; opens MCP panel.
- **Status area**: connection dot, cwd path (click to copy), session cost/tokens
  (`~12.4k tok · $0.03 · 8 steps`).

### 5.2 Chat area (center)

- **Message bubbles**: user messages right-aligned/compact; assistant messages full-width
  with markdown rendering. Streaming cursor while generating.
- **Tool call cards**: inline within the assistant turn, chronological. Collapsed by
  default to one line (`⚙ run_command · npm test · 1.2s ✓`), expandable to show
  args + output. Color-coded: blue=read, green=write/edit, orange=command, purple=MCP,
  gray=sub-agent.
- **Sub-agent cards**: nested/indented, show delegated prompt + final report.
- **Approval cards**: as §3.3 — must be impossible to miss; sticky until resolved.
- **Todo widget**: when `todo_write` is active, show checklist pinned above input or
  in right panel with live status icons (pending/in-progress/done).
- **Image attachments**: thumbnails in user messages; attach button + drag-drop + paste.
- **Empty state**: mascot/logo, suggested prompts, quick provider/status summary.

### 5.3 Left sidebar

- **Sessions**: list with title/preview, provider·model, relative time, turn count.
  Active session highlighted; click to resume; "new chat" button.
- **Workspace**: cwd display, checkpoint count, "view diff" entry, undo button.
- **Settings** (or top-bar menu): provider management (add custom endpoint wizard:
  base URL → display name → API key → model), API key status per provider, allowlist
  editor, theme toggle.

### 5.4 Right activity panel (collapsible)

- **Live turn feed**: chronological stream of tool calls with status spinner → result.
- **Todos**: current task list.
- **Diff**: changed files with +/- counts; click → file diff view.
- **Checkpoints**: list with timestamps; undo buttons.
- **Usage**: session + lifetime tokens/cost chart (simple bars).

### 5.5 MCP panel

- Server list rows: name, transport icon (⌨ stdio / 🌐 http), command or URL,
  tool count, status dot, remove button.
- Add form: name, transport toggle, command+args OR url, env/headers JSON, "connect"
  button with spinner → success/error (show stderr on failure).

---

## 6. API surface (current + proposed)

### Existing endpoints (`src/web.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Dashboard HTML |
| GET | `/api/ping` | Health check |
| GET | `/api/state` | `{mode, provider, providers[], mcp[]}` |
| POST | `/api/message` | `{text}` → `{reply, error?}` (blocking; streams internally) |
| GET | `/api/approvals` | Pending approvals `[{id, cmd}]` |
| POST | `/api/approve` | `{id, ok, all}` resolve approval |
| POST | `/api/mode` | `{mode: act\|plan}` |
| POST | `/api/provider` | `{id}` switch provider |
| POST | `/api/mcp/add` | `{name, transport, command/args/env \| url/headers}` |
| POST | `/api/mcp/remove` | `{name}` |

### Proposed endpoints the design should assume (backend work needed)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sessions` | List saved sessions |
| POST | `/api/session/new` `/api/session/load` | Session management |
| GET | `/api/usage` | Session + lifetime token/cost stats |
| GET | `/api/diff` | Workspace diff vs. last checkpoint |
| POST | `/api/undo` | Rollback to checkpoint |
| GET | `/api/checkpoints` | Checkpoint list |
| GET | `/api/todos` | Current todo list |
| POST | `/api/image` | Attach image (base64) to next message |
| GET | `/api/events` (SSE) or WS | **Streaming**: token deltas, tool_start/tool_end, usage — replaces blocking `/api/message` + polling |

> The single biggest UX upgrade available: **replace request/response + 1.5s polling
> with Server-Sent Events** so tokens, tool calls, and approvals stream live.

---

## 7. Interaction & state requirements

- **Streaming response**: text appears token-by-token; tool cards populate as the
  agent works; a stop (⏹) button aborts the turn (AbortSignal already supported).
- **Approval latency**: card appears ≤500ms after the tool request; buttons respond
  instantly; page must not lose scroll position.
- **Optimistic UI**: user message renders immediately; errors render inline in the
  assistant slot, not as toasts.
- **Reconnect**: if the server restarts, UI shows "reconnecting…" and resumes polling.
- **States to design**: empty (no messages), loading (server starting/MCP connecting),
  streaming, tool-running, approval-pending, error (provider down, MCP failed,
  context overflow), offline.
- **Keyboard**: `Enter` send / `Shift+Enter` newline, `Esc` stop generation,
  `Ctrl+K` command palette (`/mode`, `/provider`, `/clear`, `/undo`, `/sessions`…),
  `↑` recall last message, `Tab` autocomplete provider/model names.
- **Responsive**: ≥1200px three-column; 800–1200 two-column (activity panel overlays);
  <800px single column with bottom-sheet panels.

---

## 8. Visual design direction

- **Theme**: dark-first. Base `#0d1117`, panels `#161b22`, borders `#30363d`,
  text `#e6edf3`, muted `#8b949e` (GitHub-dark palette works well for dev tools).
- **Accents**: green `#3fb950` (success/act), blue `#58a6ff` (user/info),
  amber `#d29922` (warnings/approvals/plan mode), red `#f85149` (errors/danger),
  purple `#bc8cff` (MCP/sub-agents).
- **Typography**: system UI stack for UI; **monospace** (ui-monospace/SF Mono/Cascadia)
  for code, commands, diffs, paths. ~13–14px base, compact density.
- **Iconography**: minimal line icons (tool glyphs per §5.2), consistent 16px grid.
- **Motion**: subtle — 120–160ms ease-out fades/slides; streaming cursor pulse;
  no gratuitous animation. Respect `prefers-reduced-motion`.
- **Code/diff rendering**: syntax-highlighted code blocks with copy button; diffs with
  red/green gutters; file paths in muted mono with folder icons.

---

## 9. Security & privacy notes for the designer

- The page is served only on localhost — but treat all rendered content as
  **untrusted**: tool outputs, file contents, command results, and model text must be
  HTML-escaped (XSS via repo files is a real vector).
- Never render API keys; show only "configured" status.
- Command strings in approval cards must be shown verbatim (no truncation of the
  dangerous part) — wrap long commands, don't ellipsis the middle.
- URLs fetched by `web_fetch`/MCP may contain sensitive internal hosts — fine to show,
  they're the user's own.

---

## 10. Nice-to-haves (post-MVP)

- Command palette (`Ctrl+K`) with fuzzy search over sessions, providers, slash-commands.
- Markdown export of a session transcript.
- Sound/haptic notification when approval is needed while tab is unfocused
  (`document.title` flash / favicon badge).
- PWA-ish: works acceptably on mobile for "approve/deny on the go".
- Theme variants (light, high-contrast).
- Split view: chat left, diff right, live during act mode.
- Voice input (Web Speech API) — gimmick but fun.

---

## 11. Suggested build order

1. **Shell**: three-column layout, top bar with provider/mode/MCP controls (exists — restyle).
2. **Chat core**: SSE streaming, markdown, tool cards, stop button.
3. **Approvals**: inline cards wired to existing endpoints.
4. **Sidebar**: sessions list + workspace diff.
5. **Right panel**: live activity, todos, usage.
6. **Settings**: provider wizard, MCP manager, allowlist.
7. **Polish**: command palette, keyboard map, empty states, responsive.
