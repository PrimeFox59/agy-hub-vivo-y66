const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execSync } = require('child_process');
const db = require('./db');

const TOKEN_FILE_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const loginSessions = new Map();

const GOOGLE_CLIENT_ID = 'Buffer.from(" ODg0MzU0OTE5MDUyLTM2dHJjMWpqYjN0Z3VpYWMzMm92NmNvZDI2OGM1YmxoLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t, base64).toString()';
const GOOGLE_CLIENT_SECRET = 'Buffer.from(R0NDU1BYLTlZUXdwRjdSV0RDMFFUZGoteVhrTXdSMFp0c1g=, base64).toString()';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email';

/**
 * Returns path to AGY OAuth token file
 */
function getTokenFilePath() {
  return TOKEN_FILE_PATH;
}

/**
 * Get setting from database
 */
function getAgySetting(key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (err) {
    return defaultValue;
  }
}

/**
 * Save setting to database
 */
function setAgySetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run(key, String(value));
    return true;
  } catch (err) {
    console.error('Failed to set agy setting:', err);
    return false;
  }
}

/**
 * Check if Auto-Fallback is globally enabled
 */
function isAutoFallbackEnabled() {
  const val = getAgySetting('auto_fallback_enabled', '1');
  return val === '1' || val === 'true' || val === true;
}

const psWinCredScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCredHelper {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string ReadSecret(string target) {
        IntPtr credPtr;
        if (CredRead(target, 1, 0, out credPtr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
                byte[] bytes = new byte[cred.CredentialBlobSize];
                Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
                CredFree(credPtr);
                return Encoding.UTF8.GetString(bytes);
            }
            CredFree(credPtr);
        }
        return "";
    }
}
'@
[WinCredHelper]::ReadSecret('gemini:antigravity')
`;

function getWindowsAgyToken() {
  if (process.platform !== 'win32') return null;
  try {
    const b64 = Buffer.from(psWinCredScript, 'utf16le').toString('base64');
    const { execFileSync } = require('child_process');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out && (out.includes('access_token') || out.includes('refresh_token'))) {
      return out;
    }
  } catch (e) {}
  return null;
}

function fetchGoogleUserInfo(accessToken) {
  return new Promise((resolve) => {
    https.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const user = JSON.parse(body);
          if (user && user.email) return resolve(user);
        } catch (_) {}
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

function refreshGoogleAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.access_token || null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

function detectSystemAgyMetadata() {
  let model = 'Gemini 3.7 Flash';
  let cliVersion = '1.1.22';

  // Read settings.json
  const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (s.model) model = s.model;
    } catch (_) {}
  }

  // Read raw token from WinCred or token file
  let rawToken = getWindowsAgyToken();
  if (!rawToken && fs.existsSync(TOKEN_FILE_PATH)) {
    try {
      const f = fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim();
      if (f && (f.includes('access_token') || f.includes('refresh_token'))) {
        rawToken = f;
      }
    } catch (_) {}
  }

  return { rawToken, model, cliVersion };
}

let isSyncingProfile = false;

async function syncSystemAccountDetails() {
  if (isSyncingProfile) return;
  isSyncingProfile = true;
  try {
    const { rawToken, model, cliVersion } = detectSystemAgyMetadata();
    if (!rawToken) return;

    let parsedToken;
    try { parsedToken = JSON.parse(rawToken); } catch (_) { return; }

    let accessToken = parsedToken.token?.access_token;
    const refreshToken = parsedToken.token?.refresh_token;

    let userInfo = null;
    if (accessToken) {
      userInfo = await fetchGoogleUserInfo(accessToken);
    }
    if ((!userInfo || !userInfo.email) && refreshToken) {
      const newAccess = await refreshGoogleAccessToken(refreshToken);
      if (newAccess) {
        accessToken = newAccess;
        userInfo = await fetchGoogleUserInfo(newAccess);
        if (parsedToken.token) parsedToken.token.access_token = newAccess;
      }
    }

    const email = userInfo?.email || '';
    const name = userInfo?.name ? `${userInfo.name} (Antigravity CLI)` : (email ? `Akun Antigravity (${email.split('@')[0]})` : 'Akun Antigravity CLI (Sistem Utama)');
    const avatarUrl = userInfo?.picture || '';
    const cleanTokenJson = JSON.stringify(parsedToken);

    // Write token to disk if not exists or different
    try {
      if (!fs.existsSync(TOKEN_FILE_PATH) || fs.readFileSync(TOKEN_FILE_PATH, 'utf8').trim() !== cleanTokenJson) {
        writeTokenToDisk(cleanTokenJson);
      }
    } catch (_) {}

    // Check if we have an active or placeholder account to update
    const placeholderAcc = db.prepare(`
      SELECT id FROM agy_accounts
      WHERE email LIKE '%system.local%' OR email = '' OR email = ? OR is_active = 1
      ORDER BY is_active DESC, id ASC LIMIT 1
    `).get(email);

    if (placeholderAcc) {
      db.prepare(`
        UPDATE agy_accounts
        SET name = ?,
            email = ?,
            avatar_url = ?,
            model = ?,
            cli_version = ?,
            token_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, email, avatarUrl, model, cliVersion, cleanTokenJson, placeholderAcc.id);
    } else {
      db.prepare(`
        INSERT INTO agy_accounts (name, email, avatar_url, model, cli_version, token_json, is_active, status, auto_fallback)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'ready', 1)
      `).run(name, email, avatarUrl, model, cliVersion, cleanTokenJson);
    }
  } catch (err) {
    console.error('Error syncing system AGY account details:', err.message);
  } finally {
    isSyncingProfile = false;
  }
}

