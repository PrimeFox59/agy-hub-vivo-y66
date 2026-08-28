# AGY Fast Telegram Bot Bridge

Jembatan interaktif antara Telegram Bot dan Google Antigravity CLI (AGY) di server VPS dengan tombol inline, pemrosesan dokumen/file, status live streaming, dan rotasi kuota otomatis (*Auto-Fallback*).

## Fitur Utama
- **Auto-Fallback Integrasi Database**: Otomatis berganti ke akun cadangan saat token limit habis tanpa memutus percakapan.
- **Kirim & Analisis File**: Menerima file kode, PDF, Word, CSV, teks, gambar, dan suara untuk dianalisis langsung oleh AGY.
- **Dukungan Multi-Model**: Gemini 3.7 Flash, Claude Sonnet 4.6, Gemini 3.1 Pro, dll.
- **Perintah Eksekusi Cepat Shell**: `/sh <command>` untuk kontrol server langsung via Telegram.
- **Whitelist Akses Aman**: Hanya user ID yang diizinkan yang dapat berinteraksi dengan bot.

## Menjalankan Bot
```bash
python3 bot.py
# Atau via PM2:
pm2 start bot.py --name "agy-telegram-bot" --interpreter python3
```
