---
name: release-checklist
description: Cut a BrosAi release — version bump, binaries, tag, GitHub release with all assets
---

# BrosAi release checklist

Use when the user asks to release, ship, or cut a new version.

## Steps

1. Confirm what is being released: `git log --oneline <last-tag>..HEAD` and `git status` (tree must be clean).
2. Run `./release.sh <version>` from the repo root (e.g. `./release.sh 0.7.0`). It will:
   - bump `VERSION` in `src/update.ts` and commit it
   - build `brosai-linux` and `brosai.exe` (Bun compile)
   - zip the source as `brosai-src-<version>.zip`
   - commit, tag `v<version>`, push, and create the GitHub release with all three assets
3. Verify: `gh release view v<version> --json assets` shows `brosai-linux`, `brosai.exe`, `brosai-src-<version>.zip`; run `./brosai-linux -v` to confirm the version string.
4. Copy `brosai.exe` to the user's Windows locations if they exist:
   - `/mnt/c/Users/<user>/brosai.exe`
   - `/mnt/c/Users/<user>/AppData/Local/brosai/brosai.exe`
5. Report the release URL to the user.

## Rules

- Never skip the source zip — every release ships it.
- Do not push tags or create releases manually; `release.sh` owns the whole flow.
- If `brosai.exe` is locked on Windows (BrosAi running), copy to `%LOCALAPPDATA%\brosai\brosai.exe` and tell the user to close BrosAi for the other copy.
- Version format: `0.x.y` — no `v` prefix in the argument.

## After release

- Remind the user other installs pick it up via `brosai update` or the daily update notice.
- Update the README "Next up" section if the release closed planned items.
