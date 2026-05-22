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

# Windows PowerShell มักใช้ cp1252 — กัน log/print ไทยแล้ว COMMAND POLL ERROR
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        try:
            import io

            if hasattr(sys.stdout, "buffer"):
                sys.stdout = io.TextIOWrapper(
                    sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
                )
            if hasattr(sys.stderr, "buffer"):
                sys.stderr = io.TextIOWrapper(
                    sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
                )
        except Exception:
            pass


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
AGENT_BUILD_ID = "2026-05-22-login-cli-v25"
# รายงานเวอร์ชันจากโค้ดจริง — ไม่ให้ .env เก่าค้างทำให้เว็บคิดว่ายังเป็น agent เก่า
AGENT_VERSION = AGENT_BUILD_ID
# ชื่อไฟล์ INI ในโฟลเดอร์แต่ละ PORT สำหรับ MT5 portable /config: (มาตรฐานโปรเจกต์: startUp.ini)
_MT5_LOGIN_INI = os.getenv("AVELQUA_MT5_LOGIN_INI", "startup.ini").strip()
MT5_LOGIN_INI_NAME = _MT5_LOGIN_INI if _MT5_LOGIN_INI else "startup.ini"
LEGACY_MT5_LOGIN_INI = "avelqua-login.ini"
# Windows: true = เปิด MT5 โชว์หน้าจอบน VPS (ตรวจรหัสผ่านได้จาก title bar / RDP)
SHOW_MT5_WINDOW = os.getenv("AVELQUA_MT5_SHOW_WINDOW", "true").lower() != "false"

AGENT_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ตัวอย่าง bytes_sent/recv ครั้งก่อน — คำนวณ Mbps ระหว่าง heartbeat
_NET_IO_SAMPLE: Dict[str, float] = {"ts": 0.0, "bytes_sent": 0.0, "bytes_recv": 0.0}


def has_journal_gate_marker(version_or_build: str) -> bool:
    v = str(version_or_build or "").strip()
    if not v:
        return False
    if v == AGENT_BUILD_ID:
        return True
    for marker in ("journal-gate", "equity-live", "algo-live", "run-bot-hot", "metrics-sync"):
        if marker in v:
            return True
    return False


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


def _safe_console_text(msg: str) -> str:
    if sys.platform == "win32":
        return str(msg).encode("ascii", errors="replace").decode("ascii")
    try:
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        return str(msg).encode(enc, errors="replace").decode(enc, errors="replace")
    except Exception:
        return str(msg).encode("ascii", errors="replace").decode("ascii")


def log(msg: str) -> None:
    text = f"{datetime.now():%Y-%m-%d %H:%M:%S} - {msg}"
    line = (text + "\n").encode("utf-8", errors="replace")
    try:
        if hasattr(sys.stdout, "buffer"):
            sys.stdout.buffer.write(line)
            sys.stdout.flush()
        else:
            print(_safe_console_text(text), flush=True)
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

