# Avelqua Agent Watchdog — ถ้า agent.log ไม่ขยับเกิน N นาที → kill agent.py แล้ว start Task ใหม่
# รันจาก Scheduled Task ทุก 5 นาที (ติดโดย install-agent-desktop-with-watchdog.ps1)

param(
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$TaskName = "AvelquaPythonAgentDesktop",
  [int]$MaxLogAgeMin = 8
)

$ErrorActionPreference = "SilentlyContinue"
$log = Join-Path $AgentDir "logs\agent.log"
$stamp = Join-Path $AgentDir "logs\watchdog-last-run.txt"

try {
  Set-Content -Path $stamp -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -Encoding UTF8
} catch {}

if (-not (Test-Path $log)) {
  Write-Output "watchdog: no log yet — start task"
  schtasks /Run /TN $TaskName 2>$null
  exit 0
}

$age = ((Get-Date) - (Get-Item $log).LastWriteTime).TotalMinutes
if ($age -le $MaxLogAgeMin) {
  Write-Output "watchdog: ok age=$([math]::Round($age,1))m"
  exit 0
}

Write-Output "watchdog: STALE log age=$([math]::Round($age,1))m — restarting agent"

Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like "*$AgentDir*agent.py*" } |
  ForEach-Object {
    Write-Output "watchdog: stop pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 3
schtasks /Run /TN $TaskName 2>$null
Write-Output "watchdog: task started $TaskName"
