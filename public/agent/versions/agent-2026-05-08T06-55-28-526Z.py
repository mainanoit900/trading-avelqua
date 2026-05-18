# Avelqua Python Windows VPS Agent - Production
# Path: C:\\avelqua-python-agent\\agent.py
# Works with existing Node web endpoints: /api/vps-agent/* and /app/mt5/connect-result

import json
import base64
import os
import platform
import re
import shutil
import subprocess
import sys
import signal
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def load_env_file(path: Path) -> None:
    try:
        if not path.exists():
            return
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and not os.getenv(k):
                os.environ[k] = v
    except Exception:
        pass


ENV_FILE = Path(r"C:\avelqua-python-agent\.env")
load_env_file(ENV_FILE)

import requests  # noqa: E402

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - psutil may not be installed yet
    psutil = None


# ===== CONFIG =====
SERVER_URL = os.getenv("AVELQUA_SERVER_URL", "https://trading.avelqua.com/api/vps-agent").rstrip("/")
AGENT_TOKEN = os.getenv("AVELQUA_AGENT_TOKEN", "PUT_YOUR_AGENT_TOKEN_HERE")
SERVICE_NAME = os.getenv("AVELQUA_SERVICE_NAME", "AvelquaPythonAgent")
AGENT_DIR = Path(os.getenv("AVELQUA_AGENT_DIR", r"C:\avelqua-python-agent"))
AGENT_FILE = Path(os.getenv("AVELQUA_AGENT_FILE", str(AGENT_DIR / "agent.py")))
MT5_ROOT = Path(os.getenv("AVELQUA_MT5_ROOT", r"C:\MT5_PORTS"))
LOG_DIR = AGENT_DIR / "logs"
LOG_FILE = LOG_DIR / "agent.log"
STOP_FLAG = AGENT_DIR / "agent.disabled"
MAX_LOG_DAYS = int(os.getenv("AVELQUA_MAX_LOG_DAYS", "10"))
LOOP_SECONDS = int(os.getenv("AVELQUA_LOOP_SECONDS", "3"))
HEARTBEAT_SECONDS = int(os.getenv("AVELQUA_HEARTBEAT_SECONDS", "15"))
CONNECT_TIMEOUT_SECONDS = int(os.getenv("AVELQUA_CONNECT_TIMEOUT_SECONDS", "90"))
DEFAULT_CALLBACK_URL = os.getenv("AVELQUA_CONNECT_CALLBACK", "https://trading.avelqua.com/app/mt5/connect-result")
AGENT_VERSION = os.getenv("AVELQUA_AGENT_VERSION", "2026-05-05-pro-mt5-engine-v2")

# ===== MT5 PROCESS HANDLES PER PORT =====
MT5_HANDLES = {}

AGENT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    text = f"{datetime.now():%Y-%m-%d %H:%M:%S} - {msg}"
    print(text, flush=True)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(text + "\n")
    except Exception:
        pass

def handle_exit(sig, frame):
    log(f"AGENT EXIT SAFE signal={sig}")
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_exit)

if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, handle_exit)


def safe_json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, default=str)
    except Exception:
        return str(data)


def api(method: str, path_or_url: str, body: Optional[Dict[str, Any]] = None, timeout: int = 25) -> Dict[str, Any]:
    if not SERVER_URL and not path_or_url.startswith("http"):
        raise RuntimeError("Missing AVELQUA_SERVER_URL")
    url = path_or_url if path_or_url.startswith("http") else f"{SERVER_URL}{path_or_url}"
    headers = {
        "x-agent-token": AGENT_TOKEN,
        "Authorization": f"Bearer {AGENT_TOKEN}",
        "Accept": "application/json",
        "User-Agent": f"AvelquaPythonAgent/{AGENT_VERSION}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    r = requests.request(method.upper(), url, headers=headers, json=body, timeout=timeout)
    r.raise_for_status()
    if not r.text:
        return {}
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}

def post_json(path, payload):
    return api("POST", path, payload)

def command_result(cmd_id: Any, ok: bool = True, result: Optional[Dict[str, Any]] = None, error: str = "") -> None:
    try:
        api("POST", f"/commands/{cmd_id}/result", {"ok": ok, "result": result or {}, "error": error})
        log(f"RESULT SENT CommandID={cmd_id} Ok={ok}")
    except Exception as e:
        log(f"RESULT ERROR CommandID={cmd_id}: {e}")


def clean_old_logs() -> None:
    cutoff = time.time() - MAX_LOG_DAYS * 86400
    try:
        for p in LOG_DIR.glob("*"):
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
    except Exception as e:
        log(f"CLEAR OLD LOG ERROR: {e}")


def metrics() -> Dict[str, Any]:
    cpu = ram = ping = 0.0
    err = ""
    try:
        if psutil:
            cpu = float(psutil.cpu_percent(interval=0.2))
            ram = float(psutil.virtual_memory().percent)
        try:
            cmd = ["ping", "-n", "1", "8.8.8.8"] if os.name == "nt" else ["ping", "-c", "1", "8.8.8.8"]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=4).stdout
            m = re.search(r"time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms", out, re.I)
            if m:
                ping = float(m.group(1))
        except Exception:
            ping = 0.0
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
        "agent_version": AGENT_VERSION,
        "last_error": err,
    }


