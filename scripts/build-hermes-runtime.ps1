# Build the Hermes backend runtime inside the vendored submodule so that
# electron-builder's `extraResources` (electron-builder.json) can ship it
# inside the installed app. Two strategies, in order:
#
#   1. Copy a known-good LOCAL install (fast, reuses your already-validated
#      runtime). Safe because uv's venv is relocatable (path-independent),
#      matching the "whole-directory copy" migration approach.
#   2. Fall back to `uv sync` (needs network or a populated uv cache) for a
#      clean machine that has never installed Hermes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$agent = Join-Path (Join-Path $root '..') 'vendor' | Join-Path -ChildPath 'hermes-agent'

if (-not (Test-Path $agent)) {
  Write-Error "vendor/hermes-agent not found. Run 'git submodule update --init' first."
  exit 1
}

Push-Location $agent

function Test-Built {
  return (Test-Path 'venv/Scripts/hermes.exe') -or (Test-Path '.venv/Scripts/hermes.exe')
}

# Already bootstrapped (e.g. dev re-run) -> nothing to do.
if (Test-Built) {
  Write-Host '[hermes-runtime] runtime already present, skipping bootstrap.'
  exit 0
}

# Strategy 1: copy from an existing local install (same helix-rebase-try source).
$src = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent'
if ((Test-Path $src) -and ((Test-Path "$src/venv/Scripts/hermes.exe") -or (Test-Path "$src/.venv/Scripts/hermes.exe"))) {
  Write-Host "[hermes-runtime] copying runtime from $src"
  if (Test-Path "$src/venv")            { Copy-Item "$src/venv"            './venv'            -Recurse -Force }
  if (Test-Path "$src/.venv")           { Copy-Item "$src/.venv"           './.venv'           -Recurse -Force }
  if (Test-Path "$src/.hermes-runtime") { Copy-Item "$src/.hermes-runtime" './.hermes-runtime' -Recurse -Force }
  if (Test-Built) { Write-Host '[hermes-runtime] copied successfully.'; exit 0 }
  Write-Warning '[hermes-runtime] copy did not produce hermes.exe, falling back to uv'
}

# Strategy 2: bootstrap via uv (requires network or uv cache).
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error 'uv not found and no local install to copy from. Install uv or run the official Hermes install first.'
  exit 1
}
Write-Host '[hermes-runtime] bootstrapping via uv sync...'
# `web` provides the FastAPI/uvicorn gateway; `acp` provides the ACP adapter.
# Extend --extra list if your serve path needs more (see pyproject.toml).
uv sync --locked --extra web --extra acp
if (-not (Test-Built)) { Write-Error 'uv sync did not produce hermes.exe'; exit 1 }
