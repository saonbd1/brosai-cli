# BrosAi

Personal CLI coding agent. Give it a task in plain English — it reads, writes, and runs code in your workspace using your own LLM provider keys. Single-file binary, zero runtime dependencies.

## Features

- **Agent loop** — tool calling until task completion (read/write/edit/run/glob/grep)
- **Providers** — Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, DeepSeek, Cerebras, Groq, Ollama/local, custom OpenAI-compatible
- **Streaming output** — tokens and tool calls render live in the terminal
- **Sessions** — auto-saved history; `--continue` / `--resume` / `brosai sessions`
- **Safety** — workspace path sandbox, command approval prompts (`-y` to auto-approve), `0600` config files
- **Telegram** — chat with the agent from your phone, approve commands with buttons, and let the agent message you when it finishes
- **Web dashboard** — `brosai web` serves a localhost UI with live SSE streaming, tool cards, approvals, sessions, images, diff/undo, provider/mode/MCP controls, and a skills manager
- **Skills & rules** — drop `SKILL.md` files into `~/.brosai/skills/` or `.brosai/skills/`; manage them via `brosai skills` or the dashboard
- **Checkpoints** — git shadow-repo snapshots every turn; `undo`, `diff`, `/checkpoints`
- **Plan mode** — read-only tools, outputs a plan before touching anything
- **Diagnostics** — `brosai doctor [--deep]` checks config, providers, MCP, and environment
- **Cross-platform** — Linux/WSL binary + native Windows `.exe`
- **Self-updating** — checks for new releases once a day; `brosai update` installs the latest binary

## Install on another PC

BrosAi ships as a **single standalone binary** — no Node, Bun, or npm install needed.

### Option A — Install script (recommended)

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/saonbd1/brosai-cli/master/install.ps1 | iex
```

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/saonbd1/brosai-cli/master/install.sh | bash
```

### Option B — Download a release manually

Download the binary for your platform from [Releases](../../releases) (or copy it manually):

| Platform | File |
|---|---|
| Windows x64 | `brosai.exe` |
| Linux x64 | `brosai-linux` |

```bash
# Linux/macOS-style
chmod +x brosai-linux
mv brosai-linux ~/bin/brosai   # or anywhere on PATH
```

### Option C — Build from source

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`):

```bash
bun build src/cli.ts --compile --outfile brosai-linux                 # Linux/macOS
bun build src/cli.ts --compile --target=bun-windows-x64 --outfile brosai.exe   # Windows
```

## Configure your API key

Keys are stored in `~/.brosai/config.json` (Linux/macOS) or `%USERPROFILE%\.brosai\config.json` (Windows) — directory `0700`, file `0600`.

```bash
brosai auth cerebras        # prompts for key (hidden input)
brosai auth cerebras csk-...   # or pass it directly
brosai providers            # show key status for all providers
```

Or use environment variables instead (nothing saved to disk):

```bash
export CEREBRAS_API_KEY=csk-...     # or ANTHROPIC_API_KEY, OPENROUTER_API_KEY, etc.
brosai -p cerebras "your task"
```

Env overrides: `BROS_DIR`, `BROS_CONFIG_PATH`, `BROSAI_PROVIDER`, `BROSAI_MODEL`, `BROSAI_API_KEY`.

### Ollama / local models (no API key)

BrosAi speaks the OpenAI-compatible Ollama API, so any installed model works — including one hosted on a remote VM:

```bash
brosai models url http://192.168.1.10:11434   # point at your Ollama server
brosai models                                 # list installed models
brosai models use qwen2.5:7b-instruct         # select one (sets ollama as provider)
brosai "your task"                            # runs on the local model
```

Or per-run: `brosai -p ollama -m qwen2.5:7b-instruct --base-url http://192.168.1.10:11434/v1 "task"`.
Env override: `BROSAI_OLLAMA_URL` / `OLLAMA_BASE_URL`. Note: the Ollama server must listen on a reachable interface (`OLLAMA_HOST=0.0.0.0:11434 ollama serve`) and small models may struggle with tool calling.

## Telegram

Control BrosAi from your phone, and let the agent ping you. Uses the plain Telegram Bot API — no extra dependencies.

```bash
brosai telegram setup        # 1) create a bot with @BotFather, paste the token (hidden input)
                             # 2) send the printed  /start <code>  to your bot  -> pairs ONE private chat
brosai telegram              # bot mode: runs on this machine, in the current directory
brosai telegram status|test|logout
```

