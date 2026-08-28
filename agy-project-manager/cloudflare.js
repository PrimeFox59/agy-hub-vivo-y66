const { spawn, exec, execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { getDb } = require('./db');
const { getIO } = require('./sockets');

const isWindows = process.platform === 'win32';

// Cache for detected cloudflared binary
let cachedBinaryPath = null;

function findCloudflaredBinary() {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) {
    return cachedBinaryPath;
  }

  const envPath = process.env.CLOUDFLARED_PATH;
  if (envPath && fs.existsSync(envPath)) {
    cachedBinaryPath = envPath;
    return envPath;
  }

  const candidates = isWindows
    ? [
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'cloudflared', 'cloudflared.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'cloudflared.cmd'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'cloudflared.exe')
      ]
    : [
        '/usr/local/bin/cloudflared',
        '/usr/bin/cloudflared',
        '/bin/cloudflared',
        path.join(os.homedir(), 'bin', 'cloudflared'),
        path.join(os.homedir(), '.local', 'bin', 'cloudflared')
      ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedBinaryPath = c;
      return c;
    }
  }

  // Fallback to searching PATH
  try {
    const cmd = isWindows ? 'where cloudflared' : 'which cloudflared';
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    const firstPath = out.split(/\r?\n/)[0];
    if (firstPath && fs.existsSync(firstPath)) {
      cachedBinaryPath = firstPath;
      return firstPath;
    }
  } catch (_) {}

  return isWindows ? 'cloudflared.exe' : 'cloudflared';
}

function getCloudflaredVersion() {
  try {
    const bin = findCloudflaredBinary();
    const out = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 4000 });
    return out.trim();
  } catch (err) {
    return null;
  }
}

// In-memory registry of active Quick Tunnels
const activeQuickTunnels = new Map();

function saveOrUpdateSavedTunnel(port, name, autoPublish = 1, lastUrl = null) {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM cloudflare_tunnels WHERE port = ?').get(port);
    if (existing) {
      db.prepare(`
        UPDATE cloudflare_tunnels
        SET name = COALESCE(?, name),
            auto_publish = ?,
            last_url = COALESCE(?, last_url),
            updated_at = CURRENT_TIMESTAMP
        WHERE port = ?
      `).run(name || null, autoPublish ? 1 : 0, lastUrl || null, port);
    } else {
      db.prepare(`
        INSERT INTO cloudflare_tunnels (port, name, auto_publish, target_url, last_url)
        VALUES (?, ?, ?, ?, ?)
      `).run(port, name || `Port ${port}`, autoPublish ? 1 : 0, `http://127.0.0.1:${port}`, lastUrl || null);
    }
  } catch (e) {
    console.error('Error saving tunnel to DB:', e.message);
  }
}

function getSavedTunnels() {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM cloudflare_tunnels ORDER BY port ASC').all() || [];
  } catch (e) {
    return [];
  }
}

function toggleAutoPublish(port, autoPublish) {
  try {
    const db = getDb();
    const targetPort = parseInt(port, 10);
    db.prepare('UPDATE cloudflare_tunnels SET auto_publish = ?, updated_at = CURRENT_TIMESTAMP WHERE port = ?').run(autoPublish ? 1 : 0, targetPort);
    
    // Update in-memory active tunnel if present
    for (const [id, t] of activeQuickTunnels.entries()) {
      if (t.port === targetPort) {
        t.autoPublish = Boolean(autoPublish);
      }
    }

    emitTunnelUpdate();
    return true;
  } catch (e) {
    return false;
  }
}

function deleteSavedTunnel(port) {
  try {
    const db = getDb();
    const targetPort = parseInt(port, 10);
    db.prepare('DELETE FROM cloudflare_tunnels WHERE port = ?').run(targetPort);
    emitTunnelUpdate();
    return true;
  } catch (e) {
    return false;
  }
}

