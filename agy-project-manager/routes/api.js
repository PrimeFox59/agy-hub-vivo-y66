const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const db = require('../db');
const {
  hashPassword,
  comparePassword,
  generateToken,
  requireAuth,
  requireAdmin,
  logAudit
} = require('../auth');
const {
  getVpsMetrics,
  restartPm2Service,
  stopPm2Service,
  deletePm2Service,
  autoDiscoverAndSyncPm2,
  getPm2Logs
} = require('../vps');
const { getAvailableModels, streamAgy } = require('../agy');
const {
  getAgyAccounts,
  getActiveAccount,
  getAccountById,
  addAgyAccount,
  updateAgyAccount,
  deleteAgyAccount,
  switchActiveAccount,
  backupCurrentDiskToken,
  resetAccountStatus,
  getAgySetting,
  setAgySetting,
  isAutoFallbackEnabled,
  getAgyBin,
  getCleanEnv,
  testAccountHealth,
  exportAccountsPool,
  importAccountsPool,
  startOAuthLoginSession,
  exchangeOAuthCodeAndSaveAccount,
  completeOAuthLoginSession
} = require('../agyAccounts');

function broadcastSocket(req, event, data = {}) {
  try {
    const io = req.app.get('io');
    if (io) io.emit(event, data);
  } catch (e) {}
}

// ==================== AUTH ROUTES ====================

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !comparePassword(password, user.password_hash)) {
    logAudit(user?.id, username, 'LOGIN_FAILED', 'Invalid credentials', req.ip);
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  const token = generateToken(user);
  res.cookie('agy_token', token, {
    httpOnly: true,
    maxAge: 7 * 24 * 3600 * 1000,
    sameSite: 'lax'
  });

  logAudit(user.id, user.username, 'LOGIN_SUCCESS', 'User logged in', req.ip);

  res.json({
    message: 'Login berhasil',
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    }
  });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('agy_token');
  res.json({ message: 'Logout berhasil' });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/auth/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!comparePassword(old_password, user.password_hash)) {
    return res.status(400).json({ error: 'Password lama tidak sesuai' });
  }

  const newHash = hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  logAudit(req.user.id, req.user.username, 'PASSWORD_CHANGE', 'User changed password', req.ip);

  res.json({ message: 'Password berhasil diperbarui' });
});

// ==================== USER MANAGEMENT (ADMIN ONLY) ====================

router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, telegram_chat_id, telegram_username, telegram_notifications, created_at FROM users ORDER BY id ASC').all();
  res.json({ users });
});

router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Data user tidak lengkap' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'Username sudah digunakan' });
  }

  const hash = hashPassword(password);
  const validRoles = ['admin', 'operator', 'member', 'viewer', 'client'];
  const userRole = validRoles.includes(role) ? role : 'client';
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role)
    VALUES (?, ?, ?, ?)
  `).run(username.trim(), hash, full_name.trim(), userRole);

  logAudit(req.user.id, req.user.username, 'CREATE_USER', `Created user ${username} with role ${userRole}`, req.ip);
  broadcastSocket(req, 'users:updated', { action: 'create', username });
  res.json({ message: 'User berhasil dibuat', userId: result.lastInsertRowid });
});

router.put('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { full_name, role } = req.body;
  const targetId = parseInt(req.params.id, 10);
  const validRoles = ['admin', 'operator', 'member', 'viewer', 'client'];
  const userRole = validRoles.includes(role) ? role : 'member';

  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(
    full_name,
    userRole,
    targetId
  );
  logAudit(req.user.id, req.user.username, 'UPDATE_USER', `Updated user id ${targetId} (Role: ${userRole})`, req.ip);
  broadcastSocket(req, 'users:updated', { action: 'update', userId: targetId });
  res.json({ message: 'User berhasil diperbarui' });
});

router.put('/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  const targetId = parseInt(req.params.id, 10);
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  }

  const hash = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetId);
  logAudit(req.user.id, req.user.username, 'RESET_PASSWORD', `Reset password for user id ${targetId}`, req.ip);
  broadcastSocket(req, 'users:updated', { action: 'password_reset', userId: targetId });
  res.json({ message: 'Password user berhasil di-reset' });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Tidak dapat menghapus akun sendiri' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  logAudit(req.user.id, req.user.username, 'DELETE_USER', `Deleted user id ${targetId}`, req.ip);
  broadcastSocket(req, 'users:updated', { action: 'delete', userId: targetId });
  res.json({ message: 'User berhasil dihapus' });
});

// ==================== VPS METRICS ====================

router.get('/vps/metrics', requireAuth, async (req, res) => {
  const metrics = await getVpsMetrics();
  res.json(metrics);
});

router.post('/vps/pm2/restart', requireAuth, requireAdmin, async (req, res) => {
  const { nameOrId } = req.body;
  if (!nameOrId && nameOrId !== 0) {
    return res.status(400).json({ error: 'Nama atau ID service PM2 wajib diberikan' });
  }
  try {
    const out = await restartPm2Service(nameOrId);
    logAudit(req.user.id, req.user.username, 'PM2_RESTART', `Restarted ${nameOrId}`, req.ip);
    res.json({ message: `Service ${nameOrId} berhasil di-restart`, output: out });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

router.post('/vps/pm2/stop', requireAuth, requireAdmin, async (req, res) => {
  const { nameOrId } = req.body;
  if (!nameOrId && nameOrId !== 0) {
    return res.status(400).json({ error: 'Nama atau ID service PM2 wajib diberikan' });
  }
  try {
    const out = await stopPm2Service(nameOrId);
    logAudit(req.user.id, req.user.username, 'PM2_STOP', `Stopped ${nameOrId}`, req.ip);
    res.json({ message: `Service ${nameOrId} berhasil dihentikan`, output: out });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

router.post('/vps/pm2/delete', requireAuth, requireAdmin, async (req, res) => {
  const { nameOrId } = req.body;
  if (!nameOrId && nameOrId !== 0) {
    return res.status(400).json({ error: 'Nama atau ID service PM2 wajib diberikan' });
  }
  try {
    const out = await deletePm2Service(nameOrId);
    logAudit(req.user.id, req.user.username, 'PM2_DELETE', `Deleted ${nameOrId}`, req.ip);
    res.json({ message: `Service ${nameOrId} berhasil dihapus dari PM2`, output: out });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

router.post('/vps/pm2/auto-sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = autoDiscoverAndSyncPm2();
    logAudit(req.user.id, req.user.username, 'PM2_AUTO_SYNC', 'Auto discovered and registered PM2 services', req.ip);
    const metrics = await getVpsMetrics();
    res.json({ message: 'Auto-Discovery & Sinkronisasi PM2 berhasil dijalankan', result, metrics });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

router.get('/vps/pm2/logs', requireAuth, async (req, res) => {
  const { nameOrId, lines } = req.query;
  if (!nameOrId) {
    return res.status(400).json({ error: 'Nama atau ID service PM2 wajib diberikan' });
  }
  try {
    const logs = await getPm2Logs(nameOrId, lines || 50);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// ==================== PROJECTS ====================

router.get('/projects', requireAuth, (req, res) => {
  const projects = db.prepare(`
    SELECT p.*, u.full_name as creator_name,
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) as total_tasks,
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') as completed_tasks
    FROM projects p
    LEFT JOIN users u ON p.created_by = u.id
    ORDER BY p.updated_at DESC
  `).all();
  res.json({ projects });
});

router.post('/projects', requireAuth, (req, res) => {
  const { name, description, path: projectPath, status } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nama project wajib diisi' });
  }

  const result = db.prepare(`
    INSERT INTO projects (name, description, path, status, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    description || '',
    projectPath || '/home/Prime-Projectx',
    status || 'active',
    req.user.id
  );

  logAudit(req.user.id, req.user.username, 'CREATE_PROJECT', `Created project: ${name}`, req.ip);
  broadcastSocket(req, 'project:updated', { action: 'create', name });
  res.json({ message: 'Project berhasil dibuat', id: result.lastInsertRowid });
});