**In bot mode** send a normal message to give the agent a task (photos work if your model has vision). Commands that need approval arrive as a message with **Once / All session / Deny** buttons (read-only and allowlisted commands never ask; unanswered requests are denied after 5 min).

| Command | |
|---|---|
| `/stop` | cancel the running task |
| `/status` | provider, mode, usage |
| `/mode act\|plan` | switch mode |
| `/diff` · `/undo [n]` | changes since last checkpoint / roll back |
| `/clear` | fresh conversation |

Takes the usual flags: `brosai telegram -p anthropic --cwd ~/proj -c` (provider, workspace, resume).

**Agent tools** (enabled once paired, in every mode of brosai): `telegram_send` (text) and `telegram_send_file` (workspace file ≤ 50 MB, always asks approval). Try: `brosai "run the test suite and telegram me the result"`.

Security notes:
- Only the paired private chat is obeyed; everything else is ignored. Pairing needs a one-time 8-character code shown on your terminal.
- Messages sent while the bot was offline are never replayed.
- The bot token lives in `~/.brosai/config.json` (0600) or `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. If it leaks, revoke it in @BotFather.
- Bot chats are **not** end-to-end encrypted: prompts, answers and uploaded files pass through Telegram's servers.
- `brosai telegram -y` removes approval prompts, so anyone who gets into your Telegram account could run shell commands on your machine. Don't use it unless you accept that.
- Env: `BROSAI_TELEGRAM_API` overrides the API base URL (proxies, testing).

## Skills

Skills are reusable instruction sets the agent loads into its system prompt. Two scopes:

- **Global** — `~/.brosai/skills/<name>/SKILL.md` (Windows: `%USERPROFILE%\.brosai\skills\`)
- **Project** — `<repo>/.brosai/skills/<name>/SKILL.md`

A skill is a directory containing a `SKILL.md` file:

```markdown
---
name: my-skill                  # optional; defaults to the directory name
description: What this skill does   # shown in `brosai skills` listing
---

# Instructions

