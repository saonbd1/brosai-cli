#!/usr/bin/env bash
# BrosAi installer for Linux/macOS
set -euo pipefail

REPO="saonbd1/brosai-cli"
INSTALL_DIR="${BROS_INSTALL_DIR:-$HOME/.local/bin}"
BIN="$INSTALL_DIR/brosai"

mkdir -p "$INSTALL_DIR"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux) ;;
  darwin)
    echo "No prebuilt macOS binary is published yet (the release only has a Linux build)." >&2
    echo "Build from source instead: bun build src/cli.ts --compile --outfile brosai" >&2
    exit 1 ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)"
[ -n "$TAG" ] || { echo "Could not resolve latest release" >&2; exit 1; }

echo "Downloading brosai $TAG ..."
curl -fsSL "https://github.com/$REPO/releases/download/$TAG/brosai-linux" -o "$BIN"
chmod +x "$BIN"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

echo "Installed: $BIN"
echo "Run 'brosai' to start — the setup wizard will guide you on first run."