async function initAutoPublishTunnels() {
  const saved = getSavedTunnels().filter(t => t.auto_publish === 1);
  if (!saved.length) {
    return;
  }

  console.log(`[Cloudflare] 🚀 Menjalankan ${saved.length} Auto-Publish Quick Tunnel pada startup...`);
  for (const t of saved) {
    try {
      console.log(`[Cloudflare] Auto-publishing: ${t.name} (Port ${t.port})...`);
      startQuickTunnel(t.port, t.name, true).catch(err => {
        console.warn(`[Cloudflare] Gagal auto-publish port ${t.port}:`, err.message);
      });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {}
  }
}

function emitTunnelUpdate() {
  try {
    const io = getIO();
    if (io) {
      const tunnels = getQuickTunnelsList();
      const saved = getSavedTunnels();
      io.emit('cloudflare:tunnel_update', {
        tunnels,
        savedTunnels: saved,
        timestamp: Date.now()
      });
      io.emit('portal:apps_updated', {
        timestamp: Date.now()
      });
    }
  } catch (_) {}
}

function startQuickTunnel(port = 8562, name = '', autoPublish = true) {
  return new Promise((resolve, reject) => {
    const targetPort = parseInt(port, 10);
    if (!targetPort || isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
      return reject(new Error('Nomor port tidak valid (1-65535)'));
    }

    const tunnelName = name || `Port ${targetPort}`;

    // Save configuration in database immediately
    saveOrUpdateSavedTunnel(targetPort, tunnelName, autoPublish ? 1 : 0);

    // If an existing tunnel is already connected on this port, return it
    for (const [id, tunnel] of activeQuickTunnels.entries()) {
      if (tunnel.port === targetPort && tunnel.status === 'connected') {
        tunnel.autoPublish = Boolean(autoPublish);
        return resolve(tunnel);
      }
    }

    const bin = findCloudflaredBinary();
    const tunnelId = `qt_${targetPort}_${Date.now()}`;
    const targetUrl = `http://127.0.0.1:${targetPort}`;

    const tunnelObj = {
      id: tunnelId,
      name: tunnelName,
      port: targetPort,
      targetUrl,
      url: null,
      autoPublish: Boolean(autoPublish),
      manuallyStopped: false,
      status: 'starting',
      startedAt: new Date().toISOString(),
      pid: null,
      logs: [],
      error: null
    };

    activeQuickTunnels.set(tunnelId, tunnelObj);
    emitTunnelUpdate();

    let child = null;
    try {
      const args = ['tunnel', '--url', targetUrl, '--metrics', '127.0.0.1:0', '--no-autoupdate'];
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      tunnelObj.status = 'error';
      tunnelObj.error = err.message;
      emitTunnelUpdate();
      return reject(new Error(`Gagal menjalankan cloudflared: ${err.message}`));
    }

    tunnelObj.pid = child.pid;
    tunnelObj.process = child;

    let resolved = false;
    const timeoutTimer = setTimeout(() => {
      if (!resolved && tunnelObj.status !== 'connected') {
        if (!tunnelObj.url) {
          tunnelObj.status = 'error';
          tunnelObj.error = 'Timeout (30s) menunggu URL dari Cloudflare';
          emitTunnelUpdate();
          reject(new Error(tunnelObj.error));
        }
      }
    }, 30000);

    const handleOutput = (data) => {
      const text = data.toString('utf-8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) {
          tunnelObj.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
          if (tunnelObj.logs.length > 100) tunnelObj.logs.shift();
        }

        // Match trycloudflare URL
        const match = line.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
        if (match && match[1]) {
          tunnelObj.url = match[1];
          tunnelObj.status = 'connected';
          
          // Update last URL in cloudflare_tunnels database
          saveOrUpdateSavedTunnel(targetPort, tunnelName, autoPublish ? 1 : 0, match[1]);

          // Also update client_apps table for this internal port
          try {
            const db = getDb();
            db.prepare('UPDATE client_apps SET public_url = ?, updated_at = CURRENT_TIMESTAMP WHERE internal_port = ?')
              .run(match[1], targetPort);
          } catch (e) {}

          // Automatically broadcast updated Cloudflare link to relevant clients via Telegram
          try {
            const { broadcastCloudflareUrlToClient } = require('./telegram');
            broadcastCloudflareUrlToClient({
              port: targetPort,
              url: match[1],
              name: tunnelName,
              isRefresh: true
            }).catch((err) => console.error('[Cloudflare] Telegram broadcast error:', err.message));
          } catch (_) {}

          emitTunnelUpdate();

          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutTimer);
            resolve(tunnelObj);
          }
        }
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', (err) => {
      tunnelObj.status = 'error';
      tunnelObj.error = err.message;
      emitTunnelUpdate();
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutTimer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      const wasConnected = tunnelObj.status === 'connected';
      const shouldRestart = tunnelObj.autoPublish && !tunnelObj.manuallyStopped;

      tunnelObj.status = 'stopped';
      tunnelObj.process = null;
      emitTunnelUpdate();

      if (shouldRestart) {
        console.log(`[Cloudflare] Quick Tunnel port ${targetPort} terputus (code ${code}). Mengulang koneksi otomatis dalam 3 detik...`);
        setTimeout(() => {
          if (!tunnelObj.manuallyStopped) {
            activeQuickTunnels.delete(tunnelId);
            startQuickTunnel(targetPort, tunnelName, true).catch(() => {});
          }
        }, 3000);
      } else {
        // Remove from map after 5 minutes of stopping
        setTimeout(() => {
          if (activeQuickTunnels.get(tunnelId)?.status === 'stopped') {
            activeQuickTunnels.delete(tunnelId);
            emitTunnelUpdate();
          }
        }, 300000);
      }
    });
  });
}