/**
 * Get all AGY accounts from DB with on-the-fly auto seed for native Antigravity CLI
 */
function getAgyAccounts() {
  try {
    let accounts = db.prepare(`
      SELECT id, name, email, avatar_url, model, cli_version, is_active, status, auto_fallback, usage_count,
             last_used_at, last_error, quota_exceeded_at, latency_ms, success_count, fail_count, created_at, updated_at
      FROM agy_accounts
      ORDER BY is_active DESC, id ASC
    `).all();

    if (accounts.length === 0 || accounts.some(a => a.email.includes('system.local') || !a.email || !a.avatar_url)) {
      syncSystemAccountDetails();
      accounts = db.prepare(`
        SELECT id, name, email, avatar_url, model, cli_version, is_active, status, auto_fallback, usage_count,
               last_used_at, last_error, quota_exceeded_at, latency_ms, success_count, fail_count, created_at, updated_at
        FROM agy_accounts
        ORDER BY is_active DESC, id ASC
      `).all();
    }

    return accounts;
  } catch (err) {
    console.error('Error fetching agy accounts:', err);
    return [];
  }
}

/**
 * Get the currently active AGY account
 */
function getActiveAccount() {
  try {
    let active = db.prepare('SELECT * FROM agy_accounts WHERE is_active = 1 LIMIT 1').get();
    if (!active) {
      getAgyAccounts();
      active = db.prepare('SELECT * FROM agy_accounts WHERE is_active = 1 LIMIT 1').get();
    }
    return active;
  } catch (err) {
    console.error('Error fetching active agy account:', err);
    return null;
  }
}

/**
 * Get account by ID
 */
function getAccountById(id) {
  try {
    return db.prepare('SELECT * FROM agy_accounts WHERE id = ?').get(id);
  } catch (err) {
    return null;
  }
}

/**
 * Sync refreshed disk token to currently active DB account
 */
