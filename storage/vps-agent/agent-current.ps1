# Avelqua Windows VPS Agent
# Fixed disconnect: 2026-04-29
# Path: C:\avelqua-windows-agent\agent.ps1

$SERVER_URL = "https://trading.avelqua.com/api/vps-agent"
$TOKEN = "8ce95f3f3061a2772c4a1b51f870613ce3983bd4e0f4d4ffa2ebe8f9db56a642"
$SERVICE_NAME = "AvelquaAgent"
$AGENT_DIR = "C:\avelqua-windows-agent"
$STOP_FLAG = Join-Path $AGENT_DIR "agent.disabled"
$LOG_DIR = Join-Path $AGENT_DIR "logs"
$LOG_FILE = Join-Path $LOG_DIR "agent.log"
$MAX_LOG_DAYS = 10

$script:AgentShouldExit = $false

if (!(Test-Path $AGENT_DIR)) { New-Item -ItemType Directory -Force -Path $AGENT_DIR | Out-Null }
if (!(Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null }

function Write-AgentLog {
    param([string]$Message)
    try {
        Add-Content -Path $LOG_FILE -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $Message" -Encoding UTF8
    } catch {}
}

function Invoke-AgentApi {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        $Body = $null
    )

    $headers = @{ "x-agent-token" = $TOKEN; "Accept" = "application/json" }

    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20
        return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -Body $json -ContentType "application/json" -TimeoutSec 20
    }

    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -TimeoutSec 20
}

function Clear-OldLogs {
    try {
        Get-ChildItem -Path $LOG_DIR -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MAX_LOG_DAYS) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {}
}

function Get-Metrics {
    $cpu = 0
    $ram = 0
    $ping = 0
    $down = 0
    $up = 0
    $lastError = ""

    try {
        $rx = (Get-Counter '\Network Interface(*)\Bytes Received/sec' -ErrorAction Stop).CounterSamples |
            Where-Object { $_.InstanceName -notmatch 'Loopback|isatap|Teredo|Bluetooth|Pseudo' } |
            Measure-Object CookedValue -Sum

        $tx = (Get-Counter '\Network Interface(*)\Bytes Sent/sec' -ErrorAction Stop).CounterSamples |
            Where-Object { $_.InstanceName -notmatch 'Loopback|isatap|Teredo|Bluetooth|Pseudo' } |
            Measure-Object CookedValue -Sum

        $down = ($rx.Sum * 8) / 1000000
        $up = ($tx.Sum * 8) / 1000000
    } catch { $lastError += "NET: $($_.Exception.Message); " }

    try {
        $cpu = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
    } catch { $lastError += "CPU: $($_.Exception.Message); " }

    try {
        $ramObj = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $ram = (($ramObj.TotalVisibleMemorySize - $ramObj.FreePhysicalMemory) / $ramObj.TotalVisibleMemorySize) * 100
    } catch { $lastError += "RAM: $($_.Exception.Message); " }

    try {
        $p = Test-Connection trading.avelqua.com -Count 1 -ErrorAction Stop
        $ping = ($p | Select-Object -First 1).ResponseTime
    } catch { $lastError += "PING: $($_.Exception.Message); " }

    return @{
        status = "online"
        cpu_percent = [math]::Round([double]$cpu, 2)
        ram_percent = [math]::Round([double]$ram, 2)
        ping_ms = [math]::Round([double]$ping, 2)
        net_down_mbps = [math]::Round([double]$down, 2)
        net_up_mbps = [math]::Round([double]$up, 2)
        service_name = $SERVICE_NAME
        computer_name = $env:COMPUTERNAME
        last_error = $lastError.Trim()
    }
}

function Send-Heartbeat {
    try {
        $body = Get-Metrics
        Write-AgentLog "SEND HEARTBEAT CPU=$($body.cpu_percent)% RAM=$($body.ram_percent)% PING=$($body.ping_ms)ms DOWN=$($body.net_down_mbps)Mbps UP=$($body.net_up_mbps)Mbps"
        Invoke-AgentApi -Uri "$SERVER_URL/heartbeat" -Method "POST" -Body $body | Out-Null
        return $true
    } catch {
        Write-AgentLog "HEARTBEAT ERROR: $($_.Exception.Message)"
        return $false
    }
}

function Send-OfflineHeartbeat {
    try {
        $body = @{
            status = "offline"
            cpu_percent = 0
            ram_percent = 0
            ping_ms = 0
            net_down_mbps = 0
            net_up_mbps = 0
            service_name = $SERVICE_NAME
            computer_name = $env:COMPUTERNAME
            last_error = "Agent disconnected by admin"
        }

        Invoke-AgentApi -Uri "$SERVER_URL/heartbeat" -Method "POST" -Body $body | Out-Null
        Write-AgentLog "SEND OFFLINE HEARTBEAT"
    } catch {
        Write-AgentLog "OFFLINE HEARTBEAT ERROR: $($_.Exception.Message)"
    }
}

