# Avelqua Python Windows VPS Agent
# Path: C:\avelqua-python-agent\agent.py
# Works with existing Node web endpoints: /api/vps-agent/* and /app/mt5/connect-result

import ctypes
import glob
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

def load_env_file(path):
    try:
        if not path.exists():
            return
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k and v and not os.getenv(k):
                os.environ[k.strip()] = v.strip()
    except Exception:
        pass

load_env_file(Path(r"C:\avelqua-python-agent\.env"))

import requests

try:
    import psutil
except Exception:
    psutil = None

SERVER_URL = os.getenv("AVELQUA_SERVER_URL", "https://trading.avelqua.com/api/vps-agent").rstrip("/")
AGENT_TOKEN = os.getenv("AVELQUA_AGENT_TOKEN", "PUT_YOUR_AGENT_TOKEN_HERE")
SERVICE_NAME = os.getenv("AVELQUA_SERVICE_NAME", "AvelquaPythonAgent")
AGENT_DIR = Path(os.getenv("AVELQUA_AGENT_DIR", r"C:\avelqua-python-agent"))
MT5_ROOT = Path(os.getenv("AVELQUA_MT5_ROOT", r"C:\MT5_PORTS"))
LOG_DIR = AGENT_DIR / "logs"
LOG_FILE = LOG_DIR / "agent.log"
STOP_FLAG = AGENT_DIR / "agent.disabled"
MAX_LOG_DAYS = int(os.getenv("AVELQUA_MAX_LOG_DAYS", "10"))
LOOP_SECONDS = int(os.getenv("AVELQUA_LOOP_SECONDS", "3"))
CONNECT_TIMEOUT_SECONDS = int(os.getenv("AVELQUA_CONNECT_TIMEOUT_SECONDS", "90"))
DEFAULT_CALLBACK_URL = os.getenv("AVELQUA_CONNECT_CALLBACK", "https://trading.avelqua.com/app/mt5/connect-result")

AGENT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str):
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} - {msg}\n")
    except Exception:
        pass


def api(method: str, path_or_url: str, body=None, timeout=25):
    url = path_or_url if path_or_url.startswith("http") else f"{SERVER_URL}{path_or_url}"
    headers = {"x-agent-token": AGENT_TOKEN, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
        r = requests.request(method, url, headers=headers, json=body, timeout=timeout)
    else:
        r = requests.request(method, url, headers=headers, timeout=timeout)
    r.raise_for_status()
    if not r.text:
        return {}
    return r.json()


def clean_old_logs():
    cutoff = time.time() - MAX_LOG_DAYS * 86400
    try:
        for p in LOG_DIR.glob("*"):
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
    except Exception as e:
        log(f"CLEAR OLD LOG ERROR: {e}")


def metrics():
    cpu = ram = ping = 0
    err = ""
    try:
        if psutil:
            cpu = float(psutil.cpu_percent(interval=0.2))
            ram = float(psutil.virtual_memory().percent)
        else:
            cpu = 0
            ram = 0
        # lightweight ping to Google DNS; failure does not stop agent
        try:
            cmd = ["ping", "-n", "1", "8.8.8.8"] if os.name == "nt" else ["ping", "-c", "1", "8.8.8.8"]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=4).stdout
            m = re.search(r"time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms", out, re.I)
            if m:
                ping = float(m.group(1))
        except Exception:
            ping = 0
    except Exception as e:
        err = str(e)
    return {
        "status": "online",
        "cpu_percent": cpu,
        "ram_percent": ram,
        "ping_ms": ping,
        "net_down_mbps": 0,
        "net_up_mbps": 0,
        "service_name": SERVICE_NAME,
        "computer_name": platform.node(),
        "agent_type": "python",
        "agent_version": "2026-05-04",
        "last_error": err,
    }


def send_heartbeat(status="online", last_error=""):
    body = metrics()
    body["status"] = status
    if last_error:
        body["last_error"] = last_error
    try:
        res = api("POST", "/heartbeat", body)
        log(f"HEARTBEAT status={body['status']} agent_enabled={res.get('agent_enabled')}")
        return res
    except Exception as e:
        log(f"HEARTBEAT ERROR: {e}")
        return None


def command_result(cmd_id, ok=True, result=None, error=""):
    try:
        api("POST", f"/commands/{cmd_id}/result", {"ok": ok, "result": result or {}, "error": error})
        log(f"RESULT SENT CommandID={cmd_id} Ok={ok}")
    except Exception as e:
        log(f"RESULT ERROR CommandID={cmd_id}: {e}")