def _shrink_command_result(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not result:
        return {}
    out: Dict[str, Any] = dict(result)
    for key in ("content", "journalEvidence", "journal_evidence", "text", "preview_b64"):
        val = out.get(key)
        if isinstance(val, str) and len(val) > 12000:
            out[key] = val[-12000:]
    return out


def command_result(cmd_id: Any, ok: bool = True, result: Optional[Dict[str, Any]] = None, error: str = "") -> None:
    try:
        body = {
            "ok": ok,
            "result": _shrink_command_result(result),
            "error": str(error or "")[:2000],
        }
        api("POST", f"/commands/{cmd_id}/result", body)
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
            os.getenv("AVELQUA_SELF_DEPLOY_ON_HEARTBEAT", "true").lower() not in ("0", "false", "no")
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
    if now - _LAST_SELF_DEPLOY_AT < float(os.getenv("AVELQUA_SELF_DEPLOY_COOLDOWN_SEC", "300")):
        return
    _LAST_SELF_DEPLOY_AT = now
    required = str(
        heartbeat_res.get("required_agent_version")
        or heartbeat_res.get("requiredAgentVersion")
        or AGENT_BUILD_ID
    ).strip()
    if required and required == AGENT_BUILD_ID:
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

        if m and int(m.group(1)) != n:
            log(f"PORT mismatch warning: selected={n} folder={p.name} — using folder_path from payload")

        return p

    # fallback แบบไม่ scan
    name = payload_get(payload, "vpsPortName")
    if name:
        p = MT5_ROOT / name
        if not p.exists():
            raise RuntimeError(f"PORT not found: {p}")
        return p

    n = normalize_port(port) if port not in (None, "") else 0
    if n > 0:
        for candidate in (
            MT5_ROOT / f"VPS-WIN-01-PORT-{n:02d}",
            MT5_ROOT / f"VPS-WIN-01-PORT-{n}",
            MT5_ROOT / f"PORT{n:02d}",
            MT5_ROOT / f"PORT{n}",
        ):
            if candidate.exists():
                return candidate
        # path มาตรฐานบน VPS (ยังไม่มีโฟลเดอร์ — ใช้สำหรับ stop/gate ไม่ต้อง error)
        return MT5_ROOT / f"VPS-WIN-01-PORT-{n:02d}"

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


def stop_bot_trading_only(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """หยุดการเทรด BOT — ปิด gate/Experts แต่ไม่ kill terminal64.exe"""
    port_dir = resolve_mt5_port_dir(port, payload)
    write_avelqua_trading_gate(port_dir, False, payload)
    patch_mt5_experts_config(port_dir, False)
    try:
        files_dir = port_dir / "MQL5" / "Files"
        files_dir.mkdir(parents=True, exist_ok=True)
        (files_dir / "avelqua_run.json").write_text(
            json.dumps(
                {
                    "phase": "bot_stopped",
                    "tradingEnabled": False,
                    "allowExpertTrading": False,
                    "updatedAt": datetime.now().isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        log(f"avelqua_run.json bot_stopped: {e}")

    snap = account_snapshot(port, payload)
    bal = snap.get("balance")
    eq = snap.get("equity")
    profit = snap.get("profit")
    instance_id = payload_get(payload, "instanceId", "instance_id")
    send_mt5_live_status(
        instance_id,
        port,
        "stopped",
        "trading_halted",
        bal or 0,
        eq or 0,
        "",
        payload,
        profit=profit,
    )

    mt5_open = mt5_running_for_port_dir(port_dir)
    return {
        "action": "stop_bot_trading",
        "ok": True,
        "message": "หยุดการเทรดแล้ว — โปรแกรม MT5 ยังเปิดอยู่",
        "port": port,
        "port_dir": str(port_dir),
        "mt5Running": mt5_open,
        "tradingEnabled": False,
        "instanceId": instance_id,
    }


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
    """ลบเฉพาะ cache บัญชี — เก็บ servers.dat/common.ini ไว้ให้ MT5 รู้ชื่อ Server"""
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


def write_mt5_login_ini(
    port_dir: Path,
    login: str,
    password: str,
    server: str,
    allow_expert_trading: bool = False,
) -> Path:
    """เขียน startUp.ini — ค่าเริ่มต้นไม่เปิดเทรดอัตโนมัติ (รอ Run BOT จากเว็บ)"""
    config_file = mt5_startup_ini_path(port_dir)
    for stale in (port_dir / LEGACY_MT5_LOGIN_INI, port_dir / "startup.ini", port_dir / "avelqua-login.ini"):
        if stale.is_file():
            try:
                if stale.resolve() != config_file.resolve():
                    stale.unlink()
                    log(f"REMOVE STALE INI {stale}")
            except Exception:
                pass
    trade_flag = "true" if allow_expert_trading else "false"
    ini = f"""[Common]
Login={login}
Password={password}
Server={server}
KeepPrivate=0
SavePassword=1
AutoConfiguration=false
CertInstall=0

[Experts]
AllowLiveTrading={trade_flag}
AllowDllImport=true
Enabled={trade_flag}
"""
    config_file.write_text(ini, encoding="utf-8", errors="ignore")
    for alias in (port_dir / "startup.ini", port_dir / "startUp.ini"):
        if alias.resolve() != config_file.resolve():
            try:
                alias.write_text(ini, encoding="utf-8", errors="ignore")
            except Exception:
                pass
    log(
        f"WRITE MT5 INI {config_file} LOGIN={login} SERVER={server} "
        f"PW_LEN={len(password)} EXPERT_TRADING={trade_flag}"
    )
    return config_file


def metaquotes_common_files_dir() -> Optional[Path]:
    """โฟลเดอร์ที่ EA อ่านเมื่อใช้ FileOpen(..., FILE_COMMON)"""
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
    """เขียน gate ทั้ง MQL5/Files ของ PORT และ Common (EA ใช้ FILE_COMMON)"""
    seen: set = set()
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
    """ไฟล์บอกสถานะว่าอนุญาตให้ EA เทรดหรือยัง (login=ปิด, Run BOT=เปิด)"""
    flag = "1" if enabled else "0"
    body = {
        "tradingEnabled": bool(enabled),
        "allowExpertTrading": bool(enabled),
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    if payload:
        body["instanceId"] = payload_get(payload, "instanceId")
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


def _patch_ini_experts_section(path: Path, enabled: bool) -> bool:
    """อัปเดต [Experts] ใน common.ini / settings.ini ของ MT5 portable"""
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
        out.extend(
            [
                "[Experts]",
                f"AllowLiveTrading={trade}",
                "AllowDllImport=true",
                f"Enabled={flag}",
            ]
        )
    else:
        if not seen_allow or not seen_en:
            idx = max(i for i, l in enumerate(out) if l.strip().lower() == "[experts]")
            insert = []
            if not seen_allow:
                insert.append(f"AllowLiveTrading={trade}")
            if not seen_dll:
                insert.append("AllowDllImport=true")
            if not seen_en:
                insert.append(f"Enabled={flag}")
            out[idx + 1 : idx + 1] = insert
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(out) + "\n", encoding="ascii", errors="ignore")
        return True
    except Exception as e:
        log(f"PATCH INI EXPERTS ERROR {path}: {e}")
        return False


def patch_mt5_experts_config(port_dir: Path, enabled: bool) -> None:
    for rel in ("config/common.ini", "config/settings.ini", "MQL5/config/common.ini"):
        p = port_dir / Path(rel.replace("/", os.sep))
        if _patch_ini_experts_section(p, enabled):
            log(f"PATCH EXPERTS enabled={enabled} file={p}")


def quarantine_chart_profiles_with_ea(port_dir: Path) -> None:
    """ย้าย chart ที่อาจแนบ EA ค้าง — Login เปิดกราฟใหม่ไม่รัน BOT อัตโนมัติ"""
    prof = port_dir / "MQL5" / "Profiles"
    if not prof.exists():
        return
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest_root = prof / f"_avelqua_quarantine_{stamp}"
    for rel in ("Charts", "charts", "LastProfile.ini", "lastprofile.ini"):
        src = prof / rel
        if not src.exists():
            continue
        try:
            dest_root.mkdir(parents=True, exist_ok=True)
            target = dest_root / rel
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink()
            shutil.move(str(src), str(target))
            log(f"QUARANTINE CHART PROFILE {src} -> {target}")
        except Exception as e:
            log(f"QUARANTINE CHART SKIP {src}: {e}")


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


def enforce_login_no_trading(
    port_dir: Path,
    port: Any,
    payload: Dict[str, Any],
    login: str,
    password: str,
    server: str,
) -> None:
    """หลัง Login สำเร็จ — ห้ามเทรดจนกว่าผู้ใช้กด Run BOT บนเว็บ"""
    write_avelqua_trading_gate(port_dir, False, payload)
    patch_mt5_experts_config(port_dir, False)
    try:
        quarantine_chart_profiles_with_ea(port_dir)
    except Exception as e:
        log(f"enforce_login quarantine: {e}")
    try:
        write_mt5_login_ini(port_dir, login, password, server, allow_expert_trading=False)
    except Exception as e:
        log(f"enforce_login_no_trading ini: {e}")
    try:
        files_dir = port_dir / "MQL5" / "Files"
        files_dir.mkdir(parents=True, exist_ok=True)
        (files_dir / "avelqua_run.json").write_text(
            json.dumps(
                {
                    "phase": "login_only",
                    "tradingEnabled": False,
                    "allowExpertTrading": False,
                    "updatedAt": datetime.now().isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        log(f"avelqua_run.json login_only: {e}")


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


def _parse_money_token(raw: str) -> Optional[float]:
    if raw is None:
        return None
    s = str(raw).strip().replace(" ", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def parse_account_metrics_from_text(text: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"balance": None, "equity": None, "profit": None, "currency": ""}
    if not text:
        return out
    bal_pats = [
        r"(?i)balance\s*[:=]\s*([0-9][0-9,.\s]*)",
        r"(?i)previous\s+balance[:\s]+([0-9][0-9,.\s]*)",
        r"(?i)new\s+balance[:\s]+([0-9][0-9,.\s]*)",
    ]
    eq_pats = [
        r"(?i)equity\s*[:=]\s*([0-9][0-9,.\s]*)",
        r"(?i)account\s+equity[:\s]+([0-9][0-9,.\s]*)",
    ]
    profit_pats = [
        r"(?i)(?:total\s+)?(?:floating\s+)?profit\s*[:=]\s*(-?[0-9][0-9,.\s]*)",
        r"(?i)profit/loss\s*[:=]\s*(-?[0-9][0-9,.\s]*)",
        r"(?i)profit\s+(-?[0-9][0-9,.\s]*)\s+USD",
    ]
    cur_pat = r"(?i)currency\s*[:=]\s*([A-Z]{3})"
    for pat in bal_pats:
        hits = list(re.finditer(pat, text))
        if hits:
            out["balance"] = _parse_money_token(hits[-1].group(1))
    for pat in eq_pats:
        hits = list(re.finditer(pat, text))
        if hits:
            out["equity"] = _parse_money_token(hits[-1].group(1))
    for pat in profit_pats:
        hits = list(re.finditer(pat, text))
        if hits:
            out["profit"] = _parse_money_token(hits[-1].group(1))
    mc = list(re.finditer(cur_pat, text))
    if mc:
        out["currency"] = mc[-1].group(1).upper()
    if out["equity"] is None and out["balance"] is not None and out["profit"] is not None:
        out["equity"] = round(float(out["balance"]) + float(out["profit"]), 2)
    return out


def collect_log_text_for_snapshot(port_dir: Path, max_files: int = 10) -> str:
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
        return ""
    files = sorted(files, key=lambda x: x.stat().st_mtime, reverse=True)[:max_files]
    chunks: List[str] = []
    for f in files:
        try:
            data = f.read_text(errors="ignore")
            chunks.append("\n".join(data.splitlines()[-400:]))
        except Exception:
            pass
    return "\n".join(chunks)


def account_snapshot_equity_file(port_dir: Path, max_age_sec: int = 0) -> Dict[str, Any]:
    """อ่านจาก MQL5/Files/avelqua_account.txt (AvelquaEquityPulse indicator)"""
    out: Dict[str, Any] = {"balance": None, "equity": None, "currency": ""}
    candidates = [
        port_dir / "MQL5" / "Files" / "avelqua_account.txt",
        port_dir / "MQL5" / "Files" / "avelqua_account.json",
    ]
    for p in candidates:
        if not p.exists():
            continue
        try:
            if max_age_sec > 0:
                age = time.time() - p.stat().st_mtime
                if age > max_age_sec:
                    continue
            raw = p.read_text(encoding="utf-8", errors="ignore").strip()
            if not raw:
                continue
            if p.suffix.lower() == ".json":
                data = json.loads(raw)
                out["balance"] = _parse_money_token(data.get("balance"))
                out["equity"] = _parse_money_token(data.get("equity"))
                out["currency"] = str(data.get("currency") or "")
            else:
                kv: Dict[str, str] = {}
                for line in raw.splitlines():
                    if "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    kv[k.strip().lower()] = v.strip()
                out["balance"] = _parse_money_token(kv.get("balance"))
                out["equity"] = _parse_money_token(kv.get("equity"))
                if kv.get("profit") and out["equity"] is None and out["balance"] is not None:
                    pr = _parse_money_token(kv.get("profit"))
                    if pr is not None:
                        out["equity"] = round(float(out["balance"]) + float(pr), 2)
                out["currency"] = str(kv.get("currency") or "").upper()
            if out.get("balance") or out.get("equity"):
                log(f"MT5 SNAPSHOT FILE {p.name} BALANCE={out.get('balance')} EQUITY={out.get('equity')}")
                return out
        except Exception as e:
            log(f"MT5 SNAPSHOT FILE ERROR {p}: {e}")
    return out


_LAST_ALGO_ENABLE: Dict[str, float] = {}


def enable_mt5_algo_trading_uia(port: Any, payload: Optional[Dict[str, Any]] = None) -> bool:
    """กดปุ่ม Algo Trading บนแถบเครื่องมือ MT5 (ต้องเป็นสีเขียว BOT ถึงเทรดได้)"""
    if os.name != "nt":
        return False
    key = str(normalize_port(port) or port or "")
    now = time.time()
    if key and now - _LAST_ALGO_ENABLE.get(key, 0) < 90:
        return False
    if key:
        _LAST_ALGO_ENABLE[key] = now
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        root = str(port_dir).replace("\\", "\\\\")
        login = str(payload_get(payload or {}, "mt5Login", "login") or "").strip()
        ps = f"""
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = '{root}'
$login = '{login}'
$proc = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {{
  $p = $_.Path
  if (-not $p) {{ return $false }}
  if ($p -like "*$root*") {{ return $true }}
  if ($login -and $_.MainWindowTitle -match [regex]::Escape($login)) {{ return $true }}
  return $false
}} | Select-Object -First 1
if (-not $proc) {{ Write-Output '0'; exit 0 }}
$ae = [Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $ae) {{ Write-Output '0'; exit 0 }}
$names = @('Algo Trading', 'Algorithmic Trading', 'Auto Trading')
foreach ($label in $names) {{
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [Windows.Automation.AutomationElement]::NameProperty, $label)
  $btn = $ae.FindFirst([Windows.Automation.TreeScope]::Descendants, $cond)
  if ($btn) {{
    try {{
      $inv = $btn.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
      if ($inv) {{ $inv.Invoke(); Write-Output '1'; exit 0 }}
    }} catch {{ }}
    try {{
      $tog = $btn.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
      if ($tog -and $tog.Current.ToggleState -ne 'On') {{ $tog.Toggle(); Write-Output '1'; exit 0 }}
    }} catch {{ }}
  }}
}}
Write-Output '0'
"""
        raw = _run_powershell(ps, timeout=14).strip()
        ok = raw in ("1", "true", "True")
        if ok:
            log(f"MT5 ALGO TRADING ENABLED PORT={port}")
        return ok
    except Exception as e:
        log(f"MT5 ALGO TRADING UIA ERROR PORT={port}: {e}")
        return False


def account_snapshot_uia(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """อ่าน Balance/Equity จาก UI หน้าต่าง MT5 (Windows UIAutomation)"""
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
            if out.get("balance") or out.get("equity"):
                log(f"MT5 SNAPSHOT UIA PORT={port} BALANCE={out.get('balance')} EQUITY={out.get('equity')}")
    except Exception as e:
        log(f"MT5 SNAPSHOT UIA ERROR PORT={port}: {e}")
    return out


def ensure_equity_pulse_indicator(port_dir: Path) -> None:
    """คัดลอก indicator ไปโฟลเดอร์ PORT ถ้ายังไม่มี"""
    try:
        src = AGENT_DIR / "mql5" / "AvelquaEquityPulse.mq5"
        if not src.exists():
            src = Path(__file__).resolve().parent / "mql5" / "AvelquaEquityPulse.mq5"
        if not src.exists():
            return
        dest_dir = port_dir / "MQL5" / "Indicators"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / "AvelquaEquityPulse.mq5"
        if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
            shutil.copy2(src, dest)
            log(f"DEPLOY AvelquaEquityPulse -> {dest}")
    except Exception as e:
        log(f"DEPLOY AvelquaEquityPulse ERROR: {e}")


def account_snapshot_mt5_api(port_dir: Path) -> Dict[str, Any]:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception:
        return {}
    terminal = port_dir / "terminal64.exe"
    if not terminal.exists():
        return {}
    try:
        if not mt5.initialize(path=str(terminal)):
            return {}
        ai = mt5.account_info()
        mt5.shutdown()
        if ai is None:
            return {}
        return {
            "balance": float(ai.balance),
            "equity": float(ai.equity),
            "currency": str(ai.currency or ""),
        }
    except Exception as e:
        log(f"MT5 API SNAPSHOT ERROR: {e}")
        try:
            mt5.shutdown()
        except Exception:
            pass
        return {}


def _snap_positive(snap: Dict[str, Any]) -> bool:
    b = snap.get("balance")
    e = snap.get("equity")
    try:
        return (b is not None and float(b) > 0) or (e is not None and float(e) > 0)
    except Exception:
        return False


def _snap_merge_profit(snap: Dict[str, Any]) -> Dict[str, Any]:
    try:
        b = snap.get("balance")
        e = snap.get("equity")
        if b is not None and e is not None and snap.get("profit") is None:
            snap["profit"] = round(float(e) - float(b), 2)
    except Exception:
        pass
    return snap


def account_snapshot(port: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    snap: Dict[str, Any] = {"balance": None, "equity": None, "profit": None, "currency": ""}
    try:
        port_dir = resolve_mt5_port_dir(port, payload)
        ensure_equity_pulse_indicator(port_dir)
        mt5_open = mt5_running_for_port_dir(port_dir)

        if mt5_open:
            uia_snap = account_snapshot_uia(port, payload)
            if _snap_positive(uia_snap):
                snap.update({k: v for k, v in uia_snap.items() if v is not None and v != ""})
                return _snap_merge_profit(snap)

        file_snap = account_snapshot_equity_file(port_dir, max_age_sec=25 if mt5_open else 0)
        if _snap_positive(file_snap):
            snap.update({k: v for k, v in file_snap.items() if v is not None and v != ""})
            return _snap_merge_profit(snap)

        if not mt5_open:
            api_snap = account_snapshot_mt5_api(port_dir)
            if _snap_positive(api_snap):
                snap.update({k: v for k, v in api_snap.items() if v is not None and v != ""})
                log(f"MT5 SNAPSHOT API PORT={port} BALANCE={snap.get('balance')} EQUITY={snap.get('equity')}")
                return _snap_merge_profit(snap)

        if not mt5_open:
            uia_snap = account_snapshot_uia(port, payload)
            if _snap_positive(uia_snap):
                snap.update({k: v for k, v in uia_snap.items() if v is not None and v != ""})
                return _snap_merge_profit(snap)

        text = collect_log_text_for_snapshot(port_dir)
        if not text:
            _, text = latest_log_text(port_dir)
        parsed = parse_account_metrics_from_text(text)
        if parsed.get("balance") is not None:
            snap["balance"] = parsed["balance"]
        if parsed.get("equity") is not None:
            snap["equity"] = parsed["equity"]
        if parsed.get("profit") is not None:
            snap["profit"] = parsed["profit"]
        if parsed.get("currency"):
            snap["currency"] = parsed["currency"]
        log(f"MT5 SNAPSHOT PORT={port} BALANCE={snap.get('balance')} EQUITY={snap.get('equity')}")
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
        return n if n == n else None  # NaN guard
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


def schedule_account_metrics_retry(payload: Dict[str, Any], port: Any, delays: Tuple[int, ...] = (5, 12, 25, 45, 90)) -> None:
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
            schedule_account_metrics_retry(payload, port)
            try:
                snap = account_snapshot(port, payload)
                body["balance"] = snap.get("balance")
                body["equity"] = snap.get("equity")
                body["accountCurrency"] = snap.get("currency", "")
            except Exception as snap_err:
                log(f"CONNECT SNAPSHOT DEFERRED: {snap_err}")
        api("POST", callback, body)
        log(f"CONNECT CALLBACK SENT status={status} userId={body['userId']} portSlot={port_slot} login={body['mt5Login']} port={port}")
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


def _journal_failed_words() -> List[str]:
    return [
        "authorization failed",
        "failed (invalid account)",
        "failed [invalid account]",
        "invalid account",
        "invalid password",
        "wrong password",
        "login failed",
        "not authorized",
    ]


def _journal_dirs_for_port(port_dir: Path) -> List[Path]:
    return [
        Path(port_dir) / "Logs",
        Path(port_dir) / "logs",
        Path(port_dir) / "MQL5" / "Logs",
        Path(port_dir) / "MQL5" / "logs",
    ]


def _collect_journal_log_files(port_dir: Path, since_ts: float = 0.0) -> List[Path]:
    """
    รวมไฟล์ journal — ไฟล์วันนี้ (YYYYMMDD.log) อ่านเสมอ
    เพราะ mtime มักเป็นต้นวัน แต่มีบรรทัด authorized ใหม่ท้ายไฟล์
    """
    today_name = datetime.now().strftime("%Y%m%d")
    log_files: List[Path] = []
    for d in _journal_dirs_for_port(port_dir):
        if not d.exists():
            continue
        today_log = d / f"{today_name}.log"
        if today_log.exists():
            log_files.append(today_log)
        try:
            log_files.extend(d.rglob("*.log"))
        except Exception:
            pass

    seen = set()
    uniq: List[Path] = []
    for f in log_files:
        try:
            is_today = f.name.lower() == f"{today_name}.log".lower()
            if since_ts and not is_today and f.stat().st_mtime < since_ts - 10:
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

    def _sort_key(p: Path) -> float:
        try:
            return float(p.stat().st_mtime)
        except Exception:
            return 0.0

    uniq.sort(key=_sort_key, reverse=True)
    return uniq


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

    lines = text.splitlines()
    for line in reversed(lines):
        low = line.lower()
        if login.lower() not in low:
            continue
        if server.lower() not in low:
            continue
        if fail_rx.search(line):
            return False
        if any(w in low for w in failed_words):
            return False
        if "authorization on" in low and "failed" in low:
            return False
        if ok_rx.search(line):
            return True
        if "authorized" in low and "failed" not in low:
            return True
        if "previous successful authorization" in low:
            return True
    return None


def _journal_has_broker_login_attempt(text: str, login: str) -> bool:
    login = str(login or "").strip()
    if not login or not text:
        return False
    low = text.lower()
    if login.lower() not in low:
        return False
    markers = (
        "authorization on",
        "authorized on",
        "authorization failed",
        "login failed",
        "invalid account",
        "not authorized",
    )
    return any(m in low for m in markers)


def _journal_only_terminal_startup(text: str, login: str) -> bool:
    if not text or not str(text).strip():
        return True
    if _journal_has_broker_login_attempt(text, login):
        return False
    low = text.lower()
    return "launched with" in low or "successfully initialized from start config" in low


def automate_mt5_open_account_wizard(
    company: str = LOCKED_MT5_COMPANY,
    server: str = LOCKED_MT5_SERVER,
) -> bool:
    """กด wizard Open an Account ให้เลือก Mohicans Markets Ltd + Server MohicansMarkets-Live"""
    company_esc = company.replace("'", "''")
    server_esc = server.replace("+", "{+}")
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "SilentlyContinue"
$dlg = Get-Process | Where-Object {{
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*Open an Account*"
}} | Select-Object -First 1
if (-not $dlg) {{ exit 0 }}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}}
"@
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
exit 0
"""
    try:
        _run_powershell(ps, timeout=18)
        log(f"MT5 WIZARD AUTO company={company} server={server}")
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
    failed_words = _journal_failed_words()
    last_progress_at = 0.0
    wait_start = time.time()

    while time.time() < deadline:
        if progress_callback and (time.time() - last_progress_at) >= 10:
            try:
                progress_callback(int(time.time() - wait_start))
            except Exception as e:
                log(f"JOURNAL PROGRESS CB ERROR: {e}")
            last_progress_at = time.time()

        uniq = _collect_journal_log_files(port_dir, since_ts)

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
    failed_words = _journal_failed_words()
    uniq = _collect_journal_log_files(port_dir, since_ts)
    if not uniq:
        return None, ""
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
    """รอ login — Journal + หน้าต่าง MT5 (ยืนยันเร็วเมื่อ title bar แสดงบัญชีแล้ว)"""
    wait_cap = max(20, min(int(timeout_sec or 60), 75))
    deadline = time.time() + wait_cap
    last_preview_at = 0.0
    last_progress_at = 0.0
    last_wizard_at = 0.0
    last_gate_at = 0.0
    last_title = ""
    window_ok_streak = 0
    wait_start = time.time()
    preview_b64 = ""

    while time.time() < deadline:
        elapsed = int(time.time() - wait_start)
        now = time.time()

        if now - last_gate_at >= 1.5:
            try:
                write_avelqua_trading_gate(port_dir, False, payload)
                patch_mt5_experts_config(port_dir, False)
            except Exception:
                pass
            last_gate_at = now

        if now - last_wizard_at >= 4.0:
            automate_mt5_open_account_wizard()
            last_wizard_at = now

        j_out, j_chunk = _quick_journal_probe(port_dir, login, journal_since)
        if j_out is False:
            cleanup_mt5_after_login_fail(port, payload, port_dir)
            send_connect_result(
                payload,
                "failed",
                JOURNAL_FAIL_MSG,
                port,
                process_id=None,
                journal_evidence=j_chunk,
            )
            return False, JOURNAL_FAIL_MSG, j_chunk
        if j_out is True:
            return True, "window verified; journal ok", j_chunk

        titles = mt5_window_titles(port, payload)
        joined = " | ".join(titles)
        if joined and joined != last_title:
            last_title = joined

        if mt5_title_suggests_auth_failure(joined):
            cleanup_mt5_after_login_fail(port, payload, port_dir)
            send_connect_result(
                payload,
                "failed",
                JOURNAL_FAIL_MSG,
                port,
                process_id=proc_pid,
                journal_evidence=joined,
            )
            return False, JOURNAL_FAIL_MSG, joined

        ok_w, _wmsg = mt5_login_verified_by_window(port, payload)
        if ok_w:
            window_ok_streak += 1
        else:
            window_ok_streak = 0

        # สำเร็จเฉพาะเมื่อ Journal ยืนยัน authorized on (ห้ามยอมแค่เห็นเลขบนหน้าต่าง)
        if window_ok_streak >= 2 and j_out is True:
            try:
                enforce_login_no_trading(port_dir, port, payload, login, str(payload_get(payload, "mt5Password", "password") or ""), LOCKED_MT5_SERVER)
            except Exception:
                pass
            send_connect_result(
                payload,
                "connected",
                "เชื่อมต่อสำเร็จ — ยังไม่เปิด BOT กรุณาตั้งค่าขั้นตอน 3) แล้วกด ▶ เปิด BOT",
                port,
                process_id=proc_pid,
                journal_evidence=j_chunk or joined,
                window_title=joined,
                preview_b64=preview_b64 if preview_b64 else capture_mt5_window_base64(port, payload),
                window_verified=True,
            )
            return True, "window verified; login success", j_chunk or joined

        preview_b64 = ""
        if now - last_preview_at >= 10.0 and window_ok_streak < 1:
            preview_b64 = capture_mt5_window_base64(port, payload)
            last_preview_at = now

        if ok_w and now - last_progress_at >= 1.2:
            send_connect_result(
                payload,
                "checking",
                f"เห็นบัญชี {login} บนหน้าต่าง MT5 แล้ว — กำลังยืนยัน...",
                port,
                process_id=proc_pid,
                window_title=joined,
                preview_b64=preview_b64,
            )
            last_progress_at = now
        elif now - last_progress_at >= 2.0:
            hint = joined or f"กำลังเปิด MT5 ({elapsed} วินาที)..."
            send_connect_result(
                payload,
                "starting" if elapsed < 6 else "checking",
                hint,
                port,
                process_id=proc_pid,
                window_title=joined,
                preview_b64=preview_b64,
            )
            last_progress_at = now

        time.sleep(0.14)

    chunk = ""
    j_out, j_chunk = _quick_journal_probe(port_dir, login, journal_since)
    if j_out is True:
        return True, JOURNAL_OK_MSG, j_chunk
    if j_out is False:
        cleanup_mt5_after_login_fail(port, payload, port_dir)
        send_connect_result(
            payload,
            "failed",
            JOURNAL_FAIL_MSG,
            port,
            process_id=proc_pid,
            journal_evidence=j_chunk,
        )
        return False, JOURNAL_FAIL_MSG, j_chunk

    remain = max(8, int(deadline - time.time()))
    extra_ok, extra_msg, extra_chunk = check_mt5_journal_login_result(
        port_dir, login, timeout_sec=remain, since_ts=journal_since
    )
    if extra_ok:
        return True, extra_msg, extra_chunk

    journal_files = _collect_journal_log_files(port_dir, journal_since)
    probe_tail = _read_log_tail(journal_files[0]) if journal_files else ""
    if _journal_only_terminal_startup(probe_tail or chunk, login):
        fail_no_broker = (
            "MT5 เปิดแล้วแต่ยังไม่เชื่อมต่อโบรกเกอร์ — ตรวจ Login/รหัสผ่าน "
            f"และ Server {LOCKED_MT5_SERVER}"
        )
        cleanup_mt5_after_login_fail(port, payload, port_dir)
        send_connect_result(
            payload,
            "failed",
            fail_no_broker,
            port,
            process_id=proc_pid,
            journal_evidence=(probe_tail or chunk)[-2000:],
        )
        return False, fail_no_broker, probe_tail or chunk

    if window_ok_streak >= 2 and j_out is not False:
        titles = mt5_window_titles(port, payload)
        joined = " | ".join(titles)
        if mt5_login_verified_by_window(port, payload)[0]:
            try:
                enforce_login_no_trading(
                    port_dir,
                    port,
                    payload,
                    login,
                    str(payload_get(payload, "mt5Password", "password") or ""),
                    LOCKED_MT5_SERVER,
                )
            except Exception:
                pass
            send_connect_result(
                payload,
                "connected",
                "เชื่อมต่อสำเร็จ (ยืนยันจากหน้าต่าง MT5) — ยังไม่เปิด BOT",
                port,
                process_id=proc_pid,
                window_title=joined,
                window_verified=True,
            )
            return True, "window verified; journal slow", extra_chunk or joined

    return False, JOURNAL_TIMEOUT_MSG, chunk or extra_chunk


def start_mt5_bot(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    PRO MT5 Engine V2:
    - exact PORT isolation
    - ยืนยันล็อกอินสำเร็จเฉพาะจาก Journal: เลข login + "authorized on" เท่านั้น
    """
    port = payload_get(payload, "port", "port_no", "portNumber", "vpsPortNumber", "folderPort", "portSlot")
    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    server = LOCKED_MT5_SERVER
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

    config_file = write_mt5_login_ini(port_dir, login, password, server, allow_expert_trading=False)
    write_avelqua_trading_gate(port_dir, False, payload)
    patch_mt5_experts_config(port_dir, False)

    ok_fast, title_fast = mt5_login_verified_by_window(port, payload)
    if ok_fast and mt5_running_for_port_dir(port_dir):
        j_fast, j_chunk_fast = _quick_journal_probe(port_dir, login, time.time() - 180)
        if j_fast is False:
            cleanup_mt5_after_login_fail(port, payload, port_dir)
            send_connect_result(
                payload,
                "failed",
                JOURNAL_FAIL_MSG,
                port,
                journal_evidence=j_chunk_fast,
            )
            raise RuntimeError(JOURNAL_FAIL_MSG)
        if j_fast is True:
            enforce_login_no_trading(port_dir, port, payload, login, password, server)
            send_connect_result(
                payload,
                "connected",
                "เชื่อมต่อแล้ว — ยังไม่เปิด BOT กรุณาตั้งค่าขั้นตอน 3) แล้วกด Run BOT",
                port,
                window_title=title_fast,
                window_verified=True,
                journal_evidence=j_chunk_fast,
            )
            log(f"LOGIN FAST REUSE PORT={port} LOGIN={login} (journal ok)")
            return {
                "action": "login_mt5",
                "status": "connected",
                "loginOnly": True,
                "fastReuse": True,
                "port": port,
                "login": login,
                "server": server,
                "bot": bot,
                "config": str(config_file),
                "terminal": str(terminal),
            }
        log(f"LOGIN FAST REUSE skipped — journal not confirmed for {login}")

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
                    "failed",
                    f"MT5 login={login} กำลังทำงานอยู่ใน PORT อื่น กรุณาปิดก่อน",
                    port,
                )
                raise RuntimeError(f"MT5 login already running on another port login={login}")

        except RuntimeError:
            raise
        except Exception:
            pass

    def result_ok(message: str, process_id: Any = None) -> Dict[str, Any]:
        try:
            write_mt5_login_ini(port_dir, login, password, server, allow_expert_trading=False)
            write_avelqua_trading_gate(port_dir, False, payload)
        except Exception as e:
            log(f"POST-LOGIN TRADING GATE OFF ERROR: {e}")
        send_connect_result(payload, "connected", message, port, process_id=process_id)
        log(f"LOGIN OK PORT={port} LOGIN={login} MESSAGE={message}")
        return {
            "action": "run_mt5_bot",
            "status": "started",
            "port": port,
            "login": login,
            "server": server,
            "bot": bot,
            "config": str(config_file),
            "terminal": str(terminal),
        }

    def launch_mt5(reason: str) -> Optional[subprocess.Popen]:
        try:
            stop_mt5_port_only(port, payload)
        except Exception as e:
            log(f"STOP OLD MT5 ERROR: {e}")
        time.sleep(0.35)
        write_mt5_login_ini(port_dir, login, password, server, allow_expert_trading=False)
        write_avelqua_trading_gate(port_dir, False, payload)
        patch_mt5_experts_config(port_dir, False)
        quarantine_chart_profiles_with_ea(port_dir)
        clear_mt5_login_cache(port_dir)
        # ไม่ลบ log ก่อนเปิด MT5 — เก็บบรรทัด authorized on ให้ตรวจได้
        cfg = mt5_startup_ini_path(port_dir)
        args = [
            str(terminal),
            "/portable",
            f"/login:{login}",
            f"/config:{cfg}",
        ]
        log(f"START MT5 V2 reason={reason} args={args} cwd={port_dir}")
        return _popen_hidden(args, cwd=str(port_dir))

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

    journal_timeout = int(os.getenv("AVELQUA_JOURNAL_TIMEOUT_SEC", "60"))
    log(f"MT5 LOGIN VERIFY PORT={port} LOGIN={login} timeout_sec={journal_timeout}")

    ok, msg, journal_chunk = wait_mt5_login_hybrid(
        port, payload, port_dir, login, journal_since, proc_pid, journal_timeout
    )
    titles = " | ".join(mt5_window_titles(port, payload))
    preview_final = capture_mt5_window_base64(port, payload)

    if not ok:
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
            "failed",
            msg,
            port,
            process_id=None,
            journal_evidence=journal_chunk,
            window_title=titles,
            preview_b64=preview_final,
        )
        raise RuntimeError(msg)

    journal_final = journal_chunk or ""
    if "window verified" not in (msg or "").lower():
        j_final, j_chunk_final = _quick_journal_probe(port_dir, login, journal_since)
        if j_final is False:
            fail_final = JOURNAL_FAIL_MSG
            try:
                kill_mt5_by_folder(port_dir)
                stop_mt5_port_only(port, payload)
            except Exception:
                pass
            remove_mt5_login_ini(port_dir)
            send_connect_result(
                payload,
                "failed",
                fail_final,
                port,
                process_id=None,
                journal_evidence=j_chunk_final,
                window_title=titles,
                preview_b64=preview_final,
            )
            raise RuntimeError(fail_final)
        if j_chunk_final:
            journal_final = j_chunk_final

    enforce_login_no_trading(port_dir, port, payload, login, password, server)

    send_connect_result(
        payload,
        "connected",
        "เชื่อมต่อสำเร็จ — ยังไม่เปิด BOT กรุณาตั้งค่าขั้นตอน 3) เปิด BOT แล้วกด Run",
        port,
        process_id=proc_pid,
        journal_evidence=journal_final,
        window_title=titles,
        preview_b64=preview_final,
        window_verified=True,
    )
    log(f"LOGIN OK PORT={port} LOGIN={login} (login_only, no auto trade)")
    return {
        "action": "login_mt5",
        "status": "connected",
        "loginOnly": True,
        "port": port,
        "login": login,
        "server": server,
        "bot": bot,
        "config": str(config_file),
        "terminal": str(terminal),
        "journalEvidence": journal_final,
        "journalVerified": bool(journal_final),
        "loginVerified": True,
        "windowVerified": True,
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
            port_dir = None
            for p in [
                MT5_ROOT / f"VPS-WIN-01-PORT-{i:02d}",
                MT5_ROOT / f"VPS-WIN-01-PORT-{i}",
                MT5_ROOT / f"PORT{i:02d}",
                MT5_ROOT / f"PORT{i}",
            ]:
                if p.exists():
                    port_dir = p
                    break
            if port_dir is None:
                port_dir = MT5_ROOT / f"PORT{i:02d}"
            snap = account_snapshot(str(i), {"vpsFolderPath": str(port_dir), "folder_path": str(port_dir)})
            ports.append({
                "port": f"PORT{i:02d}",
                "portNumber": i,
                "path": str(port_dir),
                "running": False,
                "busy": False,
                "status": "free" if port_dir.exists() else "missing",
                "pid": [],
                "lot": 0,
                "balance": snap.get("balance"),
                "equity": snap.get("equity"),
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


def _optional_port_read_purpose(payload: Dict[str, Any]) -> bool:
    purpose = str(payload_get(payload, "purpose") or "").lower()
    return purpose in ("equity_sync", "equity_sync_journal", "journal_probe")


def port_read_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    port, _, full = safe_port_file_path(payload)
    if not full.exists():
        if _optional_port_read_purpose(payload):
            return {
                "action": "port_read_file",
                "port": port,
                "file_path": str(full),
                "found": False,
                "content": "",
            }
        raise RuntimeError(f"File not found: {full}")
    content = _read_log_tail(full, max_bytes=262144)
    return {
        "action": "port_read_file",
        "port": port,
        "file_path": str(full),
        "found": True,
        "content": content,
    }


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
        "BOT_TEST": ["sniper-demo.ex5", "BOT.ex5", "BOT.mq5"],
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


def _write_ea_preset_files(port_dir: Path, payload: Dict[str, Any], experts_dir: Path) -> Dict[str, Any]:
    """เขียน .set จาก payload.eaSetContent ลงโฟลเดอร์ Presets / Experts (ไม่แก้ .mq5)"""
    content = str(payload_get(payload, "eaSetContent", "ea_set_content") or "").strip()
    file_name = str(payload_get(payload, "eaSetFileName", "ea_set_file_name") or "").strip()
    if not content or not file_name:
        return {"ok": False, "reason": "no_ea_set_content"}

    if not file_name.lower().endswith(".set"):
        file_name = f"{file_name}.set"

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

  # คู่มือแนบ EA + ชื่อ preset
    try:
        run_json = {
            "instanceId": payload_get(payload, "instanceId"),
            "accountId": payload_get(payload, "accountId", "account_id"),
            "botCode": payload_get(payload, "botCode", "eaName"),
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
                log(f"EA matched (case-insensitive): {ex5.name}")
                break
    if not found and experts_dir.is_dir():
        on_disk = [x.name for x in experts_dir.glob("*.ex5")]
        if on_disk:
            log(f"EA scan {experts_dir}: on disk {on_disk[:8]} want {code}")
    return {
        "experts_dir": str(experts_dir),
        "found": found,
        "missing": missing,
        "ok": len(found) > 0,
    }


def _is_modern_run_bot_payload(payload: Dict[str, Any]) -> bool:
    """Run BOT ผ่าน PORT เดิม (มี instanceId) — ไม่ใช่ start_mt5_bot แบบ login ใหม่"""
    if payload_get(payload, "instanceId", "instance_id"):
        return True
    action = str(payload_get(payload, "action", "commandType") or "").lower()
    return action in ("run_bot", "restart_ea", "run_mt5_bot", "restart_mt5_bot")


def run_bot_command(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    เปิด BOT บน PORT เดิม — ไม่ kill terminal64.exe
    ถ้า MT5 เปิดอยู่แล้ว: เปิด gate/Experts + preset เท่านั้น (ไม่ relaunch)
    """
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
    ea_info = _verify_ea_in_experts_dir(experts_dir, bot_code)
    ea_missing = not ea_info["ok"]
    if ea_missing:
        log(
            f"RUN BOT EA not in Experts (continue — attach manually): "
            f"{', '.join(ea_info['missing'][:4])}"
        )

    set_info = _write_ea_preset_files(port_dir, payload, experts_dir)
    if not set_info.get("ok"):
        log(f"RUN BOT preset .set skipped: {set_info.get('reason')}")

    login = str(payload_get(payload, "mt5Login", "login") or "").strip()
    password = str(payload_get(payload, "mt5Password", "password") or "")
    server = str(payload_get(payload, "serverName", "server") or LOCKED_MT5_SERVER).strip() or LOCKED_MT5_SERVER

    procs = mt5_port_processes(port, payload)
    mt5_open = bool(procs) or mt5_running_for_port_dir(port_dir)
    launched = False
    proc_pid = procs[0].pid if procs else None
    hot_run = False

    write_avelqua_trading_gate(port_dir, True, payload)
    patch_mt5_experts_config(port_dir, True)
    try:
        files_dir = port_dir / "MQL5" / "Files"
        files_dir.mkdir(parents=True, exist_ok=True)
        (files_dir / "avelqua_run.json").write_text(
            json.dumps(
                {
                    "phase": "bot_running",
                    "tradingEnabled": True,
                    "allowExpertTrading": True,
                    "botCode": bot_code,
                    "instanceId": payload_get(payload, "instanceId", "instance_id"),
                    "updatedAt": datetime.now().isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        log(f"avelqua_run.json bot_running: {e}")

    if mt5_open:
        hot_run = True
        log(f"RUN BOT HOT PORT={port} PID={proc_pid or '?'} — MT5 stays open, trading gate ON")
    else:
        if login and password:
            try:
                write_mt5_login_ini(port_dir, login, password, server, allow_expert_trading=True)
            except Exception as e:
                log(f"RUN BOT enable expert trading in ini skipped: {e}")
        cfg = mt5_startup_ini_path(port_dir)
        if not cfg.exists():
            raise RuntimeError("MT5 startup.ini missing — connect MT5 from web first")
        args = [str(terminal), "/portable", f"/config:{cfg}"]
        log(f"RUN BOT launch MT5 PORT={port} cwd={port_dir} config={cfg}")
        proc = _popen_hidden(args, cwd=str(port_dir))
        launched = True
        proc_pid = proc.pid if proc else None
        time.sleep(3)

    snap = account_snapshot(port, payload)
    bal = snap.get("balance")
    eq = snap.get("equity")
    profit = snap.get("profit")
    if profit is None and bal is not None and eq is not None:
        try:
            profit = round(float(eq) - float(bal), 2)
        except Exception:
            profit = None

    instance_id = payload_get(payload, "instanceId")
    ea_status = "attach_required" if ea_missing else "ready"
    send_mt5_live_status(
        instance_id,
        port,
        "running",
        ea_status,
        bal or 0,
        eq or 0,
        "",
        payload,
        profit=profit,
    )
    send_account_metrics(payload, bal, eq, snap.get("currency", ""))
    schedule_account_metrics_retry(payload, port, (8, 20, 45, 90))
    threading.Thread(target=lambda: (time.sleep(6), watch_mt5_instance(payload)), daemon=True).start()
    threading.Thread(
        target=lambda: (time.sleep(2), enable_mt5_algo_trading_uia(port, payload)),
        daemon=True,
    ).start()

    if hot_run:
        msg = (
            "BOT enabled — MT5 stayed open; attach EA / load preset / turn on Algo Trading"
            if ea_missing
            else "BOT enabled — MT5 stayed open"
        )
    else:
        msg = (
            "BOT ready — attach EA on XAUUSD and load preset"
            if ea_missing
            else "BOT ready on PORT"
        )
    return {
        "action": "run_bot",
        "ok": True,
        "status": "running",
        "message": msg,
        "folderPath": str(port_dir),
        "portNumber": normalize_port(port),
        "mt5Running": True,
        "hotRun": hot_run,
        "keepMt5Open": True,
        "launched": launched,
        "processId": proc_pid,
        "balance": bal,
        "equity": eq,
        "profit": profit,
        "eaStatus": ea_status,
        "botCode": bot_code,
        "expertsPath": str(experts_dir),
        "eaFiles": ea_info,
        "eaSet": set_info,
        "instanceId": instance_id,
    }


def restart_ea_command(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Restart EA context — ใช้ folder PORT เดิม ไม่ kill ข้าม PORT"""
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
            "errorText": error_text,
            "at": datetime.now().isoformat(timespec="seconds"),
        }
        api("POST", "/mt5/live-status", body)
        log(f"LIVE STATUS SENT PORT={port} STATUS={status} EA={ea_status} BAL={bal_out} EQ={eq_out}")
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
        if st["running"]:
            enable_mt5_algo_trading_uia(port, payload)
        send_mt5_live_status(
            instance_id,
            port,
            "running" if st["running"] else "stopped",
            st["status"],
            snap.get("balance"),
            snap.get("equity"),
            "",
            payload,
            profit=snap.get("profit"),
        )
        if snap.get("balance") is not None or snap.get("equity") is not None:
            send_account_metrics(
                payload,
                snap.get("balance"),
                snap.get("equity"),
                snap.get("currency", ""),
            )
    except Exception as e:
        log(f"WATCH INSTANCE ERROR: {e}")


_LAST_RUNNING_SYNC = 0.0
RUNNING_SYNC_INTERVAL_SEC = int(os.getenv("AVELQUA_RUNNING_SYNC_SEC", "4"))


def poll_running_mt5_list() -> None:
    """ซิงค์ Balance/Equity ของ BOT ที่ running — ไม่เปิด MT5 ใหม่เอง"""
    global _LAST_RUNNING_SYNC
    now = time.time()
    if now - _LAST_RUNNING_SYNC < RUNNING_SYNC_INTERVAL_SEC:
        return
    _LAST_RUNNING_SYNC = now
    try:
        res = api("GET", "/running-sync")
        if res.get("ok") is not True:
            return
        for item in res.get("items", []):
            watch_mt5_instance(item)
    except Exception as e:
        log(f"RUNNING SYNC ERROR: {e}")


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
    if not content.strip() and script_url:
        try:
            content = _fetch_agent_script_from_url(script_url)
        except Exception as e:
            raise RuntimeError(f"scriptUrl download failed: {e}") from e
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

        elif ctype == "run_bot":
            command_result(cmd_id, True, run_bot_command(payload))

        elif ctype == "restart_ea":
            command_result(cmd_id, True, restart_ea_command(payload))

        elif ctype in ("connect_mt5", "login_mt5"):
            command_result(cmd_id, True, start_mt5_bot(payload))

        elif ctype in ("run_mt5_bot", "run_mt5"):
            command_result(cmd_id, True, run_bot_command(payload))

        elif ctype in ("sync_mt5_account", "account_snapshot", "read_account_metrics"):
            port = payload_get(payload, "port", "portNumber", "port_no", "portSlot")
            snap: Dict[str, Any] = {"balance": None, "equity": None, "profit": None, "currency": ""}
            try:
                snap = account_snapshot(port, payload)
                send_account_metrics(
                    payload,
                    snap.get("balance"),
                    snap.get("equity"),
                    snap.get("currency", ""),
                )
                instance_id = payload_get(payload, "instanceId")
                if instance_id and port:
                    send_mt5_live_status(
                        instance_id,
                        port,
                        "running",
                        "ready",
                        snap.get("balance") or 0,
                        snap.get("equity") or 0,
                        "",
                        payload,
                        profit=snap.get("profit"),
                    )
            except Exception as sync_err:
                log(f"SYNC_MT5_ACCOUNT ERROR: {sync_err}")
                snap["error"] = str(sync_err)[:500]
            command_result(cmd_id, True, {"action": ctype, **snap})

        elif ctype in ("stop_mt5", "stop_mt5_bot", "force_stop_mt5", "kill_mt5", "stop_port"):
            folder = payload_get(payload, "folder_path", "vpsFolderPath")
            port = payload_get(payload, "port", "portSlot", "portNumber", "vpsPortNumber", "folderPort")
            stop_soft = ctype == "stop_mt5_bot" or payload_get(
                payload, "stopTradingOnly", "keepMt5Open", "softStop"
            )

            if stop_soft:
                command_result(cmd_id, True, stop_bot_trading_only(port, payload))
            elif folder:
                command_result(cmd_id, True, stop_mt5_by_folder(folder))
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
            if _is_modern_run_bot_payload(payload):
                command_result(cmd_id, True, restart_ea_command(payload))
            else:
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
            err_unknown = f"Unknown command_type: {ctype}"
            if ctype in ("run_bot", "restart_ea", "run_mt5_bot", "restart_mt5_bot"):
                try:
                    instance_id = payload_get(payload, "instanceId")
                    port = payload_get(payload, "port", "portNumber", "portSlot")
                    send_mt5_live_status(
                        instance_id,
                        port,
                        "failed",
                        "error",
                        0,
                        0,
                        err_unknown,
                        payload,
                    )
                except Exception:
                    pass
            command_result(cmd_id, False, {"command_type": ctype}, err_unknown)

    except Exception as e:
        log(f"COMMAND ERROR ID={cmd_id}: {_safe_console_text(str(e))}")
        if ctype in ("connect_mt5", "login_mt5"):
            try:
                send_connect_result(payload, "failed", str(e))
            except Exception:
                pass
            try:
                command_result(
                    cmd_id,
                    False,
                    {
                        "action": ctype,
                        "status": "failed",
                        "login": payload_get(payload, "mt5Login", "login"),
                        "message": str(e)[:500],
                    },
                    str(e)[:500],
                )
            except Exception:
                pass
            return
        if ctype in (
            "run_bot",
            "restart_ea",
            "run_mt5_bot",
            "run_mt5",
            "restart_mt5_bot",
            "restart_mt5",
        ):
            try:
                instance_id = payload_get(payload, "instanceId", "instance_id")
                port = payload_get(payload, "port", "portNumber", "portSlot")
                send_mt5_live_status(
                    instance_id,
                    port,
                    "failed",
                    "",
                    0,
                    0,
                    str(e),
                    payload,
                )
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
if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("PYTHON AGENT STOP KeyboardInterrupt")
    except Exception as exc:
        log(f"PYTHON AGENT FATAL: {exc}")
        sys.exit(1)
