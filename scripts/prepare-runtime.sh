#!/bin/bash
# prepare-runtime.sh — Download python-build-standalone, create a --copies
# venv, pip-install hermes-agent with all dependencies, and prune the result.
# Run from the repo root. Output lands in src-tauri/resources/hermes-runtime/.
#
# Usage:
#   bash scripts/prepare-runtime.sh
#
# The script is idempotent: if the venv hermes binary already exists, it
# skips the download and build steps. Delete the runtime directory first to
# force a rebuild.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$REPO_ROOT/src-tauri/resources/hermes-runtime"

# ── Configuration ──────────────────────────────────────────────────────────
PYTHON_VERSION="3.12.10"
PBS_RELEASE="20250409"

# Detect host target triple for python-build-standalone downloads.
# See: https://gregoryszorc.com/docs/python-build-standalone/main/running.html
detect_target_triple() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) echo "ERROR: unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  case "$os" in
    linux)   echo "${arch}-unknown-linux-gnu" ;;
    darwin)  echo "${arch}-apple-darwin" ;;
    mingw*|msys*|cygwin*|windows*)
      echo "${arch}-pc-windows-msvc" ;;
    *) echo "ERROR: unsupported OS: $os" >&2; exit 1 ;;
  esac
}

TARGET_TRIPLE=$(detect_target_triple)
ARCHIVE_NAME="cpython-${PYTHON_VERSION}-${TARGET_TRIPLE}-install_only-${PBS_RELEASE}.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${ARCHIVE_NAME}"
PYTHON_BIN="$RESOURCES_DIR/python/bin/python3"
if [ "$(uname -s | tr '[:upper:]' '[:lower:]')" = "mingw" ] || [ "$(uname -s | tr '[:upper:]' '[:lower:]')" = "msys" ] || [ "$(uname -s | tr '[:upper:]' '[:lower:]')" = "cygwin" ]; then
  PYTHON_BIN="$RESOURCES_DIR/python/python.exe"
fi
VENV_DIR="$RESOURCES_DIR/hermes-agent/venv"
VENV_HERMES="$VENV_DIR/bin/hermes"
if [ "${TARGET_TRIPLE##*-}" = "msvc" ]; then
  VENV_HERMES="$VENV_DIR/Scripts/hermes.exe"
fi

# ── Idempotency ────────────────────────────────────────────────────────────
if [ -x "$VENV_HERMES" ]; then
  echo "[prepare] hermes runtime already exists at $VENV_HERMES — skipping."
  echo "[prepare] delete $RESOURCES_DIR to force a rebuild."
  exit 0
fi

echo "[prepare] target:  $TARGET_TRIPLE"
echo "[prepare] python:   $PYTHON_VERSION"
echo "[prepare] output:   $RESOURCES_DIR"

# ── 1. Download python-build-standalone ─────────────────────────────────────
echo "[prepare] downloading python-build-standalone..."
mkdir -p "$RESOURCES_DIR"
curl -sL --retry 3 --retry-delay 5 "$PBS_URL" | tar xz -C "$RESOURCES_DIR/"

if [ ! -f "$PYTHON_BIN" ]; then
  echo "ERROR: python binary not found at $PYTHON_BIN after extraction" >&2
  ls -la "$RESOURCES_DIR/python/bin/" 2>/dev/null || echo "(python/bin does not exist)"
  exit 1
fi
echo "[prepare]   python binary: $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

# ── 2. Create --copies venv ─────────────────────────────────────────────────
echo "[prepare] creating --copies venv..."
"$PYTHON_BIN" -m venv --copies "$VENV_DIR"
echo "[prepare]   venv python: $("$VENV_DIR/bin/python3" --version 2>&1)"

# ── 3. pip install hermes-agent ─────────────────────────────────────────────
echo "[prepare] pip install hermes-agent..."
HERMES_NIX_BUILD=1 "$VENV_DIR/bin/pip" install \
  --quiet \
  --disable-pip-version-check \
  "$REPO_ROOT/hermes-agent/"

# Verify the hermes entry point was created.
if [ ! -f "$VENV_HERMES" ]; then
  echo "ERROR: hermes entry point not found at $VENV_HERMES after pip install" >&2
  ls -la "$VENV_DIR/bin/" 2>/dev/null || echo "(venv/bin does not exist)"
  exit 1
fi
echo "[prepare]   hermes entry: $VENV_HERMES"

# ── 4. Prune ────────────────────────────────────────────────────────────────
echo "[prepare] pruning..."
find "$RESOURCES_DIR" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$RESOURCES_DIR" -name "*.pyc" -delete 2>/dev/null || true
find "$RESOURCES_DIR" -name "tests" -type d -not -path "*/site-packages/*" -exec rm -rf {} + 2>/dev/null || true
rm -rf "$RESOURCES_DIR/python/include" 2>/dev/null || true
rm -rf "$RESOURCES_DIR/python/share" 2>/dev/null || true

SIZE=$(du -sh "$RESOURCES_DIR" 2>/dev/null | cut -f1)
echo "[prepare] done.  Total size: $SIZE"
echo "[prepare] runtime ready at: $RESOURCES_DIR"