def payload_get(payload, *names, default=""):
    payload = payload or {}
    for name in names:
        v = payload.get(name)
        if v is not None and str(v).strip() != "":
            return str(v)
    return default


def normalize_port(port: str) -> int:
    s = str(port or "")
    n = int(re.sub(r"[^0-9]", "", s) or "0")
    if n > 20:
        n = n % 100
    if n <= 0:
        raise RuntimeError(f"invalid port: {port}")
    return n


def resolve_mt5_port_dir(port, payload=None) -> Path:
    payload = payload or {}
    folder = payload_get(payload, "vpsFolderPath", "folder_path", "path")
    if folder:
        p = Path(folder).expanduser()
        if str(p).lower().endswith(r"mql5\experts"):
            p = p.parent.parent
        if p.exists():
            return p
        raise RuntimeError(f"PORT folder not found. portDir={p}")

    name = payload_get(payload, "vpsPortName")
    if name:
        p = MT5_ROOT / name
        if p.exists():
            return p

    n = normalize_port(port)
    p2 = f"{n:02d}"
    candidates = [
        MT5_ROOT / f"VPS-WIN-01-PORT-{p2}",
        MT5_ROOT / f"VPS-WIN-01-PORT-{n}",
        MT5_ROOT / f"PORT{p2}",
        MT5_ROOT / f"PORT_{p2}",
        MT5_ROOT / f"PORT_{n}",
        MT5_ROOT / f"PORT{n}",
    ]
    for p in candidates:
        if p.exists():
            return p
    raise RuntimeError("PORT folder not found. Tried: " + ", ".join(map(str, candidates)))


def iter_terminal_processes():
    if psutil:
        for p in psutil.process_iter(["pid", "name", "exe", "cmdline"]):
            try:
                if (p.info.get("name") or "").lower() == "terminal64.exe":
                    yield p
            except Exception:
                continue
    else:
        return []


def stop_mt5_port_only(port, payload=None):
    port_dir = resolve_mt5_port_dir(port, payload)
    root = str(port_dir).rstrip("\\/").lower()
    stopped = []
    for p in list(iter_terminal_processes()):
        try:
            exe = (p.info.get("exe") or "").lower()
            cmd = " ".join(p.info.get("cmdline") or []).lower()
            if exe.startswith(root) or root in cmd:
                log(f"STOP MT5 PORT={port} PID={p.pid} PATH={exe}")
                p.kill()
                stopped.append(p.pid)
        except Exception as e:
            log(f"STOP PROCESS ERROR PID={getattr(p, 'pid', '')}: {e}")
    time.sleep(1)
    return {"action": "stop_mt5", "port": port, "port_dir": str(port_dir), "stopped": stopped}


def latest_log_text(port_dir: Path):
    log_dirs = [port_dir / "logs", port_dir / "MQL5" / "Logs"]
    files = []
    for d in log_dirs:
        if d.exists():
            files.extend(d.rglob("*.log"))
    if not files:
        return None, ""
    latest = max(files, key=lambda x: x.stat().st_mtime)
    try:
        data = latest.read_text(errors="ignore")
        return latest, "\n".join(data.splitlines()[-300:])
    except Exception:
        return latest, ""


def clear_mt5_logs(port_dir: Path):
    for d in [port_dir / "logs", port_dir / "MQL5" / "Logs"]:
        if d.exists():
            for f in d.rglob("*.log"):
                try:
                    f.unlink()
                except Exception:
                    pass


def send_connect_result(payload, status, message, port=""):
    try:
        callback = payload_get(payload, "callbackUrl", default=DEFAULT_CALLBACK_URL)
        port = str(port or payload_get(payload, "port", "portNumber", "vpsPortNumber"))
        port_slot = payload_get(payload, "portSlot")
        try:
            port_num = int(re.sub(r"[^0-9]", "", port) or "0")
            if port_num > 20 and port_slot:
                port = port_slot
        except Exception:
            pass
        body = {
            "nodeId": payload_get(payload, "nodeId"),
            "userId": payload_get(payload, "userId"),
            "portSlot": port_slot,
            "portNumber": port,
            "mt5Login": payload_get(payload, "mt5Login", "login"),
            "mt5Password": payload_get(payload, "mt5Password", "password"),
            "serverName": payload_get(payload, "serverName", default="MohicansMarkets-Live"),
            "status": status,
            "message": message,
            "balance": None,
            "equity": None,
            "accountCurrency": "",
            "loginVerified": status == "connected",
        }
        if status == "connected" and port:
            snap = account_snapshot(port, payload)
            body["balance"] = snap.get("balance")
            body["equity"] = snap.get("equity")
            body["accountCurrency"] = snap.get("currency", "")
        api("POST", callback, body)
        log(f"CONNECT CALLBACK SENT status={status} userId={body['userId']} portSlot={port_slot} login={body['mt5Login']} port={port}")
    except Exception as e:
        log(f"CONNECT CALLBACK ERROR: {e}")


