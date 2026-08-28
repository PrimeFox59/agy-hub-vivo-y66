@echo off
title Disable AGY Integration Hub Auto-Start
echo ========================================================
echo   Menonaktifkan Auto-Start AGY Integration Hub...
echo ========================================================

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\AGYIntegrationHub.vbs"

if exist "%VBS_PATH%" (
    del /f /q "%VBS_PATH%" >nul 2>&1
    echo [✓] Auto-Start BERHASIL dinonaktifkan.
) else (
    echo [!] File Auto-Start tidak ditemukan di folder Startup.
)

echo.
pause