function syncDiskTokenToActiveAccount() {
  try {
    if (!fs.existsSync(TOKEN_FILE_PATH)) return;
    const diskToken = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    if (!diskToken) return;

    const active = getActiveAccount();
    if (active && active.token_json !== diskToken) {
      db.prepare(`
        UPDATE agy_accounts
        SET token_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(diskToken, active.id);
    }
  } catch (err) {
    console.error('Error syncing disk token to DB:', err.message);
  }
}

/**
 * Write token to disk safely
 */
function writeTokenToDisk(tokenJson) {
  const dir = path.dirname(TOKEN_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(TOKEN_FILE_PATH, tokenJson, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    fs.writeFileSync(TOKEN_FILE_PATH, tokenJson, { encoding: 'utf-8' });
  }
}

/**
 * Switch active account to specified account ID
 */
function switchActiveAccount(accountId, reason = '') {
  const target = getAccountById(accountId);
  if (!target) {
    throw new Error(`Akun AGY dengan ID ${accountId} tidak ditemukan`);
  }

  try {
    JSON.parse(target.token_json);
  } catch (err) {
    throw new Error(`Token JSON pada akun ${target.name} tidak valid: ${err.message}`);
  }

  db.transaction(() => {
    db.prepare('UPDATE agy_accounts SET is_active = 0').run();
    db.prepare(`
      UPDATE agy_accounts
      SET is_active = 1, last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(accountId);
  })();

  writeTokenToDisk(target.token_json);
  return target;
}

/**
 * Add a new AGY account
 */
function addAgyAccount({ name, email = '', token_json, auto_fallback = 1, set_active = false }) {
  if (!name || !name.trim()) {
    throw new Error('Nama akun wajib diisi');
  }
  if (!token_json || !token_json.trim()) {
    throw new Error('Token JSON wajib diisi');
  }

  let cleanJson = token_json.trim();
  try {
    const parsed = JSON.parse(cleanJson);
    cleanJson = JSON.stringify(parsed);
  } catch (err) {
    throw new Error('Format Token JSON tidak valid. Pastikan format JSON benar.');
  }

  const existingCount = db.prepare('SELECT count(*) as count FROM agy_accounts').get().count;
  const shouldBeActive = set_active || existingCount === 0;

  const result = db.prepare(`
    INSERT INTO agy_accounts (name, email, token_json, is_active, status, auto_fallback)
    VALUES (?, ?, ?, ?, 'ready', ?)
  `).run(
    name.trim(),
    email ? email.trim() : '',
    cleanJson,
    shouldBeActive ? 1 : 0,
    auto_fallback ? 1 : 0
  );

  const newId = result.lastInsertRowid;

  if (shouldBeActive) {
    switchActiveAccount(newId, 'Initial creation / set as active');
  }

  return getAccountById(newId);
}

/**
 * Update existing AGY account
 */
function updateAgyAccount(id, { name, email, token_json, auto_fallback, status }) {
  const current = getAccountById(id);
  if (!current) {
    throw new Error('Akun AGY tidak ditemukan');
  }

  let cleanToken = current.token_json;
  if (token_json && token_json.trim()) {
    try {
      const parsed = JSON.parse(token_json.trim());
      cleanToken = JSON.stringify(parsed);
    } catch (err) {
      throw new Error('Format Token JSON baru tidak valid');
    }
  }

  db.prepare(`
    UPDATE agy_accounts
    SET name = COALESCE(?, name),
        email = COALESCE(?, email),
        token_json = ?,
        auto_fallback = COALESCE(?, auto_fallback),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name ? name.trim() : null,
    email !== undefined ? (email ? email.trim() : '') : null,
    cleanToken,
    auto_fallback !== undefined ? (auto_fallback ? 1 : 0) : null,
    status || null,
    id
  );

  if (current.is_active && token_json) {
    writeTokenToDisk(cleanToken);
  }

  return getAccountById(id);
}

/**
 * Delete AGY account
 */
function deleteAgyAccount(id) {
  const current = getAccountById(id);
  if (!current) {
    throw new Error('Akun AGY tidak ditemukan');
  }

  const total = db.prepare('SELECT count(*) as count FROM agy_accounts').get().count;
  if (total <= 1) {
    throw new Error('Tidak dapat menghapus satu-satunya akun AGY yang tersedia');
  }

  if (current.is_active) {
    const other = db.prepare('SELECT id FROM agy_accounts WHERE id != ? ORDER BY id ASC LIMIT 1').get(id);
    if (other) {
      switchActiveAccount(other.id, 'Switching before deleting active account');
    }
  }

  db.prepare('DELETE FROM agy_accounts WHERE id = ?').run(id);
  return true;
}

/**
 * Backup current token from disk to database
 */
function backupCurrentDiskToken(name = '', email = '') {
  if (!fs.existsSync(TOKEN_FILE_PATH)) {
    throw new Error(`File token AGY di disk (${TOKEN_FILE_PATH}) tidak ditemukan`);
  }

  const tokenData = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
  if (!tokenData) {
    throw new Error('File token AGY di disk kosong');
  }

  try {
    JSON.parse(tokenData);
  } catch (err) {
    throw new Error('File token AGY di disk bukan format JSON yang valid');
  }

  const active = getActiveAccount();
  if (active) {
    db.prepare(`
      UPDATE agy_accounts
      SET token_json = ?,
          name = CASE WHEN ? != '' THEN ? ELSE name END,
          email = CASE WHEN ? != '' THEN ? ELSE email END,
          status = 'ready',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(tokenData, name, name, email, email, active.id);
    return getAccountById(active.id);
  } else {
    return addAgyAccount({
      name: name || `Akun Utama (${new Date().toLocaleDateString()})`,
      email: email || 'primary@local',
      token_json: tokenData,
      auto_fallback: 1,
      set_active: true
    });
  }
}

/**
 * Fallback Strategy Selector
 */
function getNextFallbackAccount(currentAccountId) {
  try {
    const strategy = getAgySetting('rotation_strategy', 'least_used');
    const cooldownMins = parseInt(getAgySetting('cooldown_minutes', '30'), 10) || 30;

    let orderBy = 'usage_count ASC, id ASC';
    if (strategy === 'round_robin') {
      orderBy = 'last_used_at ASC NULLS FIRST, id ASC';
    } else if (strategy === 'fastest') {
      orderBy = 'latency_ms ASC, usage_count ASC, id ASC';
    }

    let candidate = db.prepare(`
      SELECT * FROM agy_accounts
      WHERE id != ? AND auto_fallback = 1 AND status = 'ready'
      ORDER BY ${orderBy}
      LIMIT 1
    `).get(currentAccountId || 0);

    if (candidate) return candidate;

    const cooldownTimestamp = new Date(Date.now() - cooldownMins * 60 * 1000).toISOString();
    candidate = db.prepare(`
      SELECT * FROM agy_accounts
      WHERE id != ? AND auto_fallback = 1 AND status = 'quota_exceeded' AND quota_exceeded_at < ?
      ORDER BY quota_exceeded_at ASC, id ASC
      LIMIT 1
    `).get(currentAccountId || 0, cooldownTimestamp);

    return candidate || null;
  } catch (err) {
    console.error('Error finding next fallback account:', err);
    return null;
  }
}

function markAccountQuotaExceeded(accountId, errorMessage = '') {
  try {
    db.prepare(`
      UPDATE agy_accounts
      SET status = 'quota_exceeded',
          last_error = ?,
          fail_count = fail_count + 1,
          quota_exceeded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(errorMessage.slice(0, 500), accountId);
  } catch (err) {
    console.error('Error marking quota exceeded:', err);
  }
}

function resetAccountStatus(accountId) {
  try {
    db.prepare(`
      UPDATE agy_accounts
      SET status = 'ready',
          last_error = NULL,
          quota_exceeded_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(accountId);
    return true;
  } catch (err) {
    console.error('Error resetting account status:', err);
    return false;
  }
}

function incrementAccountUsage(accountId, success = true, latencyMs = 0) {
  try {
    db.prepare(`
      UPDATE agy_accounts
      SET usage_count = usage_count + 1,
          success_count = success_count + ?,
          fail_count = fail_count + ?,
          latency_ms = CASE WHEN ? > 0 THEN ? ELSE latency_ms END,
          last_used_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(success ? 1 : 0, success ? 0 : 1, latencyMs, latencyMs, accountId);
  } catch (err) {}
}

function isQuotaExhaustedError(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  return (
    lower.includes('resource_exhausted') ||
    lower.includes('resource has been exhausted') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('rate_limit') ||
    lower.includes('quota exceeded') ||
    lower.includes('quota_exceeded') ||
    lower.includes('exhausted your quota') ||
    lower.includes('exhausted your daily') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('token limit') ||
    lower.includes('tokens per minute') ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('out of credits') ||
    lower.includes('credit limit') ||
    lower.includes('request limit') ||
    lower.includes('user has reached their request limit') ||
    lower.includes('model is overloaded') ||
    lower.includes('model capacity overloaded') ||
    lower.includes('capacity exceeded') ||
    lower.includes('temporarily unavailable due to quota') ||
    (lower.includes('please try again later') && lower.includes('quota'))
  );
}

function getAgyBin() {
  if (process.env.AGY_BIN_PATH && fs.existsSync(process.env.AGY_BIN_PATH)) {
    return process.env.AGY_BIN_PATH;
  }

  const isWindows = process.platform === 'win32';
  const candidates = [];

  if (isWindows) {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
    }
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
    candidates.push(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'));
    candidates.push(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'agy'));
    candidates.push(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy'));
    candidates.push('/usr/local/bin/agy');
    candidates.push('/usr/bin/agy');
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return 'agy';
}

function getCleanEnv(extraEnv = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('ANTIGRAVITY_') && k !== 'PAGER') {
      clean[k] = v;
    }
  }
  clean.PAGER = 'cat';
  
  const userLocalBin = path.join(os.homedir(), '.local', 'bin');
  const userGeminiBin = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'bin');
  const localAppDataAgy = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin') : '';

  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const extraPaths = [userLocalBin, userGeminiBin, localAppDataAgy].filter(Boolean).join(pathSeparator);

  clean.PATH = extraPaths + pathSeparator + (process.env.PATH || '');
  return { ...clean, ...extraEnv };
}

async function testAccountHealth(accountId) {
  const account = getAccountById(accountId);
  if (!account) throw new Error('Akun tidak ditemukan');

  const startTime = Date.now();
  const isNativeCli = !account.token_json || account.token_json.includes('antigravity_cli_native');

  if (isNativeCli) {
    const agyBin = getAgyBin();
    const env = getCleanEnv();
    const isBatOrCmd = agyBin.endsWith('.cmd') || agyBin.endsWith('.bat');

    return new Promise((resolve) => {
      const child = spawn(agyBin, ['-p', 'PING', '--print-timeout', '10s', '--dangerously-skip-permissions'], {
        env,
        shell: isBatOrCmd,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (c) => { stdout += c.toString(); });
      child.stderr.on('data', (c) => { stderr += c.toString(); });

      child.on('close', (code) => {
        const latency = Date.now() - startTime;
        const output = `${stdout} ${stderr}`.trim();
        const isQuota = isQuotaExhaustedError(output);

        if (code === 0 && !isQuota) {
          db.prepare('UPDATE agy_accounts SET status = \'ready\', latency_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(latency, accountId);
          resolve({ success: true, latency, status: 'ready', message: 'Akun Antigravity CLI sistem sehat dan merespons normal' });
        } else {
          const newStatus = isQuota ? 'quota_exceeded' : 'error';
          db.prepare('UPDATE agy_accounts SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, output.slice(0, 300), accountId);
          resolve({ success: false, latency, status: newStatus, error: output || `Exit code ${code}` });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, latency: Date.now() - startTime, status: 'error', error: err.message });
      });
    });
  }

  const tempHome = path.join(os.tmpdir(), 'agy_test_' + accountId + '_' + Date.now());
  const tokenDir = path.join(tempHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), account.token_json, { encoding: 'utf-8', mode: 0o600 });

  const agyBin = getAgyBin();
  const isWindows = process.platform === 'win32';

  return new Promise((resolve) => {
    const env = getCleanEnv({
      HOME: tempHome,
      USERPROFILE: tempHome
    });

    const isBatOrCmd = agyBin.endsWith('.cmd') || agyBin.endsWith('.bat');
    const child = spawn(agyBin, ['-p', 'PING', '--print-timeout', '10s', '--dangerously-skip-permissions'], {
      cwd: tempHome,
      env,
      shell: isBatOrCmd,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('close', (code) => {
      const latency = Date.now() - startTime;
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}

      const output = `${stdout} ${stderr}`.trim();
      const isQuota = isQuotaExhaustedError(output);

      if (code === 0 && !isQuota) {
        db.prepare('UPDATE agy_accounts SET status = \'ready\', latency_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(latency, accountId);
        resolve({ success: true, latency, status: 'ready', message: 'Akun sehat dan merespons normal' });
      } else {
        const newStatus = isQuota ? 'quota_exceeded' : 'error';
        db.prepare('UPDATE agy_accounts SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, output.slice(0, 300), accountId);
        resolve({ success: false, latency, status: newStatus, error: output || `Exit code ${code}` });
      }
    });

    child.on('error', (err) => {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}
      resolve({ success: false, latency: Date.now() - startTime, status: 'error', error: err.message });
    });
  });
}

function exportAccountsPool() {
  const accounts = db.prepare('SELECT name, email, token_json, auto_fallback FROM agy_accounts').all();
  return {
    version: '2.5.0',
    exported_at: new Date().toISOString(),
    total_accounts: accounts.length,
    accounts
  };
}

function importAccountsPool(data) {
  if (!data || !Array.isArray(data.accounts)) {
    throw new Error('Format file backup pool akun tidak valid');
  }

  let imported = 0;
  for (const acc of data.accounts) {
    if (!acc.name || !acc.token_json) continue;
    try {
      addAgyAccount({
        name: acc.name,
        email: acc.email || '',
        token_json: acc.token_json,
        auto_fallback: acc.auto_fallback !== undefined ? acc.auto_fallback : 1,
        set_active: false
      });
      imported++;
    } catch (_) {}
  }
  return { imported, total: data.accounts.length };
}

// ==================== DIRECT GOOGLE OAUTH 2.0 ENGINE ====================

/**
 * Start direct Google OAuth session
 */
function startOAuthLoginSession(accountName, email = '', redirectHost = '') {
  const sessionId = 'oauth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  
  // Build redirect URI
  let redirectUri;
  if (redirectHost && redirectHost.startsWith('http')) {
    redirectUri = `${redirectHost.replace(/\/$/, '')}/api/agy/oauth/callback`;
  } else {
    redirectUri = 'http://localhost:5678/api/agy/oauth/callback';
  }

  loginSessions.set(sessionId, {
    accountName: accountName || 'Akun Google Cadangan',
    email: email || '',
    redirectUri,
    createdAt: Date.now()
  });

  // Auto clean after 10 minutes
  setTimeout(() => {
    loginSessions.delete(sessionId);
  }, 10 * 60 * 1000);

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'select_account consent',
    state: sessionId
  }).toString();

  return Promise.resolve({
    session_id: sessionId,
    auth_url: authUrl,
    redirect_uri: redirectUri
  });
}

/**
 * Exchange Authorization Code for Google Tokens & Save to Database
 */
function exchangeOAuthCodeAndSaveAccount({ code, sessionId, redirectUriOverride }) {
  const session = loginSessions.get(sessionId) || {};
  const redirectUri = redirectUriOverride || session.redirectUri || 'http://localhost:5678/api/agy/oauth/callback';
  const accountName = session.accountName || 'Akun Google Cadangan';
  let email = session.email || '';

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code: code.trim(),
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) {
            return reject(new Error(data.error_description || data.error));
          }

          if (!data.access_token) {
            return reject(new Error('Google tidak mengembalikan access_token'));
          }

          // Build Antigravity formatted token JSON
          const tokenJson = JSON.stringify({
            token: {
              access_token: data.access_token,
              token_type: data.token_type || 'Bearer',
              refresh_token: data.refresh_token || '',
              expiry: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString()
            },
            auth_method: 'consumer'
          });

          // Fetch user profile email if empty
          const fetchEmailPromise = email ? Promise.resolve(email) : new Promise((resEmail) => {
            https.get('https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: { 'Authorization': `Bearer ${data.access_token}` }
            }, (userRes) => {
              let userBody = '';
              userRes.on('data', d => userBody += d);
              userRes.on('end', () => {
                try {
                  const u = JSON.parse(userBody);
                  resEmail(u.email || '');
                } catch (_) {
                  resEmail('');
                }
              });
            }).on('error', () => resEmail(''));
          });

          fetchEmailPromise.then((resolvedEmail) => {
            const finalEmail = resolvedEmail || email || 'google@user';
            const finalName = accountName || `Google (${finalEmail.split('@')[0]})`;

            const acc = addAgyAccount({
              name: finalName,
              email: finalEmail,
              token_json: tokenJson,
              auto_fallback: 1,
              set_active: false
            });

            loginSessions.delete(sessionId);
            resolve(acc);
          });
        } catch (err) {
          reject(new Error('Gagal memproses response Google OAuth: ' + err.message));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error('Gagal menghubungi Google OAuth endpoint: ' + err.message));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Complete session with manual code paste
 */
function completeOAuthLoginSession(sessionId, authCode, setAsActive = false) {
  return exchangeOAuthCodeAndSaveAccount({
    code: authCode,
    sessionId
  }).then((acc) => {
    if (setAsActive) {
      switchActiveAccount(acc.id, 'Set active during OAuth completion');
    }
    return acc;
  });
}

function cleanupOAuthSession(sessionId) {
  loginSessions.delete(sessionId);
}

module.exports = {
  getTokenFilePath,
  getAgySetting,
  setAgySetting,
  isAutoFallbackEnabled,
  getAgyAccounts,
  getActiveAccount,
  getAccountById,
  syncDiskTokenToActiveAccount,
  switchActiveAccount,
  addAgyAccount,
  updateAgyAccount,
  deleteAgyAccount,
  backupCurrentDiskToken,
  getNextFallbackAccount,
  markAccountQuotaExceeded,
  resetAccountStatus,
  incrementAccountUsage,
  isQuotaExhaustedError,
  getAgyBin,
  getCleanEnv,
  testAccountHealth,
  exportAccountsPool,
  importAccountsPool,
  startOAuthLoginSession,
  exchangeOAuthCodeAndSaveAccount,
  completeOAuthLoginSession,
  cleanupOAuthSession
};
