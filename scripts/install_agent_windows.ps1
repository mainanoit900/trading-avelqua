# Run PowerShell as Administrator
$AgentDir = "C:\avelqua-python-agent"
$ServiceName = "AvelquaPythonAgent"
$ServerUrl = "https://trading.avelqua.com"
$AgentToken = "avelqua-vps-2026"
$Mt5Root = "C:\MT5_PORTS"

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path "$AgentDir\logs" | Out-Null
Copy-Item -Force ".\public\agent\agent_pro_startupini.py" "$AgentDir\agent.py"
Copy-Item -Force ".\public\agent\requirements.txt" "$AgentDir\requirements.txt"

py -m pip install -r "$AgentDir\requirements.txt"

# NSSM must be installed and in PATH. If already installed, this updates env and restarts.
$nssm = "nssm"
& $nssm stop $ServiceName 2>$null
& $nssm remove $ServiceName confirm 2>$null
& $nssm install $ServiceName "py" "$AgentDir\agent.py"
& $nssm set $ServiceName AppDirectory $AgentDir
& $nssm set $ServiceName AppEnvironmentExtra "AVELQUA_SERVER_URL=$ServerUrl" "AVELQUA_AGENT_TOKEN=$AgentToken" "AVELQUA_MT5_ROOT=$Mt5Root"
& $nssm set $ServiceName AppStdout "$AgentDir\logs\agent.log"
& $nssm set $ServiceName AppStderr "$AgentDir\logs\agent-error.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateOnline 1
& $nssm set $ServiceName AppRestartDelay 3000
& $nssm start $ServiceName

Write-Host "DONE: $ServiceName started"
Write-Host "Log: Get-Content C:\avelqua-python-agent\logs\agent.log -Tail 80 -Wait"
