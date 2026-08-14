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

# Ensure the runtime's .gitignore exists — it keeps the CI-built tree out of
# git (only .gitignore + RUNTIME_VERSION are tracked). Restore it when the
# runtime was deleted wholesale (`rm -rf`) ahead of a rebuild.
if [ ! -f "$RESOURCES_DIR/.gitignore" ]; then
  mkdir -p "$RESOURCES_DIR"
  printf '# CI-generated runtime directory — contents are built by scripts/prepare-runtime.sh\n*\n!.gitignore\n!RUNTIME_VERSION\n' > "$RESOURCES_DIR/.gitignore"
fi

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
ARCHIVE_NAME="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${TARGET_TRIPLE}-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${ARCHIVE_NAME}"
PYTHON_BIN="$RESOURCES_DIR/python/bin/python3"
case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  mingw*|msys*|cygwin*|windows*)
    PYTHON_BIN="$RESOURCES_DIR/python/python.exe" ;;
esac
# Site-packages location differs by OS for python-build-standalone.
# Windows: python/Lib/site-packages  | Unix: python/lib/python3.12/site-packages
SITE_PACKAGES="$RESOURCES_DIR/python/Lib/site-packages"
if [ ! -d "$SITE_PACKAGES" ]; then
  SITE_PACKAGES="$RESOURCES_DIR/python/lib/python3.12/site-packages"
fi

# ── Idempotency ────────────────────────────────────────────────────────────
# Skip the heavy download/pip steps only when the runtime is already built
# AND its dependency signature matches the current hermes-agent source. The
# signature hashes pyproject.toml + uv.lock, so any dependency change forces
# a rebuild instead of silently reusing a stale runtime (the previous
# "hermes_cli exists" check kept shipping voice-era runtimes forever after
# the voice stack was removed — that's how the bundle ballooned).
BUILT=0
DEPS_FILE="$REPO_ROOT/hermes-agent/pyproject.toml"
LOCK_FILE="$REPO_ROOT/hermes-agent/uv.lock"
SIG="none"
if [ -f "$DEPS_FILE" ]; then
  SIG=$(cat "$DEPS_FILE" "$LOCK_FILE" 2>/dev/null | sha256sum | cut -d' ' -f1)
fi
SIG_FILE="$RESOURCES_DIR/.deps-sig"
if [ -d "$SITE_PACKAGES/hermes_cli" ] && [ -f "$SIG_FILE" ] && [ "$(cat "$SIG_FILE" 2>/dev/null)" = "$SIG" ]; then
  BUILT=1
  echo "[prepare] hermes_cli already installed and dependency signature unchanged — skipping pip install."
else
  echo "[prepare] building runtime from scratch (deps changed or runtime unbuilt)"
fi

echo "[prepare] target:  $TARGET_TRIPLE"
echo "[prepare] python:   $PYTHON_VERSION"
echo "[prepare] output:   $RESOURCES_DIR"

if [ "$BUILT" -eq 0 ]; then

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

# ── 2. pip install hermes-agent into the standalone interpreter ──────────────
# No venv: deps land in the standalone Python's own site-packages, which is
# fully portable (copies cleanly to any machine). Launching is
# `python -m hermes_cli.main` (hermes-agent has NO top-level `hermes` module;
# its console entry point is `hermes = "hermes_cli.main:main"`).
echo "[prepare] pip install hermes-agent (into standalone site-packages)..."
HERMES_NIX_BUILD=1 "$PYTHON_BIN" -m pip install \
  --quiet \
  --disable-pip-version-check \
  "$REPO_ROOT/hermes-agent/"

# Verify the hermes package is importable from the standalone interpreter.
# The importable package is `hermes_cli` (NOT `hermes` — that name only exists
# as the repo's source launcher script, never as an installed module).
if ! "$PYTHON_BIN" -c "import hermes_cli.main" 2>/dev/null; then
  echo "ERROR: hermes_cli not importable after pip install" >&2
  "$PYTHON_BIN" -m pip show hermes 2>/dev/null || true
  exit 1
fi
echo "[prepare]   hermes importable OK"

