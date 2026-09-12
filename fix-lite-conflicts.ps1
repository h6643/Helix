$ErrorActionPreference = "Stop"

$path = Join-Path $env:USERPROFILE ".pi\agent\settings.json"
$settings = Get-Content $path -Raw | ConvertFrom-Json

$disabledSources = @("npm:pi-lens", "npm:pi-subagents")
$settings.packages = @(
  $settings.packages | ForEach-Object {
    if ($disabledSources -contains $_) {
      [pscustomobject]@{
        source = $_
        extensions = @()
        skills = @()
        prompts = @()
        themes = @()
      }
    } else {
      $_
    }
  }
)

$settings | ConvertTo-Json -Depth 20 | Set-Content $path -Encoding utf8
Write-Output "Disabled direct loading: $($disabledSources -join ', ')"
