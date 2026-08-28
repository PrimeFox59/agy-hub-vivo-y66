# Antigravity (AGY) Integration Hub - PowerShell Launcher
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Antigravity (AGY) Integration Hub - Local PC Launcher" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Detect Python
$pythonExe = "python"
try {
    $ver = & python --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Not in path" }
} catch {
    $fallbackPaths = @(
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe"
    )
    foreach ($p in $fallbackPaths) {
        if (Test-Path $p) {
            $pythonExe = $p
            break
        }
    }
}

Write-Host "[*] Using Python: $pythonExe" -ForegroundColor Gray

# 1. Install npm deps
$managerDir = Join-Path $scriptDir "agy-project-manager"
if (-not (Test-Path (Join-Path $managerDir "node_modules"))) {
    Write-Host "[*] Installing Node.js packages in agy-project-manager..." -ForegroundColor Yellow
    Start-Process -FilePath "npm.cmd" -ArgumentList "install" -WorkingDirectory $managerDir -Wait
}

# 2. Install python deps
$botDir = Join-Path $scriptDir "agy-telegram-bot"
Write-Host "[*] Checking Python packages in agy-telegram-bot..." -ForegroundColor Yellow
Start-Process -FilePath $pythonExe -ArgumentList "-m pip install -r requirements.txt --quiet" -WorkingDirectory $botDir -Wait

# 3. Start Manager
Write-Host "[+] Launching AGY Project Manager Web Dashboard on http://localhost:5678" -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$managerDir'; node server.js"

# 4. Start Telegram Bot
Write-Host "[+] Launching AGY Telegram Bot Bridge" -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$botDir'; & '$pythonExe' bot.py"

Write-Host "`n[✓] Both services are running!" -ForegroundColor Cyan
Write-Host "[✓] Open http://localhost:5678 in your browser (Login: admin / admin@prime2026!)" -ForegroundColor Yellow