router.put('/projects/:id', requireAuth, (req, res) => {
  const { name, description, path: projectPath, status } = req.body;
  const id = parseInt(req.params.id, 10);

  db.prepare(`
    UPDATE projects
    SET name = ?, description = ?, path = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, projectPath, status, id);

  broadcastSocket(req, 'project:updated', { action: 'update', id });
  res.json({ message: 'Project berhasil diperbarui' });
});

router.delete('/projects/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  broadcastSocket(req, 'project:updated', { action: 'delete', id });
  res.json({ message: 'Project berhasil dihapus' });
});

// ==================== TASKS ====================

router.get('/tasks', requireAuth, (req, res) => {
  const { project_id, status } = req.query;
  let sql = `
    SELECT t.*, p.name as project_name, p.path as project_path, u.full_name as assignee_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE 1=1
  `;
  const params = [];
  if (project_id) {
    sql += ' AND t.project_id = ?';
    params.push(project_id);
  }
  if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY t.id DESC';

  const tasks = db.prepare(sql).all(...params);
  res.json({ tasks });
});

router.post('/tasks', requireAuth, (req, res) => {
  const { project_id, title, description, priority, status, assigned_to } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Judul task wajib diisi' });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, priority, status, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    project_id || null,
    title.trim(),
    description || '',
    priority || 'medium',
    status || 'todo',
    assigned_to || req.user.id
  );

  broadcastSocket(req, 'task:updated', { action: 'create', title });
  res.json({ message: 'Task berhasil dibuat', id: result.lastInsertRowid });
});

router.put('/tasks/:id', requireAuth, (req, res) => {
  const { project_id, title, description, priority, status, assigned_to } = req.body;
  const id = parseInt(req.params.id, 10);

  db.prepare(`
    UPDATE tasks
    SET project_id = ?, title = ?, description = ?, priority = ?, status = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(project_id, title, description, priority, status, assigned_to, id);

  broadcastSocket(req, 'task:updated', { action: 'update', id });
  res.json({ message: 'Task berhasil diperbarui' });
});

router.put('/tasks/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const id = parseInt(req.params.id, 10);

  db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, id);

  broadcastSocket(req, 'task:updated', { action: 'status_change', id, status });
  res.json({ message: 'Status task berhasil diperbarui' });
});

router.delete('/tasks/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  broadcastSocket(req, 'task:updated', { action: 'delete', id });
  res.json({ message: 'Task berhasil dihapus' });
});

// Delegate Task to AGY CLI with SSE Stream
router.post('/tasks/:id/delegate', requireAuth, (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { customPrompt, effort = 'low', model = '' } = req.body;

  const task = db.prepare(`
    SELECT t.*, p.path as project_path, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `).get(taskId);

  if (!task) {
    return res.status(404).json({ error: 'Task tidak ditemukan' });
  }

  const workspace = task.project_path || process.env.WORKSPACE_DIR || os.homedir();
  const prompt = customPrompt || `Tugas: ${task.title}\nDeskripsi: ${task.description || '(Tidak ada)'}\n\nTolong analisis, kerjakan, atau berikan langkah implementasi kode yang diperlukan secara lengkap dan jelas.`;

  // Set response headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  db.prepare("UPDATE tasks SET agy_status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);

  let accumulated = '';
  let finalConvId = task.agy_conversation_id;

  const sendSse = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendSse({ type: 'start', message: 'Memulai proses delegasi ke AGY CLI...', taskId });

  const stream = streamAgy({
    prompt,
    conversationId: task.agy_conversation_id,
    model,
    effort,
    workspaceDir: workspace,
    onEvent: (ev) => {
      if (ev.type === 'delta') {
        accumulated += ev.text;
      }
      sendSse(ev);
    },
    onDone: (result) => {
      finalConvId = result.conversation_id || finalConvId;
      accumulated = result.response || accumulated;

      db.prepare(`
        UPDATE tasks
        SET agy_status = 'completed', agy_output = ?, agy_conversation_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(accumulated, finalConvId, taskId);

      logAudit(req.user.id, req.user.username, 'DELEGATE_TASK', `Delegated task #${taskId} to AGY`, req.ip);

      sendSse({ type: 'completed', response: accumulated, conversation_id: finalConvId });
      res.end();
    },
    onError: (err) => {
      db.prepare(`
        UPDATE tasks
        SET agy_status = 'failed', agy_output = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(`Error: ${err.message}`, taskId);

      sendSse({ type: 'error', error: err.message });
      res.end();
    }
  });

  req.on('close', () => {
    // client disconnected
  });
});

// ==================== CHAT WITH AGY CLI ====================

// Multer configuration for chat attachments
const chatUploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'chat');
if (!fs.existsSync(chatUploadsDir)) {
  fs.mkdirSync(chatUploadsDir, { recursive: true });
}

const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, chatUploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    let ext = path.extname(file.originalname || '');
    if (!ext) {
      if (file.mimetype === 'image/png') ext = '.png';
      else if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') ext = '.jpg';
      else if (file.mimetype === 'image/webp') ext = '.webp';
      else if (file.mimetype === 'image/gif') ext = '.gif';
      else if (file.mimetype === 'image/svg+xml') ext = '.svg';
      else ext = '.png';
    }
    const base = path.basename(file.originalname || 'clipboard_image', ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50) || 'upload';
    cb(null, `${base}-${uniqueSuffix}${ext}`);
  }
});

const uploadChat = multer({
  storage: chatStorage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

router.post('/chat/upload', requireAuth, uploadChat.array('files', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    }

    const uploaded = req.files.map(f => {
      const isImage = f.mimetype.startsWith('image/');
      return {
        id: path.parse(f.filename).name,
        originalName: f.originalname,
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        url: `/uploads/chat/${f.filename}`,
        localPath: f.path,
        isImage
      };
    });

    res.json({ files: uploaded });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengunggah file: ' + err.message });
  }
});

router.get('/chat/sessions', requireAuth, (req, res) => {
  const sessions = db.prepare(`
    SELECT * FROM chat_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.id);
  res.json({ sessions });
});

router.post('/chat/sessions', requireAuth, (req, res) => {
  const { title, model, effort, workspace_dir } = req.body;
  const result = db.prepare(`
    INSERT INTO chat_sessions (user_id, title, model, effort, workspace_dir)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    title || 'Percakapan Baru',
    model || '',
    effort || 'low',
    workspace_dir || process.env.WORKSPACE_DIR || os.homedir()
  );

  res.json({ message: 'Sesi chat dibuat', id: result.lastInsertRowid });
});

router.get('/chat/sessions/:id/messages', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ error: 'Sesi chat tidak ditemukan' });
  }

  const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  res.json({ session, messages });
});

router.delete('/chat/sessions/:id', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?').run(sessionId, req.user.id);
  res.json({ message: 'Sesi chat dihapus' });
});

// Helper for Brain Directory
function getBrainDir() {
  const candidates = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    '/root/.gemini/antigravity-cli/brain',
    '/data/data/com.termux/files/usr/var/lib/proot-distro/containers/debian/rootfs/root/.gemini/antigravity-cli/brain'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Secure Media & Artifact Serving Endpoint
router.get('/media', (req, res) => {
  try {
    let filePath = req.query.path || '';
    if (!filePath) {
      return res.status(400).send('File path is required');
    }

    if (filePath.startsWith('file://')) {
      filePath = filePath.replace(/^file:\/\//, '');
    }

    if (filePath.startsWith('~/')) {
      filePath = path.join(os.homedir(), filePath.slice(2));
    }

    let resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      const brainDir = getBrainDir();
      const tryInBrain = path.join(brainDir, filePath);
      if (fs.existsSync(tryInBrain)) {
        resolvedPath = tryInBrain;
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      return res.status(400).send('Target is a directory');
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolvedPath)}"`);
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  } catch (err) {
    res.status(500).send('Error serving media: ' + err.message);
  }
});

// Get Artifacts & Generated Files for a Chat Session
router.get('/chat/sessions/:id/artifacts', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({ error: 'Sesi chat tidak ditemukan' });
    }

    const convId = session.conversation_id;
    if (!convId) {
      return res.json({ artifacts: [] });
    }

    const brainDir = getBrainDir();
    const convDir = path.join(brainDir, convId);
    if (!fs.existsSync(convDir)) {
      return res.json({ artifacts: [] });
    }

    const files = fs.readdirSync(convDir);
    const artifacts = [];

    for (const f of files) {
      if (f.startsWith('.') || f.endsWith('.metadata.json') || f === 'scratch') continue;
      const fullPath = path.join(convDir, f);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile()) {
          const ext = path.extname(f).toLowerCase();
          const isImg = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(ext);
          const isMd = ext === '.md';
          let content = null;
          if (isMd && st.size < 100 * 1024) {
            content = fs.readFileSync(fullPath, 'utf8');
          }

          artifacts.push({
            id: f,
            filename: f,
            name: f,
            path: fullPath,
            size: st.size,
            mtime: st.mtime,
            isImage: isImg,
            isMarkdown: isMd,
            type: isImg ? 'image' : (isMd ? 'markdown' : 'file'),
            url: `/api/media?path=${encodeURIComponent(fullPath)}`,
            content
          });
        }
      } catch (e) {}
    }

    artifacts.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ artifacts, conversation_id: convId });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat artefak: ' + err.message, artifacts: [] });
  }
});