function stopQuickTunnel(idOrPort) {
  return new Promise((resolve) => {
    let targetId = idOrPort;
    let target = activeQuickTunnels.get(targetId);

    // If port provided instead of id
    if (!target && !isNaN(parseInt(idOrPort, 10))) {
      const p = parseInt(idOrPort, 10);
      for (const [id, t] of activeQuickTunnels.entries()) {
        if (t.port === p && (t.status === 'connected' || t.status === 'starting')) {
          target = t;
          targetId = id;
          break;
        }
      }
    }

    if (!target) {
      return resolve({ success: true, message: 'Tidak ada tunnel yang cocok' });
    }

    target.manuallyStopped = true;
    target.autoPublish = false;
    saveOrUpdateSavedTunnel(target.port, target.name, 0);

    if (target.process) {
      try {
        if (isWindows && target.pid) {
          execSync(`taskkill /PID ${target.pid} /T /F`, { timeout: 3000 });
        } else {
          target.process.kill('SIGTERM');
        }
      } catch (_) {}
    }

    target.status = 'stopped';
    target.process = null;
    emitTunnelUpdate();
    resolve({ success: true, message: `Quick Tunnel port ${target.port} berhasil dimatikan` });
  });
}

function stopAllQuickTunnels() {
  const promises = [];
  for (const [id, t] of activeQuickTunnels.entries()) {
    if (t.status === 'connected' || t.status === 'starting') {
      promises.push(stopQuickTunnel(id));
    }
  }
  return Promise.all(promises);
}

function getQuickTunnelsList() {
  const savedMap = new Map();
  try {
    const saved = getSavedTunnels();
    for (const s of saved) {
      savedMap.set(s.port, s);
    }
  } catch (_) {}

  const list = [];
  for (const [id, t] of activeQuickTunnels.entries()) {
    const dbRecord = savedMap.get(t.port);
    list.push({
      id: t.id,
      name: t.name,
      port: t.port,
      targetUrl: t.targetUrl,
      url: t.url,
      autoPublish: t.autoPublish !== undefined ? t.autoPublish : (dbRecord ? Boolean(dbRecord.auto_publish) : true),
      status: t.status,
      startedAt: t.startedAt,
      pid: t.pid,
      error: t.error,
      recentLogs: t.logs.slice(-10)
    });
  }
  return list;
}

// Windows / Linux Daemon Service Status
function getServiceStatus() {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(
        'powershell -NoProfile -Command "Get-Service -Name Cloudflared -ErrorAction SilentlyContinue | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json"',
        { timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            return resolve({
              installed: false,
              name: 'Cloudflared',
              status: 'Not Installed',
              displayName: 'Cloudflared agent'
            });
          }
          try {
            const data = JSON.parse(stdout);
            const statusMap = { 1: 'Stopped', 4: 'Running', 2: 'StartPending', 3: 'StopPending' };
            const statusText = statusMap[data.Status] || (typeof data.Status === 'string' ? data.Status : 'Unknown');
            resolve({
              installed: true,
              name: data.Name || 'Cloudflared',
              displayName: data.DisplayName || 'Cloudflared agent',
              status: statusText,
              startType: data.StartType || 'Automatic'
            });
          } catch (e) {
            resolve({
              installed: true,
              name: 'Cloudflared',
              displayName: 'Cloudflared agent',
              status: stdout.includes('Running') ? 'Running' : 'Stopped'
            });
          }
        }
      );
    } else {
      exec('systemctl status cloudflared', { timeout: 3000 }, (err, stdout) => {
        const isRunning = stdout.includes('active (running)');
        resolve({
          installed: !stdout.includes('Unit cloudflared.service could not be found'),
          name: 'cloudflared',
          displayName: 'Cloudflare Tunnel Daemon',
          status: isRunning ? 'Running' : 'Stopped'
        });
      });
    }
  });
}

