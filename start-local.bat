@echo off
setlocal enabledelayedexpansion
title Antigravity (AGY) Integration Hub - Local PC Launcher
echo ========================================================
echo   Antigravity (AGY) Integration Hub
echo   Control Center Web + Telegram Bot + Auto-Fallback Pool
echo ========================================================
echo.

cd /d "%~dp0"

REM Find Python Executable
set "PYTHON_EXE=python"
python --version >nul 2>&1
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    )
)

echo [*] Using Python: !PYTHON_EXE!

echo [*] Checking Node.js dependencies in agy-project-manager...
cd agy-project-manager
if not exist "node_modules" (
    echo [*] Installing NPM packages...
    call npm.cmd install
)
cd ..

echo [*] Checking Python dependencies in agy-telegram-bot...
call "!PYTHON_EXE!" -m pip install -r agy-telegram-bot\requirements.txt --quiet --disable-pip-version-check

echo.
echo ========================================================
echo [1] Starting AGY Project Manager Web Dashboard on http://localhost:5678 ...
echo [2] Starting AGY Telegram Bot Bridge ...
echo ========================================================
echo.

start "AGY Web Manager (Port 5678)" cmd /k "cd /d "%~dp0agy-project-manager" && node server.js"
start "AGY Telegram Bot" cmd /k "cd /d "%~dp0agy-telegram-bot" && "!PYTHON_EXE!" bot.py"

echo [+] Services launched in separate windows!
echo [+] Web Dashboard: http://localhost:5678 (Login default: admin / admin@prime2026!)
echo.
pause
