const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'manager.sqlite');

function createDatabase(filepath) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(filepath);
    try { db.pragma('journal_mode = WAL'); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    return db;
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filepath);
    try { db.exec('PRAGMA journal_mode = WAL;'); } catch (_) {}
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (_) {}

    // Add transaction polyfill if missing
    if (!db.transaction) {
      db.transaction = (fn) => {
        return (...args) => {
          db.exec('BEGIN TRANSACTION;');
          try {
            const res = fn(...args);
            db.exec('COMMIT;');
            return res;
          } catch (err) {
            db.exec('ROLLBACK;');
            throw err;
          }
        };
      };
    }

    if (!db.pragma) {
      db.pragma = (sql) => {
        try {
          return db.exec(`PRAGMA ${sql};`);
        } catch (_) {}
      };
    }

    return db;
  }
}

const db = createDatabase(dbPath);

function initDb() {
  const defaultWorkspace = process.env.WORKSPACE_DIR || os.homedir();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      path TEXT DEFAULT '${defaultWorkspace.replace(/\\/g, '\\\\')}',
      status TEXT DEFAULT 'active', -- 'active' | 'completed' | 'archived'
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'urgent'
      status TEXT DEFAULT 'todo', -- 'todo' | 'in_progress' | 'review' | 'done'
      assigned_to INTEGER,
      agy_status TEXT DEFAULT 'idle', -- 'idle' | 'running' | 'completed' | 'failed'
      agy_output TEXT,
      agy_conversation_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      conversation_id TEXT,
      model TEXT DEFAULT '',
      effort TEXT DEFAULT 'low',
      workspace_dir TEXT DEFAULT '${defaultWorkspace.replace(/\\/g, '\\\\')}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      sender TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
      message TEXT NOT NULL,
      model TEXT DEFAULT '',
      attachments TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agy_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      token_json TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ready', -- 'ready' | 'quota_exceeded' | 'error' | 'disabled'
      auto_fallback INTEGER DEFAULT 1, -- 1 = include in auto fallback pool, 0 = exclude
      usage_count INTEGER DEFAULT 0,
      last_used_at DATETIME,
      last_error TEXT,
      quota_exceeded_at DATETIME,
      latency_ms INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_by INTEGER,
      usage_count INTEGER DEFAULT 0,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'general', -- 'coding' | 'debug' | 'refactor' | 'audit' | 'general'
      prompt TEXT NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agy_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

      CREATE TABLE IF NOT EXISTS cloudflare_tunnels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        port INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        auto_publish INTEGER DEFAULT 1,
        target_url TEXT,
        last_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS client_apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_email TEXT,
        assigned_user_id INTEGER,
        description TEXT,
        category TEXT DEFAULT 'Web Application', -- 'Web Application' | 'AI Agent / Bot' | 'API Backend' | 'Dashboard Analytics' | 'E-Commerce'
        icon TEXT DEFAULT 'fa-rocket',
        internal_port INTEGER NOT NULL,
        public_url TEXT,
        pm2_service_name TEXT,
        ram_limit_mb INTEGER DEFAULT 1024,
        storage_limit_gb INTEGER DEFAULT 10,
        cpu_limit_pct INTEGER DEFAULT 100,
        app_dir TEXT DEFAULT '',
        status TEXT DEFAULT 'active', -- 'active' | 'maintenance' | 'paused'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assigned_user_id) REFERENCES users (id) ON DELETE SET NULL
      );
    `);

  // Column migrations
  try { db.exec("ALTER TABLE chat_messages ADD COLUMN model TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE chat_messages ADD COLUMN attachments TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN model TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN latency_ms INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN success_count INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN fail_count INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN avatar_url TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN model TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE agy_accounts ADD COLUMN cli_version TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE client_apps ADD COLUMN ram_limit_mb INTEGER DEFAULT 1024"); } catch (e) {}
  try { db.exec("ALTER TABLE client_apps ADD COLUMN storage_limit_gb INTEGER DEFAULT 10"); } catch (e) {}
  try { db.exec("ALTER TABLE client_apps ADD COLUMN cpu_limit_pct INTEGER DEFAULT 100"); } catch (e) {}
  try { db.exec("ALTER TABLE client_apps ADD COLUMN app_dir TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT NULL"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN telegram_username TEXT DEFAULT NULL"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN telegram_auth_token TEXT DEFAULT NULL"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN telegram_notifications INTEGER DEFAULT 1"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}

  // Seed default settings
  const checkSetting = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('auto_fallback_enabled');
  if (!checkSetting) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('auto_fallback_enabled', '1');
  }
  const checkModelSetting = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('default_agy_model');
  if (!checkModelSetting) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('default_agy_model', 'gemini-3.7-flash-low');
  }
  const checkStrategy = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('rotation_strategy');
  if (!checkStrategy) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('rotation_strategy', 'least_used');
  }
  const checkCooldown = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('cooldown_minutes');
  if (!checkCooldown) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('cooldown_minutes', '30');
  }
  const checkTeleActive = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get('telegram_bot_active');
  if (!checkTeleActive) {
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run('telegram_bot_active', '1');
  }

  // Seed default templates
  const checkTemplates = db.prepare('SELECT count(*) as count FROM prompt_templates').get();
  if (checkTemplates.count === 0) {
    const templates = [
      { title: 'Full Codebase Audit & Security Check', category: 'audit', prompt: 'Lakukan audit menyeluruh terhadap arsitektur kode, keamanan, dan celah kerentanan. Berikan rekomendasi perbaikan terstruktur.' },
      { title: 'Refactor & Clean Architecture', category: 'refactor', prompt: 'Refactor kode ini agar mengikuti prinsip Clean Code, DRY, dan SOLID. Pisahkan logika bisnis dengan presentasi secara modular.' },
      { title: 'Unit & Integration Test Suite Generator', category: 'coding', prompt: 'Buatkan automated unit test dan integration test lengkap dengan coverage tinggi menggunakan framework testing standar untuk project ini.' },
      { title: 'Debug Runtime Stacktrace & Fix', category: 'debug', prompt: 'Analisis error stack trace berikut secara mendalam, jelaskan akar penyebab (root cause), dan sediakan perbaikan kode lengkap.' }
    ];
    for (const t of templates) {
      db.prepare('INSERT INTO prompt_templates (title, category, prompt) VALUES (?, ?, ?)').run(t.title, t.category, t.prompt);
    }
  }

  // Seed default admin user if none exists
  const checkUser = db.prepare('SELECT count(*) as count FROM users').get();
  if (checkUser.count === 0) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('admin@prime2026!', salt);
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES (?, ?, ?, ?)
    `).run('admin', hash, 'Prime Admin', 'admin');

    const defaultProj = db.prepare(`
      INSERT INTO projects (name, description, path, status, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run('Prime Project Core Workspace', 'Main development workspace and AI automation ecosystem', defaultWorkspace, 'active', 1);

    db.prepare(`
      INSERT INTO tasks (project_id, title, description, priority, status, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(defaultProj.lastInsertRowid, 'Monitor System & VPS Resources', 'Check CPU, RAM & Disk metrics in AGY Manager', 'high', 'in_progress', 1);

    db.prepare(`
      INSERT INTO tasks (project_id, title, description, priority, status, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(defaultProj.lastInsertRowid, 'Integrate AGY AI Tasks', 'Delegate codebase analysis and automation tasks to Antigravity CLI', 'medium', 'todo', 1);

    console.log('[*] Default admin created: user="admin", password="admin@prime2026!"');
  }

  // Seed default Master API Key if none exists
  const checkApiKeys = db.prepare('SELECT count(*) as count FROM api_keys').get();
  if (checkApiKeys.count === 0) {
    const masterKey = 'sk-agy-' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    db.prepare('INSERT INTO api_keys (key, name, created_by) VALUES (?, ?, 1)').run(masterKey, 'Default Master API Key');
    console.log(`[*] Default Master API Key generated: ${masterKey}`);
  }

  // Seed default client applications if none exists (Leave empty so only actual apps are registered)
  // const checkClientApps = db.prepare('SELECT count(*) as count FROM client_apps').get();
}

initDb();

function getDb() {
  return db;
}

module.exports = db;
module.exports.getDb = getDb;
module.exports.initDb = initDb;
