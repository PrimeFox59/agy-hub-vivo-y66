const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

try {
  const projectDir = __dirname;
  const vbsSource = path.join(projectDir, 'autostart-agy-hub.vbs');
  
  // 1. Startup Folder
  const startupFolder = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  if (!fs.existsSync(startupFolder)) {
    fs.mkdirSync(startupFolder, { recursive: true });
  }
  const startupDest = path.join(startupFolder, 'agy-hub-autostart.vbs');
  fs.copyFileSync(vbsSource, startupDest);
  console.log('[+] 1. Installed in Windows Startup Folder:', startupDest);

  // 2. Registry HKCU Run Key (No admin required)
  try {
    const psCmd = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'AGYControlCenter' -Value 'wscript.exe "${vbsSource.replace(/\\/g, '\\\\')}"'`;
    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: 'inherit' });
    console.log('[+] 2. Registered in Windows Registry HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  } catch (e) {
    console.warn('[!] Registry Run key notice:', e.message);
  }

  // 3. Verify SQLite Auto-Fallback is enabled
  const db = require('./db');
  db.prepare("INSERT OR REPLACE INTO agy_settings (key, value) VALUES ('auto_fallback_enabled', '1')").run();
  console.log('[+] 3. Auto-Fallback setting in database verified: ACTIVE (1)');

  console.log('[SUCCESS] Auto-start & Auto-Fallback configured permanently!');
} catch (e) {
  console.error('[ERROR] Failed to configure autostart:', e.message);
}