def start_mt5_bot(payload):
    port = payload_get(payload, "port", "portNumber", "vpsPortNumber", "folderPort")
    login = payload_get(payload, "mt5Login", "login")
    password = payload_get(payload, "mt5Password", "password")
    server = payload_get(payload, "serverName", default="MohicansMarkets-Live")
    bot = payload_get(payload, "botCode", default="LOGIN_ONLY")
    if not port:
        raise RuntimeError("payload.port is required")
    if not login:
        raise RuntimeError("payload.mt5Login is required")
    if not password:
        raise RuntimeError("payload.mt5Password is required")

    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    config_file = port_dir / "avelqua-login.ini"
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    log(f"USING PORT DIR={port_dir}")
    log(f"MT5 TERMINAL={terminal}")

    ini = f"""[Common]
Login={login}
Password={password}
Server={server}
AutoConfiguration=false

[Experts]
AllowLiveTrading=true
AllowDllImport=true
Enabled=true
"""
    config_file.write_text(ini, encoding="ascii")
    log(f"CREATE INI: {config_file} LOGIN={login} SERVER={server}")

    try:
        stop_mt5_port_only(port, payload)
    except Exception as e:
        log(f"STOP OLD MT5 ERROR: {e}")

    clear_mt5_logs(port_dir)
    args = [str(terminal), "/portable", f"/config:{config_file}"]
    log(f"START MT5 args={args} cwd={port_dir}")
    subprocess.Popen(args, cwd=str(port_dir), close_fds=True)

    deadline = time.time() + CONNECT_TIMEOUT_SECONDS
    latest = None
    text = ""
    failed_rx = re.compile(r"authorization failed|invalid account|invalid password|login failed|failed authorization|account disabled|no connection|connection failed|not authorized|trade account .*? disabled", re.I)
    ok_rx = re.compile(r"authorized\s+on|previous successful authorization|startup successfully initialized|terminal synchronized|trading has been enabled", re.I)

    while time.time() < deadline:
        time.sleep(3)
        latest, text = latest_log_text(port_dir)
        if latest:
            log(f"MT5 CHECK LOG={latest}")
            if failed_rx.search(text):
                try:
                    stop_mt5_port_only(port, payload)
                except Exception:
                    pass
                send_connect_result(payload, "failed", "MT5 login failed: invalid login/password/server", port)
                raise RuntimeError("MT5 login failed: invalid login/password/server")
            if ok_rx.search(text):
                send_connect_result(payload, "connected", "MT5 login success", port)
                log(f"RUN_MT5_BOT LOGIN VERIFIED PORT={port} LOGIN={login} SERVER={server} BOT={bot}")
                return {"action": "run_mt5_bot", "status": "started", "port": port, "login": login, "server": server, "bot": bot, "config": str(config_file), "terminal": str(terminal)}

    if latest:
        log(f"MT5 LATEST LOG={latest}")
        log(f"MT5 LOG TAIL={text[-2000:]}")
    else:
        log("MT5 LOG NOT FOUND")
    try:
        stop_mt5_port_only(port, payload)
    except Exception:
        pass
    send_connect_result(payload, "failed", "MT5 login timeout: no authorization result", port)
    raise RuntimeError("MT5 login timeout: no authorization result")


def list_files(payload):
    folder = Path(payload_get(payload, "folder_path", default=str(AGENT_DIR)))
    items = []
    if folder.exists():
        for p in folder.iterdir():
            items.append({"Name": p.name, "FullName": str(p), "Length": p.stat().st_size if p.is_file() else 0, "PSIsContainer": p.is_dir()})
    return {"folder_path": str(folder), "files": items}