fi # ^ heavy build steps (skipped when the Python runtime already exists)

# ── 3b. Bundle agent-extra (full tools/ package) ──
# The standalone interpreter has no hermes-agent source tree, so extra tools
# are copied next to the runtime. Layout:
#   hermes-runtime/agent-extra/tools/__init__.py  (+ all tool modules)
AGENT_EXTRA="$RESOURCES_DIR/agent-extra"
echo "[prepare] bundling agent-extra -> $AGENT_EXTRA"
mkdir -p "$AGENT_EXTRA/scripts"
# Copy the entire tools/ package so the tools have every module they import
# at runtime. The shebang-free Python sources keep the bundle portable.
rm -rf "$AGENT_EXTRA/tools"
if [ -d "$REPO_ROOT/hermes-agent/tools" ]; then
  mkdir -p "$AGENT_EXTRA/tools"
  cp -R "$REPO_ROOT/hermes-agent/tools/." "$AGENT_EXTRA/tools/" 2>/dev/null || \
    echo "[prepare] WARNING: tools/ copy failed"
fi
# Drop the __pycache__ that may have been copied alongside the sources.
find "$AGENT_EXTRA" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# ── 4. Stamp runtime version ─────────────────────────────────────────────
# RUNTIME_VERSION is read by the Rust bootstrap (bootstrap.rs) to decide whether
# an already-installed ~/.hermes runtime must be re-extracted. Bump it on every
# build (build epoch) so any change to the Python runtime / agent-extra scripts
# propagates to existing installs.
# The file is kept out of the git ignore (see .gitignore `!RUNTIME_VERSION`).
VERSION_FILE="$RESOURCES_DIR/RUNTIME_VERSION"
echo "[prepare] stamping $VERSION_FILE"
date +%s > "$VERSION_FILE"
# Stamp the dependency signature so the next build can skip the heavy pip step
# only while it still matches (see the Idempotency block above).
echo "$SIG" > "$SIG_FILE"

# ── 3. Prune ────────────────────────────────────────────────────────────────
# The voice stack (faster-whisper / sherpa-onnx / openwakeword / ctranslate2 /
# onnxruntime / av / scipy / scikit-learn) was removed from hermes-agent's
# dependencies. Runtimes built before the removal can still carry those
# packages (the old idempotency check skipped rebuilds); drop them so they
# never ship in the app bundle or get re-deployed to ~/.hermes.
echo "[prepare] removing retired voice-stack packages (if any)..."
"$PYTHON_BIN" -m pip uninstall -y \
  faster-whisper sherpa-onnx openwakeword ctranslate2 onnxruntime \
  av scipy scikit-learn sounddevice >/dev/null 2>&1 || true

echo "[prepare] pruning..."
find "$RESOURCES_DIR" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$RESOURCES_DIR" -name "*.pyc" -delete 2>/dev/null || true
find "$RESOURCES_DIR" -name "tests" -type d -not -path "*/site-packages/*" -exec rm -rf {} + 2>/dev/null || true
rm -rf "$RESOURCES_DIR/python/include" 2>/dev/null || true
rm -rf "$RESOURCES_DIR/python/share" 2>/dev/null || true

# ── 外置记忆 Provider 不内置 ────────────────────────────────────────────────
# memory provider 插件（site-packages/plugins/memory/<name>/）改为按需安装：
# `hermes plugins install NousResearch/hermes-agent/plugins/memory/<name>`
# 会从 GitHub 下载到 $HERMES_HOME/plugins/<name>，不随应用打包。这里删除
# 所有 provider 子目录，但保留 plugins/memory/__init__.py（发现逻辑）与
# config_schema.py（配置 schema 判定）。
MEMORY_DIR="$SITE_PACKAGES/plugins/memory"
if [ -d "$MEMORY_DIR" ]; then
  find "$MEMORY_DIR" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
  echo "[prepare] memory provider plugins excluded from bundle (install on demand)"
fi

SIZE=$(du -sh "$RESOURCES_DIR" 2>/dev/null | cut -f1)
echo "[prepare] done.  Total size: $SIZE"
echo "[prepare] runtime ready at: $RESOURCES_DIR"
