# Desktop Agent Task + Watchdog (recommended instead of NSSM)
# powershell -ExecutionPolicy Bypass -File C:\avelqua-python-agent\install-agent-desktop-with-watchdog.ps1 -Token "YOUR_TOKEN"

param(
  [Parameter(Mandatory = $false)]
  [string]$Token = "",
  [string]$ServerUrl = "https://trading.avelqua.com/api/vps-agent",
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$Mt5Root = "C:\MT5_PORTS",
  [string]$AgentTaskName = "AvelquaPythonAgentDesktop",
  [string]$WatchdogTaskName = "AvelquaAgentWatchdog",
  [int]$WatchdogEveryMin = 5,
  [int]$MaxLogAgeMin = 8
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AgentDir)) {
  $AgentDir = "C:\avelqua-python-agent"
}

$installScript = Join-Path $AgentDir "install_interactive_agent_task.ps1"
if (-not (Test-Path -LiteralPath $installScript)) {
  Write-Host "ERROR: missing $installScript" -ForegroundColor Red
  exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript `
  -Token $Token -ServerUrl $ServerUrl -AgentDir $AgentDir -Mt5Root $Mt5Root -TaskName $AgentTaskName
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$watchdogSrc = Join-Path $AgentDir "watchdog-agent.ps1"
if (-not (Test-Path -LiteralPath $watchdogSrc)) {
  Write-Host "ERROR: missing $watchdogSrc" -ForegroundColor Red
  exit 1
}

$watchdogPath = Join-Path $AgentDir "watchdog-agent.ps1"
try { schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null } catch {}

$watchdogCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`" -AgentDir `"$AgentDir`" -TaskName `"$AgentTaskName`" -MaxLogAgeMin $MaxLogAgeMin"

schtasks /Create /TN $WatchdogTaskName /TR $watchdogCmd /SC MINUTE /MO $WatchdogEveryMin /RU $env:USERNAME /RL HIGHEST /F | Out-Null
schtasks /Run /TN $WatchdogTaskName 2>$null | Out-Null

Write-Host ""
Write-Host ('OK: Watchdog installed — every {0} min, restart if log stale > {1} min' -f $WatchdogEveryMin, $MaxLogAgeMin) -ForegroundColor Green
Write-Host "  Watchdog Task: $WatchdogTaskName"
Write-Host ""
Write-Host "Check:" -ForegroundColor Cyan
Write-Host ('  Get-ScheduledTask -TaskName ''{0}'',''{1}''' -f $AgentTaskName, $WatchdogTaskName)
$agentLog = Join-Path $AgentDir "logs\agent.log"
Write-Host ('  Get-Content ''{0}'' -Tail 30 -Wait' -f $agentLog)