def account_snapshot(port, payload=None):
    snap = {"balance": None, "equity": None, "currency": ""}
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        latest, text = latest_log_text(port_dir)
        if text:
            mb = re.search(r"(?i)balance\s*[:= ]\s*([0-9]+(?:\.[0-9]+)?)", text)
            me = re.search(r"(?i)equity\s*[:= ]\s*([0-9]+(?:\.[0-9]+)?)", text)
            if mb: snap["balance"] = float(mb.group(1))
            if me: snap["equity"] = float(me.group(1))
            log(f"MT5 SNAPSHOT PORT={port} BALANCE={snap['balance']} EQUITY={snap['equity']} LOG={latest}")
    except Exception as e:
        log(f"MT5 SNAPSHOT ERROR PORT={port}: {e}")
    return snap


def mt5_port_processes(port, payload=None):
    port_dir = resolve_mt5_port_dir(port, payload)
    root = str(port_dir).rstrip("\\/").lower()
    out = []
    for p in list(iter_terminal_processes()):
        try:
            exe = (p.info.get("exe") or "").lower()
            cmd = " ".join(p.info.get("cmdline") or []).lower()
            if exe.startswith(root) or root in cmd:
                out.append(p)
        except Exception:
            pass
    return out


def mt5_port_status_one(port, payload=None):
    port_dir = resolve_mt5_port_dir(port, payload)
    n = normalize_port(port)
    procs = mt5_port_processes(port, payload)
    running = len(procs) > 0
    return {
        "port": n,
        "portNumber": n,
        "name": f"PORT{n:02d}",
        "path": str(port_dir),
        "running": running,
        "busy": running,
        "status": "full" if running else "free",
        "pid": [x.pid for x in procs],
    }


def mt5_ports_dashboard():
    ports = []
    used_lot = 0.0
    for i in range(1, 21):
        try:
            # prefer real folder names from Resolve logic
            port_dir = resolve_mt5_port_dir(str(i), {})
            procs = mt5_port_processes(str(i), {})
            running = len(procs) > 0
            lot = 0.0
            try:
                for set_file in (port_dir / "MQL5" / "Profiles").rglob("*.set"):
                    txt = set_file.read_text(errors="ignore")
                    m = re.search(r"(?im)^\s*(Lots|Lot|lot)\s*=\s*([0-9.]+)", txt)
                    if m:
                        lot = float(m.group(2)); break
            except Exception:
                pass
            snap = account_snapshot(str(i), {})
            used_lot += lot
            ports.append({
                "port": f"PORT{i:02d}", "portNumber": i, "path": str(port_dir),
                "running": running, "busy": running, "status": "full" if running else "free",
                "pid": [p.pid for p in procs], "lot": lot,
                "balance": snap.get("balance"), "equity": snap.get("equity"),
            })
        except Exception:
            port_dir = MT5_ROOT / f"PORT{i:02d}"
            ports.append({"port": f"PORT{i:02d}", "portNumber": i, "path": str(port_dir), "running": False, "busy": False, "status": "missing", "pid": [], "lot": 0, "balance": None, "equity": None})
    return {"action": "dashboard", "ports": ports, "used_ports": len([p for p in ports if p["running"]]), "used_lot": used_lot, "at": datetime.now().isoformat(timespec="seconds")}


def safe_port_file_path(payload):
    port = payload_get(payload, "port", "portNumber", "portSlot")
    file_path = payload_get(payload, "file_path", "path")
    if not file_path:
        raise RuntimeError("payload.file_path is required")
    port_dir = resolve_mt5_port_dir(port, payload)
    target = Path(file_path) if Path(file_path).is_absolute() else port_dir / file_path
    full = target.resolve()
    root = port_dir.resolve()
    if str(full).lower().find(str(root).lower()) != 0:
        raise RuntimeError(f"blocked path outside port folder: {full}")
    return port, port_dir, full


def port_list_files(payload):
    port = payload_get(payload, "port", "portNumber", "portSlot")
    sub = payload_get(payload, "path")
    port_dir = resolve_mt5_port_dir(port, payload)
    target = port_dir / sub if sub else port_dir
    if not target.exists():
        raise RuntimeError(f"folder not found: {target}")
    files = []
    for x in target.iterdir():
        files.append({"Name": x.name, "FullName": str(x), "Length": x.stat().st_size if x.is_file() else 0, "LastWriteTime": datetime.fromtimestamp(x.stat().st_mtime).isoformat(timespec="seconds"), "PSIsContainer": x.is_dir()})
    return {"action": "port_list_files", "port": port, "folder": str(target), "files": files}


def port_read_file(payload):
    port, _, full = safe_port_file_path(payload)
    if not full.exists():
        raise RuntimeError(f"file not found: {full}")
    return {"action": "port_read_file", "port": port, "file_path": str(full), "content": full.read_text(encoding="utf-8", errors="ignore")}


