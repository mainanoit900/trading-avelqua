# One-click bootstrap: download all agent files + install Desktop Task + Watchdog
# Run (PowerShell Admin):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\avelqua-python-agent\bootstrap-agent.ps1 -Token "YOUR_TOKEN"

param(
  [Parameter(Mandatory = $true)]
  [string]$Token,
  [string]$AgentDir = "C:\avelqua-python-agent",
  [string]$BaseUrl = "https://trading.avelqua.com/agent"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "logs") | Out-Null
Set-Location $AgentDir

$files = @(
  "install-agent-desktop-with-watchdog.ps1",
  "install_interactive_agent_task.ps1",
  "watchdog-agent.ps1",
  "agent.py",
  "requirements.txt"
)

foreach ($name in $files) {
  $url = "$BaseUrl/$name"
  $dest = Join-Path $AgentDir $name
  Write-Host "Download: $url"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

Write-Host ""
Write-Host "Run installer..."
$installer = Join-Path $AgentDir "install-agent-desktop-with-watchdog.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Token $Token -AgentDir $AgentDir
