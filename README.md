# BrosAi

Personal CLI coding agent. Give it a task in plain English — it reads, writes, and runs code in your workspace using your own LLM provider keys. Single-file binary, zero runtime dependencies.

## Features

- **Agent loop** — tool calling until task completion (read/write/edit/run/glob/grep)
- **Providers** — Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, DeepSeek, Cerebras, Groq, custom OpenAI-compatible
- **Streaming output** — tokens and tool calls render live in the terminal
- **Sessions** — auto-saved history; `--continue` / `--resume` / `brosai sessions`
- **Safety** — workspace path sandbox, command approval prompts (`-y` to auto-approve), `0600` config files
- **Cross-platform** — Linux/WSL binary + native Windows `.exe`

## Install on another PC

BrosAi ships as a **single standalone binary** — no Node, Bun, or npm install needed.

### Option A — Download a release (recommended)

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

### Option B — Build from source

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

## Usage

```bash
brosai "fix the failing tests"     # one-shot task in current directory
brosai                              # interactive REPL
brosai -c "keep going"              # resume most recent session
brosai --resume <file> "..."        # resume specific session
brosai sessions                     # list saved sessions
brosai providers                    # provider/key status
brosai auth <provider>              # save a key
```

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

### REPL commands

`/provider <id>` · `/model <id>` · `/clear` · `/cost` · `/help` · `/exit`

## Project layout

```
src/
  cli.ts          entry point, args, REPL, slash commands
  agent.ts        tool-call loop
  providers/      streaming clients (OpenAI-compatible, Anthropic)
  tools/          read_file, write_file, edit_file, run_command, glob, grep
  secrets.ts      provider catalog + key resolution
  config.ts       ~/.brosai config (0600, atomic writes)
  session.ts      session save/load (~/.brosai/sessions)
  prompt.ts       system prompt
```

## Security notes

- File tools are sandboxed to the workspace directory (no `..` escapes)
- `run_command` asks for approval unless `-y` is passed; non-TTY input denies by default
- Config contains plaintext API keys — keep `0600` perms, never commit `~/.brosai/`
- Keys passed via env vars never touch disk

## Roadmap & Todo

### Done

- [x] Agent loop with streaming tool calls
- [x] 6 core tools (read/write/edit/run/glob/grep)
- [x] Provider layer: OpenAI-compatible + Anthropic, retries
- [x] Provider catalog (8 providers) + env/config key resolution
- [x] Interactive REPL + one-shot mode + `--json`
- [x] Session persistence, `--continue`, `--resume`, `brosai sessions`
- [x] Command approval prompts, workspace sandbox
- [x] Standalone binaries: Linux + Windows (Bun compile)
- [x] Windows support: `cmd.exe` shell, `%USERPROFILE%` config
- [x] Git repo + GitHub (private)

### Planned / Not done

- [ ] Git checkpoints — auto-snapshot before edits, `undo` support
- [ ] Plan mode (`--mode plan`, read-only pass before acting)
- [ ] `/diff` — show session changes
- [ ] Per-command approval allowlist (`brosai allow add ...`)
- [ ] Token/cost tracking with pricing table
- [ ] MCP client (stdio + HTTP tool servers)
- [ ] Subagents for parallel tasks
- [ ] Context compaction near model limits
- [ ] Skills/rules loading (`SKILL.md`, `.brosai/rules`)
- [ ] More tools: `web_fetch`, `todo_write`, `apply_patch`
- [ ] Windows installer / PATH setup script
