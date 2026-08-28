@echo off
title Stop AGY Integration Hub
echo ========================================================
echo   Menghentikan AGY Integration Hub Services...
echo ========================================================

:: Stop node server running on port 5678
for /f "tokens=5" %%a in ('netstat -aon ^| find ":5678" ^| find "LISTENING"') do (
    echo [*] Menghentikan AGY Web Manager (PID: %%a)...
    taskkill /PID %%a /F >nul 2>&1
)

:: Stop Telegram Bot if running
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq AGY_Bot_Daemon" /NH 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo [✓] AGY Integration Hub berhasil dimatikan (STOPPED).
echo.
pause
