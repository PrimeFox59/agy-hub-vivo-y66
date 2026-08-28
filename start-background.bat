@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM 1. Detect Python
set "PYTHON_EXE=python"
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
)

REM 2. Check if port 5678 is already running
netstat -aon | find ":5678" | find "LISTENING" >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0agy-project-manager' -WindowStyle Hidden"
)

REM 3. Start Telegram Bot if config.json exists
if exist "%~dp0agy-telegram-bot\config.json" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%PYTHON_EXE%' -ArgumentList 'bot.py' -WorkingDirectory '%~dp0agy-telegram-bot' -WindowStyle Hidden"
)

exit /b 0