def port_write_file(payload):
    port, _, full = safe_port_file_path(payload)
    content = payload_get(payload, "content")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    return {"action": "port_write_file", "port": port, "file_path": str(full), "status": "saved"}


def port_delete_file(payload):
    port, _, full = safe_port_file_path(payload)
    if full.is_dir(): shutil.rmtree(full)
    elif full.exists(): full.unlink()
    return {"action": "port_delete_file", "port": port, "file_path": str(full), "status": "deleted"}


def open_mt5_port_folder(payload):
    port = payload_get(payload, "port", "portNumber", "portSlot")
    port_dir = resolve_mt5_port_dir(port, payload)
    subprocess.Popen(["explorer.exe", str(port_dir)], close_fds=True)
    return {"action": "port_open_folder", "port": port, "path": str(port_dir), "status": "opened"}


def restart_mt5_port(port, payload=None):
    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")
    stop_mt5_port_only(port, payload)
    time.sleep(2)
    subprocess.Popen([str(terminal), "/portable"], cwd=str(port_dir), close_fds=True)
    return {"action": "restart_mt5_bot", "port": port, "status": "running"}


def remove_mt5_port_folder_safe(port, payload=None):
    port_dir = resolve_mt5_port_dir(port, payload)
    stop_mt5_port_only(port, payload)
    time.sleep(1)
    shutil.rmtree(port_dir)
    return {"action": "delete_port", "port": port, "port_dir": str(port_dir), "status": "deleted"}


def send_mt5_live_status(instance_id, port, status, ea_status="", balance=0, equity=0, error_text=""):
    try:
        body = {"instanceId": instance_id, "port": port, "status": status, "eaStatus": ea_status, "balance": balance, "equity": equity, "errorText": error_text, "at": datetime.now().isoformat(timespec="seconds")}
        api("POST", "https://trading.avelqua.com/app/mt5/live-status", body)
        log(f"LIVE STATUS SENT PORT={port} STATUS={status} EA={ea_status}")
    except Exception as e:
        log(f"LIVE STATUS ERROR PORT={port}: {e}")


def watch_mt5_instance(payload):
    try:
        port = payload_get(payload, "port", "portNumber", "portSlot")
        if not port: return
        instance_id = payload_get(payload, "instanceId")
        st = mt5_port_status_one(port, payload)
        snap = account_snapshot(port, payload)
        send_mt5_live_status(instance_id, port, "running" if st["running"] else "stopped", st["status"], float(snap.get("balance") or 0), float(snap.get("equity") or 0), "")
    except Exception as e:
        log(f"WATCH INSTANCE ERROR: {e}")


def poll_running_mt5_list():
    try:
        running = api("GET", "https://trading.avelqua.com/app/mt5/agent-running-list")
        if running.get("ok") is True:
            for item in running.get("items", []):
                watch_mt5_instance(item)
    except Exception as e:
        log(f"WATCH MT5 ERROR: {e}")


