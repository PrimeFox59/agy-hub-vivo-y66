# AGY Project Manager & Control Center

Dashboard Web modern untuk mengelola Google Antigravity CLI (AGY), multi-akun OAuth, sistem rotasi kuota otomatis (*Auto-Fallback*), pemantauan server VPS realtime, dan delegasi tugas AI.

## Fitur Utama
- **Multi-Akun AGY & Auto-Fallback**: Rotasi otomatis akun cadangan saat token habis / HTTP 429 tanpa menghentikan proses.
- **1-Click Google OAuth Wizard**: Hubungkan akun Google baru langsung dari web interface.
- **Dukungan 14 Model AI**: Gemini 3.7 Flash, Claude Sonnet 4.6, Gemini 3.1 Pro, Opus, dll.
- **Realtime Chat Streaming**: Obrolan interaktif dengan visualisasi tool yang sedang berjalan (SSE).
- **Task & Project Manager**: Delegasi tugas coding dan otomatisasi langsung ke AGY CLI.
- **VPS Metrics & PM2 Manager**: Monitor CPU, RAM, Disk, dan restart service langsung dari dashboard.

## Instalasi & Menjalankan
```bash
npm install
npm start
# Atau via PM2:
pm2 start server.js --name "agy-project-manager"
```