function manageService(action) {
  return new Promise((resolve, reject) => {
    const validActions = ['start', 'stop', 'restart'];
    if (!validActions.includes(action)) {
      return reject(new Error('Action tidak valid (start/stop/restart)'));
    }

    if (isWindows) {
      let cmd = '';
      if (action === 'start') cmd = 'Start-Service -Name Cloudflared';
      else if (action === 'stop') cmd = 'Stop-Service -Name Cloudflared -Force';
      else if (action === 'restart') cmd = 'Restart-Service -Name Cloudflared -Force';

      exec(`powershell -NoProfile -Command "${cmd}"`, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve({ success: true, message: `Service Cloudflared berhasil di-${action}` });
      });
    } else {
      exec(`systemctl ${action} cloudflared`, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve({ success: true, message: `Service cloudflared berhasil di-${action}` });
      });
    }
  });
}

// Cloudflare API & Settings Helper
function getCloudflareConfig() {
  const db = getDb();
  const apiTokenRow = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_api_token');
  const accountIdRow = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_account_id');
  const defaultPortRow = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_default_port');
  const tunnelNameRow = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_tunnel_name');

  const rawToken = apiTokenRow?.value || '';
  const maskedToken = rawToken ? (rawToken.length > 8 ? `${rawToken.slice(0, 4)}...${rawToken.slice(-4)}` : '••••••••') : '';

  return {
    hasApiToken: Boolean(rawToken),
    maskedApiToken: maskedToken,
    accountId: accountIdRow?.value || '',
    defaultPort: defaultPortRow?.value || '8562',
    tunnelName: tunnelNameRow?.value || ''
  };
}

function saveCloudflareConfig({ apiToken, accountId, defaultPort, tunnelName }) {
  const db = getDb();
  if (apiToken !== undefined && apiToken !== '') {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('cf_api_token', apiToken.trim());
  }
  if (accountId !== undefined) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('cf_account_id', accountId.trim());
  }
  if (defaultPort !== undefined) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('cf_default_port', String(defaultPort).trim());
  }
  if (tunnelName !== undefined) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('cf_tunnel_name', tunnelName.trim());
  }
  return getCloudflareConfig();
}

function verifyCloudflareToken(token) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('API Token tidak boleh kosong'));

    const req = https.request(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              resolve({ success: true, result: data.result });
            } else {
              reject(new Error(data.errors?.[0]?.message || 'Verifikasi token gagal'));
            }
          } catch (e) {
            reject(new Error('Respon API Cloudflare tidak valid'));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`Koneksi ke Cloudflare API gagal: ${err.message}`)));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Koneksi ke Cloudflare API timeout'));
    });
    req.end();
  });
}

function fetchRemoteTunnels(token, accountId) {
  return new Promise((resolve, reject) => {
    if (!token || !accountId) return reject(new Error('API Token dan Account ID diperlukan'));

    const req = https.request(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              resolve({ success: true, tunnels: data.result });
            } else {
              reject(new Error(data.errors?.[0]?.message || 'Gagal memuat list tunnel'));
            }
          } catch (e) {
            reject(new Error('Respon API Cloudflare tidak valid'));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`Koneksi gagal: ${err.message}`)));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

module.exports = {
  findCloudflaredBinary,
  getCloudflaredVersion,
  startQuickTunnel,
  stopQuickTunnel,
  stopAllQuickTunnels,
  getQuickTunnelsList,
  getSavedTunnels,
  toggleAutoPublish,
  deleteSavedTunnel,
  initAutoPublishTunnels,
  getServiceStatus,
  manageService,
  getCloudflareConfig,
  saveCloudflareConfig,
  verifyCloudflareToken,
  fetchRemoteTunnels
};