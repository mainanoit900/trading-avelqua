# Run PowerShell as Administrator
# Example:
# powershell -ExecutionPolicy Bypass -File .\install-python-agent-windows.ps1 -Token "YOUR_AGENT_TOKEN"

param(
  [string]$Token = "",
  [string]$ServerUrl = "https://trading.avelqua.com/api/vps-agent",
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$ServiceName = "AvelquaPythonAgent",
  [string]$NssmPath = "C:\avelqua-windows-agent\nssm-2.24\win64\nssm.exe"
)

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Host "ERROR: กรุณาใส่ -Token จากหน้า Admin VPS" -ForegroundColor Red
  exit 1
}

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path "$AgentDir\logs" | Out-Null

Copy-Item -Force "$PSScriptRoot\agent.py" "$AgentDir\agent.py"
Copy-Item -Force "$PSScriptRoot\requirements.txt" "$AgentDir\requirements.txt"

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) {
  Write-Host "ERROR: ไม่พบ Python ให้ติดตั้ง Python 3 ก่อน แล้วติ๊ก Add python.exe to PATH" -ForegroundColor Red
  exit 1
}

& $python -m pip install --upgrade pip
& $python -m pip install -r "$AgentDir\requirements.txt"

if (!(Test-Path $NssmPath)) {
  Write-Host "ERROR: ไม่พบ nssm.exe ที่ $NssmPath" -ForegroundColor Red
  Write-Host "แก้ -NssmPath ให้ตรง หรือวาง nssm ไว้ตาม path นี้"
  exit 1
}

# remove old Python service if exists
& $NssmPath stop $ServiceName 2>$null | Out-Null
& $NssmPath remove $ServiceName confirm 2>$null | Out-Null

& $NssmPath install $ServiceName $python "$AgentDir\agent.py"
& $NssmPath set $ServiceName AppDirectory $AgentDir
& $NssmPath set $ServiceName AppStdout "$AgentDir\logs\service-out.log"
& $NssmPath set $ServiceName AppStderr "$AgentDir\logs\service-err.log"
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateOnline 1
& $NssmPath set $ServiceName AppRotateBytes 1048576
& $NssmPath set $ServiceName AppEnvironmentExtra `
  "AVELQUA_SERVER_URL=$ServerUrl" `
  "AVELQUA_AGENT_TOKEN=$Token" `
  "AVELQUA_SERVICE_NAME=$ServiceName" `
  "AVELQUA_AGENT_DIR=$AgentDir" `
  "AVELQUA_MT5_ROOT=C:\MT5_PORTS"

& $NssmPath start $ServiceName
Write-Host "OK: Python Agent installed and started: $ServiceName" -ForegroundColor Green
Write-Host "Log: $AgentDir\logs\agent.log"
