# Run Avelqua Python Agent as Desktop User (recommended for MT5 GUI)
# Run this in Administrator PowerShell while logged in as the Windows user that should run MT5.

$TaskName = "AvelquaPythonAgentDesktop"
$AgentDir = "C:\avelqua-python-agent"
$PythonExe = "python.exe"
$AgentFile = "C:\avelqua-python-agent\agent.py"

# Stop old NSSM service to avoid duplicate polling/opening MT5
try { net stop AvelquaPythonAgent } catch {}

# Remove old task if exists
try { schtasks /Delete /TN $TaskName /F | Out-Null } catch {}

$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument $AgentFile -WorkingDirectory $AgentDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force
Start-ScheduledTask -TaskName $TaskName

Write-Host "OK: Started $TaskName as Desktop User: $env:USERNAME"
Write-Host "Check log: C:\avelqua-python-agent\logs\agent.log"