def send_heartbeat(status: str = "online", last_error: str = "") -> Optional[Dict[str, Any]]:
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

def extract_port_no(path_text):
    text = str(path_text or "")

    m = re.search(r"PORT[-_ ]?(\d+)", text, re.I)
    if m:
        return int(m.group(1))

    m = re.search(r"PORT(\d+)", text, re.I)
    if m:
        return int(m.group(1))

    return 0


def send_port_health():
    ports = []

    try:
        mt5_root = Path(os.getenv("AVELQUA_MT5_ROOT", r"C:\MT5_PORTS"))

        running_map = {}

        for p in psutil.process_iter(["pid", "name", "exe", "cmdline"]):
            try:
                name = (p.info.get("name") or "").lower()
                exe = (p.info.get("exe") or "")

                if name != "terminal64.exe":
                    continue

                exe_norm = exe.lower().replace("/", "\\")

                for folder in mt5_root.glob("*PORT*"):
                    folder_norm = str(folder).lower().replace("/", "\\")

                    if folder_norm in exe_norm:
                        port_no = extract_port_no(str(folder))

                        running_map[port_no] = {
                            "process_id": p.pid,
                            "exe_path": exe,
                            "folder_path": str(folder)
                        }

            except Exception:
                pass

        for folder in sorted(mt5_root.glob("*PORT*")):
            port_no = extract_port_no(str(folder))

            if not port_no:
                continue

            run = running_map.get(port_no)

            ports.append({
                "port_no": port_no,
                "folder_path": str(folder),
                "is_running": bool(run),
                "process_id": run.get("process_id") if run else None,
                "exe_path": run.get("exe_path") if run else "",
                "status": "running" if run else "free"
            })

        post_json("/port-health", {
            "ports": ports
        })

        log(f"PORT HEALTH SENT count={len(ports)}")

    except Exception as e:
        log(f"PORT HEALTH ERROR {e}")


def payload_get(payload: Optional[Dict[str, Any]], *names: str, default: str = "") -> str:
    payload = payload or {}
    for name in names:
        v = payload.get(name)
        if v is not None and str(v).strip() != "":
            return str(v)
    return default


def normalize_port(port: Any) -> int:
    s = str(port or "")
    n = int(re.sub(r"[^0-9]", "", s) or "0")
    if n > 20:
        n = n % 100
    if n <= 0:
        raise RuntimeError(f"invalid port: {port}")
    return n


def resolve_mt5_port_dir(port: Any, payload: Optional[Dict[str, Any]] = None) -> Path:
    payload = payload or {}

    # ✅ ใช้ path จริงจากเว็บ (รองรับหลาย VPS)
    folder = payload_get(payload, "vpsFolderPath", "folder_path", "path")
    if folder:
        p = Path(folder).expanduser()

        if str(p).lower().endswith(r"mql5\experts"):
            p = p.parent.parent

        if not p.exists():
            raise RuntimeError(f"PORT not found: {p}")

        # 🔒 เช็คว่า port ตรงกันจริง
        n = normalize_port(port)
        m = re.search(r"(?i)PORT[-_ ]*0*([0-9]+)$", p.name)

        if not m or int(m.group(1)) != n:
            raise RuntimeError(f"PORT mismatch: selected={n} folder={p}")

        return p

    # fallback แบบไม่ scan
    name = payload_get(payload, "vpsPortName")
    if name:
        p = MT5_ROOT / name
        if not p.exists():
            raise RuntimeError(f"PORT not found: {p}")
        return p

    raise RuntimeError("Missing vpsFolderPath (strict mode)")

def iter_terminal_processes() -> Iterable[Any]:
    if not psutil:
        return []
    out: List[Any] = []
    for p in psutil.process_iter(["pid", "name", "exe", "cmdline"]):
        try:
            if (p.info.get("name") or "").lower() == "terminal64.exe":
                out.append(p)
        except Exception:
            continue
    return out

def kill_mt5_by_port_handle(port_no):
    port_no = int(port_no or 0)

    h = MT5_HANDLES.get(port_no)
    if not h:
        return False

    proc = h.get("process")
    pid = h.get("pid")

    try:
        if proc and proc.poll() is None:
            proc.kill()
            log(f"[HANDLE KILL] PORT={port_no} PID={pid}")
    except Exception as e:
        log(f"[HANDLE KILL ERROR] PORT={port_no} {e}")

    MT5_HANDLES.pop(port_no, None)
    return True


def kill_mt5_by_folder(folder_path):
    folder_norm = str(folder_path or "").lower().replace("/", "\\")

    if not folder_norm:
        return False

    killed = False

    for p in iter_terminal_processes():
        try:
            exe = (p.info.get("exe") or "").lower().replace("/", "\\")
            cmd = " ".join(p.info.get("cmdline") or []).lower().replace("/", "\\")

            if folder_norm in exe or folder_norm in cmd:
                p.kill()
                killed = True
                log(f"[FOLDER KILL] PID={p.pid} FOLDER={folder_path}")
        except Exception:
            pass

    return killed


