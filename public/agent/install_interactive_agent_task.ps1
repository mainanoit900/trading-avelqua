# Desktop Agent Task (MT5 + BOT) - no NSSM Session 0
# powershell -ExecutionPolicy Bypass -File C:\avelqua-python-agent\install_interactive_agent_task.ps1 -Token "YOUR_TOKEN"

param(
  [Parameter(Mandatory = $false)]
  [string]$Token = "",
  [string]$ServerUrl = "https://trading.avelqua.com/api/vps-agent",
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$Mt5Root = "C:\MT5_PORTS",
  [string]$TaskName = "AvelquaPythonAgentDesktop",
  [string]$NssmServiceName = "AvelquaPythonAgent"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AgentDir)) {
  $AgentDir = "C:\avelqua-python-agent"
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  $envFile = Join-Path $AgentDir ".env"
  if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
      if ($_ -match '^\s*AVELQUA_AGENT_TOKEN\s*=\s*(.+)\s*$') { $Token = $Matches[1].Trim().Trim('"') }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "ERROR: pass -Token or set AVELQUA_AGENT_TOKEN in $AgentDir\.env" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$logsDir = Join-Path $AgentDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$agentPy = Join-Path $AgentDir "agent.py"
if (-not (Test-Path -LiteralPath $agentPy)) {
  Write-Host "ERROR: missing $agentPy - download agent.py first" -ForegroundColor Red
  exit 1
}

$envPath = Join-Path $AgentDir ".env"
@"
AVELQUA_SERVER_URL=$ServerUrl
AVELQUA_AGENT_TOKEN=$Token
AVELQUA_MT5_ROOT=$Mt5Root
AVELQUA_AGENT_DIR=$AgentDir
AVELQUA_SERVICE_NAME=$NssmServiceName
"@ | Set-Content -LiteralPath $envPath -Encoding UTF8

try { net stop $NssmServiceName 2>$null | Out-Null } catch {}
try { sc.exe config $NssmServiceName start= disabled 2>$null | Out-Null } catch {}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  Write-Host "ERROR: python not found - install Python 3 and add to PATH" -ForegroundColor Red
  exit 1
}

$requirements = Join-Path $AgentDir "requirements.txt"
if (Test-Path -LiteralPath $requirements) {
  & $python -m pip install -q -r $requirements
}

Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like "*$AgentDir*agent.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

try { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null } catch {}

$Action = New-ScheduledTaskAction -Execute $python -Argument "`"$agentPy`"" -WorkingDirectory $AgentDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "OK: Agent Desktop Task installed" -ForegroundColor Green
Write-Host "  Task: $TaskName"
Write-Host "  User: $env:USERNAME (keep RDP logged in - disconnect OK, no Sign out)"
$agentLog = Join-Path $logsDir "agent.log"
Write-Host "  Log:  $agentLog"
