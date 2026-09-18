$log = 'C:\Users\hyt\.pi\agent\helix-spawn-debug.log'
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    $hit = Select-String -Path $log -Pattern 'gateway ready|FAILED|retry failed|child stderr|spawn FAILED' -ErrorAction SilentlyContinue
    if ($hit) {
        Write-Host '=== MATCH ==='
        Get-Content $log
        exit 0
    }
    Start-Sleep -Seconds 3
}
Write-Host '=== TIMEOUT (120s) ==='
Get-Content $log
