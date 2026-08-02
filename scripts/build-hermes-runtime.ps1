# Build a slim, self-contained Hermes backend runtime for packaging.
#
# electron-builder.json `extraResources` ships `.cache/hermes-runtime/hermes-agent`
# into `resources/hermes-agent` of the installed app, so a fresh machine needs no
# separate Hermes install. This script produces that staging dir:
#
#   1. Ensure a runtime exists in vendor/hermes-agent (reuse a known-good
#      LOCALAPPDATA install, else `uv sync` fallback).
#   2. Copy a SLIM copy of the submodule into .cache/hermes-runtime/hermes-agent:
#      runtime source + `venv` + `.hermes-runtime`, dropping `.venv` (references
#      the uv cache python — not relocatable), git/website/tests/apps and all
#      __pycache__/*.pyc bytecode.
#   3. Relocate the editable-install finder: hermes is installed editable, and
#      its finder hardcodes the developer machine's absolute source path
#      (e.g. C:\Users\...\AppData\Local\hermes\hermes-agent). Rewrite it to
#      resolve the source tree relative to the finder file itself, so the
#      packaged backend imports the bundled source on ANY machine.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repo = Join-Path $root '..'
$agent = Join-Path $repo 'vendor' | Join-Path -ChildPath 'hermes-agent'
$stagingRoot = Join-Path $repo '.cache\hermes-runtime'
$staging = Join-Path $stagingRoot 'hermes-agent'

if (-not (Test-Path $agent)) {
  Write-Error "vendor/hermes-agent not found. Run 'git submodule update --init' first."
  exit 1
}

function Test-Built {
  return (Test-Path (Join-Path $agent 'venv\Scripts\hermes.exe')) -or (Test-Path (Join-Path $agent '.venv\Scripts\hermes.exe'))
}

function Invoke-Robocopy {
  param([string]$Src, [string]$Dst, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @())
  if (-not (Test-Path $Src)) { return }
  $rcArgs = @($Src, $Dst, '/E')
  foreach ($d in $ExcludeDirs) { $rcArgs += @('/XD', $d) }
  foreach ($f in $ExcludeFiles) { $rcArgs += @('/XF', $f) }
  $rcArgs += @('/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  & robocopy $rcArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { Write-Error "robocopy failed (code $code): $Src -> $Dst" }
}

# ── 1) Ensure a runtime is bootstrapped in vendor/hermes-agent ─────────────
Push-Location $agent
try {
  if (-not (Test-Built)) {
    # Strategy 1: copy from an existing local install (same helix-rebase-try source).
    $src = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent'
    if ((Test-Path $src) -and ((Test-Path "$src/venv/Scripts/hermes.exe") -or (Test-Path "$src/.venv/Scripts/hermes.exe"))) {
      Write-Host "[hermes-runtime] copying runtime from $src"
      if (Test-Path "$src/venv")            { Copy-Item "$src/venv"            './venv'            -Recurse -Force }
      if (Test-Path "$src/.venv")           { Copy-Item "$src/.venv"           './.venv'           -Recurse -Force }
      if (Test-Path "$src/.hermes-runtime") { Copy-Item "$src/.hermes-runtime" './.hermes-runtime' -Recurse -Force }
    }
    # Strategy 2: bootstrap via uv (requires network or uv cache).
    if (-not (Test-Built)) {
      if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Error 'uv not found and no local install to copy from. Install uv or run the official Hermes install first.'
        exit 1
      }
      Write-Host '[hermes-runtime] bootstrapping via uv sync...'
      uv sync --locked --extra web --extra acp
      if (-not (Test-Built)) { Write-Error 'uv sync did not produce hermes.exe'; exit 1 }
    }
  } else {
    Write-Host '[hermes-runtime] vendor runtime already present.'
  }
}
finally { Pop-Location }

# ── 2) Stage a slim, self-contained copy ─────────────────────────────────────
if (Test-Path $stagingRoot) { Remove-Item $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

# Only the runtime source tree; drop version-control, non-runtime docs/tests,
# and the alternate venvs (they are re-added explicitly below).
Invoke-Robocopy $agent $staging @('.git', '.venv', 'venv', '.hermes-runtime', 'website', 'tests', 'apps', '__pycache__') @('*.pyc', '*.pyo')

$venvSrc = Join-Path $agent 'venv'
if (-not (Test-Path $venvSrc)) { $venvSrc = Join-Path $agent '.venv' }
if (-not (Test-Path $venvSrc)) { Write-Error 'no venv to stage — bootstrap failed'; exit 1 }
Write-Host '[hermes-runtime] staging venv...'
Invoke-Robocopy $venvSrc (Join-Path $staging 'venv') @('__pycache__') @('*.pyc', '*.pyo')

$rtSrc = Join-Path $agent '.hermes-runtime'
if (Test-Path $rtSrc) {
  Write-Host '[hermes-runtime] staging .hermes-runtime...'
  Invoke-Robocopy $rtSrc (Join-Path $staging '.hermes-runtime') @('__pycache__') @('*.pyc', '*.pyo')
}

# ── 3) Relocate the editable-install finder (absolute -> relative) ───────────
$sp = Join-Path $staging 'venv\Lib\site-packages'
$finder = Get-ChildItem $sp -Filter '__editable___hermes_agent_*_finder.py' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($finder) {
  $content = [System.IO.File]::ReadAllText($finder.FullName)
  $m = [regex]::Match($content, "[A-Za-z]:[^']*?\\hermes-agent")
  if ($m.Success) {
    $base = $m.Value
    $content = $content.Replace("'$base", "_HERMES_ROOT + '")
    $marker = 'from pathlib import Path'
    if ($content -notmatch [regex]::Escape('_HERMES_ROOT = str(Path(__file__)')) {
      $content = $content -replace [regex]::Escape($marker), ($marker + "`n_HERMES_ROOT = str(Path(__file__).resolve().parents[3])")
    }
    [System.IO.File]::WriteAllText($finder.FullName, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[hermes-runtime] patched editable finder -> relative to packaged source"
  }
} else {
  Write-Warning '[hermes-runtime] no editable finder found (non-editable install?) — nothing to relocate'
}

Write-Host "[hermes-runtime] staging complete: $staging"