function Send-CommandResult {
    param(
        [int]$Id,
        [bool]$Ok,
        $Result,
        [string]$ErrorMsg = ""
    )

    try {
        $payload = @{
            ok = $Ok
            result = $Result
            error = $ErrorMsg
        }

        Invoke-AgentApi -Uri "$SERVER_URL/commands/$Id/result" -Method "POST" -Body $payload | Out-Null
        Write-AgentLog "RESULT SENT CommandID=$Id Ok=$Ok"
    } catch {
        Write-AgentLog "RESULT ERROR CommandID=$Id : $($_.Exception.Message)"
    }
}

function Get-ServiceInfo {
    $svc = Get-Service -Name $SERVICE_NAME -ErrorAction SilentlyContinue

    if (!$svc) {
        return @{ service_name = $SERVICE_NAME; status = "NotFound"; message = "ไม่พบ Service $SERVICE_NAME" }
    }

    return @{
        service_name = $SERVICE_NAME
        status = $svc.Status.ToString()
        can_stop = $svc.CanStop
        service_type = $svc.ServiceType.ToString()
        display_name = $svc.DisplayName
    }
}

function Get-AgentLogs {
    try {
        $lines = @()
        if (Test-Path $LOG_FILE) {
            $lines = Get-Content $LOG_FILE -Tail 80 -ErrorAction SilentlyContinue
        }

        return @{
            log_path = $LOG_FILE
            total_lines_returned = @($lines).Count
            content = (($lines | ForEach-Object { [string]$_ }) -join "`n")
        }
    } catch {
        return @{
            log_path = $LOG_FILE
            total_lines_returned = 0
            content = "GET LOG ERROR: $($_.Exception.Message)"
        }
    }
}

function Restart-AgentServiceSafe {
    param([int]$CommandId)

    Write-AgentLog "RESTART REQUEST CommandID=$CommandId"

    $taskName = "AvelquaAgentRestartOnce"
    $psFile = Join-Path $AGENT_DIR "restart-agent.ps1"

    $psContent = @"
Start-Sleep -Seconds 3
sc.exe stop AvelquaAgent
Start-Sleep -Seconds 5
sc.exe start AvelquaAgent
"@

    Set-Content -Path $psFile -Value $psContent -Encoding UTF8 -Force

    schtasks /Delete /TN $taskName /F | Out-Null 2>&1
    schtasks /Create /TN $taskName /SC ONCE /ST 23:59 /TR "powershell.exe -ExecutionPolicy Bypass -File `"$psFile`"" /RL HIGHEST /F | Out-Null
    schtasks /Run /TN $taskName | Out-Null

    $script:AgentShouldExit = $true

    return @{
        action = "restart_agent"
        status = "restart_scheduled"
        message = "Agent restart scheduled"
    }
}

function Stop-AgentServiceSafe {
    param([int]$CommandId)

    Write-AgentLog "DISCONNECT REQUEST CommandID=$CommandId"

    try {
        New-Item -ItemType File -Path $STOP_FLAG -Force | Out-Null
        Write-AgentLog "CREATE STOP FLAG: $STOP_FLAG"
    } catch {}

    Send-OfflineHeartbeat

    $taskName = "AvelquaAgentStopOnce"
    $psFile = Join-Path $AGENT_DIR "stop-agent.ps1"

    $psContent = @"
Start-Sleep -Seconds 2
sc.exe stop AvelquaAgent
"@

    Set-Content -Path $psFile -Value $psContent -Encoding UTF8 -Force

    schtasks /Delete /TN $taskName /F | Out-Null 2>&1
    schtasks /Create /TN $taskName /SC ONCE /ST 23:59 /TR "powershell.exe -ExecutionPolicy Bypass -File `"$psFile`"" /RL HIGHEST /F | Out-Null
    schtasks /Run /TN $taskName | Out-Null

    $script:AgentShouldExit = $true

    return @{
        action = "disconnect_agent"
        status = "disconnected"
        message = "ปิดการเชื่อมต่อ Agent แล้ว"
    }
}