def stop_mt5_by_folder(folder_path):
    if not folder_path:
        raise Exception("missing folder_path")

    folder_path = str(folder_path).lower().replace("/", "\\")
    stopped = []

    for p in iter_terminal_processes():
        try:
            name = (p.info.get("name") or "").lower()
            exe = (p.info.get("exe") or "").lower().replace("/", "\\")
            cmd = " ".join(p.info.get("cmdline") or []).lower().replace("/", "\\")

            if name == "terminal64.exe" and (folder_path in exe or folder_path in cmd):
                p.kill()
                stopped.append(p.pid)
                log(f"KILLED MT5 PID={p.pid} FOLDER={folder_path}")

        except Exception:
            pass

    return {
        "ok": True,
        "message": "MT5 stopped",
        "folder_path": folder_path,
        "stopped": stopped
    }

def stop_mt5_port_only(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    port_dir = resolve_mt5_port_dir(port, payload)
    root = str(port_dir).rstrip("\\/").lower()
    stopped: List[int] = []
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
    time.sleep(2)

    # kill ghost terminal ของ PORT นี้อีกรอบ
    for p in list(iter_terminal_processes()):
        try:
            exe = (p.info.get("exe") or "").lower().replace("/", "\\")
            cmd = " ".join(p.info.get("cmdline") or []).lower().replace("/", "\\")

            if exe.startswith(root) or root in cmd or str(port_dir).lower().replace("/", "\\") in cmd:
                log(f"KILL GHOST MT5 PORT={port} PID={p.pid}")
                p.kill()
                if p.pid not in stopped:
                    stopped.append(p.pid)
        except Exception:
            pass

    return {"action": "stop_mt5", "port": port, "port_dir": str(port_dir), "stopped": stopped}


def latest_log_text(port_dir: Path) -> Tuple[Optional[Path], str]:
    # MT5 may write logs in different folders depending on portable mode/version.
    log_dirs = [
        port_dir / "logs",
        port_dir / "Logs",
        port_dir / "MQL5" / "Logs",
        port_dir / "MQL5" / "logs",
    ]
    files: List[Path] = []
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


def clear_mt5_logs(port_dir: Path) -> None:
    for d in [port_dir / "logs", port_dir / "MQL5" / "Logs"]:
        if d.exists():
            for f in d.rglob("*.log"):
                try:
                    f.unlink()
                except Exception:
                    pass


def account_snapshot(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    snap = {"balance": None, "equity": None, "currency": ""}
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        latest, text = latest_log_text(port_dir)
        if text:
            mb = re.search(r"(?i)balance\s*[:= ]\s*([0-9]+(?:\.[0-9]+)?)", text)
            me = re.search(r"(?i)equity\s*[:= ]\s*([0-9]+(?:\.[0-9]+)?)", text)
            mc = re.search(r"(?i)currency\s*[:= ]\s*([A-Z]{3})", text)
            if mb:
                snap["balance"] = float(mb.group(1))
            if me:
                snap["equity"] = float(me.group(1))
            if mc:
                snap["currency"] = mc.group(1)
            log(f"MT5 SNAPSHOT PORT={port} BALANCE={snap['balance']} EQUITY={snap['equity']} LOG={latest}")
    except Exception as e:
        log(f"MT5 SNAPSHOT ERROR PORT={port}: {e}")
    return snap



def _popen_hidden(args: List[str], cwd: Optional[str] = None) -> subprocess.Popen:
    """Start MT5 in pseudo-headless mode on Windows."""
    kwargs: Dict[str, Any] = {
        "cwd": cwd,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "stdin": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 1  # SW_MINIMIZE (safer for MT5 than fully hidden)
        kwargs["startupinfo"] = startupinfo
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(args, **kwargs)


def _run_powershell(command: str, timeout: int = 8) -> str:
    try:
        return subprocess.check_output(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        ).decode("utf-8", errors="ignore")
    except Exception:
        return ""


def mt5_window_titles(port: Any, payload: Optional[Dict[str, Any]] = None) -> List[str]:
    """Return MainWindowTitle values for terminal64.exe matched to this PORT folder."""
    titles: List[str] = []
    port_dir = resolve_mt5_port_dir(port, payload)
    root = str(port_dir).rstrip("\\/").lower()

    # Primary: psutil gives path + pid, then PowerShell gives MainWindowTitle.
    pid_set = set()
    for proc in mt5_port_processes(port, payload):
        try:
            pid_set.add(int(proc.pid))
        except Exception:
            pass

    if pid_set:
        ps = "Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle,Path | ConvertTo-Json -Compress"
        out = _run_powershell(ps)
        try:
            data = json.loads(out) if out.strip() else []
            if isinstance(data, dict):
                data = [data]
            for item in data:
                try:
                    if int(item.get("Id") or 0) in pid_set:
                        title = str(item.get("MainWindowTitle") or "").strip()
                        if title:
                            titles.append(title)
                except Exception:
                    pass
        except Exception:
            pass

    # Fallback: tasklist /v can see window title even when PowerShell returns empty.
    if not titles:
        try:
            out = subprocess.check_output(
                'tasklist /v /fi "imagename eq terminal64.exe"',
                shell=True,
                stderr=subprocess.DEVNULL,
                timeout=8,
            ).decode(errors="ignore")
            for line in out.splitlines():
                low = line.lower()
                if "terminal64.exe" in low and (root in low or not pid_set):
                    titles.append(line.strip())
        except Exception:
            pass
    return titles


def mt5_login_verified_by_window(port: Any, payload: Dict[str, Any]) -> Tuple[bool, str]:
    login = str(payload_get(payload, "mt5Login", "login", default="") or "").strip()
    server = str(payload_get(payload, "serverName", default="") or "").strip().lower()
    titles = mt5_window_titles(port, payload)
    joined = " | ".join(titles)
    low = joined.lower()

    if login and (
        login in joined
        or f"#{login}" in joined
    ):
        if not server or server in low or "demo account" in low or "real account" in low or "hedge" in low:
            return True, joined

    try:
        procs = mt5_port_processes(port, payload)
        if procs and len(procs) > 0:
            latest, text = latest_log_text(resolve_mt5_port_dir(port, payload))
            low_text = text.lower()

            if (
                login in text
                and (
                    "authorized" in low_text
                    or "authorization" in low_text
                    or "login successful" in low_text
                )
            ):
                return True, "log authorized fallback with login"

    except Exception:
        pass

    return False, joined

def mt5_socket_established(port: Any, payload: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
    """Detect whether the terminal matched to this PORT has an established broker socket."""
    if psutil is None:
        return False, "psutil not installed"
    pids = set()
    for proc in mt5_port_processes(port, payload):
        try:
            pids.add(int(proc.pid))
        except Exception:
            pass
    if not pids:
        return False, "no process"
    hits = []
    try:
        for c in psutil.net_connections(kind="inet"):
            try:
                if c.pid in pids and str(c.status).upper() == "ESTABLISHED":
                    raddr = getattr(c, "raddr", None)
                    if raddr:
                        hits.append(f"pid={c.pid} {raddr.ip}:{raddr.port}")
            except Exception:
                pass
    except Exception as e:
        return False, str(e)
    return len(hits) > 0, ", ".join(hits[:5])


def mt5_has_login_failure_text(text: str) -> bool:
    if not text:
        return False
    failed_rx = re.compile(
        r"authorization failed|invalid account|invalid password|login failed|failed authorization|account disabled|not authorized|trade account .*? disabled|no connection|network failed|server not found",
        re.I,
    )
    return bool(failed_rx.search(text))

def mt5_login_success(text: str, login: str) -> bool:
    if not text:
        return False

    text_lower = text.lower()

    fail_words = [
        "authorization failed",
        "invalid account",
        "invalid password",
        "login failed",
        "not authorized",
        "account disabled",
        "no connection",
        "connection failed",
        "network failed",
        "server not found"
    ]

    for f in fail_words:
        if f in text_lower:
            return False

    success_patterns = [
        "authorized on",
        "authorization on",
        "login successful",
        "account authorized",
        "previous successful authorization",
        "terminal synchronized",
        "trading has been enabled",
        "connected to"
    ]

    return any(x in text_lower for x in success_patterns)

def start_mt5_bot(payload: Dict[str, Any]) -> Dict[str, Any]:
    port = payload_get(payload, "port", "portNumber", "vpsPortNumber", "folderPort", "portSlot")
    port_no = normalize_port(port)

    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    server = str(payload_get(payload, "serverName", default="MohicansMarkets-Live"))

    if not login:
        raise RuntimeError("payload.mt5Login is required")

    if not password:
        raise RuntimeError("payload.mt5Password is required")

    port_dir = resolve_mt5_port_dir(port_no, payload)

    terminal = port_dir / "terminal64.exe"

    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    config_file = port_dir / "avelqua-login.ini"

    log(f"[LOGIN START] PORT={port_no} LOGIN={login} DIR={port_dir}")

    kill_mt5_by_port_handle(port_no)
    kill_mt5_by_folder(port_dir)
    stop_mt5_port_only(port_no, payload)

    clear_mt5_logs(port_dir)

    ini = f'''[Common]
Login={login}
Password={password}
Server={server}
AutoConfiguration=false

[Experts]
AllowLiveTrading=true
AllowDllImport=true
Enabled=true
'''

    config_file.write_text(ini, encoding="ascii", errors="ignore")

    args = [
        str(terminal),
        "/portable",
        f"/config:{config_file}"
    ]

    log(f"[MT5 OPEN] PORT={port_no} CMD={args} CWD={port_dir}")

    proc = _popen_hidden(args, cwd=str(port_dir))

    MT5_HANDLES[port_no] = {
        "process": proc,
        "pid": proc.pid,
        "folder": str(port_dir),
        "login": str(login),
        "started_at": time.time()
    }

    log(f"[HANDLE CREATED] PORT={port_no} PID={proc.pid} LOGIN={login}")

    deadline = time.time() + CONNECT_TIMEOUT_SECONDS

    while time.time() < deadline:

        time.sleep(3)

        latest, text = latest_log_text(port_dir)

        raw_text = text or ""
        low_text = raw_text.lower()

        if raw_text:
            tail = raw_text[-800:].replace("\n", " | ")
            log(f"[LOGIN LOG TAIL] PORT={port_no} {tail}")

        if mt5_has_login_failure_text(raw_text):

            kill_mt5_by_port_handle(port_no)
            kill_mt5_by_folder(port_dir)

            send_connect_result(
                payload,
                "failed",
                "MT5 login failed",
                port_no
            )

            raise RuntimeError("MT5 login failed")

        auth_ok = mt5_login_success(raw_text, login)

        log(f"[AUTH CHECK] RESULT={auth_ok}")

        if auth_ok:

            log(f"[LOGIN SUCCESS MATCH] PORT={port_no} LOGIN={login}")

            send_connect_result(
                payload,
                "connected",
                "MT5 login success",
                port_no
            )

            return {
                "status": "connected",
                "port": port_no,
                "login": login,
                "pid": proc.pid
            }

        if proc.poll() is not None:

            kill_mt5_by_port_handle(port_no)
            kill_mt5_by_folder(port_dir)

            send_connect_result(
                payload,
                "failed",
                "MT5 closed before login",
                port_no
            )

            raise RuntimeError("MT5 closed before login")

        log(f"[LOGIN WAIT] PORT={port_no} PID={proc.pid} LOGIN={login}")

    kill_mt5_by_port_handle(port_no)
    kill_mt5_by_folder(port_dir)

    send_connect_result(
        payload,
        "failed",
        "MT5 login timeout",
        port_no
    )

    raise RuntimeError("MT5 login timeout")

def send_connect_result(payload: Dict[str, Any], status: str, message: str, port: Any = "") -> None:
    try:
        callback = payload_get(payload, "callbackUrl", default=DEFAULT_CALLBACK_URL)
        port = str(port or payload_get(payload, "port", "portNumber", "vpsPortNumber", "folderPort"))
        port_slot = payload_get(payload, "portSlot")
        try:
            port_num = int(re.sub(r"[^0-9]", "", port) or "0")
            if port_num > 20 and port_slot:
                port = port_slot
        except Exception:
            pass
        body: Dict[str, Any] = {
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


def list_files(payload: Dict[str, Any]) -> Dict[str, Any]:
    folder = Path(payload_get(payload, "folder_path", default=str(AGENT_DIR)))
    items = []
    if folder.exists():
        for p in folder.iterdir():
            items.append({
                "Name": p.name,
                "FullName": str(p),
                "Length": p.stat().st_size if p.is_file() else 0,
                "LastWriteTime": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                "PSIsContainer": p.is_dir(),
            })
    return {"folder_path": str(folder), "files": items}


def mt5_port_processes(port: Any, payload: Optional[Dict[str, Any]] = None) -> List[Any]:
    port_dir = resolve_mt5_port_dir(port, payload)
    port_dir_str = str(port_dir).lower().replace("/", "\\")
    out = []

    if not psutil:
        return out

    for p in psutil.process_iter(["pid", "name", "exe", "cmdline", "cwd"]):
        try:
            name = (p.info.get("name") or "").lower()
            if name != "terminal64.exe":
                continue

            exe = (p.info.get("exe") or "").lower().replace("/", "\\")
            cwd = (p.info.get("cwd") or "").lower().replace("/", "\\")
            cmd = " ".join(p.info.get("cmdline") or []).lower().replace("/", "\\")

            if port_dir_str in exe or port_dir_str in cwd or port_dir_str in cmd:
                out.append(p)
                continue

        except Exception:
            pass

    return out


def mt5_port_status_one(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
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

def scan_all_mt5_ports() -> List[Dict[str, Any]]:
    ports: List[Dict[str, Any]] = []

    for folder in MT5_ROOT.glob("*PORT*"):
        try:
            if not folder.is_dir():
                continue

            m = re.search(r"(?i)PORT[-_ ]*0*([0-9]+)$", folder.name)
            if not m:
                continue

            port_no = int(m.group(1))
            terminal = folder / "terminal64.exe"

            running_procs = []
            root = str(folder).rstrip("\\/").lower()

            for p in list(iter_terminal_processes()):
                try:
                    exe = (p.info.get("exe") or "").lower()
                    cmd = " ".join(p.info.get("cmdline") or []).lower()
                    if exe.startswith(root) or root in cmd:
                        running_procs.append(p.pid)
                except Exception:
                    pass

            ports.append({
                "portNumber": port_no,
                "folderPath": str(folder),
                "terminalExists": terminal.exists(),
                "running": len(running_procs) > 0,
                "pid": running_procs,
            })
        except Exception as e:
            log(f"SCAN PORT ERROR folder={folder}: {e}")

    return sorted(ports, key=lambda x: int(x.get("portNumber") or 0))

def mt5_ports_dashboard() -> Dict[str, Any]:
    ports = []
    used_lot = 0.0
    for i in range(1, 21):
        try:
            port_dir = resolve_mt5_port_dir(str(i), {})
            procs = mt5_port_processes(str(i), {})
            running = len(procs) > 0
            lot = 0.0
            try:
                profiles = port_dir / "MQL5" / "Profiles"
                if profiles.exists():
                    for set_file in profiles.rglob("*.set"):
                        txt = set_file.read_text(errors="ignore")
                        m = re.search(r"(?im)^\s*(Lots|Lot|lot)\s*=\s*([0-9.]+)", txt)
                        if m:
                            lot = float(m.group(2))
                            break
            except Exception:
                pass
            snap = account_snapshot(str(i), {})
            used_lot += lot
            ports.append({
                "port": f"PORT{i:02d}",
                "portNumber": i,
                "path": str(port_dir),
                "running": running,
                "busy": running,
                "status": "full" if running else "free",
                "pid": [p.pid for p in procs],
                "lot": lot,
                "balance": snap.get("balance"),
                "equity": snap.get("equity"),
            })
        except Exception:
            port_dir = MT5_ROOT / f"PORT{i:02d}"
            ports.append({
                "port": f"PORT{i:02d}",
                "portNumber": i,
                "path": str(port_dir),
                "running": False,
                "busy": False,
                "status": "missing",
                "pid": [],
                "lot": 0,
                "balance": None,
                "equity": None,
            })
    return {
        "action": "dashboard",
        "ports": ports,
        "used_ports": len([p for p in ports if p["running"]]),
        "used_lot": used_lot,
        "at": datetime.now().isoformat(timespec="seconds"),
    }


def safe_port_file_path(payload: Dict[str, Any]) -> Tuple[str, Path, Path]:
    port = payload_get(payload, "port", "portNumber", "portSlot")
    file_path = payload_get(payload, "file_path", "filename", "full_path", "path")
    target_dir = payload_get(payload, "target")
    if not port:
        raise RuntimeError("payload.port is required")
    if not file_path:
        raise RuntimeError("payload.file_path/filename is required")
    port_dir = resolve_mt5_port_dir(port, payload)
    root = port_dir.resolve()

    # ถ้าเป็น filename ธรรมดา ให้ลงใน target เช่น MQL5\Experts ก่อน
    if target_dir and not Path(file_path).is_absolute():
        target = Path(target_dir) / file_path
    else:
        target = Path(file_path) if Path(file_path).is_absolute() else port_dir / file_path

    full = target.resolve()
    # กันแก้/ลบไฟล์ข้าม PORT: ต้องอยู่ใต้โฟลเดอร์ PORT เท่านั้น
    if not str(full).lower().startswith(str(root).lower()):
        raise RuntimeError(f"blocked path outside port folder: {full}")
    return port, port_dir, full


def port_list_files(payload: Dict[str, Any]) -> Dict[str, Any]:
    port = payload_get(payload, "port", "portNumber", "portSlot")
    sub = payload_get(payload, "path")
    port_dir = resolve_mt5_port_dir(port, payload)
    target = port_dir / sub if sub else port_dir
    if not target.exists():
        raise RuntimeError(f"folder not found: {target}")
    files = []
    for x in target.iterdir():
        files.append({
            "Name": x.name,
            "FullName": str(x),
            "Length": x.stat().st_size if x.is_file() else 0,
            "LastWriteTime": datetime.fromtimestamp(x.stat().st_mtime).isoformat(timespec="seconds"),
            "PSIsContainer": x.is_dir(),
        })
    return {"action": "port_list_files", "port": port, "folder": str(target), "files": files}


def port_read_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    port, _, full = safe_port_file_path(payload)
    if not full.exists():
        raise RuntimeError(f"file not found: {full}")
    return {"action": "port_read_file", "port": port, "file_path": str(full), "content": full.read_text(encoding="utf-8", errors="ignore")}


def port_write_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    port, _, full = safe_port_file_path(payload)
    content = payload_get(payload, "content")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    return {"action": "port_write_file", "port": port, "file_path": str(full), "status": "saved"}


def port_upload_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    port, _, full = safe_port_file_path(payload)
    content_b64 = payload_get(payload, "content_b64", "base64")
    if not content_b64:
        raise RuntimeError("payload.content_b64 is required")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(base64.b64decode(content_b64))
    return {"action": "port_upload_file", "port": port, "file_path": str(full), "status": "uploaded"}


def port_delete_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    port, _, full = safe_port_file_path(payload)
    if full.is_dir():
        shutil.rmtree(full)
    elif full.exists():
        full.unlink()
    return {"action": "port_delete_file", "port": port, "file_path": str(full), "status": "deleted"}


def open_mt5_port_folder(payload: Dict[str, Any]) -> Dict[str, Any]:
    port = payload_get(payload, "port", "portNumber", "portSlot")
    port_dir = resolve_mt5_port_dir(port, payload)
    if os.name == "nt":
        subprocess.Popen(["explorer.exe", str(port_dir)], close_fds=True)
    return {"action": "port_open_folder", "port": port, "path": str(port_dir), "status": "opened"}


def restart_mt5_port(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}

    # If restart command includes MT5 credentials, use the full login flow again.
    # This makes the Restart button behave like a real reconnect, not just open terminal64.exe.
    if payload_get(payload, "mt5Login", "login") and payload_get(payload, "mt5Password", "password"):
        return start_mt5_bot(payload)

    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    config_file = port_dir / "avelqua-login.ini"
    stop_mt5_port_only(port, payload)
    time.sleep(2)

    args = [str(terminal), "/portable"]
    if config_file.exists():
        args.append(f"/config:{config_file}")

    subprocess.Popen(args, cwd=str(port_dir), close_fds=True)
    return {
        "action": "restart_mt5_bot",
        "port": port,
        "status": "running",
        "terminal": str(terminal),
        "config": str(config_file) if config_file.exists() else "",
    }


def remove_mt5_port_folder_safe(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    port_dir = resolve_mt5_port_dir(port, payload)
    stop_mt5_port_only(port, payload)
    time.sleep(1)
    shutil.rmtree(port_dir)
    return {"action": "delete_port", "port": port, "port_dir": str(port_dir), "status": "deleted"}


def send_mt5_live_status(instance_id: Any, port: Any, status: str, ea_status: str = "", balance: float = 0, equity: float = 0, error_text: str = "") -> None:
    try:
        body = {
            "instanceId": instance_id,
            "port": port,
            "status": status,
            "eaStatus": ea_status,
            "balance": balance,
            "equity": equity,
            "errorText": error_text,
            "at": datetime.now().isoformat(timespec="seconds"),
        }
        api("POST", "https://trading.avelqua.com/app/mt5/live-status", body)
        log(f"LIVE STATUS SENT PORT={port} STATUS={status} EA={ea_status}")
    except Exception as e:
        log(f"LIVE STATUS ERROR PORT={port}: {e}")


def watch_mt5_instance(payload: Dict[str, Any]) -> None:
    try:
        port = payload_get(payload, "port", "portNumber", "portSlot")
        if not port:
            return
        instance_id = payload_get(payload, "instanceId")
        st = mt5_port_status_one(port, payload)
        snap = account_snapshot(port, payload)
        send_mt5_live_status(
            instance_id,
            port,
            "running" if st["running"] else "stopped",
            st["status"],
            float(snap.get("balance") or 0),
            float(snap.get("equity") or 0),
            "",
        )
    except Exception as e:
        log(f"WATCH INSTANCE ERROR: {e}")


def poll_running_mt5_list() -> None:
    try:
        running = api("GET", "https://trading.avelqua.com/app/mt5/agent-running-list")
        if running.get("ok") is True:
            for item in running.get("items", []):
                watch_mt5_instance(item)
    except Exception as e:
        log(f"WATCH MT5 ERROR: {e}")


def restart_service_later(service_name: str) -> None:
    if os.name != "nt":
        log("SERVICE RESTART SKIPPED: not Windows")
        return
    subprocess.Popen(
        ["cmd", "/c", f"timeout /t 2 >nul && net stop {service_name} && net start {service_name}"],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def update_agent_script(payload: Dict[str, Any]) -> Dict[str, Any]:
    agent_path = Path(payload_get(payload, "agent_path", default=str(AGENT_FILE)))
    content = payload_get(payload, "content")
    service_name = payload_get(payload, "service_name", default=SERVICE_NAME)
    if not content.strip():
        raise RuntimeError("payload.content is required")

    # Validate Python syntax before writing.
    compile(content, str(agent_path), "exec")

    backup = agent_path.with_suffix(agent_path.suffix + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    if agent_path.exists():
        shutil.copy2(agent_path, backup)
    agent_path.parent.mkdir(parents=True, exist_ok=True)

    tmp = agent_path.with_suffix(agent_path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(agent_path)

    log(f"PYTHON AGENT UPDATED path={agent_path} backup={backup}")

    subprocess.Popen(
        [
            "cmd", "/c",
            f"timeout /t 2 >nul && net stop {service_name} && net start {service_name}"
        ],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    return {
        "action": "update_agent_script",
        "updated": True,
        "agent_path": str(agent_path),
        "backup": str(backup),
        "service_name": service_name,
        "restart": "scheduled",
    }


def read_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(payload_get(payload, "file_path"))
    return {"file_path": str(path), "content": path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""}


def write_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(payload_get(payload, "file_path"))
    content = payload_get(payload, "content")
    if not str(path):
        raise RuntimeError("payload.file_path is required")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"file_path": str(path), "action": "write_file", "status": "saved"}


def delete_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(payload_get(payload, "file_path"))
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()
    return {"file_path": str(path), "action": "delete_file", "status": "deleted"}


def handle_command(cmd: Dict[str, Any]) -> None:
    cmd_id = cmd.get("id")
    ctype = str(cmd.get("command_type") or "").lower()
    payload = cmd.get("payload") or {}
    log(f"COMMAND RECEIVED ID={cmd_id} TYPE={ctype} PAYLOAD={safe_json(payload)}")
    try:
        if ctype in ("status", "service_status"):
            command_result(cmd_id, True, {
                "service_name": SERVICE_NAME,
                "status": "Running",
                "agent_type": "python",
                "agent_version": AGENT_VERSION,
            })

        elif ctype in ("log", "get_log", "service_logs", "service_log"):
            lines: List[str] = []
            if LOG_FILE.exists():
                lines = LOG_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()[-120:]
            command_result(cmd_id, True, {
                "log_file": str(LOG_FILE),
                "lines": lines,
            })

        elif ctype in ("update_agent_script", "update_python_agent", "deploy_agent"):
            command_result(cmd_id, True, update_agent_script(payload))

        elif ctype in ("restart_agent", "restart_service"):
            command_result(cmd_id, True, {
                "action": "restart_agent",
                "service_name": SERVICE_NAME,
                "restart": "scheduled"
            })
            log("RESTART_AGENT COMMAND RECEIVED")
            restart_service_later(SERVICE_NAME)
            return

        elif ctype in ("health_check_mt5", "refresh_metrics", "status", "mt5_health"):
            result = {
                "service": SERVICE_NAME,
                "agent": "online",
                "mt5_root": str(MT5_ROOT),
                "ports_found": [],
                "checked_at": datetime.now().isoformat(),
            }

            for i in range(1, 21):
                found = None
                for p in [
                    MT5_ROOT / f"VPS-WIN-01-PORT-{i:02d}",
                    MT5_ROOT / f"VPS-WIN-01-PORT-{i}",
                    MT5_ROOT / f"PORT{i:02d}",
                    MT5_ROOT / f"PORT{i}",
                ]:
                    if p.exists():
                        found = p
                        break
                if found:
                    result["ports_found"].append({
                        "port": i,
                        "path": str(found),
                        "terminal_exists": (found / "terminal64.exe").exists(),
                    })

            command_result(cmd_id, True, result)

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
            command_result(cmd_id, True, read_file(payload))

        elif ctype == "write_file":
            command_result(cmd_id, True, write_file(payload))

        elif ctype == "delete_file":
            command_result(cmd_id, True, delete_file(payload))

        elif ctype in ("run_mt5_bot", "run_mt5"):
            command_result(cmd_id, True, start_mt5_bot(payload))

        elif ctype in ("stop_mt5", "stop_mt5_bot", "force_stop_mt5", "kill_mt5", "stop_port"):
            port = payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort")
            folder = payload_get(payload, "folder_path", "vpsFolderPath")

            stopped = False

            if port:
                stopped = kill_mt5_by_port_handle(normalize_port(port)) or stopped

            if folder:
                stopped = kill_mt5_by_folder(folder) or stopped
                command_result(cmd_id, True, {
                    "action": "stop_mt5",
                    "stopped": stopped,
                    "folder_path": folder
                })
            else:
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

        elif ctype == "port_upload_file":
            command_result(cmd_id, True, port_upload_file(payload))

        elif ctype == "port_delete_file":
            command_result(cmd_id, True, port_delete_file(payload))

        elif ctype in ("restart_mt5_bot", "restart_mt5", "restart_port"):
            port = payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort")
            instance_id = payload_get(payload, "instanceId")
            res = restart_mt5_port(port, payload)
            send_mt5_live_status(instance_id, port, "running", "manual_restart", 0, 0, "")
            command_result(cmd_id, True, res)

        elif ctype == "delete_port":
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
        if ctype in ("run_mt5_bot", "run_mt5"):
            try:
                send_connect_result(payload, "failed", str(e))
            except Exception:
                pass
        command_result(cmd_id, False, {}, str(e))

def main() -> None:
    log(f"PYTHON AGENT START Service={SERVICE_NAME} Computer={platform.node()} Server={SERVER_URL}")

    if AGENT_TOKEN == "PUT_YOUR_AGENT_TOKEN_HERE":
        log("ERROR: Please set AVELQUA_AGENT_TOKEN in C:\\avelqua-python-agent\\.env")

    last_hb = 0.0

    while True:
        try:
            clean_old_logs()

            disabled = STOP_FLAG.exists()
            now = time.time()

            if now - last_hb > HEARTBEAT_SECONDS:
                send_heartbeat(
                    "offline" if disabled else "online",
                    "Agent disabled" if disabled else ""
                )
                last_hb = now

            send_port_health()

            if not disabled:
                poll_running_mt5_list()

            try:
                res = api("GET", "/commands/next")
                cmd = res.get("command")

                if cmd:
                    handle_command(cmd)

            except Exception as e:
                log(f"COMMAND POLL ERROR: {e}")

            time.sleep(int(os.getenv("AVELQUA_LOOP_SECONDS", "1")))

        except Exception as e:
            log(f"MAIN LOOP ERROR: {e}")
            time.sleep(int(os.getenv("AVELQUA_LOOP_SECONDS", "1")))
if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("PYTHON AGENT STOP KeyboardInterrupt")
    except Exception as exc:
        log(f"PYTHON AGENT FATAL: {exc}")
        sys.exit(1)