Step-by-step guidance the agent should follow when this skill is relevant.
```

Frontmatter is optional — without it, the first prose line becomes the description. Keep skills focused; they share the ~24k-char context budget with `AGENTS.md`/rules files.

```bash
brosai skills                                # list all skills
brosai skills add my-skill ./SKILL.md        # install globally
brosai skills add my-skill ./SKILL.md --project   # install for this repo only
brosai skills rm my-skill                    # remove
brosai skills show my-skill                  # print contents
```

The dashboard's **Skills** tab (right panel) offers the same thing with a file picker. Starter skills live in `skills/` in this repo (`release-checklist`, `commit-style`) — install with `brosai skills add <name> skills/<name>/SKILL.md`.

## Tool performance notes

- **Parallel reads:** when the model emits several read-only calls together (`read_file`, `glob`, `grep`, `list_dir`, `web_fetch`, read-only `spawn_agent`), they run concurrently. Anything that can change state still runs in order.
- **`grep`** uses [ripgrep](https://github.com/BurntSushi/ripgrep) if `rg` is on your PATH (much faster on big repos); otherwise a built-in engine that skips binaries and gitignored files. Regex syntax `rg` rejects (e.g. lookahead) falls back automatically. Options: `ignore_case`, `context`, `files_only`.
- **`glob` / `grep`** list files with `git ls-files` (respects `.gitignore`, includes dotfiles) and fall back to a plain walk outside git repos. A pattern without `/` (e.g. `*.ts`) matches file names at any depth.
- **`read_file`** streams only the requested lines (2000 per call, then a "continue with offset=N" hint), rejects binary files, and truncates absurdly long lines.
- **`run_command`** closes stdin, kills the whole process group on timeout or Ctrl+C, keeps the head and tail of huge output, and no longer waits on leftover background processes. The login-shell `PATH` is resolved once per session instead of spawning a login shell per command. Set `BROSAI_LOGIN_SHELL=1` to restore the old per-command login shell (needed if you rely on other variables from your shell profile).
- **`web_fetch`** reads at most 2 MB of a page.
- Env: `BROSAI_NO_RG=1` disables the ripgrep path.

## Usage

```bash
brosai "fix the failing tests"     # one-shot task in current directory
brosai                              # interactive REPL
brosai -c "keep going"              # resume most recent session
brosai --resume <file> "..."        # resume specific session
brosai sessions                     # list saved sessions
brosai providers                    # provider/key status
brosai auth <provider>              # save a key
brosai checkpoints                  # list workspace checkpoints
brosai undo [n]                     # restore workspace to before last n turns
brosai diff                         # changes since last checkpoint
brosai allow                        # list auto-approved command patterns
brosai allow add "npm test*"        # always approve matching commands
brosai allow rm "npm test*"         # remove a pattern
brosai --plan "..."                 # plan mode: read-only, outputs a plan only
brosai --mode plan                  # same, or --mode act to switch back
brosai web [--port 8420]            # localhost web dashboard (auto-opens browser; SSE streaming, sessions, skills, MCP manager)
# expose safely: BROS_WEB_TOKEN=<secret> brosai web   # requires ?token= once, then cookie auth
brosai doctor [--deep]              # diagnose config, provider, MCP, environment
brosai skills                       # list installed skills (global + project)
brosai skills add <name> <file.md> [--project]   # install a SKILL.md
brosai skills rm <name> / show <name>
```

Checkpoints use a hidden git repo under `~/.brosai/checkpoints/` — every turn snapshots the workspace first, so `brosai undo` can restore files and remove agent-created ones. Disable with `--no-checkpoint`. Read-only shell commands (`ls`, `cat`, `git status/diff/log`, …) never prompt for approval; everything else asks `[y/n/a]` where `a` approves the rest of the session.

### Flags

| Flag | Description |
|---|---|
| `-p, --provider <id>` | Provider id (default: last used, else `openrouter`) |
| `-m, --model <id>` | Model override |
| `-k, --api-key <key>` | Per-run key (not saved) |
| `--base-url <url>` | Custom OpenAI-compatible endpoint |
| `--cwd <path>` | Workspace directory (default: cwd) |
| `-y, --yes` | Auto-approve all commands |
| `--json` | JSON event output for scripting |
| `--max-steps <n>` | Max agent steps (default 100) |
| `-c, --continue` | Resume latest session |
| `--plan` / `--mode <act\|plan>` | Plan mode (read-only tools, plan output only) |
| `--no-checkpoint` | Disable git shadow-repo checkpoints |
| `--resume <file>` | Resume specific session file |
| `-i, --image <path>` | Attach an image to the prompt (png/jpg/gif/webp/bmp, ≤8 MB; repeatable). Requires a vision-capable model/provider |

Images attach to the user message and stay in session history, so follow-up questions keep the visual context. In the REPL use `/image <path>` to queue an image for your next message.

### REPL commands

`/provider(s)` · `/model` · `/mode <act|plan>` · `/image <path>` · `/allow <pat>` · `/clear` · `/cost` · `/diff` · `/undo` · `/checkpoints` · `/sessions` · `/status` · `/context` · `/compact` · `/help` · `/exit`

`/context` shows context-window usage (system prompt + history tokens vs. the window, with a progress bar); `/compact` forces summarization of older history immediately instead of waiting for the 80% auto-compaction threshold. The web dashboard shows the same context meter in the Usage panel and has a **Compact** button in the workspace card.

## Project layout

```
src/
  cli.ts          entry point, args, REPL, slash commands
  agent.ts        tool-call loop
  providers/      streaming clients (OpenAI-compatible, Anthropic)
  tools/          read_file, write_file, edit_file, run_command, glob, grep, apply_patch, spawn_agent, …
  tools/fast.ts   perf helpers: ripgrep, git ls-files, streaming reads, shell runner
  secrets.ts      provider catalog + key resolution
  config.ts       ~/.brosai config (0600, atomic writes)
  session.ts      session save/load (~/.brosai/sessions)
  prompt.ts       system prompt
  mcp.ts          MCP client (stdio + Streamable HTTP)
  runtime.ts      shared agent-turn logic (CLI + Telegram)
  telegram.ts     Telegram bot mode, pairing, telegram_* tools
  update.ts       release check + self-update
  web.ts          localhost web server + dashboard API (SSE streaming)
  dashboard.html  embedded web UI (regenerate src/dashboard.ts via `npm run dashboard`)
  skills.ts       skill install/list/remove (~/.brosai/skills, .brosai/skills)
  doctor.ts       `brosai doctor` diagnostics
  checkpoint.ts   git shadow-repo snapshots + undo/diff
  compact.ts      context auto-compaction
  allow.ts        command allowlist
  markdown.ts     chat markdown renderer
  pricing.ts      token cost estimates