function Handle-Command {
    param($cmd)

    try {
        $type = [string]$cmd.command_type
        Write-AgentLog "COMMAND RECEIVED ID=$($cmd.id) TYPE=$type PAYLOAD=$(($cmd.payload | ConvertTo-Json -Compress -Depth 10))"

        switch ($type) {
            "status" { Send-CommandResult $cmd.id $true (Get-ServiceInfo) "" }
            "service_status" { Send-CommandResult $cmd.id $true (Get-ServiceInfo) "" }
            "log" { Send-CommandResult $cmd.id $true (Get-AgentLogs) "" }
            "get_log" { Send-CommandResult $cmd.id $true (Get-AgentLogs) "" }
            "service_logs" { Send-CommandResult $cmd.id $true (Get-AgentLogs) "" }
            "service_log" { Send-CommandResult $cmd.id $true (Get-AgentLogs) "" }

            "restart_agent" {
                $result = Restart-AgentServiceSafe -CommandId $cmd.id
                Send-CommandResult $cmd.id $true $result ""
                return
            }

            "service_restart" {
                $result = Restart-AgentServiceSafe -CommandId $cmd.id
                Send-CommandResult $cmd.id $true $result ""
                return
            }

            "connect_agent" {
                Send-CommandResult $cmd.id $true @{ action="connect_agent"; status="connected"; message="Agent Service ทำงานอยู่" } ""
            }

            "disconnect_agent" {
                $result = Stop-AgentServiceSafe -CommandId $cmd.id
                Send-CommandResult $cmd.id $true $result ""
                return
            }

            "list_files" {
                $folder = [string]$cmd.payload.folder_path
                $files = @()
                if (Test-Path $folder) {
                    $files = Get-ChildItem $folder -Force -ErrorAction SilentlyContinue | Select-Object Name, FullName, Length, LastWriteTime, PSIsContainer
                }
                Send-CommandResult $cmd.id $true @{ folder_path=$folder; files=$files } ""
            }

            "read_file" {
                $path = [string]$cmd.payload.file_path
                $content = ""
                if (Test-Path $path) { $content = Get-Content $path -Raw -ErrorAction Stop }
                Send-CommandResult $cmd.id $true @{ file_path=$path; content=$content } ""
            }

            "write_file" {
                $path = [string]$cmd.payload.file_path
                $content = [string]$cmd.payload.content
                $parent = Split-Path $path -Parent
                if ($parent -and !(Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
                Set-Content -Path $path -Value $content -Encoding UTF8 -Force
                Send-CommandResult $cmd.id $true @{ file_path=$path; action="write_file" } ""
            }

            "delete_file" {
                $path = [string]$cmd.payload.file_path
                if (Test-Path $path) { Remove-Item $path -Force -Recurse -ErrorAction Stop }
                Send-CommandResult $cmd.id $true @{ file_path=$path; action="delete_file" } ""
            }

            "create_folder" {
                $folder = [string]$cmd.payload.folder_path
                New-Item -ItemType Directory -Force -Path $folder | Out-Null
                Send-CommandResult $cmd.id $true @{ folder_path=$folder; action="create_folder" } ""
            }

            "reset_mt5" {
                Get-Process terminal64 -ErrorAction SilentlyContinue | Stop-Process -Force
                Send-CommandResult $cmd.id $true @{ action="reset_mt5" } ""
            }

            "stop_mt5" {
                Get-Process terminal64 -ErrorAction SilentlyContinue | Stop-Process -Force
                Send-CommandResult $cmd.id $true @{ action="stop_mt5" } ""
            }

            "read_parameters" {
                $path = "C:\MT5_PORTS"
                $files = Get-ChildItem $path -Recurse -Filter "*.set" -ErrorAction SilentlyContinue
                Send-CommandResult $cmd.id $true @{ files=$files.FullName } ""
            }

            default {
                Send-CommandResult $cmd.id $false @{ command_type=$type } "Unknown command_type: $type"
            }
        }
    } catch {
        Write-AgentLog "COMMAND ERROR ID=$($cmd.id): $($_.Exception.Message)"
        Send-CommandResult $cmd.id $false @{} $_.Exception.Message
    }
}

Write-AgentLog "AGENT START Service=$SERVICE_NAME Computer=$env:COMPUTERNAME"
if (Test-Path $STOP_FLAG) {
    Write-AgentLog "AGENT DISABLED FLAG FOUND - WAIT CONNECT COMMAND"

    while (Test-Path $STOP_FLAG) {
        try {
            Write-AgentLog "DISABLED MODE CHECK COMMAND"
            $cmdRes = Invoke-AgentApi -Uri "$SERVER_URL/commands/next" -Method "GET"

            if ($cmdRes.command) {
                $cmd = $cmdRes.command
                $type = [string]$cmd.command_type

                if ($type -eq "connect_agent") {
                    Remove-Item $STOP_FLAG -Force -ErrorAction SilentlyContinue
                    Send-CommandResult $cmd.id $true @{
                        action = "connect_agent"
                        status = "connected"
                        message = "เปิดการเชื่อมต่อ Agent แล้ว"
                    } ""

                    Write-AgentLog "CONNECT COMMAND RECEIVED - REMOVE STOP FLAG"
                    break
                } else {
                    Send-CommandResult $cmd.id $false @{
                        action = $type
                        status = "ignored"
                    } "Agent ถูกปิดอยู่ กรุณากดเชื่อมต่อก่อน"
                }
            }
        } catch {
            Write-AgentLog "DISABLED MODE ERROR: $($_.Exception.Message)"
        }

        Start-Sleep -Seconds 5
    }
}

while (-not $script:AgentShouldExit) {
    Clear-OldLogs

    try {
        Send-Heartbeat | Out-Null
    } catch {
        Write-AgentLog "LOOP HEARTBEAT ERROR: $($_.Exception.Message)"
    }

    try {
        Write-AgentLog "CHECK COMMAND"
        $cmdRes = Invoke-AgentApi -Uri "$SERVER_URL/commands/next" -Method "GET"

        if ($cmdRes.command) {
            Handle-Command $cmdRes.command
            if ($script:AgentShouldExit) { break }
        } else {
            Write-AgentLog "NO COMMAND"
        }
    } catch {
        Write-AgentLog "COMMAND CHECK ERROR: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds 5
}