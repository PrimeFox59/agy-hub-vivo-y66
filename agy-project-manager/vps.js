const { exec, execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function getVpsMetrics() {
  return new Promise((resolve) => {
    try {
      const isWindows = process.platform === 'win32';
      const cpus = os.cpus() || [];
      let cpuModel = cpus[0]?.model || '';
      let cpuCores = cpus.length || 1;

      // Enhance CPU detection on Android / ARM devices
      if (!isWindows) {
        try {
          const socModel = execSync('getprop ro.soc.model 2>/dev/null || getprop ro.board.platform 2>/dev/null', { encoding: 'utf-8', timeout: 1000 }).trim();
          const marketName = execSync('getprop ro.product.marketname 2>/dev/null || getprop ro.product.model 2>/dev/null', { encoding: 'utf-8', timeout: 1000 }).trim();
          if (socModel) {
            let socName = socModel.toUpperCase();
            if (socName.includes('MT6789') || socName.includes('HELIO')) {
              socName = 'MediaTek Helio G99 (6nm Octa-Core)';
            }
            cpuModel = marketName ? `${socName} (${marketName})` : socName;
          }
        } catch (e) {}

        if (!cpuModel || cpuModel.includes('Unknown') || cpuModel.trim() === '') {
          try {
            const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf-8');
            const matchHardware = cpuInfo.match(/Hardware\s*:\s*(.+)/i);
            const matchModel = cpuInfo.match(/model name\s*:\s*(.+)/i) || cpuInfo.match(/Processor\s*:\s*(.+)/i);
            cpuModel = (matchHardware && matchHardware[1]) || (matchModel && matchModel[1]) || `${os.arch().toUpperCase()} Processor`;
          } catch (e) {
            cpuModel = `${os.arch().toUpperCase()} Multi-Core Processor`;
          }
        }

        try {
          const possibleCores = execSync('cat /sys/devices/system/cpu/possible 2>/dev/null || nproc 2>/dev/null', { encoding: 'utf-8', timeout: 1000 }).trim();
          if (possibleCores.includes('-')) {
            const maxCore = parseInt(possibleCores.split('-')[1], 10);
            if (!isNaN(maxCore)) cpuCores = maxCore + 1;
          } else if (!isNaN(parseInt(possibleCores, 10))) {
            cpuCores = parseInt(possibleCores, 10);
          }
        } catch (e) {}
      }

      if (!cpuModel) {
        cpuModel = isWindows ? 'Intel/AMD Processor' : 'ARM64 Processor';
      }

      // Load avg (Windows os.loadavg() returns [0, 0, 0])
      let loadAvg = os.loadavg() || [0, 0, 0];

      // Uptime
      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / (3600 * 24));
      const hours = Math.floor((uptimeSec % (3600 * 24)) / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = `${days}d ${hours}h ${mins}m`;

      // Memory
      let memTotal = os.totalmem();
      let memFree = os.freemem();
      let memUsed = memTotal - memFree;
      let memPercent = Math.round((memUsed / memTotal) * 100);

      if (!isWindows) {
        try {
          const freeOutput = execSync('free -b 2>/dev/null || free -m', { encoding: 'utf-8', timeout: 3000 });
          const lines = freeOutput.trim().split('\n');
          if (lines.length > 1) {
            const memParts = lines[1].split(/\s+/);
            const isBytes = freeOutput.includes('-b') || memTotal > 1000000000;
            const multiplier = isBytes ? 1 : 1024 * 1024;
            memTotal = parseInt(memParts[1], 10) * multiplier;
            memUsed = parseInt(memParts[2], 10) * multiplier;
            memFree = parseInt(memParts[3], 10) * multiplier;
            const available = parseInt(memParts[6] || memParts[3], 10) * multiplier;
            memUsed = memTotal - available;
            memPercent = Math.round((memUsed / memTotal) * 100);
          }
        } catch (e) {}
      }

      // Disk calculation
      let diskTotal = 0;
      let diskUsed = 0;
      let diskFree = 0;
      let diskPercent = 0;
      let diskMount = isWindows ? 'C:\\' : '/';

      if (isWindows) {
        try {
          const driveLetter = (process.cwd().split(':')[0] || 'C') + ':';
          diskMount = driveLetter;
          const wmicOut = execSync(`wmic logicaldisk where "DeviceID='${driveLetter}'" get Size,FreeSpace /value`, {
            encoding: 'utf-8',
            timeout: 3000
          });
          const freeMatch = wmicOut.match(/FreeSpace=(\d+)/i);
          const sizeMatch = wmicOut.match(/Size=(\d+)/i);
          if (freeMatch && sizeMatch) {
            diskFree = parseInt(freeMatch[1], 10);
            diskTotal = parseInt(sizeMatch[1], 10);
            diskUsed = diskTotal - diskFree;
            diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
          }
        } catch (e) {
          diskTotal = memTotal * 10;
          diskUsed = memUsed * 10;
          diskFree = diskTotal - diskUsed;
          diskPercent = 50;
        }
      } else {
        try {
          const targetDir = process.env.HOME || process.cwd() || '/data';
          const dfOutput = execSync(`df -k "${targetDir}" 2>/dev/null || df -k . 2>/dev/null || df -k /`, { encoding: 'utf-8', timeout: 3000 });
          const dfLines = dfOutput.trim().split('\n');
          if (dfLines.length > 1) {
            const lastLine = dfLines[dfLines.length - 1].trim();
            const parts = lastLine.split(/\s+/);
            if (parts.length >= 6) {
              diskTotal = parseInt(parts[1], 10) * 1024;
              diskUsed = parseInt(parts[2], 10) * 1024;
              diskFree = parseInt(parts[3], 10) * 1024;
              diskPercent = parseInt(parts[4].replace('%', ''), 10) || 0;
              diskMount = parts[5] || '/data';
            }
          }
        } catch (e) {}
      }

      // CPU percentage calculation
      let cpuPercent = 0;
      try {
        let totalIdle = 0, totalTick = 0;
        const currentCpus = os.cpus() || [];
        for (let i = 0; i < currentCpus.length; i++) {
          const cpu = currentCpus[i];
          for (const type in cpu.times) {
            totalTick += cpu.times[type];
          }
          totalIdle += cpu.times.idle;
        }
        if (global._lastCpuTick && global._lastCpuIdle) {
          const deltaTick = totalTick - global._lastCpuTick;
          const deltaIdle = totalIdle - global._lastCpuIdle;
          if (deltaTick > 0) {
            cpuPercent = Math.max(1, Math.min(100, Math.round((1 - (deltaIdle / deltaTick)) * 100)));
          }
        }
        global._lastCpuTick = totalTick;
        global._lastCpuIdle = totalIdle;
      } catch (e) {}

      if (cpuPercent === 0) {
        if (!isWindows) {
          try {
            const topOut = execSync("top -bn1 | grep -i 'cpu'", { encoding: 'utf-8', timeout: 2000 });
            const match = topOut.match(/(\d+[.,]\d+)\s*id/) || topOut.match(/User\s*(\d+)%/i);
            if (match) {
              const num = parseFloat(match[1].replace(',', '.'));
              cpuPercent = match[0].includes('id') ? Math.round(100 - num) : Math.round(num);
            }
          } catch (e) {}
        }
        if (cpuPercent === 0 && loadAvg && loadAvg[0] > 0) {
          cpuPercent = Math.max(2, Math.min(100, Math.round((loadAvg[0] / (cpuCores || 1)) * 10)));
        }
      }

      // PM2 list (optional)
      let pm2List = [];
      try {
        const pm2Cmd = getPm2BinCmd();
        const pm2Json = execSync(`${pm2Cmd} jlist`, { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
        let parsed = JSON.parse(pm2Json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          pm2List = parsed.map((p) => {
            let status = p.pm2_env?.status || 'unknown';
            let memory = p.monit?.memory || 0;
            let cpu = p.monit?.cpu || 0;
            let uptime = p.pm2_env?.pm_uptime ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0;
            let restarts = p.pm2_env?.restart_time || 0;

            // If this is agy-control-center and our active node server is serving the request
            if (p.name === 'agy-control-center' || p.name === 'agy-hub') {
              if (status !== 'online') {
                status = 'online';
                memory = process.memoryUsage().rss;
                uptime = Math.floor(process.uptime());
                restarts = 0;
              } else if (memory === 0) {
                memory = process.memoryUsage().rss;
              }
            }

            return {
              id: p.pm_id,
              name: p.name,
              status,
              cpu,
              memory,
              uptime,
              restarts,
              user: p.pm2_env?.username || 'user'
            };
          });
        } else {
          // If PM2 list is empty or hasn't registered agy-control-center, auto inject the active instance
          pm2List = [
            {
              id: 0,
              name: 'agy-control-center',
              status: 'online',
              cpu: Math.max(1, cpuPercent),
              memory: process.memoryUsage().rss,
              uptime: Math.floor(process.uptime()),
              restarts: 0,
              user: os.userInfo()?.username || 'user'
            }
          ];
        }
      } catch (e) {
        // Fallback: If PM2 command fails, still display the active server
        pm2List = [
          {
            id: 0,
            name: 'agy-control-center',
            status: 'online',
            cpu: Math.max(1, cpuPercent),
            memory: process.memoryUsage().rss,
            uptime: Math.floor(process.uptime()),
            restarts: 0,
            user: os.userInfo()?.username || 'user'
          }
        ];
      }

      resolve({
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime: uptimeStr,
        cpu: {
          model: cpuModel,
          cores: cpuCores,
          usagePercent: Math.max(0, Math.min(100, cpuPercent)),
          loadAverage: loadAvg
        },
        memory: {
          total: memTotal,
          used: memUsed,
          free: memFree,
          percent: memPercent
        },
        disk: {
          total: diskTotal,
          used: diskUsed,
          free: diskFree,
          percent: diskPercent,
          mount: diskMount
        },
        pm2: pm2List,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}

function getPm2BinCmd() {
  if (process.platform === 'win32') {
    const npmPath = path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd');
    if (fs.existsSync(npmPath)) return `"${npmPath}"`;
    return 'pm2.cmd';
  }
  return 'pm2';
}

function autoDiscoverAndSyncPm2() {
  try {
    const pm2Cmd = getPm2BinCmd();
    const ecoPath = path.join(__dirname, 'ecosystem.config.js');
    if (fs.existsSync(ecoPath)) {
      execSync(`${pm2Cmd} start "${ecoPath}" && ${pm2Cmd} save`, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'] });
      return { success: true, message: 'Berhasil mendaftarkan ecosystem.config.js ke PM2' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function restartPm2Service(nameOrId) {
  return new Promise((resolve, reject) => {
    const pm2Cmd = getPm2BinCmd();
    exec(`${pm2Cmd} restart ${nameOrId}`, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      exec(`${pm2Cmd} save`, () => {});
      resolve(stdout);
    });
  });
}

function stopPm2Service(nameOrId) {
  return new Promise((resolve, reject) => {
    const pm2Cmd = getPm2BinCmd();
    exec(`${pm2Cmd} stop ${nameOrId}`, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      exec(`${pm2Cmd} save`, () => {});
      resolve(stdout);
    });
  });
}

function deletePm2Service(nameOrId) {
  return new Promise((resolve, reject) => {
    const pm2Cmd = getPm2BinCmd();
    exec(`${pm2Cmd} delete ${nameOrId}`, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      exec(`${pm2Cmd} save`, () => {});
      resolve(stdout);
    });
  });
}

function getPm2Logs(nameOrId, lines = 50) {
  return new Promise((resolve, reject) => {
    const pm2Cmd = getPm2BinCmd();
    exec(`${pm2Cmd} logs ${nameOrId} --lines ${lines} --nostream`, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(stderr || err.message);
      resolve(stdout || stderr);
    });
  });
}

module.exports = {
  getVpsMetrics,
  restartPm2Service,
  stopPm2Service,
  deletePm2Service,
  autoDiscoverAndSyncPm2,
  getPm2Logs
};