```

## Security notes

- File tools are sandboxed to the workspace directory (no `..` escapes)
- `run_command` asks for approval unless `-y` is passed; non-TTY input denies by default
- Config contains plaintext API keys — keep `0600` perms, never commit `~/.brosai/`
- Keys passed via env vars never touch disk

## Roadmap & Todo

### Done

- [x] Agent loop with streaming tool calls
- [x] 12 core tools (file ops, shell, search, web_fetch, todo_write, apply_patch, move_file, connect_service)
- [x] Subagents — `spawn_agent` tool delegates to a fresh-context child agent (read-only explore or full act mode, depth-capped)
- [x] Vision input — `-i/--image` flag and `/image` REPL command (OpenAI-compatible + Anthropic providers)
- [x] MCP client — stdio **and Streamable HTTP** servers, `brosai mcp add/list/rm`, tools as `mcp__<server>__<tool>`
  - stdio: `brosai mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /path`
  - HTTP: `brosai mcp add remote --url https://mcp.example.com/mcp [--header Authorization=Bearer ...]`
- [x] Context compaction — auto-summarizes history near the context limit
- [x] Skills/rules loading — `AGENTS.md`, `CLAUDE.md`, `.brosai/rules/`, `.brosai/skills/*/SKILL.md`
- [x] Interactive `/provider` + `/model` pickers, per-provider display names
- [x] `connect_service` — OAuth device flow (e.g. `brosai "connect my github"`)
- [x] Ollama/local model support — keyless provider, `brosai models` discovery
- [x] Provider layer: OpenAI-compatible + Anthropic, retries
- [x] Provider catalog (8 providers) + env/config key resolution
- [x] Interactive REPL + one-shot mode + `--json`
- [x] Session persistence, `--continue`, `--resume`, `brosai sessions`
- [x] Command approval prompts, workspace sandbox
- [x] Standalone binaries: Linux + Windows (Bun compile)
- [x] Windows support: `cmd.exe` shell, `%USERPROFILE%` config
- [x] Git repo + GitHub (public)
- [x] Git checkpoints — shadow-repo snapshots before each turn, `brosai undo [n]`, `/undo`, `/checkpoints`, `--no-checkpoint`
- [x] Plan mode (`--plan` / `--mode plan`, `/mode` in REPL — read-only tools only)
- [x] `/diff` and `brosai diff` — changes since last checkpoint
- [x] Approval UX — read-only auto-approve, `brosai allow` wildcard allowlist, `[y/n/a]` session approve-all
- [x] Telegram — bot mode with inline-button approvals, pairing, `telegram_send` / `telegram_send_file` tools
- [x] Web UI — `brosai web` serves a localhost chat page with approval buttons
- [x] Self-update — `brosai update` + daily release check
- [x] `brosai doctor` / `/doctor` — config, provider reachability, MCP, environment diagnostics (`--deep` adds a live completion + MCP connect test)
- [x] Token/cost tracking — pricing table, session + lifetime estimates in `/cost` and run footer
- [x] Web dashboard v2 — SSE token/tool streaming, stop button, session sidebar with history restore, image attach, diff/undo overlays, todos + usage panels, provider/mode/MCP controls, skills tab
- [x] Skills management — `brosai skills` CLI + dashboard upload; global (`~/.brosai/skills`) and project (`.brosai/skills`) scopes
- [x] Source archives — every GitHub release ships `brosai-src-<ver>.zip` alongside binaries

### Planned / Not done

- [ ] MCP resources/prompts (tools only today)
- [ ] Per-project provider/mode defaults
- [ ] Conversational `/rewind` (undo by description, not just last turn)
- [ ] `brosai web` as a service (systemd unit / always-on dashboard)
- [ ] Mobile-responsive pass on the dashboard
- [ ] Colibri speed profile (fewer MCP tools for casual sessions / faster prefill)

### Next up

- [ ] Polish pass on dashboard mobile layout + empty states
- [ ] Decide on MCP resources/prompts scope — implement or defer
- [x] Host `brosai web` on the Oracle VM behind the Cloudflare tunnel — live at `https://chat.saonbd.bond` (systemd `brosai-web.service`, `BROS_WEB_TOKEN` auth)
