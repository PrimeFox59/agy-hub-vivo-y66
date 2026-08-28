require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api');

const http = require('http');
const { setupSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5678;

// Setup Socket.IO
const io = setupSockets(server);
app.set('io', io);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust reverse proxy (Nginx)
app.set('trust proxy', true);

// API Router
app.use('/api', apiRoutes);

// Static frontend (with no-cache headers for instant local updates)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// SPA Fallback for all other routes
app.use((req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cloudflare Auto-Publish & AI Orchestrator initialization
const { initAutoPublishTunnels } = require('./cloudflare');
const { initOrchestratorWatcher } = require('./orchestrator');

server.listen(PORT, () => {
  console.log(`[+] AGY Control Center (AI Orchestrator & VPS Manager) running on port ${PORT} with Socket.IO Realtime`);
  initOrchestratorWatcher(io);
  setTimeout(() => {
    initAutoPublishTunnels().catch(err => console.warn('[Cloudflare] Auto-publish on startup error:', err.message));
  }, 2000);
});
