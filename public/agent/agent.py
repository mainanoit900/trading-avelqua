# Avelqua Python Windows VPS Agent - Production (journal-gate-v4)
# Path: C:\\avelqua-python-agent\\agent.py
# Mount: https://trading.avelqua.com/api/vps-agent
# MT5 login: ยืนยันจาก Journal เท่านั้น (authorized on / authorization failed)

import json
import base64
import os
import platform
import re
import shutil
import subprocess
import sys
import signal
import threading
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
LOG_FILE = AGENT_DIR / "agent.log"
STOP_FLAG = AGENT_DIR / "agent.disabled"
LOGIN_UI_LOCK_FILE = AGENT_DIR / "login-ui.lock"
MAX_LOG_DAYS = int(os.getenv("AVELQUA_MAX_LOG_DAYS", "10"))
LOOP_SECONDS = int(os.getenv("AVELQUA_LOOP_SECONDS", "3"))
HEARTBEAT_SECONDS = int(os.getenv("AVELQUA_HEARTBEAT_SECONDS", "15"))
CONNECT_TIMEOUT_SECONDS = int(os.getenv("AVELQUA_CONNECT_TIMEOUT_SECONDS", "45"))
JOURNAL_POLL_INTERVAL_SEC = float(os.getenv("AVELQUA_JOURNAL_POLL_SEC", "0.4"))
LOCKED_MT5_SERVER = "MohicansMarkets-Live"
LOCKED_MT5_COMPANY = "Mohicans Markets Ltd"
JOURNAL_OK_MSG = "เชื่อมต่อสำเร็จ"
JOURNAL_FAIL_MSG = "เชื่อมต่อไม่สำเร็จผู้ใช้งานผิด"
JOURNAL_TIMEOUT_MSG = "ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่"
DEFAULT_CALLBACK_URL = os.getenv("AVELQUA_CONNECT_CALLBACK", "https://trading.avelqua.com/api/vps-agent/connect-result")
AGENT_BUILD_ID = "2026-05-26-mt5-compile-ea-v22"
# รายงานเวอร์ชันจากโค้ดจริง — ไม่ให้ .env เก่าค้างทำให้เว็บคิดว่ายังเป็น agent เก่า
AGENT_VERSION = AGENT_BUILD_ID
# ชื่อไฟล์ INI ในโฟลเดอร์แต่ละ PORT สำหรับ MT5 portable /config: (มาตรฐานโปรเจกต์: startUp.ini)
_MT5_LOGIN_INI = os.getenv("AVELQUA_MT5_LOGIN_INI", "startup.ini").strip()
MT5_LOGIN_INI_NAME = _MT5_LOGIN_INI if _MT5_LOGIN_INI else "startup.ini"
LEGACY_MT5_LOGIN_INI = "avelqua-login.ini"
# Windows: true = เปิด MT5 โชว์หน้าจอบน VPS (ตรวจรหัสผ่านได้จาก title bar / RDP)
SHOW_MT5_WINDOW = os.getenv("AVELQUA_MT5_SHOW_WINDOW", "true").lower() != "false"
MT5_RUNBOT_PERIOD = str(os.getenv("AVELQUA_MT5_RUNBOT_PERIOD", "H1") or "H1").strip().upper() or "H1"

AGENT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
WORKER_STATE_DIR = AGENT_DIR / "workers"
WORKER_STATE_DIR.mkdir(parents=True, exist_ok=True)

# ตัวอย่าง bytes_sent/recv ครั้งก่อน — คำนวณ Mbps ระหว่าง heartbeat
_NET_IO_SAMPLE: Dict[str, float] = {"ts": 0.0, "bytes_sent": 0.0, "bytes_recv": 0.0}
ACTIVE_CONNECT_WORKERS: Dict[str, subprocess.Popen] = {}
ACTIVE_CONNECT_WORKERS_LOCK = threading.Lock()


def has_journal_gate_marker(version_or_build: str) -> bool:
    v = str(version_or_build or "").strip()
    return bool(v) and "journal-gate" in v


def mt5_startup_ini_path(port_dir: Path) -> Path:
    return port_dir / MT5_LOGIN_INI_NAME


def mt5_existing_login_config(port_dir: Path) -> Optional[Path]:
    """ไฟล์ที่มีอยู่สำหรับส่ง /config: — ใช้ startUp.ini ก่อน แล้วจึง avelqua-login.ini เดิม"""
    primary = port_dir / MT5_LOGIN_INI_NAME
    if primary.exists():
        return primary
    legacy = port_dir / LEGACY_MT5_LOGIN_INI
    if legacy.exists():
        return legacy
    return None


def log(msg: str) -> None:
    text = f"{datetime.now():%Y-%m-%d %H:%M:%S} - {msg}"
    try:
        if hasattr(sys.stdout, "buffer") and sys.stdout.buffer:
            sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))
            sys.stdout.flush()
        else:
            print(text, flush=True)
    except Exception:
        try:
            print(text.encode("ascii", errors="replace").decode("ascii"), flush=True)
        except Exception:
            pass
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


