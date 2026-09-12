$ErrorActionPreference = "Stop"

$agent = Join-Path $env:USERPROFILE ".pi\agent"
$npmRoot = Join-Path $agent "npm"

$files = @(
  "$agent\pi-subagents-lite.ts",
  "$agent\pi-subagents-package.json",
  "$agent\extensions\pi-subagents-lite.ts",
  "$agent\extensions\pi-subagents-package.json",
  "$agent\extensions\subagent\config.json"
)

foreach ($file in $files) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
  }
}

$directories = @(
  "$agent\extensions\subagent",
  "$agent\missions",
  "$npmRoot\node_modules\pi-subagents"
)

foreach ($directory in $directories) {
  if (Test-Path -LiteralPath $directory) {
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
}

Write-Output "pi-subagents files removed."
