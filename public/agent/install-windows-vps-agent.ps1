# Avelqua Windows VPS Agent - one-shot installer (Desktop Task + Watchdog)
#
# Prerequisites:
#   - Windows Server with RDP (stay logged in; disconnect OK, no Sign out)
#   - Python 3.10+ in PATH (python --version)
#   - PowerShell run as Administrator
#   - Agent TOKEN from Admin -> VPS -> Edit -> Agent TOKEN (per VPS)
#
# Quick install (copy one line, replace TOKEN):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://trading.avelqua.com/agent/install-windows-vps-agent.ps1' -OutFile $env:TEMP\install-windows-vps-agent.ps1 -UseBasicParsing; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\install-windows-vps-agent.ps1 -Token 'YOUR_TOKEN'"
#
# Or download this file first, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-vps-agent.ps1 -Token "YOUR_TOKEN"

param(
  [Parameter(Mandatory = $true)]
  [string]$Token,
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$Mt5Root = "C:\MT5_PORTS",
  [string]$ServerUrl = "https://trading.avelqua.com/api/vps-agent",
  [string]$BaseUrl = "https://trading.avelqua.com/agent",
  [string]$AgentTaskName = "AvelquaPythonAgentDesktop",
  [string]$WatchdogTaskName = "AvelquaAgentWatchdog",
  [string]$NssmServiceName = "AvelquaPythonAgent",
  [int]$WatchdogEveryMin = 5,
  [int]$MaxLogAgeMin = 8
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Msg) {
  Write-Host ""
  Write-Host "==> $Msg" -ForegroundColor Cyan
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "ERROR: pass -Token from Admin VPS page" -ForegroundColor Red
  exit 1
}

$Token = $Token.Trim().Trim('"').Trim("'")

Write-Step "Create folders"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$logsDir = Join-Path $AgentDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Set-Location -LiteralPath $AgentDir

Write-Step "Download agent files"
$files = @(
  "agent.py",
  "requirements.txt",
  "watchdog-agent.ps1",
  "install_interactive_agent_task.ps1",
  "install-agent-desktop-with-watchdog.ps1",
  "bootstrap-agent.ps1"
)
foreach ($name in $files) {
  $url = "$BaseUrl/$name"
  $dest = Join-Path $AgentDir $name
  Write-Host "  $url"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

Write-Step "Write .env"
$envPath = Join-Path $AgentDir ".env"
@"
AVELQUA_SERVER_URL=$ServerUrl
AVELQUA_AGENT_TOKEN=$Token
AVELQUA_MT5_ROOT=$Mt5Root
AVELQUA_AGENT_DIR=$AgentDir
AVELQUA_SERVICE_NAME=$NssmServiceName
"@ | Set-Content -LiteralPath $envPath -Encoding UTF8

Write-Step "Check Python"
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  Write-Host "ERROR: Python 3 not found. Install from https://www.python.org/downloads/" -ForegroundColor Red
  Write-Host "       Tick 'Add python.exe to PATH' then open a new PowerShell and run this script again." -ForegroundColor Yellow
  exit 1
}
Write-Host "  $python"

Write-Step "Install pip packages"
$requirements = Join-Path $AgentDir "requirements.txt"
if (Test-Path -LiteralPath $requirements) {
  & $python -m pip install -q -r $requirements
}

Write-Step "Disable old NSSM service (if any)"
try { net stop $NssmServiceName 2>$null | Out-Null } catch {}
try { sc.exe config $NssmServiceName start= disabled 2>$null | Out-Null } catch {}

Write-Step "Stop old agent processes"
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like "*$AgentDir*agent.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Step "Register Desktop Agent scheduled task"
$agentPy = Join-Path $AgentDir "agent.py"
try { schtasks /Delete /TN $AgentTaskName /F 2>$null | Out-Null } catch {}

$Action = New-ScheduledTaskAction -Execute $python -Argument "`"$agentPy`"" -WorkingDirectory $AgentDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $AgentTaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $AgentTaskName

Write-Step "Register Watchdog scheduled task"
$watchdogPath = Join-Path $AgentDir "watchdog-agent.ps1"
try { schtasks /Delete /TN $WatchdogTaskName /F 2>$null | Out-Null } catch {}

$watchdogCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`" -AgentDir `"$AgentDir`" -TaskName `"$AgentTaskName`" -MaxLogAgeMin $MaxLogAgeMin"
schtasks /Create /TN $WatchdogTaskName /TR $watchdogCmd /SC MINUTE /MO $WatchdogEveryMin /RU $env:USERNAME /RL HIGHEST /F | Out-Null
schtasks /Run /TN $WatchdogTaskName 2>$null | Out-Null

Write-Step "Wait for agent log"
Start-Sleep -Seconds 8
$agentLog = Join-Path $AgentDir "agent.log"
$agentLogAlt = Join-Path $logsDir "agent.log"
$logPath = if (Test-Path -LiteralPath $agentLog) { $agentLog } elseif (Test-Path -LiteralPath $agentLogAlt) { $agentLogAlt } else { $agentLog }

Write-Host ""
Write-Host "OK: Installation complete" -ForegroundColor Green
Write-Host "  Agent dir : $AgentDir"
Write-Host "  Task      : $AgentTaskName"
Write-Host "  Watchdog  : $WatchdogTaskName (every ${WatchdogEveryMin}m)"
Write-Host "  User      : $env:USERNAME (keep RDP session logged in)"
Write-Host "  Log       : $logPath"
Write-Host ""
Write-Host "Verify:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName '$AgentTaskName','$WatchdogTaskName'"
Write-Host "  Get-Content '$logPath' -Tail 20"
Write-Host ""
if (Test-Path -LiteralPath $logPath) {
  Get-Content -LiteralPath $logPath -Tail 8
} else {
  Write-Host "Log not created yet - wait 30s and run Get-Content again" -ForegroundColor Yellow
}