// Real-time Chat Stream with AGY CLI via SSE
router.post('/chat/stream', requireAuth, (req, res) => {
  const { session_id, prompt, model, effort, workspace_dir, attachments } = req.body;
  
  const validAttachments = Array.isArray(attachments) ? attachments : [];
  const rawText = (prompt || '').trim();

  if (!rawText && validAttachments.length === 0) {
    return res.status(400).json({ error: 'Pesan prompt atau lampiran file tidak boleh kosong' });
  }

  const userDisplayPrompt = rawText || 'Tolong analisis lampiran file/foto yang saya sertakan.';

  let session = null;
  if (session_id) {
    session = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(session_id, req.user.id);
  }

  if (!session) {
    // create new session
    const title = userDisplayPrompt.slice(0, 35) + (userDisplayPrompt.length > 35 ? '...' : '');
    const result = db.prepare(`
      INSERT INTO chat_sessions (user_id, title, model, effort, workspace_dir)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, title, model || '', effort || 'low', workspace_dir || process.env.WORKSPACE_DIR || os.homedir());
    session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(result.lastInsertRowid);
  }

  // Save user message to SQLite with attachments JSON
  const attachmentsJson = validAttachments.length > 0 ? JSON.stringify(validAttachments) : '[]';
  db.prepare('INSERT INTO chat_messages (session_id, sender, message, attachments) VALUES (?, ?, ?, ?)').run(
    session.id,
    'user',
    userDisplayPrompt,
    attachmentsJson
  );

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSse = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendSse({ type: 'session_init', session });

  // Build enhanced prompt for AGY CLI if attachments are present
  let promptForAgy = userDisplayPrompt;
  if (validAttachments.length > 0) {
    let attachmentSection = '\n\n---\n📎 [LAMPIRAN FILE / FOTO DARI PENGGUNA]:\n';
    validAttachments.forEach((att, idx) => {
      const isImg = att.isImage || (att.mimetype && att.mimetype.startsWith('image/'));
      const sizeKB = (att.size / 1024).toFixed(1);
      const fullPath = att.localPath || path.join(chatUploadsDir, att.filename);

      attachmentSection += `${idx + 1}. Nama: "${att.originalName}" (${isImg ? 'Foto/Gambar' : 'File'}, ${sizeKB} KB)\n   Lokasi file di VPS: ${fullPath}\n`;

      // If it's a small text/code file (< 30KB), embed the content for instant context
      if (!isImg && att.size < 30 * 1024 && fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for non-binary content
          if (!/[\x00-\x08\x0E-\x1F]/.test(content.slice(0, 1000))) {
            const ext = path.extname(att.originalName).replace('.', '') || 'txt';
            attachmentSection += `   Isi file (${att.originalName}):\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
          }
        } catch (e) {}
      }
    });

    attachmentSection += '\n*Instruksi untuk Antigravity (AGY): Pengguna melampirkan file/foto di atas pada VPS. Kamu dapat memeriksa path file tersebut jika memerlukan analisis lebih lanjut.*';
    promptForAgy = userDisplayPrompt + attachmentSection;
  }

  let accumulated = '';
  let finalConvId = session.conversation_id;

  const stream = streamAgy({
    prompt: promptForAgy,
    conversationId: session.conversation_id,
    model: model || session.model,
    effort: effort || session.effort || 'low',
    workspaceDir: workspace_dir || session.workspace_dir || process.env.WORKSPACE_DIR || os.homedir(),
    onEvent: (ev) => {
      if (ev.type === 'delta') {
        accumulated += ev.text;
      }
      sendSse(ev);
    },
    onDone: (result) => {
      finalConvId = result.conversation_id || finalConvId;
      accumulated = result.response || accumulated;

      // Discover any artifacts/images generated during this conversation
      let generatedArtifacts = [];
      if (finalConvId) {
        const brainDir = getBrainDir();
        const convDir = path.join(brainDir, finalConvId);
        if (fs.existsSync(convDir)) {
          try {
            const files = fs.readdirSync(convDir);
            for (const f of files) {
              if (f.startsWith('.') || f.endsWith('.metadata.json') || f === 'scratch') continue;
              const fullPath = path.join(convDir, f);
              const st = fs.statSync(fullPath);
              if (st.isFile()) {
                const ext = path.extname(f).toLowerCase();
                const isImg = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(ext);
                generatedArtifacts.push({
                  originalName: f,
                  filename: f,
                  url: `/api/media?path=${encodeURIComponent(fullPath)}`,
                  localPath: fullPath,
                  size: st.size,
                  isImage: isImg,
                  mimetype: isImg ? (ext === '.png' ? 'image/png' : 'image/jpeg') : 'text/plain'
                });
              }
            }
          } catch (_) {}
        }
      }

      const assistantAttachmentsJson = generatedArtifacts.length > 0 ? JSON.stringify(generatedArtifacts) : '[]';

      // Save assistant message to SQLite with generated artifacts
      db.prepare('INSERT INTO chat_messages (session_id, sender, message, attachments) VALUES (?, ?, ?, ?)').run(session.id, 'assistant', accumulated, assistantAttachmentsJson);

      // Update session conversation_id and timestamp
      db.prepare(`
        UPDATE chat_sessions
        SET conversation_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalConvId, session.id);

      sendSse({ type: 'done', response: accumulated, conversation_id: finalConvId, attachments: generatedArtifacts });
      res.end();
    },
    onError: (err) => {
      sendSse({ type: 'error', error: err.message });
      res.end();
    }
  });

  req.on('close', () => {
    // client disconnect
  });
});

// ==================== MODELS ====================

router.get('/models', requireAuth, (req, res) => {
  const models = getAvailableModels();
  res.json({ models });
});

// ==================== AUDIT LOGS ====================

router.get('/audit', requireAuth, requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all();
  res.json({ logs });
});

// ==================== AGY ACCOUNTS & AUTO-FALLBACK ====================

// Get all AGY accounts and fallback settings
router.get('/agy/accounts', requireAuth, (req, res) => {
  const accounts = getAgyAccounts();
  const activeAccount = getActiveAccount();
  const autoFallback = isAutoFallbackEnabled();
  res.json({
    accounts,
    active_account: activeAccount ? {
      id: activeAccount.id,
      name: activeAccount.name,
      email: activeAccount.email,
      status: activeAccount.status,
      last_used_at: activeAccount.last_used_at
    } : null,
    auto_fallback_enabled: autoFallback
  });
});

// Add a new AGY account
router.post('/agy/accounts', requireAuth, requireAdmin, (req, res) => {
  const { name, email, token_json, auto_fallback, set_active } = req.body;
  try {
    const account = addAgyAccount({
      name,
      email,
      token_json,
      auto_fallback: auto_fallback !== undefined ? auto_fallback : 1,
      set_active: !!set_active
    });
    logAudit(req.user.id, req.user.username, 'CREATE_AGY_ACCOUNT', `Added AGY account: ${name}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'create', account });
    res.json({ message: 'Akun AGY berhasil ditambahkan', account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update AGY account
router.put('/agy/accounts/:id', requireAuth, requireAdmin, (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const { name, email, token_json, auto_fallback, status } = req.body;
  try {
    const account = updateAgyAccount(accountId, {
      name,
      email,
      token_json,
      auto_fallback,
      status
    });
    logAudit(req.user.id, req.user.username, 'UPDATE_AGY_ACCOUNT', `Updated AGY account #${accountId}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'update', account });
    res.json({ message: 'Akun AGY berhasil diperbarui', account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete AGY account
router.delete('/agy/accounts/:id', requireAuth, requireAdmin, (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  try {
    deleteAgyAccount(accountId);
    logAudit(req.user.id, req.user.username, 'DELETE_AGY_ACCOUNT', `Deleted AGY account #${accountId}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'delete', accountId });
    res.json({ message: 'Akun AGY berhasil dihapus' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Switch / Activate AGY account
router.post('/agy/accounts/:id/activate', requireAuth, requireAdmin, (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  try {
    const account = switchActiveAccount(accountId, `Manual switch by ${req.user.username}`);
    logAudit(req.user.id, req.user.username, 'SWITCH_AGY_ACCOUNT', `Switched active AGY account to: ${account.name}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'activate', account });
    res.json({ message: `Berhasil beralih ke akun "${account.name}"`, account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reset status of AGY account back to 'ready'
router.post('/agy/accounts/:id/reset-status', requireAuth, requireAdmin, (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  try {
    resetAccountStatus(accountId);
    logAudit(req.user.id, req.user.username, 'RESET_AGY_ACCOUNT_STATUS', `Reset quota status for AGY account #${accountId}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'reset_status', accountId });
    res.json({ message: 'Status akun berhasil di-reset ke Ready' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backup currently active disk token to DB
router.post('/agy/accounts/backup-current', requireAuth, requireAdmin, (req, res) => {
  const { name, email } = req.body;
  try {
    const account = backupCurrentDiskToken(name, email);
    logAudit(req.user.id, req.user.username, 'BACKUP_AGY_TOKEN', `Backed up current disk token as: ${account.name}`, req.ip);
    req.app.get('io')?.emit('agy:status_changed', { action: 'backup', account });
    res.json({ message: 'Token AGY aktif di disk berhasil disimpan ke database', account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get / Update AGY Settings (like auto fallback toggle & default model)
router.get('/agy/settings', requireAuth, (req, res) => {
  res.json({
    auto_fallback_enabled: isAutoFallbackEnabled(),
    default_agy_model: getAgySetting('default_agy_model', 'gemini-3.7-flash-low')
  });
});

router.post('/agy/settings', requireAuth, requireAdmin, (req, res) => {
  const { auto_fallback_enabled, default_agy_model } = req.body;
  if (auto_fallback_enabled !== undefined) {
    setAgySetting('auto_fallback_enabled', auto_fallback_enabled ? '1' : '0');
    logAudit(req.user.id, req.user.username, 'UPDATE_AGY_SETTINGS', `Auto-fallback set to ${auto_fallback_enabled ? 'ENABLED' : 'DISABLED'}`, req.ip);
  }
  if (default_agy_model !== undefined) {
    setAgySetting('default_agy_model', default_agy_model);
    logAudit(req.user.id, req.user.username, 'UPDATE_AGY_MODEL', `Default AGY model set to ${default_agy_model}`, req.ip);
  }
  req.app.get('io')?.emit('agy:status_changed', { action: 'settings_changed' });
  res.json({
    message: 'Pengaturan AGY berhasil disimpan',
    auto_fallback_enabled: isAutoFallbackEnabled(),
    default_agy_model: getAgySetting('default_agy_model', 'gemini-3.7-flash-low')
  });
});

// Quick test active account
router.post('/agy/test', requireAuth, (req, res) => {
  const active = getActiveAccount();
  if (!active) {
    return res.status(400).json({ error: 'Tidak ada akun AGY yang aktif' });
  }

  const { spawn } = require('child_process');
  const agyBin = getAgyBin();
  const cleanEnv = getCleanEnv();
  const isBatOrCmd = agyBin.endsWith('.cmd') || agyBin.endsWith('.bat');
  const child = spawn(agyBin, ['-p', 'Balas dengan kata "READY"', '--print-timeout', '15s', '--dangerously-skip-permissions'], {
    cwd: workspace,
    env: cleanEnv,
    shell: isBatOrCmd,
    windowsHide: true
  });

  let output = '';
  let errOutput = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    errOutput += chunk.toString();
  });

  child.on('close', (code) => {
    if (code === 0 || output.trim()) {
      res.json({
        success: true,
        account: active.name,
        output: output.trim() || 'OK (Respon diterima)',
        message: `Akun "${active.name}" berfungsi dengan baik.`
      });
    } else {
      res.status(500).json({
        success: false,
        account: active.name,
        error: errOutput || output || `Process exited with code ${code}`,
        message: `Akun "${active.name}" mengalami kendala koneksi atau kuota.`
      });
    }
  });

  child.on('error', (err) => {
    res.status(500).json({
      success: false,
      account: active.name,
      error: err.message
    });
  });
});

// OAuth 1-Click Login Wizard Endpoints
router.post('/agy/auth/start-login', requireAuth, requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nama akun wajib diisi' });
  }

  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5678';
    const redirectHost = `${protocol}://${host}`;

    const session = await startOAuthLoginSession(name.trim(), email ? email.trim() : '', redirectHost);
    res.json({
      message: 'Sesi login Google dimulai',
      session_id: session.session_id,
      auth_url: session.auth_url,
      redirect_uri: session.redirect_uri
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memulai sesi login Google: ' + err.message });
  }
});

router.get('/agy/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Login Gagal</title>
      <style>body { font-family: sans-serif; background: #020617; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }</style>
      </head>
      <body>
        <div style="background: #0f172a; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 420px; border: 1px solid #ef4444;">
          <h2 style="color: #ef4444; margin-top: 0;">❌ Login Google Dibatalkan</h2>
          <p style="color: #94a3b8; font-size: 13px;">${error_description || error}</p>
          <button onclick="window.close()" style="background: #334155; color: #fff; border: 0; padding: 10px 20px; border-radius: 8px; cursor: pointer;">Tutup Jendela</button>
        </div>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send('Authorization code tidak ditemukan.');
  }

  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5678';
    const redirectUri = `${protocol}://${host}/api/agy/oauth/callback`;

    const acc = await exchangeOAuthCodeAndSaveAccount({
      code,
      sessionId: state,
      redirectUriOverride: redirectUri
    });

    logAudit(1, 'System/OAuth', 'OAUTH_LOGIN_SUCCESS', `Added Google account ${acc.name} (${acc.email}) via OAuth callback`, req.ip);

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Google Login Berhasil</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #020617; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #0f172a; border: 1px solid rgba(99, 102, 241, 0.3); padding: 2.5rem; border-radius: 1.5rem; text-align: center; max-width: 420px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
          .icon { width: 64px; height: 64px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399; border-radius: 1.25rem; display: inline-flex; align-items: center; justify-content: center; font-size: 28px; margin-bottom: 1.25rem; }
          h2 { font-size: 20px; font-weight: 700; margin: 0 0 0.5rem 0; color: #fff; }
          p { font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0 0 1.5rem 0; }
          .badge { background: #1e1b4b; border: 1px solid rgba(99, 102, 241, 0.4); color: #a5b4fc; padding: 6px 14px; border-radius: 9999px; font-size: 12px; font-weight: 600; display: inline-block; margin-bottom: 1.5rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h2>Akun Google Terhubung!</h2>
          <div class="badge">${acc.name} (${acc.email || 'ready'})</div>
          <p>Akun telah berhasil ditambahkan ke pool fallback AGY. Jendela ini akan otomatis tertutup...</p>
        </div>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage({ type: 'AGY_OAUTH_SUCCESS', account: ${JSON.stringify(acc)} }, '*');
            }
          } catch(e) {}
          setTimeout(() => {
            window.close();
          }, 1800);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Error</title><style>body { font-family: sans-serif; background: #020617; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }</style></head>
      <body>
        <div style="background: #0f172a; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 450px; border: 1px solid #ef4444;">
          <h2 style="color: #ef4444; margin-top: 0;">Gagal Menyimpan Akun</h2>
          <p style="color: #94a3b8; font-size: 13px;">${err.message}</p>
          <button onclick="window.close()" style="background: #334155; color: #fff; border: 0; padding: 10px 20px; border-radius: 8px; cursor: pointer;">Tutup</button>
        </div>
      </body>
      </html>
    `);
  }
});

router.post('/agy/auth/complete-login', requireAuth, requireAdmin, async (req, res) => {
  const { session_id, auth_code, set_active } = req.body;
  if (!session_id || !auth_code) {
    return res.status(400).json({ error: 'Session ID dan Kode Verifikasi Google wajib diisi' });
  }

  try {
    const account = await completeOAuthLoginSession(session_id, auth_code, !!set_active);
    logAudit(req.user.id, req.user.username, 'GOOGLE_OAUTH_LOGIN', `Added AGY account via 1-Click OAuth: ${account.name}`, req.ip);
    res.json({
      message: `Akun "${account.name}" berhasil dihubungkan & disimpan!`,
      account
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== CLOUDFLARE DEPLOYMENT & TUNNEL ROUTES ====================

const {
  findCloudflaredBinary,
  getCloudflaredVersion,
  startQuickTunnel,
  stopQuickTunnel,
  stopAllQuickTunnels,
  getQuickTunnelsList,
  getSavedTunnels,
  toggleAutoPublish,
  deleteSavedTunnel,
  getServiceStatus,
  manageService,
  getCloudflareConfig,
  saveCloudflareConfig,
  verifyCloudflareToken,
  fetchRemoteTunnels
} = require('../cloudflare');

// Overview: Binary version, service status, running tunnels, config
router.get('/cloudflare/overview', requireAuth, async (req, res) => {
  try {
    const binPath = findCloudflaredBinary();
    const version = getCloudflaredVersion();
    const service = await getServiceStatus();
    const quickTunnels = getQuickTunnelsList();
    const savedTunnels = getSavedTunnels();
    const config = getCloudflareConfig();

    res.json({
      installed: Boolean(version),
      binaryPath: binPath,
      version: version || 'Tidak terdeteksi',
      service,
      quickTunnels,
      savedTunnels,
      config
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat status Cloudflare: ' + err.message });
  }
});

// Start Quick Tunnel
router.post('/cloudflare/quicktunnel/start', requireAuth, async (req, res) => {
  const { port, name, auto_publish } = req.body;
  const targetPort = parseInt(port || 8562, 10);
  const autoPub = auto_publish !== undefined ? Boolean(auto_publish) : true;

  try {
    const tunnel = await startQuickTunnel(targetPort, name, autoPub);
    logAudit(req.user.id, req.user.username, 'CLOUDFLARE_QUICKTUNNEL_START', `Started quick tunnel on port ${targetPort} -> ${tunnel.url} (auto-publish: ${autoPub})`, req.ip);
    res.json({
      success: true,
      message: `Quick Tunnel untuk port ${targetPort} berhasil dijalankan!`,
      tunnel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Auto-Publish for a port
router.post('/cloudflare/quicktunnel/toggle-auto', requireAuth, (req, res) => {
  const { port, auto_publish } = req.body;
  const targetPort = parseInt(port, 10);
  if (!targetPort) return res.status(400).json({ error: 'Port tidak valid' });

  const ok = toggleAutoPublish(targetPort, auto_publish);
  logAudit(req.user.id, req.user.username, 'CLOUDFLARE_QUICKTUNNEL_AUTO_TOGGLE', `Set auto-publish to ${Boolean(auto_publish)} for port ${targetPort}`, req.ip);
  res.json({ success: ok, port: targetPort, auto_publish: Boolean(auto_publish) });
});

// Delete Saved Tunnel
router.delete('/cloudflare/quicktunnel/saved/:port', requireAuth, (req, res) => {
  const port = parseInt(req.params.port, 10);
  deleteSavedTunnel(port);
  res.json({ success: true, message: `Konfigurasi tunnel port ${port} berhasil dihapus` });
});

// Stop Quick Tunnel
router.post('/cloudflare/quicktunnel/stop', requireAuth, async (req, res) => {
  const { id, port, all } = req.body;

  try {
    if (all) {
      await stopAllQuickTunnels();
      logAudit(req.user.id, req.user.username, 'CLOUDFLARE_QUICKTUNNEL_STOP_ALL', 'Stopped all active quick tunnels', req.ip);
      return res.json({ success: true, message: 'Semua Quick Tunnel berhasil dinonaktifkan' });
    }

    const target = id || port;
    if (!target) {
      return res.status(400).json({ error: 'ID tunnel atau Port wajib disertakan' });
    }

    const result = await stopQuickTunnel(target);
    logAudit(req.user.id, req.user.username, 'CLOUDFLARE_QUICKTUNNEL_STOP', `Stopped quick tunnel: ${target}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manage Cloudflared Windows/Linux Service (start/stop/restart)
router.post('/cloudflare/service/:action', requireAuth, requireAdmin, async (req, res) => {
  const { action } = req.params;
  try {
    const result = await manageService(action);
    logAudit(req.user.id, req.user.username, `CLOUDFLARE_SERVICE_${action.toUpperCase()}`, `Performed ${action} on Cloudflared service`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Cloudflare Config
router.get('/cloudflare/config', requireAuth, (req, res) => {
  try {
    const config = getCloudflareConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Cloudflare Config
router.post('/cloudflare/config', requireAuth, requireAdmin, (req, res) => {
  const { apiToken, accountId, defaultPort, tunnelName } = req.body;
  try {
    const config = saveCloudflareConfig({ apiToken, accountId, defaultPort, tunnelName });
    logAudit(req.user.id, req.user.username, 'CLOUDFLARE_CONFIG_SAVE', 'Updated Cloudflare settings', req.ip);
    res.json({ success: true, message: 'Pengaturan Cloudflare berhasil disimpan', config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify API Token
router.post('/cloudflare/verify-token', requireAuth, async (req, res) => {
  const { apiToken } = req.body;
  const token = apiToken || (getDb().prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_api_token')?.value);

  if (!token) {
    return res.status(400).json({ error: 'API Token belum disediakan' });
  }

  try {
    const result = await verifyCloudflareToken(token);
    res.json({ success: true, message: 'API Token Cloudflare Valid!', details: result.result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remote Tunnels from Cloudflare API
router.get('/cloudflare/remote-tunnels', requireAuth, async (req, res) => {
  const db = getDb();
  const token = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_api_token')?.value;
  const accountId = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cf_account_id')?.value;

  if (!token || !accountId) {
    return res.json({ tunnels: [], message: 'API Token dan Account ID belum dikonfigurasi' });
  }

  try {
    const data = await fetchRemoteTunnels(token, accountId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, tunnels: [] });
  }
});

// ==================== AI ORCHESTRATOR ROUTES ====================
const {
  listSessions,
  getSessionTranscript,
  getKanbanTasks,
  handleSessionAction
} = require('../orchestrator');

// List all detected AGY CLI sessions
router.get('/orchestrator/sessions', requireAuth, (req, res) => {
  try {
    const sessions = listSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message, sessions: [] });
  }
});

// Get detailed step-by-step transcript of a specific session
router.get('/orchestrator/sessions/:id', requireAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '150', 10);
    const data = getSessionTranscript(req.params.id, limit);
    if (!data.session) {
      return res.status(404).json({ error: 'Sesi tidak ditemukan atau log belum tersedia' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Perform action on a session (kill, pause, resume, priority)
router.post('/orchestrator/sessions/:id/action', requireAuth, (req, res) => {
  const { action, payload } = req.body;
  if (!action) {
    return res.status(400).json({ error: 'Action wajib diisi (kill, pause, resume, priority, status)' });
  }
  try {
    const result = handleSessionAction(req.params.id, action, payload);
    logAudit(req.user.id, req.user.username, 'ORCHESTRATOR_ACTION', `Action ${action} on session ${req.params.id}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified Kanban tasks across CLI sessions and project tasks
router.get('/orchestrator/kanban', requireAuth, (req, res) => {
  try {
    const kanban = getKanbanTasks();
    res.json(kanban);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLIENT PORTAL & APP GATEWAY ====================

router.get('/client-apps', requireAuth, async (req, res) => {
  try {
    let apps = [];
    if (req.user.role === 'admin') {
      apps = db.prepare(`
        SELECT a.*, u.full_name as assigned_user_name, u.username as assigned_username
        FROM client_apps a
        LEFT JOIN users u ON a.assigned_user_id = u.id
        ORDER BY a.id ASC
      `).all();
    } else {
      apps = db.prepare(`
        SELECT a.*, u.full_name as assigned_user_name, u.username as assigned_username
        FROM client_apps a
        LEFT JOIN users u ON a.assigned_user_id = u.id
        WHERE a.assigned_user_id = ? OR a.client_email = ? OR a.client_name LIKE ?
        ORDER BY a.id ASC
      `).all(req.user.id, req.user.username, `%${req.user.full_name}%`);
    }

    // Enhance with live Cloudflare Quick Tunnels and PM2 Metrics
    const quickTunnels = getQuickTunnelsList();
    const metrics = await getVpsMetrics();
    const pm2Map = new Map((metrics.pm2 || []).map(p => [p.name, p]));

    const enhanced = apps.map(app => {
      const activeTunnel = quickTunnels.find(t => t.port === app.internal_port && (t.status === 'connected' || t.status === 'starting'));
      const activeUrl = activeTunnel ? activeTunnel.url : (app.public_url || null);
      const isTunnelLive = Boolean(activeTunnel && activeTunnel.status === 'connected');
      const pm2Info = app.pm2_service_name ? pm2Map.get(app.pm2_service_name) : null;

      const ramUsageMb = pm2Info?.memory ? parseFloat((pm2Info.memory / (1024 * 1024)).toFixed(1)) : 0;
      const ramLimitMb = parseInt(app.ram_limit_mb || 1024, 10);
      const ramUsagePct = Math.min(100, Math.round((ramUsageMb / ramLimitMb) * 100));

      const storageLimitGb = parseFloat(app.storage_limit_gb || 10);
      let storageUsageMb = 145.0; // Base application footprint estimate
      if (app.app_dir && fs.existsSync(app.app_dir)) {
        try {
          const files = fs.readdirSync(app.app_dir);
          let totalBytes = 0;
          for (const f of files.slice(0, 200)) {
            try { totalBytes += fs.statSync(path.join(app.app_dir, f)).size; } catch (_) {}
          }
          if (totalBytes > 0) storageUsageMb = parseFloat((totalBytes / (1024 * 1024)).toFixed(1));
        } catch (_) {}
      }
      const storageUsageGb = parseFloat((storageUsageMb / 1024).toFixed(2));
      const storageUsagePct = Math.min(100, Math.round((storageUsageGb / storageLimitGb) * 100));

      const cpuUsage = pm2Info?.cpu !== undefined ? pm2Info.cpu : 0;
      const cpuLimit = parseInt(app.cpu_limit_pct || 100, 10);

      return {
        ...app,
        active_url: activeUrl,
        is_tunnel_live: isTunnelLive,
        tunnel_status: activeTunnel ? activeTunnel.status : (app.public_url ? 'configured' : 'inactive'),
        quota: {
          ram_usage_mb: ramUsageMb,
          ram_limit_mb: ramLimitMb,
          ram_pct: ramUsagePct,
          storage_usage_gb: storageUsageGb,
          storage_usage_mb: storageUsageMb,
          storage_limit_gb: storageLimitGb,
          storage_pct: storageUsagePct,
          cpu_usage: cpuUsage,
          cpu_limit: cpuLimit
        },
        pm2_info: pm2Info ? {
          status: pm2Info.status,
          cpu: pm2Info.cpu,
          memory: pm2Info.memory,
          uptime: pm2Info.uptime,
          restarts: pm2Info.restarts
        } : null
      };
    });

    res.json({ apps: enhanced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/client-apps', requireAuth, requireAdmin, (req, res) => {
  const { name, client_name, client_email, assigned_user_id, description, category, icon, internal_port, public_url, pm2_service_name, ram_limit_mb, storage_limit_gb, cpu_limit_pct, app_dir, status } = req.body;
  if (!name || !client_name || !internal_port) {
    return res.status(400).json({ error: 'Nama Aplikasi, Nama Klien, dan Port Lokal wajib diisi' });
  }

  const port = parseInt(internal_port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Port tidak valid (1-65535)' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO client_apps (name, client_name, client_email, assigned_user_id, description, category, icon, internal_port, public_url, pm2_service_name, ram_limit_mb, storage_limit_gb, cpu_limit_pct, app_dir, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      client_name.trim(),
      client_email ? client_email.trim() : null,
      assigned_user_id ? parseInt(assigned_user_id, 10) : null,
      description || '',
      category || 'Web Application',
      icon || 'fa-rocket',
      port,
      public_url ? public_url.trim() : null,
      pm2_service_name ? pm2_service_name.trim() : null,
      ram_limit_mb ? parseInt(ram_limit_mb, 10) : 1024,
      storage_limit_gb ? parseInt(storage_limit_gb, 10) : 10,
      cpu_limit_pct ? parseInt(cpu_limit_pct, 10) : 100,
      app_dir ? app_dir.trim() : '',
      status || 'active'
    );

    logAudit(req.user.id, req.user.username, 'CREATE_CLIENT_APP', `Registered client app "${name}" for ${client_name} (Port ${port}, RAM: ${ram_limit_mb || 1024}MB, Storage: ${storage_limit_gb || 10}GB)`, req.ip);
    broadcastSocket(req, 'portal:apps_updated', { action: 'create', name, client_name });
    res.json({ message: 'Aplikasi klien berhasil didaftarkan!', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/client-apps/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, client_name, client_email, assigned_user_id, description, category, icon, internal_port, public_url, pm2_service_name, ram_limit_mb, storage_limit_gb, cpu_limit_pct, app_dir, status } = req.body;

  if (!name || !client_name || !internal_port) {
    return res.status(400).json({ error: 'Nama Aplikasi, Nama Klien, dan Port Lokal wajib diisi' });
  }

  const port = parseInt(internal_port, 10);
  try {
    db.prepare(`
      UPDATE client_apps
      SET name = ?, client_name = ?, client_email = ?, assigned_user_id = ?, description = ?, category = ?, icon = ?, internal_port = ?, public_url = ?, pm2_service_name = ?, ram_limit_mb = ?, storage_limit_gb = ?, cpu_limit_pct = ?, app_dir = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name.trim(),
      client_name.trim(),
      client_email ? client_email.trim() : null,
      assigned_user_id ? parseInt(assigned_user_id, 10) : null,
      description || '',
      category || 'Web Application',
      icon || 'fa-rocket',
      port,
      public_url ? public_url.trim() : null,
      pm2_service_name ? pm2_service_name.trim() : null,
      ram_limit_mb ? parseInt(ram_limit_mb, 10) : 1024,
      storage_limit_gb ? parseInt(storage_limit_gb, 10) : 10,
      cpu_limit_pct ? parseInt(cpu_limit_pct, 10) : 100,
      app_dir ? app_dir.trim() : '',
      status || 'active',
      id
    );

    logAudit(req.user.id, req.user.username, 'UPDATE_CLIENT_APP', `Updated client app id ${id} ("${name}" - RAM: ${ram_limit_mb || 1024}MB, Storage: ${storage_limit_gb || 10}GB)`, req.ip);
    broadcastSocket(req, 'portal:apps_updated', { action: 'update', id, name });
    res.json({ message: 'Aplikasi klien & kuota berhasil diperbarui!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/client-apps/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const existing = db.prepare('SELECT name, client_name FROM client_apps WHERE id = ?').get(id);
    db.prepare('DELETE FROM client_apps WHERE id = ?').run(id);
    logAudit(req.user.id, req.user.username, 'DELETE_CLIENT_APP', `Deleted client app id ${id} ("${existing?.name}")`, req.ip);
    broadcastSocket(req, 'portal:apps_updated', { action: 'delete', id });
    res.json({ message: 'Aplikasi klien berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/client-apps/:id/start-tunnel', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const app = db.prepare('SELECT * FROM client_apps WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Aplikasi tidak ditemukan' });

  try {
    const tunnel = await startQuickTunnel(app.internal_port, `${app.name} (${app.client_name})`, true);
    if (tunnel && tunnel.url) {
      db.prepare('UPDATE client_apps SET public_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tunnel.url, id);
    }
    logAudit(req.user.id, req.user.username, 'CLIENT_APP_START_TUNNEL', `Started tunnel for "${app.name}" on port ${app.internal_port} -> ${tunnel.url}`, req.ip);
    broadcastSocket(req, 'portal:apps_updated', { action: 'tunnel_start', id, url: tunnel.url });
    res.json({
      success: true,
      message: `Cloudflare Tunnel untuk "${app.name}" berhasil aktif!`,
      url: tunnel.url,
      tunnel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/client-apps/link-pm2', requireAuth, requireAdmin, (req, res) => {
  const { pm2_service_name, client_app_id, new_client_app, unlink } = req.body;
  if (!pm2_service_name) {
    return res.status(400).json({ error: 'Nama PM2 service wajib diisi' });
  }

  try {
    if (unlink) {
      db.prepare('UPDATE client_apps SET pm2_service_name = NULL, updated_at = CURRENT_TIMESTAMP WHERE pm2_service_name = ?')
        .run(pm2_service_name);
      logAudit(req.user.id, req.user.username, 'UNLINK_PM2_CLIENT_APP', `Unlinked PM2 service "${pm2_service_name}" from client apps`, req.ip);
      broadcastSocket(req, 'portal:apps_updated', { action: 'unlink_pm2', pm2_service_name });
      return res.json({ success: true, message: `Tautan PM2 service "${pm2_service_name}" berhasil dilepas.` });
    }

    if (client_app_id) {
      const id = parseInt(client_app_id, 10);
      // Clear previous assignment of this PM2 service if any
      db.prepare('UPDATE client_apps SET pm2_service_name = NULL WHERE pm2_service_name = ?').run(pm2_service_name);
      db.prepare('UPDATE client_apps SET pm2_service_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(pm2_service_name, id);
      
      const app = db.prepare('SELECT * FROM client_apps WHERE id = ?').get(id);
      logAudit(req.user.id, req.user.username, 'LINK_PM2_TO_CLIENT_APP', `Linked PM2 "${pm2_service_name}" to "${app?.name}" (${app?.client_name})`, req.ip);
      broadcastSocket(req, 'portal:apps_updated', { action: 'link_pm2', pm2_service_name, app });
      return res.json({ success: true, message: `PM2 "${pm2_service_name}" berhasil ditautkan ke ${app?.client_name}!`, app });
    }

    if (new_client_app && new_client_app.name && new_client_app.client_name) {
      const port = parseInt(new_client_app.internal_port || 8080, 10);
      // Clear previous assignment
      db.prepare('UPDATE client_apps SET pm2_service_name = NULL WHERE pm2_service_name = ?').run(pm2_service_name);

      const result = db.prepare(`
        INSERT INTO client_apps (name, client_name, client_email, description, category, icon, internal_port, pm2_service_name, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        new_client_app.name.trim(),
        new_client_app.client_name.trim(),
        new_client_app.client_email ? new_client_app.client_email.trim() : null,
        new_client_app.description || '',
        new_client_app.category || 'Web Application',
        new_client_app.icon || 'fa-rocket',
        port,
        pm2_service_name.trim()
      );

      logAudit(req.user.id, req.user.username, 'CREATE_AND_LINK_PM2', `Created client app "${new_client_app.name}" for ${new_client_app.client_name} and linked to PM2 "${pm2_service_name}"`, req.ip);
      broadcastSocket(req, 'portal:apps_updated', { action: 'create_and_link_pm2', pm2_service_name });
      return res.json({ success: true, message: `Aplikasi baru berhasil dibuat dan ditautkan ke PM2 "${pm2_service_name}"!`, id: result.lastInsertRowid });
    }

    return res.status(400).json({ error: 'Pilih aplikasi yang ada atau isi data aplikasi baru' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TELEGRAM BOT & CLIENT BROADCAST ROUTES ====================

const {
  getTelegramConfig,
  testTelegramBot,
  getUserTelegramAuth,
  unlinkUserTelegram,
  broadcastCloudflareUrlToClient,
  startTelegramPolling,
  restartTelegramBot,
  setSetting,
  sendTelegramMessage
} = require('../telegram');

router.get('/telegram/status', requireAuth, (req, res) => {
  try {
    const config = getTelegramConfig();
    const userAuth = getUserTelegramAuth(req.user.id);
    
    // Count linked users
    const linkedCount = db.prepare('SELECT count(*) as count FROM users WHERE telegram_chat_id IS NOT NULL').get()?.count || 0;

    res.json({
      config,
      user_auth: userAuth,
      linked_users_count: linkedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/telegram/config', requireAuth, requireAdmin, async (req, res) => {
  const { bot_token, is_active, admin_chat_id } = req.body;

  try {
    if (bot_token !== undefined && bot_token !== null) {
      const cleanToken = bot_token.trim();
      setSetting('telegram_bot_token', cleanToken);

      if (cleanToken) {
        // Test token validity & store bot info
        const testRes = await testTelegramBot(cleanToken);
        logAudit(req.user.id, req.user.username, 'TELEGRAM_CONFIG_UPDATE', `Updated Telegram bot token (Bot: @${testRes.bot_username})`, req.ip);
      }
    }

    if (is_active !== undefined) {
      setSetting('telegram_bot_active', is_active ? '1' : '0');
    }

    if (admin_chat_id !== undefined) {
      setSetting('telegram_admin_chat_id', admin_chat_id ? admin_chat_id.trim() : '');
    }

    await restartTelegramBot();
    broadcastSocket(req, 'telegram:config_updated', { is_active });

    res.json({
      success: true,
      message: 'Konfigurasi Telegram Bot berhasil disimpan & diaktifkan.',
      config: getTelegramConfig()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/telegram/test', requireAuth, requireAdmin, async (req, res) => {
  const { bot_token, chat_id } = req.body;

  try {
    const bot = await testTelegramBot(bot_token || null);
    let messageSent = false;

    if (chat_id) {
      await sendTelegramMessage(chat_id, `🤖 <b>Tes Koneksi Telegram Bot AGY Integration Hub</b>\n\n✅ Pesan ini dikirim dari server VPS untuk mengonfirmasi integrasi bot Telegram berjalan lancar.\n\n⏱️ Waktu: <code>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</code>`);
      messageSent = true;
    }

    res.json({
      success: true,
      message: `Koneksi Bot Telegram @${bot.bot_username} berhasil!${messageSent ? ' Pesan tes berhasil dikirim.' : ''}`,
      bot
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/telegram/auth-link', requireAuth, (req, res) => {
  try {
    const authData = getUserTelegramAuth(req.user.id);
    res.json({ success: true, ...authData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/telegram/unlink', requireAuth, (req, res) => {
  try {
    const result = unlinkUserTelegram(req.user.id);
    logAudit(req.user.id, req.user.username, 'TELEGRAM_UNLINK', 'User unlinked Telegram account', req.ip);
    broadcastSocket(req, 'telegram:user_unlinked', { userId: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/telegram/broadcast-link', requireAuth, async (req, res) => {
  const { port, client_app_id } = req.body;
  if (!port && !client_app_id) {
    return res.status(400).json({ error: 'Port atau ID aplikasi klien wajib disertakan' });
  }

  try {
    let targetPort = parseInt(port, 10);
    let app = null;

    if (client_app_id) {
      app = db.prepare('SELECT * FROM client_apps WHERE id = ?').get(parseInt(client_app_id, 10));
      if (app) targetPort = app.internal_port;
    } else if (port) {
      app = db.prepare('SELECT * FROM client_apps WHERE internal_port = ?').get(targetPort);
    }

    // Get current tunnel URL
    const tunnel = db.prepare('SELECT last_url, target_url, name FROM cloudflare_tunnels WHERE port = ?').get(targetPort);
    const activeUrl = app?.public_url || tunnel?.last_url;

    if (!activeUrl) {
      return res.status(400).json({ error: `Belum ada link Cloudflare aktif untuk port ${targetPort}. Silakan start tunnel terlebih dahulu.` });
    }

    const broadcastRes = await broadcastCloudflareUrlToClient({
      port: targetPort,
      url: activeUrl,
      name: app?.name || tunnel?.name || `Port ${targetPort}`,
      isRefresh: false
    });

    logAudit(req.user.id, req.user.username, 'TELEGRAM_MANUAL_BROADCAST', `Broadcasted Cloudflare link for port ${targetPort} (${activeUrl}) to ${broadcastRes.count || 0} clients`, req.ip);

    res.json({
      success: true,
      message: `Link Cloudflare berhasil dibroadcast ke ${broadcastRes.count || 0} user Telegram!`,
      url: activeUrl,
      broadcastRes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;



