const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const os = require('os');
const { getVpsMetrics, restartPm2Service, getPm2Logs } = require('./vps');
const { streamAgyCore, getAvailableModels } = require('./agy');
const { getAgyAccounts, getActiveAccount } = require('./agyAccounts');
const { getDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'agy_secret_prime_2026_jwt_token';

let ioInstance = null;

function setupSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    pingInterval: 10000,
    pingTimeout: 5000
  });

  ioInstance = io;

  // Socket Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      socket.user = null;
      return next();
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      return next();
    } catch (e) {
      socket.user = null;
      return next();
    }
  });

  io.on('connection', (socket) => {
    // Send immediate welcome and live snapshot
    socket.emit('rct:connected', { status: 'ok', socketId: socket.id, timestamp: Date.now() });

    // Client requests immediate metrics
    socket.on('vps:refresh', async () => {
      try {
        const metrics = await getVpsMetrics();
        socket.emit('vps:stats', metrics);
      } catch (e) {}
    });

    // Client restarts PM2 process via socket
    socket.on('pm2:restart', async (data, callback) => {
      try {
        const result = await restartPm2Service(data.nameOrId);
        const updatedMetrics = await getVpsMetrics();
        io.emit('vps:stats', updatedMetrics);
        if (callback) callback({ success: true, message: result });
      } catch (err) {
        if (callback) callback({ success: false, error: err.toString() });
      }
    });

    // Real-Time Chat over WebSockets
    socket.on('chat:send', async (payload, callback) => {
      try {
        const { session_id, prompt, model, effort, workspace_dir } = payload;
        const db = getDb();
        const defaultWs = process.env.WORKSPACE_DIR || os.homedir();

        let sessId = session_id;
        if (!sessId) {
          const title = prompt.length > 35 ? prompt.slice(0, 35) + '...' : prompt;
          const user_id = socket.user?.id || 1;
          const info = db.prepare(
            `INSERT INTO chat_sessions (user_id, title, model, effort, workspace_dir) VALUES (?, ?, ?, ?, ?)`
          ).run(user_id, title, model || null, effort || 'low', workspace_dir || defaultWs);
          sessId = info.lastInsertRowid;
          const newSession = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessId);
          socket.emit('chat:session_init', { session: newSession });
        }

        // Save user message
        db.prepare(`INSERT INTO chat_messages (session_id, sender, message, model) VALUES (?, ?, ?, ?)`).run(
          sessId, 'user', prompt, model || null
        );

        let accumulatedResponse = '';

        streamAgyCore({
          prompt,
          model,
          effort,
          workspaceDir: workspace_dir || defaultWs,
          onEvent: (event) => {
            if (event.type === 'delta') {
              accumulatedResponse += event.text;
            } else if (event.type === 'done' || event.type === 'result') {
              if (event.response) accumulatedResponse = event.response;
              try {
                db.prepare(`INSERT INTO chat_messages (session_id, sender, message, model) VALUES (?, ?, ?, ?)`).run(
                  sessId, 'assistant', accumulatedResponse, model || null
                );
              } catch (e) {}
            } else if (event.type === 'fallback_switch') {
              io.emit('agy:status_changed', { message: event.message });
            }
            socket.emit('chat:event', event);
          },
          onDone: (result) => {
            socket.emit('chat:event', { type: 'done', ...result });
          },
          onError: (err) => {
            socket.emit('chat:event', { type: 'error', error: err.message });
          }
        });

        if (callback) callback({ success: true, sessionId: sessId });
      } catch (err) {
        socket.emit('chat:event', { type: 'error', error: err.message });
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Realtime Ping
    socket.on('rct:ping', (cb) => {
      if (typeof cb === 'function') cb({ pong: Date.now() });
    });
  });

  // Background High-Frequency Metrics Stream (Every 2 seconds)
  setInterval(async () => {
    if (io && io.sockets && io.sockets.sockets.size > 0) {
      try {
        const metrics = await getVpsMetrics();
        io.emit('vps:stats', metrics);
      } catch (err) {}
    }
  }, 2000);

  return io;
}

function getIO() {
  return ioInstance;
}

module.exports = { setupSockets, getIO };