def handle_command(cmd):
    cmd_id = cmd.get("id")
    ctype = str(cmd.get("command_type") or "").lower()
    payload = cmd.get("payload") or {}
    log(f"COMMAND RECEIVED ID={cmd_id} TYPE={ctype} PAYLOAD={json.dumps(payload, ensure_ascii=False)}")
    try:
        if ctype in ("status", "service_status"):
            command_result(cmd_id, True, {"service_name": SERVICE_NAME, "status": "Running", "agent_type": "python"})
        elif ctype in ("log", "get_log", "service_logs", "service_log"):
            lines = []
            if LOG_FILE.exists():
                lines = LOG_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()[-120:]
            command_result(cmd_id, True, {"log_file": str(LOG_FILE), "lines": lines})

        elif ctype in ("update_agent_script", "update_python_agent"):
            agent_path = Path(payload_get(payload, "agent_path", default=str(AGENT_DIR / "agent.py")))
            content = payload_get(payload, "content")
            service_name = payload_get(payload, "service_name", default=SERVICE_NAME)

            if not content.strip():
                raise RuntimeError("payload.content is required")

            backup = agent_path.with_suffix(agent_path.suffix + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))

            if agent_path.exists():
                shutil.copy2(agent_path, backup)

            agent_path.write_text(content, encoding="utf-8")

            command_result(cmd_id, True, {
                "action": "update_agent_script",
                "agent_path": str(agent_path),
                "backup": str(backup),
                "service_name": service_name
            })

            log(f"PYTHON AGENT UPDATED path={agent_path} backup={backup}")

            subprocess.Popen(
                ["powershell", "-ExecutionPolicy", "Bypass", "-Command", f"Restart-Service {service_name}"],
                close_fds=True
            )
            return

        elif ctype == "connect_agent":
            STOP_FLAG.unlink(missing_ok=True)
            command_result(cmd_id, True, {"action": "connect_agent", "status": "connected"})
        elif ctype == "disconnect_agent":
            STOP_FLAG.write_text("disabled by command", encoding="utf-8")
            send_heartbeat("offline", "Agent disconnected by admin")
            command_result(cmd_id, True, {"action": "disconnect_agent", "status": "offline"})
        elif ctype == "list_files":
            command_result(cmd_id, True, list_files(payload))
        elif ctype == "read_file":
            path = Path(payload_get(payload, "file_path"))
            command_result(cmd_id, True, {"file_path": str(path), "content": path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""})
        elif ctype == "write_file":
            path = Path(payload_get(payload, "file_path"))
            content = payload_get(payload, "content")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            command_result(cmd_id, True, {"file_path": str(path), "action": "write_file"})
        elif ctype == "delete_file":
            path = Path(payload_get(payload, "file_path"))
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
            command_result(cmd_id, True, {"file_path": str(path), "action": "delete_file"})
        elif ctype in ("run_mt5_bot", "RUN_MT5_BOT".lower()):
            result = start_mt5_bot(payload)
            command_result(cmd_id, True, result)
        elif ctype in ("stop_mt5", "kill_mt5", "stop_port", "stop_port"):
            port = payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort")
            command_result(cmd_id, True, stop_mt5_port_only(port, payload))
        elif ctype in ("dashboard", "watchdog"):
            command_result(cmd_id, True, mt5_ports_dashboard())
        elif ctype == "port_open_folder":
            command_result(cmd_id, True, open_mt5_port_folder(payload))
        elif ctype == "port_list_files":
            command_result(cmd_id, True, port_list_files(payload))
        elif ctype == "port_read_file":
            command_result(cmd_id, True, port_read_file(payload))
        elif ctype == "port_write_file":
            command_result(cmd_id, True, port_write_file(payload))
        elif ctype == "port_delete_file":
            command_result(cmd_id, True, port_delete_file(payload))
        elif ctype in ("restart_mt5_bot", "restart_mt5", "restart_port"):
            port = payload_get(payload, "port", "portSlot", "portNumber")
            instance_id = payload_get(payload, "instanceId")
            res = restart_mt5_port(port, payload)
            send_mt5_live_status(instance_id, port, "running", "manual_restart", 0, 0, "")
            command_result(cmd_id, True, res)
        elif ctype in ("delete_port",):
            port = payload_get(payload, "port", "portSlot", "portNumber")
            command_result(cmd_id, True, remove_mt5_port_folder_safe(port, payload))
        elif ctype == "read_parameters":
            folder = Path(payload_get(payload, "folder_path", default=str(MT5_ROOT)))
            files = [str(x) for x in folder.rglob("*.set")] if folder.exists() else []
            command_result(cmd_id, True, {"folder_path": str(folder), "files": files})
        else:
            command_result(cmd_id, False, {"command_type": ctype}, f"Unknown command_type: {ctype}")
    except Exception as e:
        log(f"COMMAND ERROR ID={cmd_id}: {e}")
        if ctype == "run_mt5_bot":
            try:
                send_connect_result(payload, "failed", str(e))
            except Exception:
                pass
        command_result(cmd_id, False, {}, str(e))


def main():
    log(f"PYTHON AGENT START Service={SERVICE_NAME} Computer={platform.node()} Server={SERVER_URL}")
    if AGENT_TOKEN == "PUT_YOUR_AGENT_TOKEN_HERE":
        log("ERROR: Please set AVELQUA_AGENT_TOKEN")
    last_hb = 0
    while True:
        clean_old_logs()
        if STOP_FLAG.exists():
            # disabled mode: only check connect_agent command
            time.sleep(LOOP_SECONDS)
        if time.time() - last_hb > 15:
            send_heartbeat("offline" if STOP_FLAG.exists() else "online", "Agent disabled" if STOP_FLAG.exists() else "")
            last_hb = time.time()
        poll_running_mt5_list()
        try:
            res = api("GET", "/commands/next")
            cmd = res.get("command")
            if cmd:
                handle_command(cmd)
        except Exception as e:
            log(f"COMMAND POLL ERROR: {e}")
        time.sleep(LOOP_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("PYTHON AGENT STOP KeyboardInterrupt")