def _sample_network_mbps() -> Tuple[float, float]:
    """Download/Upload Mbps จาก delta ของ psutil.net_io_counters ระหว่าง heartbeat"""
    if not psutil:
        return 0.0, 0.0
    try:
        counters = psutil.net_io_counters()
        now = time.time()
        sent = float(getattr(counters, "bytes_sent", 0) or 0)
        recv = float(getattr(counters, "bytes_recv", 0) or 0)
        prev_ts = float(_NET_IO_SAMPLE.get("ts") or 0.0)
        prev_sent = float(_NET_IO_SAMPLE.get("bytes_sent") or 0.0)
        prev_recv = float(_NET_IO_SAMPLE.get("bytes_recv") or 0.0)
        _NET_IO_SAMPLE["ts"] = now
        _NET_IO_SAMPLE["bytes_sent"] = sent
        _NET_IO_SAMPLE["bytes_recv"] = recv
        if prev_ts <= 0:
            return 0.0, 0.0
        dt = max(0.5, now - prev_ts)
        d_recv = recv - prev_recv
        d_sent = sent - prev_sent
        if d_recv < 0 or d_sent < 0:
            return 0.0, 0.0
        down_mbps = (d_recv * 8.0) / dt / 1_000_000.0
        up_mbps = (d_sent * 8.0) / dt / 1_000_000.0
        return round(down_mbps, 2), round(up_mbps, 2)
    except Exception as e:
        log(f"NET SAMPLE ERROR: {e}")
        return 0.0, 0.0


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
    net_down, net_up = _sample_network_mbps()
    return {
        "status": "online",
        "cpu_percent": cpu,
        "ram_percent": ram,
        "ping_ms": ping,
        "net_down_mbps": net_down,
        "net_up_mbps": net_up,
        "service_name": SERVICE_NAME,
        "computer_name": platform.node(),
        "agent_type": "python",
        "agent_version": AGENT_VERSION,
        "agent_build_id": AGENT_BUILD_ID,
        "journal_gate": True,
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
        if (
            os.getenv("AVELQUA_SELF_DEPLOY_ON_HEARTBEAT", "false").lower() in ("1", "true", "yes")
            and res.get("deploy_required")
            and not STOP_FLAG.exists()
        ):
            _maybe_self_deploy_agent(res)
        return res
    except Exception as e:
        log(f"HEARTBEAT ERROR: {e}")
        return None


def _maybe_self_deploy_agent(heartbeat_res: Dict[str, Any]) -> None:
    """ดาวน์โหลด agent.py ล่าสุดเมื่อเซิร์ฟเวอร์บอกว่าเวอร์ชันเก่า (กัน deploy ค้างแต่ service ไม่รีสตาร์ท)"""
    global _LAST_SELF_DEPLOY_AT
    now = time.time()
    if now - _LAST_SELF_DEPLOY_AT < float(os.getenv("AVELQUA_SELF_DEPLOY_COOLDOWN_SEC", "3600")):
        return
    _LAST_SELF_DEPLOY_AT = now
    required = str(
        heartbeat_res.get("required_agent_version")
        or heartbeat_res.get("requiredAgentVersion")
        or AGENT_BUILD_ID
    ).strip()
    if has_journal_gate_marker(AGENT_BUILD_ID) and has_journal_gate_marker(required):
        return
    script_url = str(heartbeat_res.get("agent_script_url") or heartbeat_res.get("scriptUrl") or "").strip()
    if not script_url:
        script_url = f"{SERVER_URL}/agent-script"
    try:
        log(f"SELF DEPLOY start required={required} url={script_url}")
        update_agent_script({
            "scriptUrl": script_url,
            "targetPath": str(AGENT_FILE),
            "agent_path": str(AGENT_FILE),
            "service_name": SERVICE_NAME,
            "restartService": True,
        })
    except Exception as e:
        log(f"SELF DEPLOY ERROR: {e}")


_LAST_SELF_DEPLOY_AT = 0.0


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

            mt5_login = ""
            if run and run.get("process_id"):
                try:
                    ps = f"(Get-Process -Id {run['process_id']} -ErrorAction SilentlyContinue).MainWindowTitle"
                    title = (_run_powershell(ps, timeout=4) or "").strip()
                    m = re.match(r"^(\d{4,})\s*[-–]", title)
                    if m:
                        mt5_login = m.group(1)
                except Exception:
                    pass

            ports.append({
                "port_no": port_no,
                "port_number": port_no,
                "folder_path": str(folder),
                "running": bool(run),
                "is_running": bool(run),
                "process_id": run.get("process_id") if run else None,
                "mt5_login": mt5_login or None,
                "exe_path": run.get("exe_path") if run else "",
                "status": "running" if run else "free",
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


def _parse_money_token(raw: Any) -> Optional[float]:
    if raw is None or raw == "":
        return None
    s = str(raw).strip().replace(" ", "").replace(",", "")
    s = re.sub(r"[^0-9.\-]", "", s)
    if not s or s in ("-", ".", "-."):
        return None
    try:
        return float(s)
    except Exception:
        return None


def _snap_positive(snap: Dict[str, Any]) -> bool:
    try:
        bal = snap.get("balance")
        eq = snap.get("equity")
        return (bal is not None and float(bal) > 0) or (eq is not None and float(eq) > 0)
    except Exception:
        return False


def account_snapshot_uia(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Read Balance/Equity from live MT5 window via UIAutomation."""
    if os.name != "nt":
        return {}
    out: Dict[str, Any] = {"balance": None, "equity": None, "currency": ""}
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        root = str(port_dir).replace("\\", "\\\\")
        login = str(payload_get(payload or {}, "mt5Login", "login") or "").strip()
        ps = f"""
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AvqWin {{
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}}
"@
$root = '{root}'
$login = '{login}'
$proc = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {{
  $p = $_.Path
  if (-not $p) {{ return $false }}
  if ($p -like "*$root*") {{ return $true }}
  if ($login -and $_.MainWindowTitle -match [regex]::Escape($login)) {{ return $true }}
  return $false
}} | Select-Object -First 1
if (-not $proc) {{ Write-Output '{{}}'; exit 0 }}
if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {{
  [void][AvqWin]::ShowWindow($proc.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 300
}}
$ae = [Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $ae) {{ Write-Output '{{}}'; exit 0 }}
$names = New-Object System.Collections.Generic.List[string]
$walker = [Windows.Automation.TreeWalker]::RawViewWalker
function Walk($el) {{
  if (-not $el) {{ return }}
  $n = $el.Current.Name
  if ($n) {{ [void]$names.Add($n) }}
  $ch = $walker.GetFirstChild($el)
  while ($ch) {{ Walk $ch; $ch = $walker.GetNextSibling($ch) }}
}}
Walk $ae
$blob = ($names -join ' ')
$bal = $null; $eq = $null
if ($blob -match '(?i)Balance[^0-9-]*(-?[0-9][0-9\\s,\\.]+)') {{ $bal = ($matches[1] -replace '\\s','') }}
if ($blob -match '(?i)Equity[^0-9-]*(-?[0-9][0-9\\s,\\.]+)') {{ $eq = ($matches[1] -replace '\\s','') }}
if (-not $eq -and $bal -and $blob -match '(?i)(?:Profit|Floating|P/L)[^0-9-]*(-?[0-9][0-9\\s,\\.]+)') {{
  $pr = ($matches[1] -replace '\\s','')
  try {{ $eq = [string]([decimal]$bal + [decimal]$pr) }} catch {{ }}
}}
@{{ balance = $bal; equity = $eq }} | ConvertTo-Json -Compress
"""
        raw = _run_powershell(ps, timeout=12).strip()
        if raw and raw.startswith("{"):
            data = json.loads(raw)
            out["balance"] = _parse_money_token(data.get("balance"))
            out["equity"] = _parse_money_token(data.get("equity"))
            if _snap_positive(out):
                log(f"MT5 SNAPSHOT UIA PORT={port} BALANCE={out.get('balance')} EQUITY={out.get('equity')}")
    except Exception as e:
        log(f"MT5 SNAPSHOT UIA ERROR PORT={port}: {e}")
    return out


def account_snapshot_mt5_api(port_dir: Path, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Read Balance/Equity via MetaTrader5 Python API when available."""
    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception:
        return {}
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        return {}
    login_hint = 0
    try:
        login_hint = int(str(payload_get(payload or {}, "mt5Login", "login") or "0").strip() or "0")
    except Exception:
        login_hint = 0
    try:
        try:
            mt5.shutdown()
        except Exception:
            pass
        if not mt5.initialize(path=str(terminal)):
            return {}
        ai = mt5.account_info()
        if ai is None and login_hint:
            try:
                mt5.login(login_hint)
                ai = mt5.account_info()
            except Exception:
                ai = None
        mt5.shutdown()
        if ai is None:
            return {}
        if login_hint and int(getattr(ai, "login", 0) or 0) not in (0, login_hint):
            return {}
        out = {
            "balance": float(ai.balance),
            "equity": float(ai.equity),
            "currency": str(ai.currency or ""),
            "observedLogin": str(int(getattr(ai, "login", 0) or 0) or ""),
            "accountName": str(getattr(ai, "name", "") or ""),
            "source": "mt5_api",
        }
        if _snap_positive(out):
            log(f"MT5 API SNAPSHOT path={port_dir.name} BALANCE={out['balance']} EQUITY={out['equity']}")
        return out
    except Exception as e:
        log(f"MT5 API SNAPSHOT ERROR: {e}")
        try:
            mt5.shutdown()
        except Exception:
            pass
        return {}


def clear_mt5_logs(port_dir: Path) -> None:
    for d in [
        port_dir / "Logs",
        port_dir / "logs",
        port_dir / "MQL5" / "Logs",
        port_dir / "MQL5" / "logs",
    ]:
        if d.exists():
            for f in d.rglob("*.log"):
                try:
                    f.unlink()
                except Exception:
                    pass


def clear_mt5_login_cache(port_dir: Path) -> None:
    """ลบ cache บัญชีที่ MT5 จำไว้ แต่เก็บ server list/config ไว้ให้เลือก MohicansMarkets-Live ได้"""
    for rel in (
        "config/accounts.dat",
        "config/account.ini",
    ):
        p = port_dir / rel
        if p.is_file():
            try:
                p.unlink()
                log(f"CLEAR MT5 CACHE FILE {p}")
            except Exception as e:
                log(f"CLEAR MT5 CACHE ERROR {p}: {e}")


def resolve_mt5_server(payload: Optional[Dict[str, Any]] = None) -> str:
    """ล็อคชื่อ server ให้เป็น MohicansMarkets-Live เสมอ แม้ payload จะส่งชื่อแปลกมา"""
    payload = payload or {}
    s = str(
        payload_get(payload, "serverName", "server_name", "mt5_server", "server") or ""
    ).strip()
    if not s:
        return LOCKED_MT5_SERVER
    if "mohicans" in s.lower():
        return LOCKED_MT5_SERVER
    return s


def _patch_ini_common_login(path: Path, login: str, password: str, server: str) -> bool:
    """บันทึก Login/Password/Server ใน config/common.ini ของ portable"""
    if not login or not server:
        return False
    safe_password = password.replace("\r", "").replace("\n", "")
    if any(c in safe_password for c in ('=', ';', '#', '"')):
        safe_password = safe_password.replace('"', "'")
        pw_line = f'Password="{safe_password}"'
    else:
        pw_line = f"Password={safe_password}"
    try:
        text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    except Exception:
        text = ""
    lines = text.splitlines() if text else []
    out: List[str] = []
    in_common = False
    seen_login = seen_pw = seen_srv = False
    for line in lines:
        low = line.strip().lower()
        if low == "[common]":
            in_common = True
            out.append(line)
            continue
        if in_common and low.startswith("[") and low != "[common]":
            in_common = False
        if in_common:
            if low.startswith("login="):
                out.append(f"Login={login}")
                seen_login = True
                continue
            if low.startswith("password="):
                out.append(pw_line)
                seen_pw = True
                continue
            if low.startswith("server="):
                out.append(f"Server={server}")
                seen_srv = True
                continue
        out.append(line)
    if not any(l.strip().lower() == "[common]" for l in out):
        if out and out[-1].strip():
            out.append("")
        out.append("[Common]")
    idx = max(i for i, l in enumerate(out) if l.strip().lower() == "[common]")
    insert: List[str] = []
    if not seen_login:
        insert.append(f"Login={login}")
    if not seen_pw and password:
        insert.append(pw_line)
    if not seen_srv:
        insert.append(f"Server={server}")
    if insert:
        out[idx + 1 : idx + 1] = insert
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(out) + "\n", encoding="utf-8", errors="replace")
        return True
    except Exception as e:
        log(f"PATCH COMMON LOGIN ERROR {path}: {e}")
        return False


def write_mt5_common_login_config(port_dir: Path, login: str, password: str, server: str) -> None:
    """เขียน Login/Server ลง common.ini/settings.ini เพื่อให้ MT5 ไม่ค้างหน้าเลือก server"""
    server = str(server or LOCKED_MT5_SERVER).strip()
    for rel in ("config/common.ini", "config/settings.ini"):
        p = port_dir / Path(rel.replace("/", os.sep))
        if _patch_ini_common_login(p, login, password, server):
            log(f"PATCH COMMON LOGIN server={server} file={p}")


def write_mt5_login_ini(
    port_dir: Path,
    login: str,
    password: str,
    server: str,
    allow_expert_trading: bool = True,
    startup_expert: str = "",
    startup_symbol: str = "",
    startup_period: str = "",
    startup_template: str = "",
    startup_expert_parameters: str = "",
) -> Path:
    """เขียน startUp.ini ใหม่ทุกครั้ง พร้อม patch common.ini ให้ lock server ตรงกัน"""
    config_file = mt5_startup_ini_path(port_dir)
    for stale in (port_dir / LEGACY_MT5_LOGIN_INI, port_dir / "startup.ini", port_dir / "avelqua-login.ini"):
        if stale.is_file():
            try:
                if stale.resolve() != config_file.resolve():
                    stale.unlink()
                    log(f"REMOVE STALE INI {stale}")
            except Exception:
                pass
    safe_password = password.replace("\r", "").replace("\n", "")
    if any(c in safe_password for c in ('=', ';', '#', '"')):
        safe_password = safe_password.replace('"', "'")
        pw_line = f'Password="{safe_password}"'
    else:
        pw_line = f"Password={safe_password}"
    trade_flag = "true" if allow_expert_trading else "false"
    startup_expert = str(startup_expert or "").strip()
    startup_symbol = str(startup_symbol or "").strip()
    startup_period = str(startup_period or "").strip().upper()
    startup_template = str(startup_template or "").strip()
    startup_expert_parameters = str(startup_expert_parameters or "").strip()
    ini = f"""[Common]
Login={login}
{pw_line}
Server={server}
AutoConfiguration=true
ProxyEnable=false
CertInstall=0

[Experts]
AllowLiveTrading={trade_flag}
AllowDllImport=true
Enabled={trade_flag}
"""
    if startup_expert:
        ini += "\n[StartUp]\n"
        ini += f"Expert={startup_expert}\n"
        if startup_symbol:
            ini += f"Symbol={startup_symbol}\n"
        if startup_period:
            ini += f"Period={startup_period}\n"
        if startup_template:
            ini += f"Template={startup_template}\n"
        if startup_expert_parameters:
            ini += f"ExpertParameters={startup_expert_parameters}\n"
    config_file.write_text(ini, encoding="utf-8", errors="replace")
    for alias in (port_dir / "startup.ini", port_dir / "startUp.ini"):
        if alias.resolve() != config_file.resolve():
            try:
                alias.write_text(ini, encoding="utf-8", errors="replace")
            except Exception:
                pass
    write_mt5_common_login_config(port_dir, login, password, server)
    log(
        f"WRITE MT5 INI {config_file} LOGIN={login} SERVER={server} "
        f"PW_LEN={len(password)} EXPERT_TRADING={trade_flag} STARTUP_EXPERT={startup_expert or '-'}"
    )
    return config_file


def metaquotes_common_files_dir() -> Optional[Path]:
    for base in (os.getenv("APPDATA"), os.getenv("LOCALAPPDATA")):
        if not base:
            continue
        p = Path(base) / "MetaQuotes" / "Terminal" / "Common" / "Files"
        try:
            p.mkdir(parents=True, exist_ok=True)
            return p
        except Exception:
            continue
    return None


def avelqua_gate_target_dirs(port_dir: Path) -> List[Path]:
    seen = set()
    out: List[Path] = []

    def add(p: Path) -> None:
        key = str(p).lower()
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    add(port_dir / "MQL5" / "Files")
    for rel in ("Terminal/Common/Files", "terminal/Common/Files"):
        p = port_dir / Path(rel.replace("/", os.sep))
        if p.parent.exists():
            add(p)
    common = metaquotes_common_files_dir()
    if common:
        add(common)
    return out


def write_avelqua_trading_gate(port_dir: Path, enabled: bool, payload: Optional[Dict[str, Any]] = None) -> None:
    flag = "1" if enabled else "0"
    body = {
        "tradingEnabled": bool(enabled),
        "allowExpertTrading": bool(enabled),
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    if payload:
        body["instanceId"] = payload_get(payload, "instanceId", "instance_id")
        body["botCode"] = payload_get(payload, "botCode", "eaName", "bot_code")
    body_json = json.dumps(body, ensure_ascii=False, indent=2)
    for files_dir in avelqua_gate_target_dirs(port_dir):
        try:
            files_dir.mkdir(parents=True, exist_ok=True)
            (files_dir / "avelqua_trading_gate.json").write_text(body_json, encoding="utf-8")
            (files_dir / "avelqua_trading_enabled.txt").write_text(flag, encoding="ascii")
            log(f"TRADING GATE {'ON' if enabled else 'OFF'} {files_dir}")
        except Exception as e:
            log(f"TRADING GATE WRITE ERROR {files_dir}: {e}")


MT5_PORT_INI_REL_PATHS = (
    "config/common.ini",
    "config/settings.ini",
    "config/terminal.ini",
    "config/trade.ini",
    "config/history.ini",
    "config/experts.ini",
    "config/journal.ini",
    "MQL5/config/common.ini",
    "MQL5/config/experts.ini",
)


def _patch_ini_experts_section(path: Path, enabled: bool) -> bool:
    if not path.parent.exists():
        return False
    trade = "true" if enabled else "false"
    flag = "1" if enabled else "0"
    try:
        text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    except Exception:
        text = ""
    lines = text.splitlines() if text else []
    out: List[str] = []
    in_exp = False
    seen_allow = seen_en = seen_dll = False
    for line in lines:
        low = line.strip().lower()
        if low == "[experts]":
            in_exp = True
            out.append(line)
            continue
        if in_exp and low.startswith("[") and low != "[experts]":
            in_exp = False
        if in_exp:
            if low.startswith("allowlivetrading="):
                out.append(f"AllowLiveTrading={trade}")
                seen_allow = True
                continue
            if low.startswith("enabled="):
                out.append(f"Enabled={flag}")
                seen_en = True
                continue
            if low.startswith("allowdllimport="):
                out.append("AllowDllImport=true")
                seen_dll = True
                continue
        out.append(line)
    if not any(l.strip().lower() == "[experts]" for l in out):
        if out and out[-1].strip():
            out.append("")
        out.extend(["[Experts]", f"AllowLiveTrading={trade}", "AllowDllImport=true", f"Enabled={flag}"])
    else:
        idx = max(i for i, l in enumerate(out) if l.strip().lower() == "[experts]")
        insert: List[str] = []
        if not seen_allow:
            insert.append(f"AllowLiveTrading={trade}")
        if not seen_dll:
            insert.append("AllowDllImport=true")
        if not seen_en:
            insert.append(f"Enabled={flag}")
        if insert:
            out[idx + 1 : idx + 1] = insert
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(out) + "\n", encoding="ascii", errors="ignore")
        return True
    except Exception as e:
        log(f"PATCH INI EXPERTS ERROR {path}: {e}")
        return False


def patch_mt5_experts_config(port_dir: Path, enabled: bool) -> None:
    for rel in MT5_PORT_INI_REL_PATHS:
        p = port_dir / Path(rel.replace("/", os.sep))
        if _patch_ini_experts_section(p, enabled):
            log(f"PATCH EXPERTS enabled={enabled} file={p}")


def mt5_running_for_port_dir(port_dir: Path) -> bool:
    root = str(port_dir).rstrip("\\/").lower()
    for p in iter_terminal_processes():
        try:
            exe = (p.info.get("exe") or "").lower()
            cmd = " ".join(p.info.get("cmdline") or []).lower()
            if exe.startswith(root) or root in cmd:
                return True
        except Exception:
            pass
    return False


def remove_mt5_login_ini(port_dir: Path) -> None:
    """หลัง login ล้มเหลว — กัน restart ด้วยรหัสผ่านเก่าใน INI"""
    for p in (
        mt5_startup_ini_path(port_dir),
        port_dir / LEGACY_MT5_LOGIN_INI,
        port_dir / "startup.ini",
        port_dir / "avelqua-login.ini",
    ):
        if p.is_file():
            try:
                p.unlink()
                log(f"REMOVE INI AFTER FAIL {p}")
            except Exception:
                pass


def account_snapshot(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    snap = {"balance": None, "equity": None, "currency": "", "observedLogin": "", "source": ""}
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        for metric_file in (
            port_dir / "MQL5" / "Files" / "avelqua_account.json",
            port_dir / "MQL5" / "Files" / "avelqua_account.txt",
        ):
            if not metric_file.exists():
                continue
            try:
                raw = metric_file.read_text(encoding="utf-8", errors="ignore").strip()
                if not raw:
                    continue
                if metric_file.suffix.lower() == ".json":
                    data = json.loads(raw)
                    for key in ("balance", "equity"):
                        val = data.get(key)
                        if val is None or val == "":
                            continue
                        num = float(str(val).replace(",", "").replace(" ", ""))
                        snap[key] = num if num > 0 else None
                    snap["currency"] = str(data.get("currency") or "").upper()
                    snap["observedLogin"] = str(data.get("login") or data.get("mt5_login") or "").strip()
                    snap["source"] = "metric_file"
                else:
                    kv: Dict[str, str] = {}
                    for line in raw.splitlines():
                        if "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        kv[k.strip().lower()] = v.strip()
                    for key in ("balance", "equity"):
                        val = kv.get(key)
                        if not val:
                            continue
                        num = float(str(val).replace(",", "").replace(" ", ""))
                        snap[key] = num if num > 0 else None
                    snap["currency"] = str(kv.get("currency") or "").upper()
                    snap["observedLogin"] = str(kv.get("login") or kv.get("mt5_login") or "").strip()
                    snap["source"] = "metric_file"
                if snap["balance"] is not None or snap["equity"] is not None:
                    log(
                        f"MT5 SNAPSHOT FILE PORT={port} BALANCE={snap['balance']} "
                        f"EQUITY={snap['equity']} FILE={metric_file.name}"
                    )
                    return snap
            except Exception as e:
                log(f"MT5 SNAPSHOT FILE ERROR PORT={port} FILE={metric_file.name}: {e}")
        api_snap = account_snapshot_mt5_api(port_dir, payload)
        if _snap_positive(api_snap):
            snap.update({k: v for k, v in api_snap.items() if v is not None and v != ""})
            return snap
        uia_snap = account_snapshot_uia(port, payload)
        if _snap_positive(uia_snap):
            snap.update({k: v for k, v in uia_snap.items() if v is not None and v != ""})
            return snap
        latest, text = latest_log_text(port_dir)
        if text:
            mb = re.search(r"(?i)balance\s*[:= ]\s*([0-9][0-9,.\s]*)", text)
            me = re.search(r"(?i)equity\s*[:= ]\s*([0-9][0-9,.\s]*)", text)
            mc = re.search(r"(?i)currency\s*[:= ]\s*([A-Z]{3})", text)
            if mb:
                snap["balance"] = float(mb.group(1).replace(",", "").replace(" ", ""))
            if me:
                snap["equity"] = float(me.group(1).replace(",", "").replace(" ", ""))
            if mc:
                snap["currency"] = mc.group(1)
            log(f"MT5 SNAPSHOT PORT={port} BALANCE={snap['balance']} EQUITY={snap['equity']} LOG={latest}")
    except Exception as e:
        log(f"MT5 SNAPSHOT ERROR PORT={port}: {e}")
    return snap


def _metric_value(v: Any) -> Any:
    try:
        if v is None or v == "":
            return None
        n = float(v)
        return n if n > 0 else None
    except Exception:
        return None


def _profit_value(v: Any) -> Any:
    try:
        if v is None or v == "":
            return None
        n = float(v)
        return n if n == n else None
    except Exception:
        return None


def send_account_metrics(
    payload: Dict[str, Any],
    balance: Any = None,
    equity: Any = None,
    currency: str = "",
) -> None:
    account_id = payload_get(payload, "accountId", "account_id")
    user_id = payload_get(payload, "userId", "user_id")
    if not account_id and not user_id:
        return
    balance = _metric_value(balance)
    equity = _metric_value(equity)
    if balance is None and equity is None:
        return
    try:
        url = os.getenv(
            "AVELQUA_ACCOUNT_METRICS_URL",
            "https://trading.avelqua.com/app/mt5/account-metrics",
        )
        body = {
            "accountId": account_id,
            "userId": user_id,
            "portNumber": payload_get(payload, "port", "portNumber", "port_no", "portSlot"),
            "balance": balance,
            "equity": equity,
            "currency": currency or "",
        }
        api("POST", url, body)
        log(f"ACCOUNT METRICS SENT accountId={account_id} balance={balance} equity={equity}")
    except Exception as e:
        log(f"ACCOUNT METRICS ERROR: {e}")


def schedule_account_metrics_retry(
    payload: Dict[str, Any],
    port: Any,
    delays: Tuple[int, ...] = (5, 12, 25, 45, 90),
) -> None:
    def _worker(delay_sec: int) -> None:
        try:
            time.sleep(delay_sec)
            snap = account_snapshot(port, payload)
            if snap.get("balance") is None and snap.get("equity") is None:
                return
            send_account_metrics(
                payload,
                snap.get("balance"),
                snap.get("equity"),
                snap.get("currency", ""),
            )
        except Exception as e:
            log(f"ACCOUNT METRICS RETRY ERROR delay={delay_sec}: {e}")

    for d in delays:
        threading.Thread(target=_worker, args=(d,), daemon=True).start()


def schedule_connect_metrics_retry(
    payload: Dict[str, Any],
    port: Any,
    message: str,
    process_id: Any = None,
    journal_evidence: str = "",
    window_title: str = "",
    delays: Tuple[int, ...] = (6, 12, 20, 35, 60),
) -> None:
    def _worker(delay_sec: int) -> None:
        try:
            time.sleep(delay_sec)
            snap = account_snapshot(port, payload)
            if snap.get("balance") is None and snap.get("equity") is None:
                log(f"CONNECT METRICS RETRY MISS PORT={port} delay={delay_sec}")
                return
            log(
                f"CONNECT METRICS RETRY HIT PORT={port} delay={delay_sec} "
                f"BALANCE={snap.get('balance')} EQUITY={snap.get('equity')}"
            )
            send_connect_result(
                payload,
                "connected",
                message,
                port,
                process_id=process_id,
                journal_evidence=journal_evidence,
                window_title=window_title,
                schedule_metric_retry=False,
            )
        except Exception as e:
            log(f"CONNECT METRICS RETRY ERROR PORT={port} delay={delay_sec}: {e}")

    for delay_sec in delays:
        threading.Thread(target=_worker, args=(delay_sec,), daemon=True).start()



def _popen_hidden(args: List[str], cwd: Optional[str] = None) -> subprocess.Popen:
    """Start MT5 (terminal64). On Windows: AVELQUA_MT5_SHOW_WINDOW=true → new console (visible); else no extra console."""
    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        if SHOW_MT5_WINDOW:
            creationflags = subprocess.CREATE_NEW_CONSOLE
        else:
            creationflags = subprocess.CREATE_NO_WINDOW
        return subprocess.Popen(
            args,
            cwd=cwd,
            creationflags=creationflags,
            startupinfo=startupinfo,
            close_fds=True,
        )
    return subprocess.Popen(
        args,
        cwd=cwd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )


def acquire_login_ui_lock(timeout_sec: int = 180, stale_sec: int = 420) -> str:
    """Cross-process lock for MT5 SendKeys/UI automation on the shared Windows desktop."""
    deadline = time.time() + max(5, int(timeout_sec))
    token = f"{os.getpid()}:{time.time()}"
    while time.time() < deadline:
        try:
            fd = os.open(str(LOGIN_UI_LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, token.encode("utf-8", errors="ignore"))
            finally:
                os.close(fd)
            log(f"LOGIN UI LOCK ACQUIRED token={token}")
            return token
        except FileExistsError:
            try:
                age = time.time() - LOGIN_UI_LOCK_FILE.stat().st_mtime
                if age > stale_sec:
                    LOGIN_UI_LOCK_FILE.unlink(missing_ok=True)
                    log(f"LOGIN UI LOCK STALE REMOVED age_sec={int(age)}")
                    continue
            except Exception:
                pass
        time.sleep(0.5)
    raise RuntimeError("มีคำสั่ง Login MT5 อื่นกำลังใช้งานจอบน VPS กรุณารอสักครู่แล้วลองใหม่")


def release_login_ui_lock(token: str) -> None:
    try:
        if not LOGIN_UI_LOCK_FILE.exists():
            return
        current = LOGIN_UI_LOCK_FILE.read_text(encoding="utf-8", errors="ignore").strip()
        if current == token:
            LOGIN_UI_LOCK_FILE.unlink(missing_ok=True)
            log(f"LOGIN UI LOCK RELEASED token={token}")
    except Exception as e:
        log(f"LOGIN UI LOCK RELEASE ERROR: {e}")


def release_login_ui_lock_for_current_process() -> None:
    try:
        if not LOGIN_UI_LOCK_FILE.exists():
            return
        current = LOGIN_UI_LOCK_FILE.read_text(encoding="utf-8", errors="ignore").strip()
        if current.startswith(f"{os.getpid()}:"):
            LOGIN_UI_LOCK_FILE.unlink(missing_ok=True)
            log(f"LOGIN UI LOCK FORCE RELEASE pid={os.getpid()}")
    except Exception as e:
        log(f"LOGIN UI LOCK FORCE RELEASE ERROR: {e}")


def _worker_port_num(payload: Dict[str, Any]) -> int:
    try:
        return int(payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort") or 0)
    except Exception:
        return 0


def worker_state_path(port: Any) -> Path:
    port_no = max(0, int(port or 0))
    return WORKER_STATE_DIR / f"port-{port_no:02d}.json"


def worker_log_path(port: Any, cmd_id: Any) -> Path:
    port_no = max(0, int(port or 0))
    return LOG_DIR / f"worker-port-{port_no:02d}-cmd-{cmd_id}.log"


def write_worker_state(port: Any, info: Dict[str, Any]) -> None:
    try:
        worker_state_path(port).write_text(json.dumps(info, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception as e:
        log(f"WORKER STATE WRITE ERROR port={port}: {e}")


def clear_worker_state(port: Any, pid: Any = None) -> None:
    try:
        path = worker_state_path(port)
        if not path.exists():
            return
        if pid is not None:
            try:
                raw = json.loads(path.read_text(encoding="utf-8", errors="ignore") or "{}")
                if int(raw.get("pid") or 0) != int(pid or 0):
                    return
            except Exception:
                pass
        path.unlink(missing_ok=True)
    except Exception as e:
        log(f"WORKER STATE CLEAR ERROR port={port}: {e}")


def reap_connect_workers() -> None:
    with ACTIVE_CONNECT_WORKERS_LOCK:
        for key, proc in list(ACTIVE_CONNECT_WORKERS.items()):
            try:
                rc = proc.poll()
            except Exception:
                rc = None
            if rc is None:
                continue
            ACTIVE_CONNECT_WORKERS.pop(key, None)
            try:
                clear_worker_state(int(key), getattr(proc, "pid", None))
            except Exception:
                pass
            log(f"CONNECT WORKER EXIT port={key} pid={getattr(proc, 'pid', '')} exit_code={rc}")


def run_login_ui_automation(
    login: str,
    password: str,
    server: str,
    port_dir: Path,
    process_id: Any = None,
    with_wizard: bool = False,
    timeout_sec: int = 45,
) -> None:
    token = acquire_login_ui_lock(timeout_sec=timeout_sec)
    try:
        if with_wizard:
            automate_mt5_open_account_wizard(server=server, port_dir=port_dir, process_id=process_id)
        automate_mt5_login_server_form(login, password, server, port_dir=port_dir, process_id=process_id)
    finally:
        release_login_ui_lock(token)


def spawn_connect_worker(cmd_id: Any, ctype: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    port = _worker_port_num(payload)
    if not port:
        raise RuntimeError("payload.port is required for worker dispatch")

    key = str(port)
    wait_timeout = 0.0
    if str(ctype or "").lower() in ("run_mt5_bot", "run_mt5", "restart_mt5_bot", "restart_mt5", "restart_port"):
        wait_timeout = 45.0
    deadline = time.time() + wait_timeout

    while True:
        reap_connect_workers()
        with ACTIVE_CONNECT_WORKERS_LOCK:
            prev = ACTIVE_CONNECT_WORKERS.get(key)
            if prev and prev.poll() is None:
                if wait_timeout > 0 and time.time() < deadline:
                    prev_pid = getattr(prev, "pid", "")
                    log(
                        f"WORKER WAIT port={port} cmd_id={cmd_id} type={ctype} "
                        f"busy_pid={prev_pid} remaining={max(0.0, deadline - time.time()):.1f}s"
                    )
                else:
                    raise RuntimeError(f"PORT {port} มี worker กำลังทำงานอยู่ กรุณารอสักครู่")
            else:
                ACTIVE_CONNECT_WORKERS.pop(key, None)
                break
        time.sleep(0.5)

    payload_b64 = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
    args = [sys.executable, str(AGENT_FILE), "--worker-connect", str(cmd_id), str(ctype or ""), payload_b64]
    log_file = worker_log_path(port, cmd_id)
    log_handle = log_file.open("ab")
    creationflags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW

    proc = subprocess.Popen(
        args,
        cwd=str(AGENT_DIR),
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
        close_fds=(os.name != "nt"),
    )
    log_handle.close()

    with ACTIVE_CONNECT_WORKERS_LOCK:
        ACTIVE_CONNECT_WORKERS[key] = proc

    write_worker_state(port, {
        "pid": proc.pid,
        "port": port,
        "command_id": cmd_id,
        "command_type": ctype,
        "started_at": datetime.now().isoformat(),
        "log_file": str(log_file),
    })
    log(f"CONNECT WORKER SPAWNED port={port} pid={proc.pid} cmd_id={cmd_id} type={ctype}")
    return {
        "action": "spawn_connect_worker",
        "status": "started",
        "port": port,
        "worker_pid": proc.pid,
        "log_file": str(log_file),
    }


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


def mt5_title_suggests_auth_failure(title_joined: str) -> bool:
    """Window title hints at failed login (do not treat TCP ESTABLISHED as proof of login)."""
    if not title_joined:
        return False
    low = title_joined.lower()
    if re.search(
        r"invalid\s+account|invalid\s+password|wrong\s+password|authorization\s+failed|failed\s+authorization|"
        r"account\s+disabled|not\s+authorized|login\s+failed|no\s+connection|access\s+denied",
        low,
    ):
        return True
    for frag in ("ไม่ถูกต้อง", "รหัสผ่านไม่ถูกต้อง", "บัญชีไม่ถูกต้อง"):
        if frag in title_joined:
            return True
    return False

def capture_mt5_window_base64(port: Any, payload: Optional[Dict[str, Any]] = None) -> str:
    """จับภาพหน้าต่าง MT5 ของ PORT นี้ (JPEG base64) สำหรับแสดงบนเว็บ"""
    if os.name != "nt":
        return ""
    try:
        port_dir = str(resolve_mt5_port_dir(port, payload)).replace("'", "''")
        ps = f"""
$dir = '{port_dir}'.ToLower()
$p = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {{
  $_.Path -and ($_.Path.ToLower().StartsWith($dir))
}} | Select-Object -First 1
if (-not $p -or $p.MainWindowHandle -eq 0) {{ exit 2 }}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Rect {{
  [StructLayout(LayoutKind.Sequential)] public struct RECT {{ public int Left, Top, Right, Bottom; }}
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}}
"@
$rect = New-Object Win32Rect+RECT
[void][Win32Rect]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
$w = [Math]::Max(320, $rect.Right - $rect.Left)
$h = [Math]::Max(240, $rect.Bottom - $rect.Top)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }}
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 72)
$bmp.Save($ms, $enc, $ep)
[Convert]::ToBase64String($ms.ToArray())
"""
        out = _run_powershell(ps, timeout=12).strip()
        if out and len(out) > 200 and not out.lower().startswith("exit"):
            return out[:2_400_000]
    except Exception as e:
        log(f"MT5 SCREENSHOT ERROR: {e}")
    return ""


def send_connect_result(
    payload: Dict[str, Any],
    status: str,
    message: str,
    port: Any = "",
    process_id: Any = None,
    journal_evidence: str = "",
    window_title: str = "",
    preview_b64: str = "",
    window_verified: bool = False,
    schedule_metric_retry: bool = True,
) -> None:
    try:
        callback = payload_get(payload, "callbackUrl", default=DEFAULT_CALLBACK_URL)
        port = str(port or payload_get(payload, "port", "portNumber", "vpsPortNumber", "folderPort"))
        port_slot = payload_get(payload, "portSlot")
        # ห้ามแปลง port_no เป็น portSlot: port_no คือเลข PORT จริงของ VPS/Folder
        # portSlot ใช้แสดงลำดับตามแพ็กเกจผู้ใช้เท่านั้น
        body: Dict[str, Any] = {
            "nodeId": payload_get(payload, "nodeId"),
            "userId": payload_get(payload, "userId"),
            "accountId": payload_get(payload, "accountId"),
            "attemptId": payload_get(payload, "attemptId", "attempt_id"),
            "portId": payload_get(payload, "portId", "port_id"),
            "portSlot": port_slot,
            "portNumber": port,
            "mt5Login": payload_get(payload, "mt5Login", "login"),
            "mt5Password": payload_get(payload, "mt5Password", "password"),
            "serverName": payload_get(payload, "serverName", default="MohicansMarkets-Live"),
            "status": status,
            "message": message,
            "process_id": process_id,
            "balance": None,
            "equity": None,
            "accountCurrency": "",
            "loginVerified": status == "connected",
            "journalEvidence": (journal_evidence or "")[:8000],
            "windowTitle": (window_title or "")[:500],
            "mt5WindowTitle": (window_title or "")[:500],
            "previewImage": (preview_b64 or "")[:2_400_000],
            "mt5PreviewImage": (preview_b64 or "")[:2_400_000],
            "windowVerified": bool(window_verified),
            "agentVersion": AGENT_BUILD_ID,
            "agentBuildId": AGENT_BUILD_ID,
        }
        if status == "connected" and port:
            snap = account_snapshot(port, payload)
            body["balance"] = snap.get("balance")
            body["equity"] = snap.get("equity")
            body["accountCurrency"] = snap.get("currency", "")
            body["observedLogin"] = snap.get("observedLogin", "")
            body["observed_login"] = snap.get("observedLogin", "")
        api("POST", callback, body)
        log(f"CONNECT CALLBACK SENT status={status} userId={body['userId']} portSlot={port_slot} login={body['mt5Login']} port={port}")
        if (
            status == "connected"
            and schedule_metric_retry
            and body.get("balance") is None
            and body.get("equity") is None
        ):
            schedule_connect_metrics_retry(
                payload,
                port,
                message,
                process_id=process_id,
                journal_evidence=journal_evidence,
                window_title=window_title,
            )
    except Exception as e:
        log(f"CONNECT CALLBACK ERROR: {e}")


def kill_mt5_by_folder(port_dir: Path) -> None:
    """Stop terminal64 for this portable folder (alias for stop_mt5_by_folder)."""
    stop_mt5_by_folder(str(port_dir))


def cleanup_mt5_after_login_fail(
    port: Any,
    payload: Dict[str, Any],
    port_dir: Path,
) -> None:
    """ปิด MT5 + ลบ INI/cache ทันทีเมื่อ Journal รายงาน authorization failed"""
    try:
        kill_mt5_by_folder(port_dir)
    except Exception as e:
        log(f"CLEANUP kill_mt5_by_folder: {e}")
    try:
        stop_mt5_port_only(port, payload)
    except Exception as e:
        log(f"CLEANUP stop_mt5_port_only: {e}")
    try:
        remove_mt5_login_ini(port_dir)
        clear_mt5_login_cache(port_dir)
    except Exception as e:
        log(f"CLEANUP clear ini/cache: {e}")


def _read_log_tail(path: Path, max_bytes: int = 262144) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode("utf-8", errors="ignore")
    except Exception:
        try:
            return path.read_text(errors="ignore")
        except Exception:
            return ""


def _journal_outcome_for_login(
    text: str,
    login: str,
    failed_words: List[str],
    server: str = LOCKED_MT5_SERVER,
) -> Optional[bool]:
    """
    อ่าน Journal ตามรูปแบบ MT5 จริง (ล็อค Server MohicansMarkets-Live):
      ล้มเหลว: '12345': authorization on MohicansMarkets-Live failed
      สำเร็จ:  '12345': authorized on MohicansMarkets-Live through ...
    """
    login = str(login).strip()
    server = str(server or LOCKED_MT5_SERVER).strip()
    if not login or not text or not server:
        return None

    login_esc = re.escape(login)
    server_esc = re.escape(server)
    fail_rx = re.compile(
        rf"(?:'|\")?{login_esc}(?:'|\")?\s*:\s*authorization on\s+{server_esc}\s+failed\b",
        re.I,
    )
    ok_rx = re.compile(
        rf"(?:'|\")?{login_esc}(?:'|\")?\s*:\s*authorized on\s+{server_esc}(?:\s+through)?\b",
        re.I,
    )

    last: Optional[bool] = None
    for line in text.splitlines():
        low = line.lower()
        if login.lower() not in low:
            continue
        if server.lower() not in low:
            continue
        if fail_rx.search(line):
            last = False
            continue
        if any(w in low for w in failed_words):
            last = False
            continue
        if "authorization on" in low and "failed" in low:
            last = False
            continue
        if ok_rx.search(line):
            last = True
    return last


def automate_mt5_login_server_form(
    login: str,
    password: str,
    server: str = LOCKED_MT5_SERVER,
    port_dir: Optional[Path] = None,
    process_id: Any = None,
) -> bool:
    """กรอกฟอร์ม Login MT5 ซ้ำอีกชั้นเมื่อ terminal เปิดมาแต่ยังไม่ผูก server ให้"""
    login_esc = str(login or "").replace("+", "{+}").replace("{", "{{").replace("}", "}}")
    server_esc = (
        str(server or LOCKED_MT5_SERVER)
        .replace("+", "{+}")
        .replace("{", "{{")
        .replace("}", "}}")
    )
    pw_esc = (
        str(password or "")
        .replace("+", "{+}")
        .replace("^", "{^}")
        .replace("%", "{%}")
        .replace("~", "{~}")
        .replace("(", "{(}")
        .replace(")", "{)}")
        .replace("{", "{{")
        .replace("}", "}}")
    )
    root_esc = str(port_dir or "").replace("'", "''").lower()
    try:
        pid_hint = int(process_id or 0)
    except Exception:
        pid_hint = 0
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "SilentlyContinue"
$pidHint = {pid_hint}
$root = '{root_esc}'
$strict = ($pidHint -gt 0) -or [bool]$root
$items = Get-Process terminal64 -ErrorAction SilentlyContinue |
  Where-Object {{ $_.MainWindowHandle -ne 0 }}
$p = $null
if ($pidHint -gt 0) {{
  $p = $items | Where-Object {{ $_.Id -eq $pidHint }} | Select-Object -First 1
}}
if ((-not $p) -and $root) {{
  $p = $items |
    Where-Object {{ $_.Path -and $_.Path.ToLower().StartsWith($root) }} |
    Sort-Object Id -Descending |
    Select-Object -First 1
}}
if ((-not $p) -and (-not $strict)) {{
  $p = $items | Sort-Object MainWindowTitle -Descending | Select-Object -First 1
}}
if (-not $p) {{ Write-Output "TARGET_FOUND=0"; exit 0 }}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}}
"@
[void]($items | ForEach-Object {{
  if ($_.Id -ne $p.Id) {{ [W32]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }}
}})
[W32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{login_esc}")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{{TAB}}")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("{pw_esc}")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{{TAB}}")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("{server_esc}")
Start-Sleep -Milliseconds 350
[System.Windows.Forms.SendKeys]::SendWait("{{DOWN}}{{ENTER}}")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
Write-Output "TARGET_FOUND=1"
exit 0
"""
    try:
        out = _run_powershell(ps, timeout=14)
        if "TARGET_FOUND=1" not in out:
            log(f"MT5 LOGIN FORM TARGET MISS pid_hint={pid_hint} root={port_dir}")
            return False
        log(f"MT5 LOGIN FORM server={server} login={login} pid_hint={pid_hint} root={port_dir}")
        return True
    except Exception as e:
        log(f"MT5 LOGIN FORM ERROR: {e}")
        return False


def automate_mt5_open_account_wizard(
    company: str = LOCKED_MT5_COMPANY,
    server: str = LOCKED_MT5_SERVER,
    port_dir: Optional[Path] = None,
    process_id: Any = None,
) -> bool:
    """กด wizard Open an Account ให้เลือก Mohicans Markets Ltd + Server MohicansMarkets-Live"""
    company_esc = company.replace("'", "''")
    server_esc = server.replace("+", "{+}")
    root_esc = str(port_dir or "").replace("'", "''").lower()
    try:
        pid_hint = int(process_id or 0)
    except Exception:
        pid_hint = 0
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "SilentlyContinue"
$pidHint = {pid_hint}
$root = '{root_esc}'
$strict = ($pidHint -gt 0) -or [bool]$root
$items = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {{
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*Open an Account*"
}}
$dlg = $null
if ($pidHint -gt 0) {{
  $dlg = $items | Where-Object {{ $_.Id -eq $pidHint }} | Select-Object -First 1
}}
if ((-not $dlg) -and $root) {{
  $dlg = $items |
    Where-Object {{ $_.Path -and $_.Path.ToLower().StartsWith($root) }} |
    Sort-Object Id -Descending |
    Select-Object -First 1
}}
if ((-not $dlg) -and (-not $strict)) {{
  $dlg = $items | Select-Object -First 1
}}
if (-not $dlg) {{ Write-Output "TARGET_FOUND=0"; exit 0 }}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}}
"@
[void]((Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowHandle -ne 0 }}) | ForEach-Object {{
  if ($_.Id -ne $dlg.Id) {{ [W32]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }}
}})
[W32]::ShowWindow($dlg.MainWindowHandle, 9) | Out-Null
[W32]::SetForegroundWindow($dlg.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
# เลือก Mohicans Markets Ltd แล้วกด Next
[System.Windows.Forms.SendKeys]::SendWait("{{DOWN}}{{ENTER}}")
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait("%n")
Start-Sleep -Milliseconds 900
# หน้าเลือก Server — พิมพ์ MohicansMarkets-Live
[System.Windows.Forms.SendKeys]::SendWait("{server_esc}")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("%n")
Write-Output "TARGET_FOUND=1"
exit 0
"""
    try:
        out = _run_powershell(ps, timeout=18)
        if "TARGET_FOUND=1" not in out:
            log(f"MT5 WIZARD TARGET MISS pid_hint={pid_hint} root={port_dir}")
            return False
        log(f"MT5 WIZARD AUTO company={company} server={server} pid_hint={pid_hint} root={port_dir}")
        return True
    except Exception as e:
        log(f"MT5 WIZARD AUTO ERROR: {e}")
        return False


def check_mt5_journal_login_result(
    port_dir: Path,
    mt5_login: str,
    timeout_sec: int = 60,
    since_ts: float = 0.0,
    progress_callback: Any = None,
) -> Tuple[bool, str, str]:
    """
    อ่าน Journal (.log) เท่านั้น — ไม่ถือ process / socket / หน้าต่างเป็นสำเร็จ
    สำเร็จ: บรรทัดล่าสุดของ login นี้มี authorized on
    ล้มเหลว: บรรทัดล่าสุดมี authorization failed / invalid account ฯลฯ
    """
    login = str(mt5_login).strip()
    if not login:
        return False, "MT5 Login หรือ Password ไม่ถูกต้อง", ""
    deadline = time.time() + timeout_sec
    since_ts = since_ts or 0.0

    journal_dirs = [
        Path(port_dir) / "Logs",
        Path(port_dir) / "logs",
        Path(port_dir) / "MQL5" / "Logs",
        Path(port_dir) / "MQL5" / "logs",
    ]

    failed_words = [
        "authorization failed",
        "failed (invalid account)",
        "failed [invalid account]",
        "invalid account",
        "invalid password",
        "wrong password",
        "login failed",
        "not authorized",
    ]
    today_name = datetime.now().strftime("%Y%m%d")
    last_progress_at = 0.0
    wait_start = time.time()

    while time.time() < deadline:
        if progress_callback and (time.time() - last_progress_at) >= 10:
            try:
                progress_callback(int(time.time() - wait_start))
            except Exception as e:
                log(f"JOURNAL PROGRESS CB ERROR: {e}")
            last_progress_at = time.time()

        log_files: List[Path] = []
        for d in journal_dirs:
            if not d.exists():
                continue
            today_log = d / f"{today_name}.log"
            if today_log.exists():
                log_files.append(today_log)
            log_files.extend(d.rglob("*.log"))

        seen = set()
        uniq: List[Path] = []
        for f in log_files:
            try:
                if since_ts and f.stat().st_mtime < since_ts - 10:
                    continue
            except Exception:
                pass
            try:
                k = str(f.resolve())
            except Exception:
                k = str(f)
            if k not in seen:
                seen.add(k)
                uniq.append(f)

        if not uniq:
            time.sleep(JOURNAL_POLL_INTERVAL_SEC)
            continue

        uniq.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        newest = uniq[0]
        chunk = _read_log_tail(newest)
        outcome = _journal_outcome_for_login(chunk, login, failed_words, LOCKED_MT5_SERVER)
        if outcome is False:
            log(f"MT5 JOURNAL FAIL login={login} file={newest.name} server={LOCKED_MT5_SERVER}")
            return False, JOURNAL_FAIL_MSG, chunk
        if outcome is True:
            log(f"MT5 JOURNAL OK login={login} file={newest.name}")
            return True, JOURNAL_OK_MSG, chunk

        time.sleep(JOURNAL_POLL_INTERVAL_SEC)

    log(f"MT5 JOURNAL TIMEOUT login={login} port_dir={port_dir}")
    return False, JOURNAL_TIMEOUT_MSG, ""


def _quick_journal_probe(port_dir: Path, login: str, since_ts: float) -> Tuple[Optional[bool], str]:
    """อ่าน journal ครั้งเดียว — True/False/None(ยังไม่รู้)"""
    login = str(login).strip()
    if not login:
        return None, ""
    today_name = datetime.now().strftime("%Y%m%d")
    journal_dirs = [
        Path(port_dir) / "Logs",
        Path(port_dir) / "logs",
        Path(port_dir) / "MQL5" / "Logs",
        Path(port_dir) / "MQL5" / "logs",
    ]
    failed_words = [
        "authorization failed",
        "failed (invalid account)",
        "failed [invalid account]",
        "invalid account",
        "invalid password",
        "wrong password",
        "login failed",
        "not authorized",
    ]
    log_files: List[Path] = []
    for d in journal_dirs:
        if not d.exists():
            continue
        today_log = d / f"{today_name}.log"
        if today_log.exists():
            log_files.append(today_log)
        log_files.extend(d.rglob("*.log"))
    seen = set()
    uniq: List[Path] = []
    for f in log_files:
        try:
            if since_ts and f.stat().st_mtime < since_ts - 10:
                continue
        except Exception:
            pass
        try:
            k = str(f.resolve())
        except Exception:
            k = str(f)
        if k not in seen:
            seen.add(k)
            uniq.append(f)
    if not uniq:
        return None, ""
    uniq.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    chunk = _read_log_tail(uniq[0])
    outcome = _journal_outcome_for_login(chunk, login, failed_words, LOCKED_MT5_SERVER)
    if outcome is True:
        return True, chunk
    if outcome is False:
        return False, chunk
    return None, chunk


def wait_mt5_login_hybrid(
    port: Any,
    payload: Dict[str, Any],
    port_dir: Path,
    login: str,
    journal_since: float,
    proc_pid: Any,
    timeout_sec: int,
) -> Tuple[bool, str, str]:
    """รอ login — ตรวจ Journal + หน้าต่าง MT5 พร้อมส่งภาพหน้าจอให้เว็บ"""
    deadline = time.time() + max(12, timeout_sec)
    last_preview_at = 0.0
    last_wizard_at = 0.0
    last_title = ""
    window_ok_streak = 0
    saw_window_verified = False
    wait_start = time.time()

    while time.time() < deadline:
        elapsed = int(time.time() - wait_start)
        now = time.time()

        if elapsed < 18 and (last_wizard_at <= wait_start or now - last_wizard_at >= 7.0):
            server = resolve_mt5_server(payload)
            pw = str(payload_get(payload, "mt5Password", "password") or "")
            run_login_ui_automation(
                login,
                pw,
                server,
                port_dir,
                process_id=proc_pid,
                with_wizard=True,
                timeout_sec=45,
            )
            last_wizard_at = now

        j_out, j_chunk = _quick_journal_probe(port_dir, login, journal_since)
        if j_out is False:
            cleanup_mt5_after_login_fail(port, payload, port_dir)
            send_connect_result(
                payload,
                "failed_auth",
                JOURNAL_FAIL_MSG,
                port,
                process_id=None,
                journal_evidence=j_chunk,
            )
            return False, JOURNAL_FAIL_MSG, j_chunk
        if j_out is True:
            return True, JOURNAL_OK_MSG, j_chunk

        titles = mt5_window_titles(port, payload)
        joined = " | ".join(titles)
        if joined and joined != last_title:
            last_title = joined

        if mt5_title_suggests_auth_failure(joined):
            cleanup_mt5_after_login_fail(port, payload, port_dir)
            send_connect_result(
                payload,
                "failed_auth",
                JOURNAL_FAIL_MSG,
                port,
                process_id=proc_pid,
                journal_evidence=joined,
            )
            return False, JOURNAL_FAIL_MSG, joined

        ok_w, _wmsg = mt5_login_verified_by_window(port, payload)
        if ok_w:
            window_ok_streak += 1
            saw_window_verified = True
        else:
            window_ok_streak = 0
        preview_b64 = ""
        now = time.time()
        if now - last_preview_at >= 2.5:
            preview_b64 = capture_mt5_window_base64(port, payload)
            last_preview_at = now

        if ok_w:
            send_connect_result(
                payload,
                "checking",
                f"เห็นบัญชี {login} บนหน้าต่าง MT5 แล้ว — กำลังยืนยันจาก Journal...",
                port,
                process_id=proc_pid,
                window_title=joined,
                preview_b64=preview_b64,
            )
            if j_out is True or j_chunk:
                ok2, msg2, chunk2 = check_mt5_journal_login_result(
                    port_dir, login, timeout_sec=6, since_ts=journal_since
                )
                if ok2:
                    return True, JOURNAL_OK_MSG, chunk2 or j_chunk
                journal_outcome = _journal_outcome_for_login(
                    chunk2 or j_chunk,
                    login,
                    [
                        "authorization failed",
                        "failed (invalid account)",
                        "failed [invalid account]",
                        "invalid account",
                        "invalid password",
                        "wrong password",
                        "login failed",
                        "not authorized",
                    ],
                    LOCKED_MT5_SERVER,
                )
                if ok2 is False and journal_outcome is False:
                    cleanup_mt5_after_login_fail(port, payload, port_dir)
                    send_connect_result(
                        payload,
                        "failed_auth",
                        JOURNAL_FAIL_MSG,
                        port,
                        process_id=proc_pid,
                        journal_evidence=chunk2 or j_chunk,
                    )
                    return False, JOURNAL_FAIL_MSG, chunk2 or j_chunk
        hint = joined or f"กำลังเปิด MT5 ({elapsed} วินาที)..."
        send_connect_result(
            payload,
            "starting" if elapsed < 8 else "checking",
            hint,
            port,
            process_id=proc_pid,
            window_title=joined,
            preview_b64=preview_b64,
        )
        time.sleep(0.45)

    chunk = ""
    j_out, j_chunk = _quick_journal_probe(port_dir, login, journal_since)
    if j_out is True:
        return True, JOURNAL_OK_MSG, j_chunk
    if j_out is False:
        cleanup_mt5_after_login_fail(port, payload, port_dir)
        send_connect_result(
            payload,
            "failed_auth",
            JOURNAL_FAIL_MSG,
            port,
            process_id=proc_pid,
            journal_evidence=j_chunk,
        )
        return False, JOURNAL_FAIL_MSG, j_chunk
    if saw_window_verified:
        return True, "window verified", last_title or chunk
    return False, JOURNAL_TIMEOUT_MSG, chunk


def start_mt5_bot(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    PRO MT5 Engine V2:
    - exact PORT isolation
    - ยืนยันล็อกอินสำเร็จเฉพาะจาก Journal: เลข login + "authorized on" เท่านั้น
    """
    port = payload_get(payload, "port", "port_no", "portNumber", "vpsPortNumber", "folderPort", "portSlot")
    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    server = resolve_mt5_server(payload)
    bot = payload_get(payload, "botCode", default="LOGIN_ONLY")
    if not port:
        raise RuntimeError("payload.port is required")
    if not login:
        raise RuntimeError("payload.mt5Login is required")
    if not password:
        raise RuntimeError("payload.mt5Password is required")

    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    config_file = mt5_startup_ini_path(port_dir)
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    log(f"USING PORT DIR={port_dir}")
    log(f"MT5 TERMINAL={terminal}")

    config_file = write_mt5_login_ini(port_dir, login, password, server)

    # ====================================
    # BLOCK SAME LOGIN ON ANOTHER PORT (not this port_dir)
    # cmdline ไม่มีเลข login — ใช้ window title หลังล็อกอินแล้วเท่านั้น
    # ====================================
    def _norm_path(p: str) -> str:
        try:
            return os.path.normcase(os.path.normpath(str(p or "")))
        except Exception:
            return str(p or "").strip().lower()

    port_self_n = _norm_path(str(port_dir))

    for p in list(iter_terminal_processes()):
        try:
            exe = p.info.get("exe") or ""
            exe_n = _norm_path(exe)
            if port_self_n and exe_n and exe_n.startswith(port_self_n):
                continue
            args = p.info.get("cmdline") or []
            if port_self_n and any(port_self_n in _norm_path(str(a)) for a in args if a):
                continue
            cmd_low = " ".join(args).lower()
            port_dir_low = str(port_dir).rstrip("\\/").lower()
            if port_dir_low and port_dir_low in cmd_low:
                continue

            title_text = ""
            try:
                ps = f"(Get-Process -Id {p.pid} -ErrorAction SilentlyContinue).MainWindowTitle"
                title_text = _run_powershell(ps, timeout=3)
            except Exception:
                pass

            if login and title_text and title_text.strip() and login in title_text:
                log(
                    f"BLOCK DUPLICATE LOGIN OTHER PORT login={login} pid={p.pid} "
                    f"title={(title_text or '')[:80]}"
                )
                send_connect_result(
                    payload,
                    "failed_auth",
                    f"MT5 login={login} กำลังทำงานอยู่ใน PORT อื่น กรุณาปิดก่อน",
                    port,
                )
                raise RuntimeError(f"MT5 login already running on another port login={login}")

        except RuntimeError:
            raise
        except Exception:
            pass

    def launch_mt5(reason: str) -> Optional[subprocess.Popen]:
        try:
            stop_mt5_port_only(port, payload)
        except Exception as e:
            log(f"STOP OLD MT5 ERROR: {e}")
        time.sleep(0.6)
        # ล้าง journal เก่าของ PORT นี้ก่อนเริ่ม attempt ใหม่
        # เพื่อไม่ให้ backend อ่าน authorized ของรอบก่อนมาฟันธง success ผิดบัญชี
        clear_mt5_logs(port_dir)
        clear_mt5_login_cache(port_dir)
        write_mt5_login_ini(port_dir, login, password, server)
        cfg = mt5_startup_ini_path(port_dir)
        args = [str(terminal), "/portable", f"/config:{cfg}"]
        log(f"START MT5 V2 reason={reason} args={args} cwd={port_dir}")
        token = acquire_login_ui_lock(timeout_sec=45)
        try:
            proc = _popen_hidden(args, cwd=str(port_dir))
            time.sleep(0.9)
            automate_mt5_login_server_form(
                login,
                password,
                server,
                port_dir=port_dir,
                process_id=(proc.pid if proc else None),
            )
        finally:
            release_login_ui_lock(token)
        return proc

    journal_since = time.time()
    proc = launch_mt5("initial")
    proc_pid = proc.pid if proc else None
    send_connect_result(
        payload,
        "starting",
        "กำลังเปิดหน้าจอ MT5 บน VPS — ตรวจสอบเลขบัญชีบน title bar",
        port,
        process_id=proc_pid,
    )

    journal_timeout = int(os.getenv("AVELQUA_JOURNAL_TIMEOUT_SEC", "28"))
    log(f"MT5 LOGIN VERIFY PORT={port} LOGIN={login} timeout_sec={journal_timeout}")

    ok, msg, journal_chunk = wait_mt5_login_hybrid(
        port, payload, port_dir, login, journal_since, proc_pid, journal_timeout
    )
    titles = " | ".join(mt5_window_titles(port, payload))
    preview_final = capture_mt5_window_base64(port, payload)

    if not ok:
        if msg == JOURNAL_TIMEOUT_MSG:
            pending_msg = "กำลังรอ verifier ยืนยันเลขบัญชีจาก Journal / MT5 API..."
            send_connect_result(
                payload,
                "checking",
                pending_msg,
                port,
                process_id=proc_pid,
                journal_evidence=journal_chunk,
                window_title=titles,
                preview_b64=preview_final,
            )
            return {
                "action": "run_mt5_bot",
                "status": "started",
                "port": port,
                "login": login,
                "server": server,
                "bot": bot,
                "config": str(config_file),
                "terminal": str(terminal),
                "journalEvidence": journal_chunk,
                "verificationPending": True,
                "loginVerified": False,
            }
        try:
            kill_mt5_by_folder(port_dir)
        except Exception as e:
            log(f"kill failed login mt5 error: {e}")
        try:
            stop_mt5_port_only(port, payload)
        except Exception as e:
            log(f"stop_mt5_port_only after failed login: {e}")
        remove_mt5_login_ini(port_dir)
        clear_mt5_login_cache(port_dir)
        send_connect_result(
            payload,
            "failed_auth" if msg == JOURNAL_FAIL_MSG else "failed",
            msg,
            port,
            process_id=None,
            journal_evidence=journal_chunk,
            window_title=titles,
            preview_b64=preview_final,
        )
        raise RuntimeError(msg)

    journal_final = journal_chunk or ""
    verification_pending = "window verified" in (msg or "").lower()
    if not verification_pending:
        ok2, msg2, journal_chunk2 = check_mt5_journal_login_result(
            port_dir, login, timeout_sec=5, since_ts=journal_since
        )
        if not ok2 and not journal_final:
            fail_final = msg2 or JOURNAL_FAIL_MSG
            if fail_final == JOURNAL_FAIL_MSG:
                try:
                    kill_mt5_by_folder(port_dir)
                    stop_mt5_port_only(port, payload)
                except Exception:
                    pass
                remove_mt5_login_ini(port_dir)
                send_connect_result(
                    payload,
                    "failed_auth",
                    fail_final,
                    port,
                    process_id=None,
                    journal_evidence=journal_chunk2,
                    window_title=titles,
                    preview_b64=preview_final,
                )
                raise RuntimeError(fail_final)
            verification_pending = True
        journal_final = journal_chunk2 or journal_final

    if verification_pending:
        pending_msg = "กำลังรอ verifier ยืนยันเลขบัญชีจาก Journal / MT5 API..."
        send_connect_result(
            payload,
            "checking",
            pending_msg,
            port,
            process_id=proc_pid,
            journal_evidence=journal_final,
            window_title=titles,
            preview_b64=preview_final,
            window_verified=True,
            schedule_metric_retry=False,
        )
        return {
            "action": "run_mt5_bot",
            "status": "started",
            "port": port,
            "login": login,
            "server": server,
            "bot": bot,
            "config": str(config_file),
            "terminal": str(terminal),
            "journalEvidence": journal_final,
            "verificationPending": True,
            "loginVerified": False,
            "windowVerified": True,
        }

    success_message = JOURNAL_OK_MSG
    send_connect_result(
        payload,
        "connected",
        success_message,
        port,
        process_id=proc_pid,
        journal_evidence=journal_final,
        window_title=titles,
        preview_b64=preview_final,
        window_verified=True,
    )
    log(f"LOGIN OK PORT={port} LOGIN={login} MESSAGE={success_message}")
    return {
        "action": "run_mt5_bot",
        "status": "started",
        "port": port,
        "login": login,
        "server": server,
        "bot": bot,
        "config": str(config_file),
        "terminal": str(terminal),
        "journalEvidence": journal_final,
        "journalVerified": True,
        "loginVerified": True,
    }

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
    content = _read_log_tail(full, max_bytes=262144)
    return {"action": "port_read_file", "port": port, "file_path": str(full), "content": content}


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


def _ea_file_candidates(bot_code: str) -> List[str]:
    code = str(bot_code or "").strip()
    names: List[str] = []
    if not code:
        return names
    aliases = {
        "SNIPER-DEMO": ["sniper-demo.ex5", "sniper_demo.ex5", "BOT.ex5", "BOT.mq5"],
        "SNIPER_DEMO": ["sniper-demo.ex5", "sniper_demo.ex5", "BOT.ex5"],
        "BOT_TEST": ["BOT_Test.ex5", "BOT.ex5", "BOT.mq5", "sniper-demo.ex5"],
        "AK-SNIPER-VIP-VER4.0": ["AK-SNIPER-VIP-VER4.0.ex5", "AK_SNIPER_VIP_VER4.0.ex5"],
        "AK-SNIPER": ["AK-SNIPER-VIP-VER4.0.ex5"],
        "PA-SNIPER-VER2.0": ["PA-SNIPER-VER2.0.ex5", "PA_SNIPER_VER2.0.ex5"],
        "PA-SNIPER": ["PA-SNIPER-VER2.0.ex5"],
        "5PA-SNIPER": ["5PA-SNIPER.ex5", "5PA_SNIPER.ex5"],
    }
    key = code.upper().replace(" ", "")
    for alt in aliases.get(key, []):
        names.append(alt)
    names.append(f"{code}.ex5")
    names.append(f"{code}.mq5")
    if "." not in code:
        names.append(f"{code.replace('-', '_')}.ex5")
    out: List[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


def _ea_num(v: Any, default: float = 0.0) -> float:
    try:
        n = float(v)
        return n if n == n else default
    except Exception:
        return default


def _ea_fmt(v: Any) -> str:
    n = _ea_num(v, 0.0)
    if abs(n - round(n)) < 1e-9:
        return str(int(round(n)))
    return f"{n:.2f}".rstrip("0").rstrip(".")


def _ea_magic_number(payload: Dict[str, Any]) -> int:
    base = 2122000
    bot_code = str(payload_get(payload, "botCode", "eaName", "bot_code") or "").strip().upper()
    checksum = sum(ord(ch) for ch in bot_code[:24])
    inst = int(_ea_num(payload_get(payload, "instanceId", "instance_id"), 0))
    return base + ((checksum + inst) % 700000)


def _default_ea_set_payload(payload: Dict[str, Any]) -> Tuple[str, str]:
    preset = payload_get(payload, "presetRow", "preset_row") or {}
    runtime = payload_get(payload, "eaRuntime", "ea_runtime") or {}
    if not isinstance(preset, dict):
        preset = {}
    if not isinstance(runtime, dict):
        runtime = {}
    bot_code = str(payload_get(payload, "botCode", "eaName", "bot_code") or "BOT").strip() or "BOT"
    trade_level = str(payload_get(payload, "tradeLevel", "trade_level") or "medium").strip().lower() or "medium"
    capital = int(round(_ea_num(payload_get(payload, "capitalUsed", "capital"), 0)))
    file_name = str(payload_get(payload, "eaSetFileName", "ea_set_file_name") or "").strip()
    if not file_name:
        safe_bot = re.sub(r"[^A-Za-z0-9_.-]+", "-", bot_code).strip("-") or "BOT"
        file_name = f"Avelqua_{safe_bot}_{trade_level}_{capital or 0}.set"
    if not file_name.lower().endswith(".set"):
        file_name = f"{file_name}.set"

    lot = _ea_num(payload_get(payload, "lot"), _ea_num(preset.get("lot_size"), 0.01))
    lot_plus = _ea_num(payload_get(payload, "lotPlus"), _ea_num(preset.get("lot_plus"), lot))
    t_start = _ea_num(payload_get(payload, "tStart"), _ea_num(preset.get("t_start"), 0))
    t_stop = _ea_num(payload_get(payload, "tStop"), _ea_num(preset.get("t_stop"), 0))
    pip_step = _ea_num(payload_get(payload, "pipStep"), _ea_num(preset.get("pip_step"), 345))
    tp_avg = _ea_num(payload_get(payload, "takeProfitAverage"), _ea_num(preset.get("take_profit_average"), 100))
    cut_loss_pct = _ea_num(runtime.get("cutLossPct"), 100)

    lines = [
        "; Avelqua - auto-generated EA preset",
        f"; bot={bot_code} level={trade_level} capital={capital or 0}",
        f"InpSoftClose=0||0||0||1||1||N",
        f"InpLotSize={_ea_fmt(lot)}||0.02||0.01||100||0.01||N",
        f"InpLotPlus={_ea_fmt(lot_plus)}||0.02||0.01||100||0.01||N",
        f"InpPipStep={_ea_fmt(pip_step)}||345||10||2000||1||N",
        f"InpTakeProfitAverage={_ea_fmt(tp_avg)}||100||10||5000||1||N",
        f"InpTrailingStartMoney={_ea_fmt(t_start)}||8||0||500||0.1||N",
        f"InpTrailingStopMoney={_ea_fmt(t_stop)}||5||0||500||0.1||N",
        f"InpCutLossPct={_ea_fmt(cut_loss_pct)}||100||1||100||1||N",
        f"InpMagicNumber={_ea_magic_number(payload)}||{_ea_magic_number(payload)}||1||999999999||1||N",
    ]
    if runtime:
        lines.extend([
            f"InpDailyProfitTarget={_ea_fmt(runtime.get('dailyProfitTarget', 0))}||0||0||100000||1||N",
            f"InpDailyLossLimit={_ea_fmt(runtime.get('dailyLossLimit', 0))}||0||0||100000||1||N",
            f"InpMaxDailyCommands={_ea_fmt(runtime.get('maxDailyCommands', 30000))}||30000||100||100000||1||N",
        ])
    return file_name, "\r\n".join(lines) + "\r\n"


def _write_ea_preset_files(port_dir: Path, payload: Dict[str, Any], experts_dir: Path) -> Dict[str, Any]:
    content = str(payload_get(payload, "eaSetContent", "ea_set_content") or "").strip()
    file_name = str(payload_get(payload, "eaSetFileName", "ea_set_file_name") or "").strip()
    if not content or not file_name:
        file_name, content = _default_ea_set_payload(payload)
    if not content or not file_name:
        return {"ok": False, "reason": "no_ea_set_content"}

    rel_paths = payload_get(payload, "eaSetPaths", "ea_set_paths") or []
    if not isinstance(rel_paths, list):
        rel_paths = []

    default_targets = [
        port_dir / "MQL5" / "Presets" / file_name,
        port_dir / "MQL5" / "Presets" / "Experts" / file_name,
        experts_dir / file_name,
        port_dir / "MQL5" / "Profiles" / file_name,
    ]
    written: List[str] = []
    seen = set()

    def _write_one(target: Path) -> None:
        key = str(target).lower()
        if key in seen:
            return
        seen.add(key)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", errors="ignore")
            written.append(str(target))
            log(f"EA SET WRITTEN {target}")
        except Exception as e:
            log(f"EA SET WRITE ERROR {target}: {e}")

    for rel in rel_paths:
        try:
            rel_s = str(rel).replace("/", os.sep).strip()
            if rel_s:
                _write_one(port_dir / rel_s)
        except Exception:
            pass
    for t in default_targets:
        _write_one(t)

    try:
        run_json = {
            "instanceId": payload_get(payload, "instanceId", "instance_id"),
            "accountId": payload_get(payload, "accountId", "account_id"),
            "botCode": payload_get(payload, "botCode", "eaName", "bot_code"),
            "symbol": payload_get(payload, "symbol", default="XAUUSD"),
            "eaSetFileName": file_name,
            "eaAttachHint": payload_get(payload, "eaAttachHint", "ea_attach_hint"),
            "tradeLevel": payload_get(payload, "tradeLevel", "trade_level"),
            "lot": payload_get(payload, "lot"),
            "capitalUsed": payload_get(payload, "capitalUsed", "capital"),
            "writtenAt": datetime.now().isoformat(timespec="seconds"),
        }
        files_dir = port_dir / "MQL5" / "Files"
        files_dir.mkdir(parents=True, exist_ok=True)
        (files_dir / "avelqua_run.json").write_text(
            json.dumps(run_json, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append(str(files_dir / "avelqua_run.json"))
    except Exception as e:
        log(f"avelqua_run.json write error: {e}")

    return {"ok": len(written) > 0, "fileName": file_name, "written": written}


def _verify_ea_in_experts_dir(experts_dir: Path, bot_code: str) -> Dict[str, Any]:
    experts_dir = Path(experts_dir)
    experts_dir.mkdir(parents=True, exist_ok=True)
    found: List[str] = []
    missing: List[str] = []
    code = str(bot_code or "").strip()
    for name in _ea_file_candidates(code):
        p = experts_dir / name
        if p.exists():
            found.append(str(p))
        else:
            missing.append(name)
    if not found and code and experts_dir.is_dir():
        want = code.lower()
        for ex5 in experts_dir.glob("*.ex5"):
            if ex5.stem.lower() == want:
                found.append(str(ex5))
                break
    return {
        "experts_dir": str(experts_dir),
        "found": found,
        "missing": missing,
        "ok": len(found) > 0,
    }


def _pick_launchable_ea_file(ea_info: Dict[str, Any]) -> Optional[Path]:
    found = ea_info.get("found") or []
    for raw in found:
        try:
            p = Path(str(raw))
            if p.suffix.lower() == ".ex5" and p.exists():
                return p
        except Exception:
            continue
    for raw in found:
        try:
            p = Path(str(raw))
            if p.suffix.lower() == ".mq5":
                ex5 = p.with_suffix(".ex5")
                if ex5.exists():
                    return ex5
        except Exception:
            continue
    return None


def _sync_ea_source_file(experts_dir: Path, payload: Dict[str, Any], bot_code: str) -> Dict[str, Any]:
    content = str(payload_get(payload, "eaSourceContent", "ea_source_content") or "")
    if not content.strip():
        return {"requested": False, "ok": True}

    file_name = str(payload_get(payload, "eaSourceFileName", "ea_source_file_name") or "").strip()
    if not file_name:
        safe_bot = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(bot_code or "BOT")).strip("-") or "BOT"
        file_name = f"{safe_bot}.mq5"
    if not file_name.lower().endswith(".mq5"):
        file_name = f"{file_name}.mq5"

    target = experts_dir / file_name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", errors="ignore")
    log(f"EA SOURCE WRITTEN {target}")
    return {"requested": True, "ok": True, "sourceFile": str(target), "fileName": file_name}


def _compile_ea_source(port_dir: Path, mq5_path: Path) -> Dict[str, Any]:
    metaeditor = port_dir / "MetaEditor64.exe"
    if not metaeditor.exists():
        return {"ok": False, "reason": "metaeditor_missing", "metaeditor": str(metaeditor)}

    logs_dir = port_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_file = logs_dir / f"metaeditor-{mq5_path.stem}-{stamp}.log"
    ex5_path = mq5_path.with_suffix(".ex5")
    prev_mtime = ex5_path.stat().st_mtime if ex5_path.exists() else 0.0

    creationflags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW

    try:
        proc = subprocess.run(
            [str(metaeditor), f"/compile:{mq5_path}", f"/log:{log_file}"],
            cwd=str(port_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="ignore",
            timeout=120,
            creationflags=creationflags,
        )
    except Exception as e:
        return {"ok": False, "reason": "compile_exec_failed", "message": str(e), "logFile": str(log_file)}

    time.sleep(1)
    log_tail = ""
    if log_file.exists():
        try:
            log_tail = _read_log_tail(log_file, max_bytes=32768)
        except Exception:
            log_tail = ""

    compiled = False
    if ex5_path.exists():
        try:
            compiled = ex5_path.stat().st_size > 0 and ex5_path.stat().st_mtime >= prev_mtime
        except Exception:
            compiled = ex5_path.stat().st_size > 0

    if not compiled and "0 error(s), 0 warning(s)" in log_tail.lower():
        compiled = ex5_path.exists()

    result = {
        "ok": compiled,
        "sourceFile": str(mq5_path),
        "ex5File": str(ex5_path),
        "logFile": str(log_file),
        "exitCode": getattr(proc, "returncode", None),
        "logTail": log_tail[-4000:],
    }
    if compiled:
        log(f"EA SOURCE COMPILED mq5={mq5_path} ex5={ex5_path} exit_code={proc.returncode}")
    else:
        log(f"EA SOURCE COMPILE FAILED mq5={mq5_path} exit_code={proc.returncode} log={log_file}")
    return result


def _mt5_startup_expert_name(port_dir: Path, expert_file: Optional[Path]) -> str:
    if not expert_file:
        return ""
    try:
        experts_root = (port_dir / "MQL5" / "Experts").resolve()
        rel = expert_file.resolve().relative_to(experts_root)
        return str(rel).replace("/", "\\")
    except Exception:
        return expert_file.name


def _ea_live_status_for_payload(port_dir: Path, payload: Optional[Dict[str, Any]], running: bool) -> str:
    if not running:
        return "stopped"
    bot_code = str(payload_get(payload or {}, "botCode", "eaName", "bot_code") or "").strip()
    rel = str(
        payload_get(payload or {}, "expertsRelative", "experts_relative", default=r"MQL5\Experts\Trading Bot")
        or r"MQL5\Experts\Trading Bot"
    )
    experts_dir = port_dir / Path(rel.replace("\\", os.sep))
    ea_info = _verify_ea_in_experts_dir(experts_dir, bot_code)
    return "ready" if _pick_launchable_ea_file(ea_info) else "attach_required"


def _is_modern_run_bot_payload(payload: Dict[str, Any]) -> bool:
    if payload_get(payload, "instanceId", "instance_id"):
        return True
    action = str(payload_get(payload, "action", "commandType") or "").lower()
    return action in ("run_bot", "restart_ea", "run_mt5_bot", "restart_mt5_bot")


def run_bot_command(payload: Dict[str, Any]) -> Dict[str, Any]:
    port = payload_get(payload, "port", "portNumber", "port_no", "portSlot")
    if not port:
        raise RuntimeError("payload.port is required")

    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    bot_code = str(payload_get(payload, "botCode", "eaName", "bot_code") or "").strip()
    rel = str(
        payload_get(payload, "expertsRelative", "experts_relative", default=r"MQL5\Experts\Trading Bot")
        or r"MQL5\Experts\Trading Bot"
    )
    experts_dir = port_dir / Path(rel.replace("\\", os.sep))
    source_sync = _sync_ea_source_file(experts_dir, payload, bot_code)
    compile_info = None
    if source_sync.get("requested"):
        compile_info = _compile_ea_source(port_dir, Path(source_sync["sourceFile"]))
        if not compile_info.get("ok"):
            detail = str(compile_info.get("logTail") or compile_info.get("message") or compile_info.get("reason") or "").strip()
            raise RuntimeError(f"EA compile failed for {bot_code}: {detail[:500]}")
    ea_info = _verify_ea_in_experts_dir(experts_dir, bot_code)
    launch_ea = _pick_launchable_ea_file(ea_info)
    if launch_ea is None:
        raise RuntimeError(f"EA file not found for {bot_code} in {experts_dir}")

    set_info = _write_ea_preset_files(port_dir, payload, experts_dir)
    if not set_info.get("ok"):
        raise RuntimeError("EA preset generation failed")

    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    server = str(payload_get(payload, "serverName", "server") or LOCKED_MT5_SERVER).strip() or LOCKED_MT5_SERVER
    symbol = str(payload_get(payload, "symbol", default="XAUUSD") or "XAUUSD").strip() or "XAUUSD"
    period = str(payload_get(payload, "period", "chartPeriod", default=MT5_RUNBOT_PERIOD) or MT5_RUNBOT_PERIOD).strip().upper()
    startup_expert = _mt5_startup_expert_name(port_dir, launch_ea)
    startup_set = str(set_info.get("fileName") or "").strip()

    write_avelqua_trading_gate(port_dir, True, payload)
    patch_mt5_experts_config(port_dir, True)

    if login and password:
        write_mt5_login_ini(
            port_dir,
            login,
            password,
            server,
            allow_expert_trading=True,
            startup_expert=startup_expert,
            startup_symbol=symbol,
            startup_period=period,
            startup_expert_parameters=startup_set,
        )

    if mt5_running_for_port_dir(port_dir):
        stop_mt5_port_only(port, payload)
        time.sleep(2)

    cfg = mt5_startup_ini_path(port_dir)
    if not cfg.exists():
        raise RuntimeError("MT5 startup.ini missing - connect MT5 from web first")

    proc = _popen_hidden([str(terminal), "/portable", f"/config:{cfg}"], cwd=str(port_dir))
    proc_pid = proc.pid if proc else None
    time.sleep(5)

    snap = account_snapshot(port, payload)
    bal = snap.get("balance")
    eq = snap.get("equity")
    profit = None
    if bal is not None and eq is not None:
        try:
            profit = round(float(eq) - float(bal), 2)
        except Exception:
            profit = None

    instance_id = payload_get(payload, "instanceId", "instance_id")
    send_mt5_live_status(
        instance_id,
        port,
        "running",
        "ready",
        bal or 0,
        eq or 0,
        "",
        payload,
        profit=profit,
    )
    send_account_metrics(payload, bal, eq, snap.get("currency", ""))
    schedule_account_metrics_retry(payload, port, (8, 20, 45, 90))
    threading.Thread(target=lambda: (time.sleep(2), enable_mt5_algo_trading_uia(port, payload)), daemon=True).start()
    threading.Thread(target=lambda: (time.sleep(6), watch_mt5_instance(payload)), daemon=True).start()

    return {
        "action": "run_bot",
        "ok": True,
        "status": "running",
        "message": f"BOT auto-attached on {symbol} ({period}) and preset loaded",
        "folderPath": str(port_dir),
        "portNumber": normalize_port(port),
        "mt5Running": True,
        "keepMt5Open": True,
        "launched": True,
        "processId": proc_pid,
        "balance": bal,
        "equity": eq,
        "profit": profit,
        "eaStatus": "ready",
        "botCode": bot_code,
        "expertsPath": str(experts_dir),
        "eaFiles": ea_info,
        "eaSet": set_info,
        "eaSource": source_sync,
        "eaCompile": compile_info,
        "instanceId": instance_id,
    }


def restart_ea_command(payload: Dict[str, Any]) -> Dict[str, Any]:
    return run_bot_command(payload)


def open_mt5_port_folder(payload: Dict[str, Any]) -> Dict[str, Any]:
    port = payload_get(payload, "port", "portNumber", "portSlot")
    port_dir = resolve_mt5_port_dir(port, payload)
    if os.name == "nt":
        subprocess.Popen(["explorer.exe", str(port_dir)], close_fds=True)
    return {"action": "port_open_folder", "port": port, "path": str(port_dir), "status": "opened"}


def restart_mt5_port(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}

    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    if login and password:
        return start_mt5_bot(payload)

    # ห้ามเปิด MT5 ด้วย INI เก่า (รหัสผ่านค้าง) — ต้องส่ง login+password มาด้วยเท่านั้น
    port_dir = resolve_mt5_port_dir(port, payload)
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        raise RuntimeError(f"terminal64.exe not found: {terminal}")

    stop_mt5_port_only(port, payload)
    log(f"RESTART MT5 SKIPPED stale INI PORT={port} (missing credentials in payload)")
    return {
        "action": "restart_mt5_bot",
        "port": port,
        "status": "stopped",
        "message": "ต้องเชื่อมต่อใหม่จากเว็บพร้อม Login/Password ล่าสุด (ไม่ใช้รหัสเก่าใน INI)",
        "terminal": str(terminal),
        "config": "",
    }


def remove_mt5_port_folder_safe(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    port_dir = resolve_mt5_port_dir(port, payload)
    stop_mt5_port_only(port, payload)
    time.sleep(1)
    shutil.rmtree(port_dir)
    return {"action": "delete_port", "port": port, "port_dir": str(port_dir), "status": "deleted"}


def send_mt5_live_status(
    instance_id: Any,
    port: Any,
    status: str,
    ea_status: str = "",
    balance: float = 0,
    equity: float = 0,
    error_text: str = "",
    payload: Optional[Dict[str, Any]] = None,
    profit: Any = None,
) -> None:
    try:
        bal_out = _metric_value(balance)
        eq_out = _metric_value(equity)
        profit_out = _profit_value(profit)
        if profit_out is None and bal_out is not None and eq_out is not None:
            try:
                profit_out = round(float(eq_out) - float(bal_out), 2)
            except Exception:
                profit_out = None
        body = {
            "instanceId": instance_id,
            "port": port,
            "accountId": payload_get(payload or {}, "accountId", "account_id") if payload else None,
            "status": status,
            "eaStatus": ea_status,
            "balance": bal_out,
            "equity": eq_out,
            "profit": profit_out,
            "error": error_text or "",
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
        port_dir = resolve_mt5_port_dir(port, payload)
        snap = account_snapshot(port, payload)
        bal = float(snap.get("balance") or 0)
        eq = float(snap.get("equity") or 0)
        profit = None
        if snap.get("balance") is not None and snap.get("equity") is not None:
            try:
                profit = round(float(snap.get("equity")) - float(snap.get("balance")), 2)
            except Exception:
                profit = None
        send_mt5_live_status(
            instance_id,
            port,
            "running" if st["running"] else "stopped",
            _ea_live_status_for_payload(port_dir, payload, bool(st["running"])),
            bal,
            eq,
            "",
            payload,
            profit=profit,
        )
        send_account_metrics(payload, snap.get("balance"), snap.get("equity"), snap.get("currency", ""))
    except Exception as e:
        log(f"WATCH INSTANCE ERROR: {e}")


def poll_running_mt5_list() -> None:
    # TEMP: Watchdog / AUTO RECONNECT OFF — MT5 only when web sends command via /queue.
    # No watch_mt5_processes(); no start_mt5_v2(...) / start_mt5_command(...) from this loop.
    # try:
    #     running = api("GET", "https://trading.avelqua.com/app/mt5/agent-running-list")
    #     if running.get("ok") is True:
    #         for item in running.get("items", []):
    #             # watch_mt5_processes()
    #             # watch_mt5_instance(item)
    # except Exception as e:
    #     log(f"WATCH MT5 ERROR: {e}")
    pass


def restart_service_later(service_name: str, exit_process: bool = True) -> None:
    """รีสตาร์ท Windows Service แล้วออกจาก process ปัจจุบันให้ SCM โหลด agent.py ใหม่"""
    if os.name != "nt":
        log("SERVICE RESTART SKIPPED: not Windows")
        return
    ps = (
        f"Start-Sleep -Seconds 2; "
        f"Restart-Service -Name '{service_name}' -Force -ErrorAction SilentlyContinue; "
        f"if (-not (Get-Service -Name '{service_name}' -ErrorAction SilentlyContinue | "
        f"Where-Object {{ $_.Status -eq 'Running' }}) ) {{ "
        f"net stop {service_name}; net start {service_name} }}"
    )
    subprocess.Popen(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    log(f"SERVICE RESTART SCHEDULED name={service_name} exit_process={exit_process}")

    if exit_process:
        def _exit_after_delay() -> None:
            time.sleep(4)
            log("AGENT EXIT after deploy/restart — loading new agent.py on service start")
            os._exit(0)

        import threading

        threading.Thread(target=_exit_after_delay, daemon=True).start()


def _sync_agent_env_build_id(build_id: str) -> None:
    """อัปเดต .env ให้ AVELQUA_AGENT_VERSION ตรงกับ build จริง (กัน heartbeat รายงานเวอร์ชันเก่าค้าง)"""
    try:
        lines: List[str] = []
        if ENV_FILE.exists():
            lines = ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
        key = "AVELQUA_AGENT_VERSION"
        found = False
        out: List[str] = []
        for line in lines:
            if line.strip().startswith(f"{key}="):
                out.append(f"{key}={build_id}")
                found = True
            else:
                out.append(line)
        if not found:
            out.append(f"{key}={build_id}")
        ENV_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")
        os.environ[key] = build_id
        log(f"AGENT ENV SYNC {key}={build_id}")
    except Exception as e:
        log(f"AGENT ENV SYNC ERROR: {e}")


try:
    _sync_agent_env_build_id(AGENT_BUILD_ID)
except Exception:
    pass


def _fetch_agent_script_from_url(script_url: str) -> str:
    url = str(script_url or "").strip()
    if not url:
        return ""
    log(f"AGENT DEPLOY DOWNLOAD {url}")
    r = requests.get(
        url,
        headers={
            "x-agent-token": AGENT_TOKEN,
            "Authorization": f"Bearer {AGENT_TOKEN}",
            "Accept": "text/plain, application/json, */*",
            "User-Agent": f"AvelquaPythonAgent/{AGENT_BUILD_ID}",
        },
        timeout=120,
    )
    r.raise_for_status()
    text = r.text or ""
    if not text.strip():
        raise RuntimeError("downloaded agent script is empty")
    return text


def update_agent_script(payload: Dict[str, Any]) -> Dict[str, Any]:
    agent_path = Path(
        str(payload_get(payload, "agent_path", "targetPath", "file_path", default=str(AGENT_FILE)) or AGENT_FILE)
    )
    service_name = str(
        payload_get(payload, "service_name", "serviceName", default=SERVICE_NAME) or SERVICE_NAME
    )
    script_url = str(payload_get(payload, "scriptUrl", "script_url", "url", default="") or "").strip()
    content = str(payload_get(payload, "content", default="") or "")
    if script_url:
        try:
            content = _fetch_agent_script_from_url(script_url)
        except Exception as e:
            if not content.strip():
                raise RuntimeError(f"scriptUrl download failed: {e}") from e
            log(f"AGENT DEPLOY scriptUrl failed, use inline content: {e}")
    if not content.strip():
        raise RuntimeError("payload.content or payload.scriptUrl is required")

    # Validate Python syntax before writing.
    compile(content, str(agent_path), "exec")

    backup = agent_path.with_suffix(agent_path.suffix + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    if agent_path.exists():
        shutil.copy2(agent_path, backup)
    agent_path.parent.mkdir(parents=True, exist_ok=True)

    tmp = agent_path.with_suffix(agent_path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(agent_path)

    build_id = AGENT_BUILD_ID
    m = re.search(r'AGENT_BUILD_ID\s*=\s*["\']([^"\']+)["\']', content)
    if m:
        build_id = m.group(1).strip()
    _sync_agent_env_build_id(build_id)

    log(f"PYTHON AGENT UPDATED path={agent_path} backup={backup} build={build_id}")

    restart_service_later(service_name)

    return {
        "action": "update_agent_script",
        "updated": True,
        "agent_path": str(agent_path),
        "backup": str(backup),
        "service_name": service_name,
        "agent_build_id": build_id,
        "restart": "scheduled",
    }


def read_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    paths: List[str] = []
    primary = str(payload_get(payload, "file_path") or "").strip()
    if primary:
        paths.append(primary)
    extra = payload.get("file_paths") or payload.get("filePaths") or []
    if isinstance(extra, list):
        paths.extend(str(p).strip() for p in extra if str(p).strip())
    seen = set()
    uniq: List[Path] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(Path(p))

    for path in uniq:
        if not path.exists():
            continue
        content = _read_log_tail(path, max_bytes=262144)
        if content.strip():
            return {"file_path": str(path), "content": content}
    return {"file_path": primary, "content": ""}


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

        elif ctype in ("connect_mt5", "login_mt5", "run_mt5_bot", "run_mt5"):
            spawn_connect_worker(cmd_id, ctype, payload)
            return

        elif ctype in ("stop_mt5", "stop_mt5_bot", "force_stop_mt5", "kill_mt5", "stop_port"):
            folder = payload_get(payload, "folder_path", "vpsFolderPath")

            if folder:
                command_result(cmd_id, True, stop_mt5_by_folder(folder))
            else:
                port = payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort")
                command_result(cmd_id, True, stop_mt5_port_only(port, payload))

        elif ctype in ("sync_mt5_account", "account_snapshot", "read_account_metrics"):
            port = payload_get(payload, "port", "portNumber", "port_no", "portSlot")
            snap: Dict[str, Any] = {"balance": None, "equity": None, "currency": ""}
            try:
                snap = account_snapshot(port, payload)
            except Exception as sync_err:
                log(f"ACCOUNT SNAPSHOT ERROR: {sync_err}")
                snap["error"] = str(sync_err)[:500]
            command_result(cmd_id, True, {"action": ctype, "snapshot": snap, **snap})

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
            if _is_modern_run_bot_payload(payload):
                res = restart_ea_command(payload)
                send_mt5_live_status(instance_id, port, "running", "ready", 0, 0, "", payload)
            else:
                res = restart_mt5_port(port, payload)
                send_mt5_live_status(instance_id, port, "running", "manual_restart", 0, 0, "", payload)
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
        if ctype in ("connect_mt5", "login_mt5", "run_mt5_bot", "run_mt5"):
            release_login_ui_lock_for_current_process()
            try:
                send_connect_result(payload, "failed", str(e))
            except Exception:
                pass
        command_result(cmd_id, False, {}, str(e))


def run_connect_worker(cmd_id: Any, ctype: str, payload: Dict[str, Any]) -> int:
    port = _worker_port_num(payload)
    try:
        log(f"CONNECT WORKER START port={port} cmd_id={cmd_id} type={ctype}")
        if ctype in ("run_mt5_bot", "run_mt5") and _is_modern_run_bot_payload(payload):
            command_result(cmd_id, True, run_bot_command(payload))
        else:
            command_result(cmd_id, True, start_mt5_bot(payload))
        return 0
    except Exception as e:
        log(f"CONNECT WORKER ERROR port={port} cmd_id={cmd_id}: {e}")
        release_login_ui_lock_for_current_process()
        try:
            if ctype in ("run_mt5_bot", "run_mt5") and _is_modern_run_bot_payload(payload):
                send_mt5_live_status(
                    payload_get(payload, "instanceId", "instance_id"),
                    port,
                    "failed",
                    "error",
                    0,
                    0,
                    str(e),
                    payload,
                )
            else:
                send_connect_result(payload, "failed", str(e))
        except Exception:
            pass
        command_result(cmd_id, False, {}, str(e))
        return 1
    finally:
        release_login_ui_lock_for_current_process()
        clear_worker_state(port, os.getpid())
        log(f"CONNECT WORKER STOP port={port} cmd_id={cmd_id} pid={os.getpid()}")

def main() -> None:
    log(f"PYTHON AGENT START Service={SERVICE_NAME} Computer={platform.node()} Server={SERVER_URL}")

    if AGENT_TOKEN == "PUT_YOUR_AGENT_TOKEN_HERE":
        log("ERROR: Please set AVELQUA_AGENT_TOKEN in C:\\avelqua-python-agent\\.env")

    last_hb = 0.0

    while True:
        try:
            clean_old_logs()
            reap_connect_workers()

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
                # TEMP: auto reconnect / agent-running-list watchdog off (was: poll_running_mt5_list())
                # poll_running_mt5_list()
                pass

            try:
                res = api("GET", "/queue")
                cmd = res.get("command")

                if cmd:
                    handle_command(cmd)

            except Exception as e:
                log(f"COMMAND POLL ERROR: {e}")

            time.sleep(int(os.getenv("AVELQUA_LOOP_SECONDS", "1")))

        except Exception as e:
            log(f"MAIN LOOP ERROR: {e}")
            time.sleep(int(os.getenv("AVELQUA_LOOP_SECONDS", "1")))

def main_entry() -> int:
    try:
        if len(sys.argv) >= 5 and sys.argv[1] == "--worker-connect":
            cmd_id = sys.argv[2]
            ctype = sys.argv[3]
            payload_raw = base64.b64decode(sys.argv[4].encode("ascii")).decode("utf-8", errors="ignore")
            payload = json.loads(payload_raw or "{}")
            return run_connect_worker(cmd_id, ctype, payload)
        main()
        return 0
    except KeyboardInterrupt:
        log("PYTHON AGENT STOP KeyboardInterrupt")
        return 0
    except Exception as exc:
        log(f"PYTHON AGENT FATAL: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main_entry())
