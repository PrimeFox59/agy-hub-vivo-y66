@echo off
title Enable AGY Integration Hub Auto-Start
echo ========================================================
echo   Mengaktifkan Auto-Start AGY Integration Hub...
echo ========================================================

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\AGYIntegrationHub.vbs"

(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.CurrentDirectory = "%~dp0"
echo WshShell.Run "cmd /c start-background.bat", 0, False
echo Set WshShell = Nothing
) > "%VBS_PATH%"

echo [✓] Auto-Start BERHASIL diaktifkan!
echo [*] Script VBS telah dipasang di Startup Windows.
echo [*] AGY Integration Hub akan otomatis jalan di latar belakang setiap PC menyala/restart.
echo.
pause
