#!/usr/bin/env python3
"""
Antigravity CLI (agy) Telegram Bot Bridge
Connects Telegram Bot with the 'agy' CLI on the VPS with interactive buttons, low-latency streaming & VPS usage monitoring.
"""

import os
import sys
import json
import time
import signal
import threading
import subprocess
import requests
import mimetypes
import sqlite3
import html
import re
import shutil
from typing import Dict, Any, List, Optional, Tuple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
DOWNLOADS_DIR = os.path.join(BASE_DIR, "downloads")
TOKEN_PATH = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "antigravity-oauth-token")
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

def find_db_path() -> str:
    if os.environ.get("DB_PATH") and os.path.exists(os.environ.get("DB_PATH")):
        return os.environ.get("DB_PATH")
    
    candidates = [
        os.path.join(os.path.dirname(BASE_DIR), "agy-project-manager", "data", "manager.sqlite"),
        os.path.join(BASE_DIR, "data", "manager.sqlite"),
        "/home/Prime-Projectx/services/agy-project-manager/data/manager.sqlite",
        os.path.join(os.path.expanduser("~"), "services", "agy-project-manager", "data", "manager.sqlite")
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return os.path.join(os.path.dirname(BASE_DIR), "agy-project-manager", "data", "manager.sqlite")

DB_PATH = find_db_path()

DEFAULT_CONFIG = {
    "bot_token": "8114593748:AAEcWIyNgMsr90_bbFCz8kHiJlPuDodTTLw",
    "allowed_users": [],
    "workspace_dir": os.environ.get("WORKSPACE_DIR", os.getcwd()),
    "dangerously_skip_permissions": True,
    "request_timeout_seconds": 300,
    "default_effort": "low",  # "low", "medium", "high"
    "default_model": "",      # empty means default agy model
    "disable_slash_commands": True,
    "stream_progress": True
}


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return {**DEFAULT_CONFIG, **json.load(f)}
        except Exception as e:
            print(f"Error loading config.json: {e}, using defaults.")
    return DEFAULT_CONFIG.copy()


def save_config(cfg: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=4)


config = load_config()
TOKEN = config["bot_token"]
TELEGRAM_API = f"https://api.telegram.org/bot{TOKEN}"
TELEGRAM_FILE_API = f"https://api.telegram.org/file/bot{TOKEN}"
WORKSPACE = config.get("workspace_dir", "/home/Prime-Projectx")
DANGEROUSLY_SKIP_PERMISSIONS = config.get("dangerously_skip_permissions", True)
TIMEOUT = config.get("request_timeout_seconds", 300)

chat_sessions: Dict[int, Dict[str, Any]] = {}
lock = threading.Lock()
is_running = True


def is_user_allowed(user_id: int, username: str = "") -> bool:
    global config
    allowed = config.get("allowed_users", [])
    if not allowed:
        with lock:
            config["allowed_users"] = [user_id]
            save_config(config)
            print(f"[*] Registered initial owner: {user_id} (@{username})")
        return True
    return user_id in allowed


def send_telegram_request(method: str, data: dict = None, timeout: int = 30) -> dict:
    url = f"{TELEGRAM_API}/{method}"
    try:
        resp = requests.post(url, json=data or {}, timeout=timeout)
        return resp.json()
    except Exception as e:
        print(f"Telegram API error ({method}): {e}")
        return {"ok": False, "error": str(e)}


def answer_callback_query(callback_query_id: str, text: str = None, show_alert: bool = False):
    payload = {"callback_query_id": callback_query_id}
    if text:
        payload["text"] = text
        payload["show_alert"] = show_alert
    send_telegram_request("answerCallbackQuery", payload)


def send_chat_action(chat_id: int, action: str = "typing"):
    send_telegram_request("sendChatAction", {"chat_id": chat_id, "action": action})


def split_message(text: str, max_length: int = 4000) -> List[str]:
    if len(text) <= max_length:
        return [text]
    chunks = []
    while text:
        if len(text) <= max_length:
            chunks.append(text)
            break
        split_idx = text.rfind("\n", 0, max_length)
        if split_idx == -1:
            split_idx = text.rfind(" ", 0, max_length)
        if split_idx == -1:
            split_idx = max_length
        chunks.append(text[:split_idx])
        text = text[split_idx:].lstrip()
    return chunks


# Cloudflare Tunnel integration
TUNNEL_LOG_PATHS = [
    "/data/data/com.termux/files/home/tunnel.log",
    "/root/tunnel.log",
    os.path.expanduser("~/tunnel.log"),
    "/data/data/com.termux/files/usr/var/log/sv/cloudflared/current"
]

last_broadcasted_tunnel_url: Optional[str] = None


def get_latest_tunnel_url() -> Optional[str]:
    for path in TUNNEL_LOG_PATHS:
        if os.path.exists(path):
            try:
                with open(path, "r", errors="ignore") as f:
                    content = f.read()
                    matches = re.findall(r"https://[a-zA-Z0-9.-]+\.trycloudflare\.com", content)
                    if matches:
                        return matches[-1]
            except Exception:
                pass
    return None


def broadcast_tunnel_url(url: str, is_restart: bool = False):
    global last_broadcasted_tunnel_url
    last_broadcasted_tunnel_url = url
    title = "🔄 *Cloudflare Tunnel AGY Diperbarui!*" if is_restart else "🚀 *Cloudflare Tunnel AGY Aktif!*"
    text = (
        f"{title}\n\n"
        f"🌐 *Link Akses:*\n`{url}`\n\n"
        f"🖥️ *Target Port:* `http://127.0.0.1:5678` (AGY Control Center)\n"
        f"⏱️ *Status:* Online & Siap Digunakan\n\n"
        f"_Link ini otomatis dikirim setiap server/tunnel restart atau URL berubah._"
    )
    markup = {
        "inline_keyboard": [
            [{"text": "🌐 Buka AGY Web Control Center", "url": url}],
            [{"text": "📊 Usage VPS", "callback_data": "act_status"}, {"text": "📋 Menu Utama", "callback_data": "act_main_menu"}]
        ]
    }
    allowed = config.get("allowed_users", [])
    for u_id in allowed:
        try:
            send_message(u_id, text, reply_markup=markup)
            print(f"[*] Berhasil mengirim notifikasi tunnel URL ke {u_id}: {url}")
        except Exception as e:
            print(f"[!] Gagal mengirim link tunnel ke {u_id}: {e}")


def tunnel_monitor_worker():
    global last_broadcasted_tunnel_url
    print("[*] Cloudflare Tunnel auto-notifier worker started.")
    time.sleep(4)
    while is_running:
        try:
            current_url = get_latest_tunnel_url()
            if current_url:
                if last_broadcasted_tunnel_url is None:
                    # Initial broadcast on startup
                    broadcast_tunnel_url(current_url, is_restart=False)
                elif current_url != last_broadcasted_tunnel_url:
                    # Detected URL change or restart
                    broadcast_tunnel_url(current_url, is_restart=True)
        except Exception as e:
            print(f"[!] Tunnel monitor error: {e}")
        time.sleep(5)


# Persistent bottom keyboard
MAIN_REPLY_KEYBOARD = {
    "keyboard": [
        [{"text": "📊 Usage VPS"}, {"text": "🌐 Link Cloudflare"}, {"text": "⚡ Mode Fast"}],
        [{"text": "🧠 Mode Smart"}, {"text": "🔄 Reset Chat"}, {"text": "📋 Model AI"}]
    ],
    "resize_keyboard": True,
    "is_persistent": True
}


def get_main_menu_keyboard():
    tunnel_url = get_latest_tunnel_url()
    keyboard = [
        [
            {"text": "📊 Cek Usage VPS", "callback_data": "act_status"},
            {"text": "🔄 Reset Sesi Chat", "callback_data": "act_reset"}
        ]
    ]
    if tunnel_url:
        keyboard.append([
            {"text": "🌐 Buka Web Control Center", "url": tunnel_url},
            {"text": "🔗 Link Cloudflare", "callback_data": "act_tunnel"}
        ])
    else:
        keyboard.append([
            {"text": "🌐 Cek Link Cloudflare", "callback_data": "act_tunnel"}
        ])

    keyboard.extend([
        [
            {"text": "⚡ Mode Fast (Low)", "callback_data": "set_effort:low"},
            {"text": "🧠 Mode Smart (High)", "callback_data": "set_effort:high"}
        ],
        [
            {"text": "📋 Pilih Model AI", "callback_data": "act_models_menu"},
            {"text": "📖 Bantuan", "callback_data": "act_help"}
        ]
    ])
    return {"inline_keyboard": keyboard}


def get_status_keyboard(view_mode: str = "full"):
    toggle_btn = (
        {"text": "📱 Mode Ringkas (Mobile)", "callback_data": "act_status_compact"}
        if view_mode == "full"
        else {"text": "🖥️ Mode Lengkap (Full PM2)", "callback_data": "act_status_full"}
    )
    refresh_cb = f"act_status_{view_mode}"
    return {
        "inline_keyboard": [
            [
                {"text": "🔄 Refresh Status", "callback_data": refresh_cb},
                toggle_btn
            ],
            [
                {"text": "🔄 Reset Chat", "callback_data": "act_reset"},
                {"text": "📋 Menu Utama", "callback_data": "act_main_menu"}
            ]
        ]
    }


def get_models_keyboard():
    return {
        "inline_keyboard": [
            [
                {"text": "⚡ Flash 3.7 (Low)", "callback_data": "set_model:gemini-3.7-flash-low"},
                {"text": "⚡ Flash 3.7 (Med)", "callback_data": "set_model:gemini-3.7-flash-medium"}
            ],
            [
                {"text": "🚀 Flash 3.5 (Low)", "callback_data": "set_model:gemini-3.5-flash-low"},
                {"text": "🎯 Flash 3.6 (Low)", "callback_data": "set_model:gemini-3.6-flash-low"}
            ],
            [
                {"text": "🧠 Claude Sonnet 4.6", "callback_data": "set_model:claude-sonnet-4-6"},
                {"text": "🧠 Gemini 3.1 Pro", "callback_data": "set_model:gemini-3.1-pro-high"}
            ],
            [
                {"text": "⚙️ Default AGY", "callback_data": "set_model:default"},
                {"text": "🔙 Kembali", "callback_data": "act_main_menu"}
            ]
        ]
    }


def send_message(chat_id: int, text: str, parse_mode: str = "Markdown", reply_markup: dict = None) -> Optional[int]:
    chunks = split_message(text)
    first_msg_id = None
    for idx, chunk in enumerate(chunks):
        payload = {"chat_id": chat_id, "text": chunk}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        # Attach reply_markup to the last chunk
        if idx == len(chunks) - 1 and reply_markup:
            payload["reply_markup"] = reply_markup
        res = send_telegram_request("sendMessage", payload)
        
        if not res.get("ok") and parse_mode:
            payload.pop("parse_mode", None)
            res = send_telegram_request("sendMessage", payload)
        
        if res.get("ok") and first_msg_id is None:
            first_msg_id = res.get("result", {}).get("message_id")
    return first_msg_id


def edit_message(chat_id: int, message_id: int, text: str, parse_mode: str = "Markdown", reply_markup: dict = None) -> bool:
    if len(text) > 4000:
        text = text[:3990] + "..."
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    res = send_telegram_request("editMessageText", payload)
    if not res.get("ok") and parse_mode:
        payload.pop("parse_mode", None)
        res = send_telegram_request("editMessageText", payload)
    return res.get("ok", False)


def download_telegram_file(file_id: str, file_name: str) -> Optional[str]:
    """Downloads a file from Telegram and saves it to DOWNLOADS_DIR."""
    try:
        res = send_telegram_request("getFile", {"file_id": file_id})
        if not res.get("ok"):
            print(f"[!] getFile failed: {res}")
            return None
        file_path = res.get("result", {}).get("file_path")
        if not file_path:
            return None
        
        download_url = f"{TELEGRAM_FILE_API}/{file_path}"
        r = requests.get(download_url, timeout=60, stream=True)
        if r.status_code == 200:
            safe_name = os.path.basename(file_name)
            local_path = os.path.join(DOWNLOADS_DIR, f"{int(time.time())}_{safe_name}")
            with open(local_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            return local_path
    except Exception as e:
        print(f"[!] Download error: {e}")
    return None


def extract_file_content(file_path: str, max_chars: int = 150000) -> Tuple[str, str]:
    """
    Extracts text content or details from downloaded file.
    Returns (summary_type, content_or_prompt_chunk)
    """
    ext = os.path.splitext(file_path)[1].lower()
    base_name = os.path.basename(file_path)

    # 1. PDF
    if ext == ".pdf":
        try:
            import pypdf
            reader = pypdf.PdfReader(file_path)
            pages_text = []
            for idx, page in enumerate(reader.pages):
                txt = page.extract_text() or ""
                if txt.strip():
                    pages_text.append(f"--- Halaman {idx+1} ---\n{txt.strip()}")
            combined = "\n\n".join(pages_text)
            if combined.strip():
                if len(combined) > max_chars:
                    combined = combined[:max_chars] + "\n\n[... Isi file terpotong karena terlalu panjang ...]"
                return ("PDF Document", f"📄 [Lampiran Dokumen PDF: {base_name}]\nPath di server: `{file_path}`\n\nIsi Dokumen:\n```\n{combined}\n```")
        except Exception as e:
            return ("PDF Document", f"📄 [Lampiran Dokumen PDF: {base_name}]\nPath di server: `{file_path}` (Gagal ekstrak teks: {e})")

    # 2. Word (.docx)
    elif ext == ".docx":
        try:
            import docx
            doc = docx.Document(file_path)
            full_text = [p.text for p in doc.paragraphs if p.text.strip()]
            combined = "\n".join(full_text)
            if combined.strip():
                if len(combined) > max_chars:
                    combined = combined[:max_chars] + "\n\n[... Isi file terpotong karena terlalu panjang ...]"
                return ("Word Document", f"📝 [Lampiran Dokumen Word: {base_name}]\nPath di server: `{file_path}`\n\nIsi Dokumen:\n```\n{combined}\n```")
        except Exception as e:
            return ("Word Document", f"📝 [Lampiran Dokumen Word: {base_name}]\nPath di server: `{file_path}` (Gagal ekstrak teks: {e})")

    # 3. Images (.png, .jpg, .jpeg, .webp, .bmp)
    elif ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp"]:
        return ("Image", f"🖼️ [Lampiran Gambar: {base_name}]\nFile tersimpan di server VPS: `{file_path}`\nUkuran file: {os.path.getsize(file_path)} bytes.\nSilakan gunakan path file di atas jika ingin membaca atau memproses gambar.")

    # 4. Text/Code/Data files
    text_extensions = [
        ".txt", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json", ".xml",
        ".yaml", ".yml", ".md", ".csv", ".sql", ".sh", ".bash", ".c", ".cpp", ".h",
        ".hpp", ".rs", ".go", ".php", ".env", ".log", ".ini", ".conf", ".java", ".rb"
    ]
    
    is_text = ext in text_extensions
    if not is_text:
        mime, _ = mimetypes.guess_type(file_path)
        if mime and (mime.startswith("text/") or "json" in mime or "xml" in mime):
            is_text = True

    if is_text or ext == "":
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            if len(content) > max_chars:
                content = content[:max_chars] + "\n\n[... Isi file terpotong karena terlalu panjang ...]"
            return ("Text/Source Code", f"📁 [Lampiran File: {base_name}]\nPath di server: `{file_path}`\n\nIsi File:\n```\n{content}\n```")
        except Exception as e:
            return ("File", f"📁 [Lampiran File: {base_name}]\nPath di server: `{file_path}` (Error membaca: {e})")

    # Binary/other files
    return ("Binary File", f"📦 [Lampiran File: {base_name}]\nFile tersimpan di server: `{file_path}`\nUkuran: {os.path.getsize(file_path)} bytes.")


def get_clean_env() -> dict:
    env = os.environ.copy()
    for k in ["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_APP_INSTANCE"]:
        env.pop(k, None)
    return env


def get_vps_metrics() -> dict:
    # 1. Uptime
    uptime_str = "N/A"
    try:
        if sys.platform == "win32":
            import ctypes
            uptime_ms = ctypes.windll.kernel32.GetTickCount64()
            uptime_seconds = uptime_ms / 1000.0
            days = int(uptime_seconds // 86400)
            hours = int((uptime_seconds % 86400) // 3600)
            mins = int((uptime_seconds % 3600) // 60)
            uptime_str = f"{days}d {hours}h {mins}m"
        else:
            with open("/proc/uptime", "r") as f:
                uptime_seconds = float(f.readline().split()[0])
                days = int(uptime_seconds // 86400)
                hours = int((uptime_seconds % 86400) // 3600)
                mins = int((uptime_seconds % 3600) // 60)
                uptime_str = f"{days}d {hours}h {mins}m"
    except Exception:
        try:
            uptime_str = subprocess.check_output("uptime -p", shell=True, text=True).strip()
        except Exception:
            pass

    # 2. Load average
    load_str = "N/A"
    try:
        load1, load5, load15 = os.getloadavg()
        load_str = f"{load1:.2f}, {load5:.2f}, {load15:.2f}"
    except Exception:
        load_str = "N/A (Windows)"

    # 3. RAM usage
    ram_str = "N/A"
    try:
        if sys.platform != "win32":
            out = subprocess.check_output("free -b", shell=True, text=True)
            lines = out.strip().split("\n")
            if len(lines) > 1:
                parts = lines[1].split()
                total = int(parts[1])
                avail = int(parts[6]) if len(parts) > 6 else int(parts[3])
                real_used = total - avail
                pct = (real_used / total) * 100 if total else 0
                ram_str = f"{pct:.1f}% ({real_used/(1024**3):.1f}G / {total/(1024**3):.1f}G)"
        else:
            # Simple Windows fallback
            ram_str = "Active (Windows Host)"
    except Exception:
        pass

    # 4. Disk usage
    disk_str = "N/A"
    try:
        disk_path = os.path.splitdrive(os.getcwd())[0] + "\\" if sys.platform == "win32" else "/"
        total, used, free = shutil.disk_usage(disk_path)
        pct = (used / total) * 100 if total else 0
        disk_str = f"{pct:.1f}% ({used/(1024**3):.1f}G / {total/(1024**3):.1f}G)"
    except Exception:
        pass

    # 5. CPU usage
    cpu_str = "N/A"
    try:
        if sys.platform != "win32":
            top_out = subprocess.check_output(["top", "-bn1"], text=True)
            for line in top_out.split("\n"):
                if "%Cpu" in line or "Cpu(s)" in line:
                    m = re.search(r"(\d+[.,]\d+)\s*id", line)
                    if m:
                        idle = float(m.group(1).replace(",", "."))
                        cpu_pct = max(0.0, min(100.0, 100.0 - idle))
                        cpu_str = f"{cpu_pct:.1f}%"
                    break
        else:
            cpu_str = "Normal"
    except Exception:
        pass

    return {
        "uptime": uptime_str,
        "load": load_str,
        "ram": ram_str,
        "disk": disk_str,
        "cpu": cpu_str
    }


def get_pm2_table(mode: str = "full") -> str:
    env = get_clean_env()
    if mode == "full":
        env["COLUMNS"] = "150"
        try:
            out = subprocess.check_output("pm2 list", shell=True, env=env, text=True).strip()
            ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
            return ansi_escape.sub("", out)
        except Exception as e:
            return f"Error executing pm2 list: {e}"

    # Compact Table Mode (fits beautifully on mobile)
    try:
        res = subprocess.run(["pm2", "jlist"], env=env, capture_output=True, text=True, timeout=5)
        if res.returncode != 0:
            return "Gagal membaca PM2 jlist"
        apps = json.loads(res.stdout)
    except Exception as e:
        return f"Error parsing pm2: {e}"

    header = "┌───┬──────────────────┬────────┬──────┬───────┬────┐\n│ ID│ App Name         │ Status │ CPU  │ RAM   │ ↺  │\n├───┼──────────────────┼────────┼──────┼───────┼────┤"
    footer = "└───┴──────────────────┴────────┴──────┴───────┴────┘"
    rows = []
    for a in apps:
        pm_id = str(a.get("pm_id", "?"))[:3]
        name = a.get("name", "unknown")
        if len(name) > 16:
            name = name[:15] + "…"
        status = a.get("pm2_env", {}).get("status", "unknown")
        st_short = "online" if status == "online" else ("stop" if status in ["stopped", "stop"] else status[:6])
        cpu = a.get("monit", {}).get("cpu", 0)
        cpu_str = f"{cpu:.0f}%" if cpu < 100 else f"{int(cpu)}%"
        mem_bytes = a.get("monit", {}).get("memory", 0)
        mem_mb = mem_bytes / (1024 * 1024)
        mem_str = f"{mem_mb:.1f}M"
        restarts = str(a.get("pm2_env", {}).get("restart_time", 0))[:3]
        row = f"│{pm_id:>3}│ {name:<16} │ {st_short:<6} │{cpu_str:>5} │{mem_str:>6} │{restarts:>3} │"
        rows.append(row)

    return header + "\n" + "\n".join(rows) + "\n" + footer


def get_vps_status(mode: str = "full") -> str:
    try:
        curr_time = time.strftime("%H:%M:%S WIB", time.localtime())
        m = get_vps_metrics()
        table = get_pm2_table(mode)
        
        cpu_val = m["cpu"]
        load_val = m["load"]
        ram_val = m["ram"]
        disk_val = m["disk"]
        uptime_val = m["uptime"]
        
        view_title = "🖥️ PM2 Full Table" if mode == "full" else "📱 PM2 Compact Table"
        
        msg = (
            f"📊 <b>VPS SYSTEM & USAGE MONITOR</b>\n"
            f"🕒 <i>Update: {curr_time}</i>\n\n"
            f"🖥️ <b>CPU:</b> <code>{cpu_val}</code> | <b>Load:</b> <code>{load_val}</code>\n"
            f"💾 <b>RAM:</b> <code>{ram_val}</code>\n"
            f"💿 <b>Disk:</b> <code>{disk_val}</code>\n"
            f"⏱️ <b>Uptime:</b> <code>{uptime_val}</code>\n\n"
            f"🚀 <b>{view_title}:</b>\n"
            f"<pre>{html.escape(table)}</pre>"
        )
        return msg
    except Exception as e:
        return f"❌ Gagal mengambil status VPS: <code>{html.escape(str(e))}</code>"


def execute_shell(command: str) -> str:
    try:
        res = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE,
            capture_output=True,
            text=True,
            timeout=60
        )
        out = res.stdout.strip()
        err = res.stderr.strip()
        result_text = ""
        if out:
            result_text += f"*Output:*\n```\n{out}\n```\n"
        if err:
            result_text += f"*Error:*\n```\n{err}\n```\n"
        if not result_text:
            result_text = "✅ Perintah selesai tanpa output (exit code 0)."
        return result_text
    except Exception as e:
        return f"❌ Gagal menjalankan shell: `{str(e)}`"


def get_available_models() -> str:
    try:
        agy_bin = get_agy_bin()
        out = subprocess.check_output([agy_bin, "models"], text=True, timeout=15)
        # Filter spinner characters
        lines = [line.strip() for line in out.splitlines() if line.strip() and not line.startswith("⠋") and not line.startswith("⠙")]
        return "\n".join(lines)
    except Exception as e:
        return f"Gagal mengambil model: {e}"


def is_quota_exhausted(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    keywords = [
        "resource_exhausted", "resource has been exhausted", "429", "too many requests",
        "rate limit", "ratelimit", "rate_limit", "quota exceeded", "quota_exceeded",
        "exhausted your quota", "exhausted your daily", "exceeded your current quota",
        "token limit", "tokens per minute", "insufficient_quota", "insufficient quota",
        "out of credits", "credit limit", "request limit", "user has reached their request limit",
        "model is overloaded", "model capacity overloaded", "capacity exceeded"
    ]
    return any(kw in lower for kw in keywords)


def get_active_account_info() -> Dict[str, Any]:
    try:
        if not os.path.exists(DB_PATH):
            return {"name": "Default VPS", "status": "ready"}
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id, name, email, status FROM agy_accounts WHERE is_active = 1 LIMIT 1")
        row = c.fetchone()
        conn.close()
        if row:
            return {"id": row[0], "name": row[1], "email": row[2], "status": row[3]}
        return {"name": "Default VPS", "status": "ready"}
    except Exception:
        return {"name": "Default VPS", "status": "ready"}


def trigger_auto_fallback(current_acc_id: Optional[int] = None, reason: str = "") -> Optional[Dict[str, Any]]:
    """
    Finds next available account in database pool, marks current as quota exceeded,
    activates the new account, and syncs the token file to disk.
    """
    try:
        if not os.path.exists(DB_PATH):
            return None
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Check if fallback is globally enabled
        c.execute("SELECT value FROM agy_settings WHERE key = 'auto_fallback_enabled'")
        setting = c.fetchone()
        if setting and str(setting[0]).lower() in ('0', 'false'):
            conn.close()
            return None

        # Find current active account if not given
        if current_acc_id is None:
            c.execute("SELECT id, name FROM agy_accounts WHERE is_active = 1 LIMIT 1")
            act = c.fetchone()
            current_acc_id = act[0] if act else 0

        # Mark current account as quota exceeded
        if current_acc_id:
            c.execute("""
                UPDATE agy_accounts 
                SET status = 'quota_exceeded', last_error = ?, quota_exceeded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            """, (reason[:300] if reason else "Quota exceeded via Telegram bot", current_acc_id))

        # Look for ready candidate in pool
        c.execute("""
            SELECT id, name, token_json FROM agy_accounts 
            WHERE id != ? AND auto_fallback = 1 AND status = 'ready' 
            ORDER BY last_used_at ASC NULLS FIRST, id ASC LIMIT 1
        """, (current_acc_id,))
        candidate = c.fetchone()

        # If none ready, check 30min quota reset
        if not candidate:
            thirty_mins_ago = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() - 30 * 60))
            c.execute("""
                SELECT id, name, token_json FROM agy_accounts 
                WHERE id != ? AND auto_fallback = 1 AND status = 'quota_exceeded' AND quota_exceeded_at < ?
                ORDER BY quota_exceeded_at ASC, id ASC LIMIT 1
            """, (current_acc_id, thirty_mins_ago))
            candidate = c.fetchone()

        if not candidate:
            conn.commit()
            conn.close()
            return None

        target_id, target_name, target_token = candidate

        # Switch active in DB
        c.execute("UPDATE agy_accounts SET is_active = 0")
        c.execute("""
            UPDATE agy_accounts 
            SET is_active = 1, last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        """, (target_id,))
        conn.commit()
        conn.close()

        # Write token to disk
        os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
        with open(TOKEN_PATH, 'w', encoding='utf-8') as f:
            f.write(target_token.strip())
        os.chmod(TOKEN_PATH, 0o600)

        print(f"[+] Telegram Bot Auto-Fallback: Switched to '{target_name}' (ID: {target_id})")
        return {"id": target_id, "name": target_name}
    except Exception as e:
        print(f"[!] Auto-fallback error in Telegram Bot: {e}")
        return None


def get_agy_bin() -> str:
    env_bin = os.environ.get("AGY_BIN")
    if env_bin and os.path.exists(env_bin):
        return env_bin
    
    which_agy = shutil.which("agy") or shutil.which("agy.exe")
    if which_agy:
        return which_agy
        
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "agy", "bin", "agy.exe") if os.environ.get("LOCALAPPDATA") else None,
        os.path.expanduser("~/.local/bin/agy"),
        os.path.expanduser("~/.gemini/antigravity-cli/bin/agy"),
        os.path.expanduser("~/.gemini/antigravity-cli/bin/agy.cmd"),
        os.path.expanduser("~/.gemini/antigravity-cli/bin/agy.exe"),
        "/usr/local/bin/agy",
        "/usr/bin/agy"
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return "agy"


def run_agy_stream(
    prompt: str,
    conversation_id: Optional[str] = None,
    effort: str = "low",
    model: str = "",
    disable_slash_commands: bool = True,
    status_callback = None,
    retry_count: int = 0,
    max_retries: int = 3
) -> Dict[str, Any]:
    """
    Runs agy using stream-json format to get rapid execution, intermediate tool status, and isolated session tracking.
    Automatically retries with fallback account if quota limit is reached.
    """
    agy_bin = get_agy_bin()
    cmd = [agy_bin, "-p", prompt, "--output-format", "stream-json"]
    
    if conversation_id:
        cmd.extend(["--conversation", conversation_id])

    selected_model = (model or "").strip()
    if selected_model:
        cmd.extend(["--model", selected_model])
        has_embedded_effort = any(selected_model.endswith(sfx) for sfx in ["-high", "-medium", "-low", "-thinking"])
        if not has_embedded_effort and effort:
            cmd.extend(["--effort", effort])
    elif effort:
        cmd.extend(["--effort", effort])

    if disable_slash_commands:
        cmd.append("--disable-slash-commands")
    if DANGEROUSLY_SKIP_PERMISSIONS:
        cmd.append("--dangerously-skip-permissions")

    # Clean environment variables from nested Antigravity session
    clean_env = {}
    for k, v in os.environ.items():
        if not k.startswith("ANTIGRAVITY_") and k != "PAGER":
            clean_env[k] = v
    clean_env["PAGER"] = "cat"

    path_sep = ";" if sys.platform == "win32" else ":"
    extra_paths = [
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.gemini/antigravity-cli/bin"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "agy", "bin") if os.environ.get("LOCALAPPDATA") else ""
    ]
    extra_path_str = path_sep.join([p for p in extra_paths if p])
    clean_env["PATH"] = f"{extra_path_str}{path_sep}{clean_env.get('PATH', '')}"

    target_cwd = WORKSPACE if (WORKSPACE and os.path.exists(WORKSPACE)) else os.getcwd()

    process = subprocess.Popen(
        cmd,
        cwd=target_cwd,
        env=clean_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )

    extracted_conv_id = conversation_id
    final_response = ""
    last_update_time = 0
    stderr_out = ""

    try:
        for line in iter(process.stdout.readline, ''):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_type = event.get("event")
            
            if event_type == "init":
                extracted_conv_id = event.get("conversation_id", extracted_conv_id)
            
            elif event_type == "step_update":
                step = event.get("step_update", {})
                step_type = step.get("step_type")
                state = step.get("state")

                if step_type == "tool" and state == "ACTIVE":
                    tool_name = step.get("tool_name", "tool")
                    last_status = f"⚙️ Menjalankan `{tool_name}`..."
                    now = time.time()
                    if status_callback and (now - last_update_time >= 1.5):
                        last_update_time = now
                        status_callback(last_status)

                elif step_type == "agent_response" and step.get("text_delta"):
                    delta = step.get("text_delta")
                    if delta:
                        final_response += delta

            elif event_type == "result":
                res_obj = event.get("result", {})
                extracted_conv_id = res_obj.get("conversation_id", extracted_conv_id)
                final_response = res_obj.get("response", final_response)

        process.stdout.close()
        process.wait(timeout=TIMEOUT)

        if not final_response.strip():
            stderr_out = process.stderr.read().strip()
            if stderr_out:
                final_response = f"⚠️ *Stderr:*\n```\n{stderr_out}\n```"
            else:
                final_response = "*(Tidak ada respon teks dari AGY)*"

        # Check for quota exhaustion / token limits and trigger auto-fallback
        check_text = (final_response or "") + " " + (stderr_out or "")
        if is_quota_exhausted(check_text) and retry_count < max_retries:
            switched = trigger_auto_fallback(reason=check_text)
            if switched:
                if status_callback:
                    status_callback(f"🔄 _Token limit habis! Otomatis rotasi ke akun:_ *{switched['name']}*...")
                time.sleep(1.5)
                return run_agy_stream(
                    prompt=prompt,
                    conversation_id=conversation_id,
                    effort=effort,
                    model=model,
                    disable_slash_commands=disable_slash_commands,
                    status_callback=status_callback,
                    retry_count=retry_count + 1,
                    max_retries=max_retries
                )

        return {
            "success": True,
            "conversation_id": extracted_conv_id,
            "response": final_response.strip()
        }

    except subprocess.TimeoutExpired:
        process.kill()
        return {
            "success": False,
            "conversation_id": extracted_conv_id,
            "response": f"⏱️ *Timeout:* Perintah melebihi batas waktu ({TIMEOUT}s)."
        }
    except Exception as e:
        return {
            "success": False,
            "conversation_id": extracted_conv_id,
            "response": f"❌ *Error menjalankan AGY:* `{str(e)}`"
        }


def handle_callback_query(callback: dict):
    cb_id = callback.get("id")
    data = callback.get("data", "")
    message = callback.get("message", {})
    chat_id = message.get("chat", {}).get("id")
    msg_id = message.get("message_id")
    user = callback.get("from", {})
    user_id = user.get("id")
    username = user.get("username", "")

    if not is_user_allowed(user_id, username):
        answer_callback_query(cb_id, "⛔ Akses Ditolak!", show_alert=True)
        return

    session = chat_sessions.setdefault(chat_id, {
        "conversation_id": None,
        "effort": config.get("default_effort", "low"),
        "model": config.get("default_model", ""),
    })

    if data in ["act_status", "act_status_full"]:
        answer_callback_query(cb_id, "📊 Memperbarui status (Full)...")
        status_msg = get_vps_status(mode="full")
        edit_message(chat_id, msg_id, status_msg, parse_mode="HTML", reply_markup=get_status_keyboard(view_mode="full"))

    elif data == "act_status_compact":
        answer_callback_query(cb_id, "📱 Beralih ke mode ringkas...")
        status_msg = get_vps_status(mode="compact")
        edit_message(chat_id, msg_id, status_msg, parse_mode="HTML", reply_markup=get_status_keyboard(view_mode="compact"))

    elif data == "act_tunnel":
        answer_callback_query(cb_id, "🌐 Memeriksa link Cloudflare...")
        tunnel_url = get_latest_tunnel_url()
        if tunnel_url:
            msg = (
                f"🌐 *Link Cloudflare Tunnel AGY*\n\n"
                f"🔗 *URL Akses:*\n`{tunnel_url}`\n\n"
                f"🖥️ *Target Port:* `http://127.0.0.1:5678` (AGY Control Center)\n"
                f"⏱️ *Status:* Online & Aktif\n\n"
                f"_Klik tombol di bawah untuk langsung membuka web dashboard._"
            )
            markup = {
                "inline_keyboard": [
                    [{"text": "🌐 Buka AGY Web Control Center", "url": tunnel_url}],
                    [{"text": "🔄 Refresh Link", "callback_data": "act_tunnel"}, {"text": "📋 Menu Utama", "callback_data": "act_main_menu"}]
                ]
            }
            edit_message(chat_id, msg_id, msg, reply_markup=markup)
        else:
            edit_message(
                chat_id,
                msg_id,
                "⚠️ *Cloudflare Tunnel belum terdeteksi.*\nPastikan service `cloudflared` sedang berjalan.",
                reply_markup=get_main_menu_keyboard()
            )

    elif data == "act_reset":
        session["conversation_id"] = None
        answer_callback_query(cb_id, "🔄 Sesi chat berhasil di-reset!")
        edit_message(
            chat_id,
            msg_id,
            "🔄 *Sesi percakapan baru telah dimulai!*\nKonteks lama telah dibersihkan. Anda bisa mengirim pesan baru.",
            reply_markup=get_main_menu_keyboard()
        )

    elif data.startswith("set_effort:"):
        effort = data.split(":")[1]
        session["effort"] = effort
        answer_callback_query(cb_id, f"✅ Effort diatur ke: {effort.upper()}")
        edit_message(
            chat_id,
            msg_id,
            f"⚡ *Mode Reasoning Diubah:*\nLevel: `{effort.upper()}`\n\n"
            f"• `low`: Cepat kilat (1-3s)\n"
            f"• `high`: Berpikir mendalam untuk koding rumit",
            reply_markup=get_main_menu_keyboard()
        )

    elif data == "act_models_menu":
        answer_callback_query(cb_id, "📋 Membuka pilihan model...")
        edit_message(
            chat_id,
            msg_id,
            "📋 *Pilih Model AI:* Klik salah satu tombol di bawah ini:",
            reply_markup=get_models_keyboard()
        )

    elif data.startswith("set_model:"):
        model_val = data.split(":", 1)[1]
        if model_val == "default":
            session["model"] = ""
            display_name = "Default AGY"
        else:
            session["model"] = model_val
            display_name = model_val

        answer_callback_query(cb_id, f"✅ Model: {display_name}")
        edit_message(
            chat_id,
            msg_id,
            f"✅ *Model AI Berhasil Diubah!*\nModel aktif sekarang: `{display_name}`",
            reply_markup=get_main_menu_keyboard()
        )

    elif data == "act_main_menu":
        answer_callback_query(cb_id)
        effort = session.get("effort", "low")
        model = session.get("model") or "Default"
        acc = get_active_account_info()
        menu_text = (
            f"🤖 *Antigravity CLI (agy) Menu Utama*\n\n"
            f"👤 Akun AGY: *{acc['name']}* (`{acc['status'].upper()}`)\n"
            f"⚡ Mode Respon: *{effort.upper()}*\n"
            f"🧠 Model: `{model}`\n"
            f"🛡️ Auto-Fallback: *Aktif (Otomatis)*\n\n"
            f"Pilih opsi cepat di bawah atau ketik pesan langsung:"
        )
        edit_message(chat_id, msg_id, menu_text, reply_markup=get_main_menu_keyboard())

    elif data == "act_help":
        answer_callback_query(cb_id)
        help_msg = (
            f"📖 *Daftar Perintah & Navigasi:*\n\n"
            f"• Kirim file dokumen, teks, kodingan, atau foto langsung ke bot.\n"
            f"• *Usage VPS*: Cek status RAM, CPU, Disk, dan PM2 realtime.\n"
            f"• *Mode Fast*: Respon cepat (1-3 detik) untuk obrolan/tanya jawab.\n"
            f"• *Mode Smart*: Penalaran tinggi untuk logic kode berat.\n"
            f"• *Reset Chat*: Memulai obrolan bersih tanpa history lama.\n"
            f"• *Auto-Fallback*: Rotasi otomatis akun cadangan saat kuota habis.\n"
            f"• `/sh <cmd>`: Jalankan perintah bash di server VPS."
        )
        edit_message(chat_id, msg_id, help_msg, reply_markup=get_main_menu_keyboard())


def handle_message(message: dict):
    chat_id = message.get("chat", {}).get("id")
    user = message.get("from", {})
    user_id = user.get("id")
    username = user.get("username", "")
    text = (message.get("text") or message.get("caption") or "").strip()

    if not chat_id:
        return

    # Check attachment types
    file_attachment_info = ""
    file_id = None
    file_name = None

    if "document" in message:
        doc = message["document"]
        file_id = doc.get("file_id")
        file_name = doc.get("file_name", "document.bin")
    elif "photo" in message:
        # Telegram sends multiple photo sizes, pick the highest resolution (last element)
        photos = message["photo"]
        if photos:
            best_photo = photos[-1]
            file_id = best_photo.get("file_id")
            file_name = f"photo_{int(time.time())}.jpg"
    elif "audio" in message:
        audio = message["audio"]
        file_id = audio.get("file_id")
        file_name = audio.get("file_name", "audio.mp3")
    elif "voice" in message:
        voice = message["voice"]
        file_id = voice.get("file_id")
        file_name = f"voice_{int(time.time())}.ogg"

    if not text and not file_id:
        return

    if not is_user_allowed(user_id, username):
        send_message(
            chat_id,
            f"⛔ *Akses Ditolak*\nUser ID Anda (`{user_id}`) belum terdaftar di whitelist bot ini."
        )
        return

    session = chat_sessions.setdefault(chat_id, {
        "conversation_id": None,
        "effort": config.get("default_effort", "low"),
        "model": config.get("default_model", ""),
    })

    text_lower = text.lower()

    # Command & Button Handling (only when no file is being sent)
    if not file_id:
        if text == "/start" or text_lower in ["menu", "/menu"]:
            effort = session.get("effort", "low")
            model = session.get("model") or "Default"
            acc = get_active_account_info()
            welcome = (
                f"🤖 *Antigravity CLI (agy) Fast Telegram Bridge*\n\n"
                f"Halo, *{user.get('first_name', 'User')}*!\n"
                f"👤 Akun AGY: *{acc['name']}* (`{acc['status'].upper()}`)\n"
                f"⚡ Mode Respon: *{effort.upper()}* (Cepat & Ringan)\n"
                f"🧠 Model: `{model}`\n"
                f"🛡️ Auto-Fallback: *Aktif*\n\n"
                f"📎 *Fitur File:* Anda dapat mengirim file lampiran (PDF, Script/Kode, Teks, CSV, Gambar) langsung ke bot ini!\n\n"
                f"Gunakan tombol di bawah ini untuk mengontrol bot atau langsung kirim pesan teks/file untuk coding!"
            )
            send_message(chat_id, welcome, reply_markup=get_main_menu_keyboard())
            send_message(chat_id, "👇 _Keyboard tombol interaktif siap digunakan_", reply_markup=MAIN_REPLY_KEYBOARD)
            return

        elif text in ["/new", "/reset"] or text_lower in ["🔄 reset chat", "reset chat", "reset"]:
            session["conversation_id"] = None
            send_message(
                chat_id,
                "🔄 *Sesi percakapan baru dimulai!* Konteks lama telah dibersihkan.",
                reply_markup=get_main_menu_keyboard()
            )
            return

        elif text == "/fast" or text_lower in ["⚡ mode fast", "mode fast", "fast"]:
            session["effort"] = "low"
            send_message(
                chat_id,
                "⚡ *Mode Fast Aktif!* (Effort: `low` - respon instan dalam hitungan detik)",
                reply_markup=get_main_menu_keyboard()
            )
            return

        elif text == "/smart" or text_lower in ["🧠 mode smart", "mode smart", "smart"]:
            session["effort"] = "high"
            send_message(
                chat_id,
                "🧠 *Mode Smart Aktif!* (Effort: `high` - penalaran mendalam untuk tugas kompleks)",
                reply_markup=get_main_menu_keyboard()
            )
            return

        elif text_lower in ["📊 usage vps", "usage vps", "/status", "status"]:
            send_chat_action(chat_id, "typing")
            status_msg = get_vps_status(mode="full")
            send_message(chat_id, status_msg, parse_mode="HTML", reply_markup=get_status_keyboard(view_mode="full"))
            return

        elif text_lower in ["📋 model ai", "model ai", "/models", "models"]:
            send_chat_action(chat_id, "typing")
            send_message(
                chat_id,
                "📋 *Pilih Model AI:* Klik salah satu pilihan di bawah:",
                reply_markup=get_models_keyboard()
            )
            return

        elif text.startswith("/effort"):
            parts = text.split()
            if len(parts) > 1 and parts[1].lower() in ["low", "medium", "high"]:
                session["effort"] = parts[1].lower()
                send_message(chat_id, f"✅ Reasoning effort diatur ke: `{session['effort']}`", reply_markup=get_main_menu_keyboard())
            else:
                send_message(chat_id, f"ℹ️ Effort saat ini: `{session.get('effort', 'low')}`\nPilihan: `/effort low`, `/effort medium`, `/effort high`", reply_markup=get_main_menu_keyboard())
            return

        elif text.startswith("/model"):
            parts = text.split(maxsplit=1)
            if len(parts) > 1:
                session["model"] = parts[1].strip()
                send_message(chat_id, f"✅ Model diatur ke: `{session['model']}`", reply_markup=get_main_menu_keyboard())
            else:
                curr_model = session.get("model") or "Default AGY"
                send_message(chat_id, f"ℹ️ Model saat ini: `{curr_model}`\nKetik `/models` untuk melihat daftar pilihan.", reply_markup=get_models_keyboard())
            return

        elif text in ["/tunnel", "/link", "/url", "/web"] or text_lower in [
            "🌐 link cloudflare", "link cloudflare", "link", "tunnel", "url", "cek link"
        ]:
            send_chat_action(chat_id, "typing")
            tunnel_url = get_latest_tunnel_url()
            if tunnel_url:
                msg = (
                    f"🌐 *Link Cloudflare Tunnel AGY*\n\n"
                    f"🔗 *URL Akses:*\n`{tunnel_url}`\n\n"
                    f"🖥️ *Target Port:* `http://127.0.0.1:5678` (AGY Control Center)\n"
                    f"⏱️ *Status:* Online & Aktif\n\n"
                    f"_Klik tombol di bawah untuk langsung membuka web dashboard._"
                )
                markup = {
                    "inline_keyboard": [
                        [{"text": "🌐 Buka AGY Web Control Center", "url": tunnel_url}],
                        [{"text": "🔄 Refresh Link", "callback_data": "act_tunnel"}, {"text": "📋 Menu Utama", "callback_data": "act_main_menu"}]
                    ]
                }
                send_message(chat_id, msg, reply_markup=markup)
            else:
                send_message(
                    chat_id,
                    "⚠️ *Cloudflare Tunnel belum terdeteksi.*\nPastikan service `cloudflared` sedang berjalan di background.",
                    reply_markup=get_main_menu_keyboard()
                )
            return

        elif text == "/help" or text_lower in ["📖 bantuan", "bantuan", "help"]:
            help_msg = (
                f"📖 *Panduan Tombol & Perintah:*\n\n"
                f"📎 *Lampiran File* : Kirim file dokumen, teks, kode (py/js/json/dll), PDF, Word, atau gambar langsung dengan pesan/caption.\n"
                f"🌐 *Link Cloudflare* : Akses link web dashboard AGY Control Center.\n"
                f"📊 *Usage VPS* : Cek penggunaan CPU, RAM, Disk, dan PM2 realtime.\n"
                f"⚡ *Mode Fast* : Respon cepat kilat (1-3 detik).\n"
                f"🧠 *Mode Smart* : Analisis mendalam untuk tugas sulit.\n"
                f"🔄 *Reset Chat* : Bersihkan konteks sesi.\n"
                f"📋 *Model AI* : Ganti model AI secara instan.\n"
                f"💻 `/sh <cmd>` : Jalankan perintah terminal VPS (contoh: `/sh df -h`)\n"
                f"🆔 `/id` : Tampilkan Telegram User ID Anda."
            )
            send_message(chat_id, help_msg, reply_markup=get_main_menu_keyboard())
            return

        elif text == "/id":
            send_message(chat_id, f"🆔 Telegram User ID Anda: `{user_id}`")
            return

        elif text.startswith("/sh "):
            cmd = text[4:].strip()
            if not cmd:
                send_message(chat_id, "⚠️ Berikan perintah shell yang ingin dijalankan. Contoh: `/sh ls -la`")
                return
            send_chat_action(chat_id, "typing")
            out = execute_shell(cmd)
            send_message(chat_id, out)
            return

    # Handle downloading & parsing attachment if present
    if file_id:
        send_chat_action(chat_id, "typing")
        downloaded_path = download_telegram_file(file_id, file_name)
        if downloaded_path:
            file_type_desc, file_attachment_info = extract_file_content(downloaded_path)
            print(f"[*] Downloaded {file_name} -> {downloaded_path} ({file_type_desc})")
        else:
            file_attachment_info = f"⚠️ [Gagal mengunduh file lampiran: {file_name}]"

    # Construct final prompt combining text/caption and file content
    if file_attachment_info:
        if text:
            full_prompt = f"{text}\n\n{file_attachment_info}"
        else:
            full_prompt = f"Tolong periksa, baca, dan analisis file lampiran berikut:\n\n{file_attachment_info}"
    else:
        full_prompt = text

    # Process prompt with agy
    stop_typing_event = threading.Event()

    def keep_typing():
        while not stop_typing_event.is_set():
            send_chat_action(chat_id, "typing")
            time.sleep(4)

    typing_thread = threading.Thread(target=keep_typing, daemon=True)
    typing_thread.start()

    placeholder_msg_id = None
    if config.get("stream_progress", True):
        initial_status = "📥 _Mengunduh & memproses file..._" if file_id else "💭 _Sedang memproses..._"
        placeholder_msg_id = send_message(chat_id, initial_status)

    def on_status_update(status_text: str):
        if placeholder_msg_id:
            edit_message(chat_id, placeholder_msg_id, status_text)

    try:
        res = run_agy_stream(
            prompt=full_prompt,
            conversation_id=session.get("conversation_id"),
            effort=session.get("effort", "low"),
            model=session.get("model", ""),
            disable_slash_commands=config.get("disable_slash_commands", True),
            status_callback=on_status_update if placeholder_msg_id else None
        )
        
        if res.get("conversation_id"):
            session["conversation_id"] = res["conversation_id"]

        final_text = res.get("response", "")
        
        # If we have a placeholder and final_text fits in one message, edit it directly
        if placeholder_msg_id and len(final_text) <= 3900:
            success = edit_message(chat_id, placeholder_msg_id, final_text)
            if not success:
                send_message(chat_id, final_text)
        else:
            if placeholder_msg_id:
                # remove placeholder or replace with start
                edit_message(chat_id, placeholder_msg_id, "✅ *Selesai:*")
            send_message(chat_id, final_text)

    finally:
        stop_typing_event.set()


def poll_updates():
    global is_running
    offset = 0
    print("[*] Fast Telegram bot service started with buttons support. Polling...")

    while is_running:
        try:
            params = {"offset": offset, "timeout": 20}
            resp = send_telegram_request("getUpdates", params, timeout=30)
            if resp.get("ok"):
                for update in resp.get("result", []):
                    offset = update["update_id"] + 1
                    if "message" in update:
                        threading.Thread(
                            target=handle_message,
                            args=(update["message"],),
                            daemon=True
                        ).start()
                    elif "callback_query" in update:
                        threading.Thread(
                            target=handle_callback_query,
                            args=(update["callback_query"],),
                            daemon=True
                        ).start()
            else:
                time.sleep(2)
        except Exception as e:
            print(f"[!] Polling error: {e}")
            time.sleep(3)


def signal_handler(sig, frame):
    global is_running
    print("\n[*] Stopping bot...")
    is_running = False
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    if not os.path.exists(CONFIG_FILE):
        save_config(config)

    # Start Cloudflare Tunnel Auto-notifier thread
    threading.Thread(target=tunnel_monitor_worker, daemon=True).start()

    poll_updates()

