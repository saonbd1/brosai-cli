#!/usr/bin/env bash
# Cut a release: builds binaries, zips source, creates GitHub release.
# Usage: ./release.sh 0.6.0   (run from repo root; requires bun + gh)
set -euo pipefail

VER="${1:?usage: ./release.sh <version>}"
TAG="v$VER"
command -v bun >/dev/null || { echo "bun required"; echo "  curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v gh  >/dev/null || { echo "gh required (github cli, authenticated)"; exit 1; }

cd "$(dirname "$0")"

echo "==> bumping VERSION to $VER"
sed -i "s/^export const VERSION = \".*\";/export const VERSION = \"$VER\";/" src/update.ts
grep -q "VERSION = \"$VER\"" src/update.ts || { echo "failed to bump VERSION"; exit 1; }

echo "==> building binaries"
bun build src/cli.ts --compile --outfile brosai-linux
bun build src/cli.ts --compile --target=bun-windows-x64 --outfile brosai.exe

echo "==> zipping source"
git archive --format=zip --prefix="brosai-cli-$VER/" HEAD -o "/tmp/brosai-src-$VER.zip"

echo "==> committing version bump"
git add src/update.ts
if ! git diff --cached --quiet; then
  git commit -m "release: v$VER"
  git push origin HEAD
fi

echo "==> tagging $TAG"
git tag -a "$TAG" -m "Release $TAG" || true
git push origin "$TAG"

echo "==> creating release"
gh release create "$TAG" \
  brosai-linux brosai.exe "/tmp/brosai-src-$VER.zip#brosai-src-$VER.zip" \
  --title "$TAG" --generate-notes

echo "done: https://github.com/saonbd1/brosai-cli/releases/tag/$TAG"
