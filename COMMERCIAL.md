# 🚀 Antigravity Orchestrator Pro (AGY Hub Pro)
### *The Ultimate Enterprise AI Agent Orchestration, Multi-Account Fallback & OpenAI-Compatible Gateway*

[![Version](https://img.shields.io/badge/version-2.5.0--pro-6366f1.svg)](https://github.com/PrimeFox59/agy-integration-hub)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Docker-emerald.svg)](https://github.com/PrimeFox59/agy-integration-hub)
[![License](https://img.shields.io/badge/license-Commercial%20Ready-amber.svg)](LICENSE)

---

## 💎 Ringkasan Produk & Nilai Jual Tinggi (Value Proposition)

**Antigravity Orchestrator Pro** adalah platform manajemen AI Agent lengkap yang mengubah Antigravity CLI (Gemini 3.7 Flash/Pro, Claude 3.7 Sonnet, GPT-OSS) menjadi **sistem AI otonom nir-henti (Zero-Downtime)**. 

Masalah terbesar developer dan perusahaan saat menggunakan AI canggih untuk coding adalah: **Rate Limit (429 Too Many Requests) & Quota Token Habis**. Produk ini menyelesaikan masalah tersebut dengan **Sistem Rotasi Multi-Akun Otomatis** tanpa memutus proses generate kode atau percakapan pengguna.

---

## 🔥 Fitur Utama Siap Jual (Key Selling Features)

### 1. 🔄 Smart Multi-Account Auto-Fallback Engine
* **Pendeteksian Error Cerdas:** Memantau `429`, `RESOURCE_EXHAUSTED`, `Rate Limit`, `Quota Exceeded` secara real-time.
* **Strategi Rotasi Canggih:** 
  * `Least-Used` (Prioritaskan akun dengan beban terendah)
  * `Round-Robin` (Bagi rata ke seluruh akun)
  * `Fastest / Ready First` (Pilih akun dengan latensi terendah)
* **Auto-Cooldown Recovery:** Akun yang terkena limit otomatis diistirahatkan (30 menit) lalu diaktifkan kembali tanpa intervensi manusia.
* **1-Click Google OAuth Wizard:** Tambah akun Google tanpa perlu mengutak-atik terminal.

### 2. 🔌 OpenAI-Compatible API Gateway (`/v1/chat/completions`)
* Expose standard endpoint `/v1/chat/completions` & `/v1/models`.
* **Dapat langsung dihubungkan ke:**
  * **Cursor IDE / Continue.dev / VS Code Extensions**
  * **LibreChat / OpenWebUI / TypingMind / Chatbox**
  * **Backend App (Python, Node.js, Go, PHP)**
* Semua request dari aplikasi luar otomatis menikmati fitur rotasi akun & auto-fallback!

### 3. 📱 Telegram Bot Pro Bridge
* Kontrol AI Agent dan monitoring server langsung dari ponsel.
* Interactive inline buttons (Pilih model AI, cek resource CPU/RAM, ganti mode cepat/smart).
* Whitelist access control & token streaming realtime.

### 4. 📊 VPS & Host Performance Real-time Monitoring
* Live CPU, RAM, Disk storage, Uptime, and PM2 service managers via WebSockets (RCT).

### 5. 🗄️ Multi-Workspace & Task Delegation
* Delegasi task project langsung ke Antigravity CLI di latar belakang.
* Histori chat, attachment viewer, dan prompt template library.

---

## 💰 Strategi Monetisasi (Cara Menjual Produk Ini)

| Model Bisnis | Target Pasar | Kisaran Harga Rekomendasi |
|---|---|---|
| **Digital Product (Gumroad / CodeCanyon)** | Freelancer & Indie Hacker yang butuh unlimited AI coding | $29 - $69 / One-time license |
| **B2B Agency AI Setup** | Software House yang butuh gateway AI internal untuk tim | $150 - $450 / Client Deployment |
| **Private SaaS Hosting** | Menyewakan akses gateway AI siap pakai | $15 - $35 / Bulan per seat |

---

## 🚀 Panduan Menjalankan

### Di Windows (PC Lokal)
Cukup klik ganda:
```text
D:\0 Running Apps\agy-integration-hub\start-local.bat
```

### Di Linux / VPS Server (PM2)
```bash
bash install.sh
```

### Menggunakan Docker & Docker Compose
```bash
docker-compose up -d
```

---

## 🔌 Cara Menghubungkan ke Cursor / Continue.dev / Third-Party Apps

1. Buka menu **API Gateway & Keys** di Dashboard (`http://localhost:5678`).
2. Buat API Key baru (misal: `sk-agy-xxxxxxxx`).
3. Pada pengaturan Cursor / Continue.dev / OpenAI Client:
   * **Base URL:** `http://localhost:5678/v1`
   * **API Key:** `sk-agy-xxxxxxxx`
   * **Model:** `gemini-3.7-flash-low` atau `claude-sonnet-4-6`

---

## 📄 Lisensi Komersial
Dilengkapi dengan lisensi komersial fleksibel untuk deployment mandiri, modifikasi, dan integrasi solusi klien.
