# รัน Agent แบบ Desktop User (แนะนำสำหรับ MT5 + BOT) — ไม่ใช้ NSSM Session 0
# PowerShell แบบ Administrator ขณะ login RDP เป็น user ที่ใช้ MT5
#
# ตัวอย่าง:
#   powershell -ExecutionPolicy Bypass -File .\install_interactive_agent_task.ps1 -Token "YOUR_TOKEN"

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

if ([string]::IsNullOrWhiteSpace($Token)) {
  $envFile = Join-Path $AgentDir ".env"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^\s*AVELQUA_AGENT_TOKEN\s*=\s*(.+)\s*$') { $Token = $Matches[1].Trim().Trim('"') }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "ERROR: ใส่ -Token หรือสร้าง $AgentDir\.env ที่มี AVELQUA_AGENT_TOKEN" -ForegroundColor Red
  exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $scriptDir "agent.py")) {
  New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
  New-Item -ItemType Directory -Force -Path "$AgentDir\logs" | Out-Null
  Copy-Item -Force (Join-Path $scriptDir "agent.py") (Join-Path $AgentDir "agent.py")
  if (Test-Path (Join-Path $scriptDir "requirements.txt")) {
    Copy-Item -Force (Join-Path $scriptDir "requirements.txt") (Join-Path $AgentDir "requirements.txt")
  }
  Copy-Item -Force $MyInvocation.MyCommand.Path (Join-Path $AgentDir "install_interactive_agent_task.ps1")
  if (Test-Path (Join-Path $scriptDir "watchdog-agent.ps1")) {
    Copy-Item -Force (Join-Path $scriptDir "watchdog-agent.ps1") (Join-Path $AgentDir "watchdog-agent.ps1")
  }
  if (Test-Path (Join-Path $scriptDir "install-agent-desktop-with-watchdog.ps1")) {
    Copy-Item -Force (Join-Path $scriptDir "install-agent-desktop-with-watchdog.ps1") (Join-Path $AgentDir "install-agent-desktop-with-watchdog.ps1")
  }
}

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path "$AgentDir\logs" | Out-Null

$envPath = Join-Path $AgentDir ".env"
@"
AVELQUA_SERVER_URL=$ServerUrl
AVELQUA_AGENT_TOKEN=$Token
AVELQUA_MT5_ROOT=$Mt5Root
AVELQUA_AGENT_DIR=$AgentDir
AVELQUA_SERVICE_NAME=$NssmServiceName
"@ | Set-Content -Path $envPath -Encoding UTF8

# หยุด NSSM — อย่ารันซ้ำกับ Task
try { net stop $NssmServiceName 2>$null | Out-Null } catch {}
try { sc.exe config $NssmServiceName start= disabled 2>$null | Out-Null } catch {}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  Write-Host "ERROR: ไม่พบ python — ติดตั้ง Python 3 และ Add to PATH" -ForegroundColor Red
  exit 1
}

if (Test-Path (Join-Path $AgentDir "requirements.txt")) {
  & $python -m pip install -q -r (Join-Path $AgentDir "requirements.txt")
}

# หยุด agent python เก่า
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like "*$AgentDir*agent.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

try { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null } catch {}

$Action = New-ScheduledTaskAction -Execute $python -Argument "`"$AgentDir\agent.py`"" -WorkingDirectory $AgentDir
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
Write-Host "  User: $env:USERNAME (keep RDP session logged in — disconnect OK, do not Sign out)"
$agentLog = Join-Path $AgentDir "logs\agent.log"
Write-Host "  Log:  $agentLog"
Write-Host ""
Write-Host "Optional: run install-agent-desktop-with-watchdog.ps1 for auto-restart watchdog" -ForegroundColor Yellow
