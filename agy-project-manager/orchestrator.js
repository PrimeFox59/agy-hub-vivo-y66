const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDb } = require('./db');

let ioInstance = null;
let watcherInterval = null;
const sessionCache = new Map();
const activeOverrides = new Map(); // sessionId -> { status, priority, paused }

/**
 * Get the path to Antigravity CLI's brain directory
 */
function getBrainDir() {
  const custom = process.env.AGY_BRAIN_DIR;
  if (custom && fs.existsSync(custom)) return custom;

  const defaultPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  if (fs.existsSync(defaultPath)) return defaultPath;

  // Fallback check for Windows app data or current user
  const winPath = path.join(process.env.USERPROFILE || 'C:\\Users\\PRIMA', '.gemini', 'antigravity-cli', 'brain');
  if (fs.existsSync(winPath)) return winPath;

  return defaultPath;
}

/**
 * Reads conversation titles directly from Antigravity CLI's conversation_summaries.db,
 * conversation_metadata.json, and annotations pbtxt files (the exact sources used by /resume).
 */
function getAgyConversationTitlesMap() {
  const titles = new Map();

  // 1. Check conversation_summaries.db (Primary Source used by /resume)
  const dbPaths = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\PRIMA', '.gemini', 'antigravity-cli', 'conversation_summaries.db')
  ];

  for (const dbFile of dbPaths) {
    if (fs.existsSync(dbFile)) {
      try {
        const Database = require('better-sqlite3');
        const db = new Database(dbFile, { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT conversation_id, title, preview, step_count, last_modified_time FROM conversation_summaries').all();
        db.close();

        for (const row of rows) {
          if (row.conversation_id) {
            titles.set(row.conversation_id, {
              title: row.title && row.title.trim() ? row.title.trim() : '',
              preview: row.preview || '',
              stepCount: row.step_count || 0,
              lastModifiedTime: row.last_modified_time || ''
            });
          }
        }
        break;
      } catch (err) {
        // Continue to fallback
      }
    }
  }

  // 2. Check cache/conversation_metadata.json (Fallback Source)
  const metaPaths = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'conversation_metadata.json'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\PRIMA', '.gemini', 'antigravity-cli', 'cache', 'conversation_metadata.json')
  ];

  for (const metaFile of metaPaths) {
    if (fs.existsSync(metaFile)) {
      try {
        const raw = fs.readFileSync(metaFile, 'utf8');
        const data = JSON.parse(raw);
        const convs = data.conversations || {};
        for (const [convId, convObj] of Object.entries(convs)) {
          const summary = convObj.summary || {};
          const title = summary.Title || summary.title || '';
          if (title && !titles.has(convId)) {
            titles.set(convId, {
              title: title.trim(),
              preview: summary.Preview || '',
              stepCount: summary.NumSteps || 0,
              lastModifiedTime: summary.UpdatedAt || ''
            });
          }
        }
        break;
      } catch (e) {}
    }
  }

  // 3. Check annotations/ directory (Fallback Source)
  const annotationsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'annotations');
  if (fs.existsSync(annotationsDir)) {
    try {
      const files = fs.readdirSync(annotationsDir);
      for (const f of files) {
        if (f.endsWith('.pbtxt')) {
          const convId = f.replace('.pbtxt', '');
          if (!titles.has(convId) || !titles.get(convId).title) {
            try {
              const content = fs.readFileSync(path.join(annotationsDir, f), 'utf8');
              const match = content.match(/title:\s*"([^"]+)"/);
              if (match && match[1]) {
                const prev = titles.get(convId) || {};
                titles.set(convId, {
                  ...prev,
                  title: match[1].trim()
                });
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  return titles;
}

function cleanPromptText(text) {
  if (!text) return '';
  return text
    .replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi, '$1')
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Discovers and returns all AGY sessions found in the brain directory
 */
function listSessions() {
  const brainDir = getBrainDir();
  if (!fs.existsSync(brainDir)) return [];

  try {
    const titlesMap = getAgyConversationTitlesMap();
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    const sessions = [];

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionId = ent.name;
      const sessionPath = path.join(brainDir, sessionId);
      const logDir = path.join(sessionPath, '.system_generated', 'logs');
      const transcriptPath = path.join(logDir, 'transcript.jsonl');
      const transcriptFullPath = path.join(logDir, 'transcript_full.jsonl');

      const targetFile = fs.existsSync(transcriptPath) ? transcriptPath : (fs.existsSync(transcriptFullPath) ? transcriptFullPath : null);
      if (!targetFile) continue;

      const stat = fs.statSync(targetFile);
      const knownMeta = titlesMap.get(sessionId);
      const metadata = inspectSessionSummary(sessionId, targetFile, stat, knownMeta);
      sessions.push(metadata);
    }

    // Sort by most recently active
    sessions.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
    return sessions;
  } catch (err) {
    console.error('[Orchestrator] Error listing sessions:', err.message);
    return [];
  }
}

/**
 * Inspects a session transcript to extract high-level summary
 */
function inspectSessionSummary(sessionId, filePath, stat, knownMeta = null) {
  let lineCount = 0;
  let firstUserPrompt = '';
  let latestUserPrompt = '';
  let latestAssistantText = '';
  let latestThinking = '';
  let latestToolCall = null;
  let status = 'idle';
  let activeToolName = '';
  let modelName = 'Gemini 3.7 Flash';

  let inputChars = 0;
  let outputChars = 0;
  let thinkingChars = 0;
  let toolChars = 0;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    lineCount = lines.length;

    // Check if updated in the last 20 seconds
    const now = Date.now();
    const isRecent = (now - stat.mtimeMs) < 20000;

    for (let i = 0; i < lines.length; i++) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.type === 'USER_INPUT') {
          const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          inputChars += text.length;
          if (!firstUserPrompt) firstUserPrompt = cleanPromptText(text);
          latestUserPrompt = cleanPromptText(text);
        }
        if (item.content && item.type === 'PLANNER_RESPONSE') {
          const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          outputChars += text.length;
          latestAssistantText = text.slice(0, 300);
        }
        if (item.thinking) {
          thinkingChars += item.thinking.length;
          latestThinking = item.thinking.slice(0, 300);
        }
        if (item.tool_calls && item.tool_calls.length > 0) {
          toolChars += JSON.stringify(item.tool_calls).length;
          latestToolCall = item.tool_calls[item.tool_calls.length - 1];
          activeToolName = latestToolCall.name || 'Tool Action';
        }
        if (item.model) {
          modelName = item.model;
        }
      } catch (e) {}
    }

    if (isRecent) {
      status = 'running';
    } else {
      status = 'completed';
    }
  } catch (err) {
    status = 'error';
  }

  // Apply user override if any
  const override = activeOverrides.get(sessionId) || {};
  if (override.status) status = override.status;
  const priority = override.priority || (status === 'running' ? 'high' : 'medium');

  const finalTitle = (knownMeta && knownMeta.title)
    ? knownMeta.title
    : (firstUserPrompt || latestUserPrompt || `Sesi ${sessionId.slice(0, 8)}`);

  // Calculate Tokens and Context Window
  const inputTokens = Math.round(inputChars / 3.8);
  const outputTokens = Math.round(outputChars / 3.8);
  const thinkingTokens = Math.round(thinkingChars / 3.8);
  const toolTokens = Math.round(toolChars / 3.8);
  const totalTokens = inputTokens + outputTokens + thinkingTokens + toolTokens;
  const totalTokensFormatted = totalTokens >= 1000000 
    ? (totalTokens / 1000000).toFixed(2) + 'M' 
    : (totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens.toString());
  const maxContextTokens = 1048576; // 1M Context Window for Gemini
  const contextUsagePercent = Math.min(100, Number(((totalTokens / maxContextTokens) * 100).toFixed(2)));

  // Get active AGY account telemetry
  let activeAccountInfo = null;
  try {
    const { getActiveAccount, isAutoFallbackEnabled } = require('./agyAccounts');
    const acc = getActiveAccount();
    if (acc) {
      activeAccountInfo = {
        id: acc.id,
        name: acc.name || 'Akun Utama (Local Disk)',
        email: acc.email || 'primary@local',
        status: acc.status || 'ready',
        usageCount: acc.usage_count || 0,
        successCount: acc.success_count || 0,
        failCount: acc.fail_count || 0,
        latencyMs: acc.latency_ms || 0,
        autoFallback: isAutoFallbackEnabled(),
        quotaRemaining: acc.status === 'quota_exceeded' ? 'Habis (0%)' : 'Siap / Unlimited (100%)',
        isQuotaExceeded: acc.status === 'quota_exceeded'
      };
    }
  } catch (_) {}

  return {
    id: sessionId,
    title: finalTitle,
    snippet: latestAssistantText || latestThinking || latestUserPrompt || (knownMeta && knownMeta.preview) || 'Tidak ada aktivitas baru',
    status, // 'running' | 'paused' | 'completed' | 'stopped' | 'todo'
    priority, // 'high' | 'medium' | 'low'
    stepsCount: (knownMeta && knownMeta.stepCount) ? Math.max(knownMeta.stepCount, lineCount) : lineCount,
    activeTool: activeToolName,
    latestThinking,
    model: modelName,
    lastActiveAt: (knownMeta && knownMeta.lastModifiedTime) ? new Date(knownMeta.lastModifiedTime).toISOString() : stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    isCurrentWorkingSession: sessionId.includes('4f7494b7'),
    tokens: {
      inputTokens,
      outputTokens,
      thinkingTokens,
      toolTokens,
      totalTokens,
      totalFormatted: totalTokensFormatted,
      contextUsagePercent,
      maxContextTokens
    },
    account: activeAccountInfo || {
      name: 'Akun Utama (Local Disk)',
      email: 'primary@local',
      status: 'ready',
      usageCount: lineCount,
      autoFallback: true,
      quotaRemaining: 'Siap / Unlimited (100%)',
      isQuotaExceeded: false
    }
  };
}

/**
 * Returns full step-by-step transcript of a given session
 */
function getSessionTranscript(sessionId, limit = 200) {
  const brainDir = getBrainDir();
  const sessionPath = path.join(brainDir, sessionId);
  const logDir = path.join(sessionPath, '.system_generated', 'logs');
  const transcriptPath = path.join(logDir, 'transcript.jsonl');
  const transcriptFullPath = path.join(logDir, 'transcript_full.jsonl');

  const targetFile = fs.existsSync(transcriptPath) ? transcriptPath : (fs.existsSync(transcriptFullPath) ? transcriptFullPath : null);
  if (!targetFile) return { session: null, steps: [] };

  try {
    const stat = fs.statSync(targetFile);
    const content = fs.readFileSync(targetFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const steps = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const item = JSON.parse(lines[i]);
        steps.push({
          step_index: item.step_index ?? i,
          type: item.type || 'UNKNOWN',
          source: item.source || 'MODEL',
          status: item.status || 'DONE',
          created_at: item.created_at || new Date().toISOString(),
          content: typeof item.content === 'string' ? item.content : (item.content ? JSON.stringify(item.content, null, 2) : ''),
          thinking: item.thinking || '',
          tool_calls: (item.tool_calls || []).map(tc => ({
            name: tc.name || tc.toolAction || 'tool_call',
            summary: tc.toolSummary || tc.toolAction || '',
            action: tc.toolAction || '',
            args: tc.parameters || tc.args || tc
          }))
        });
      } catch (e) {
        steps.push({
          step_index: i,
          type: 'RAW',
          content: lines[i]
        });
      }
    }

    const titlesMap = getAgyConversationTitlesMap();
    const summary = inspectSessionSummary(sessionId, targetFile, stat, titlesMap.get(sessionId));

    return {
      session: summary,
      steps: steps.slice(-limit)
    };
  } catch (err) {
    console.error(`[Orchestrator] Error reading transcript for ${sessionId}:`, err.message);
    return { session: null, steps: [], error: err.message };
  }
}

/**
 * Returns tasks structured for Kanban board across sessions
 */
function getKanbanTasks() {
  const sessions = listSessions();
  const db = getDb();

  // Get project tasks from database to merge
  let dbTasks = [];
  try {
    dbTasks = db.prepare(`
      SELECT t.*, p.name as project_name 
      FROM tasks t 
      LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY t.updated_at DESC
    `).all();
  } catch (e) {}

  const kanban = {
    todo: [],
    in_progress: [],
    paused: [],
    completed: [],
    stopped: []
  };

  // Convert sessions into orchestrator cards
  for (const s of sessions) {
    const card = {
      id: s.id,
      source: 'cli_session',
      title: s.title,
      description: s.snippet,
      status: s.status, // mapped to kanban column
      priority: s.priority,
      activeTool: s.activeTool,
      stepsCount: s.stepsCount,
      model: s.model,
      lastActiveAt: s.lastActiveAt,
      isCurrentWorkingSession: s.isCurrentWorkingSession
    };

    if (s.status === 'running') {
      kanban.in_progress.push(card);
    } else if (s.status === 'paused') {
      kanban.paused.push(card);
    } else if (s.status === 'stopped') {
      kanban.stopped.push(card);
    } else {
      kanban.completed.push(card);
    }
  }

  // Convert DB tasks into kanban
  for (const t of dbTasks) {
    const card = {
      id: `task-${t.id}`,
      source: 'project_task',
      dbTaskId: t.id,
      title: t.title,
      description: t.description || 'Delegated task',
      status: t.status === 'done' ? 'completed' : (t.status === 'in_progress' ? 'in_progress' : 'todo'),
      priority: t.priority || 'medium',
      projectName: t.project_name,
      agyStatus: t.agy_status,
      lastActiveAt: t.updated_at
    };

    if (card.status === 'in_progress') {
      kanban.in_progress.push(card);
    } else if (card.status === 'completed') {
      kanban.completed.push(card);
    } else {
      kanban.todo.push(card);
    }
  }

  return kanban;
}

/**
 * Handle actions on a session (pause, kill, resume, set priority)
 */
function handleSessionAction(sessionId, action, payload = {}) {
  const current = activeOverrides.get(sessionId) || {};

  if (action === 'kill' || action === 'stop') {
    activeOverrides.set(sessionId, { ...current, status: 'stopped' });
  } else if (action === 'pause') {
    activeOverrides.set(sessionId, { ...current, status: 'paused' });
  } else if (action === 'resume') {
    activeOverrides.set(sessionId, { ...current, status: 'running' });
  } else if (action === 'priority') {
    activeOverrides.set(sessionId, { ...current, priority: payload.priority || 'high' });
  } else if (action === 'status') {
    activeOverrides.set(sessionId, { ...current, status: payload.status || 'in_progress' });
  }

  // Broadcast update
  if (ioInstance) {
    ioInstance.emit('orchestrator:session_update', {
      sessionId,
      action,
      override: activeOverrides.get(sessionId)
    });
    ioInstance.emit('orchestrator:kanban_refresh', getKanbanTasks());
  }

  return { success: true, sessionId, action, override: activeOverrides.get(sessionId) };
}

/**
 * Starts background watcher for live CLI activity
 */
function initOrchestratorWatcher(io) {
  ioInstance = io;
  if (watcherInterval) clearInterval(watcherInterval);

  let lastKnownMtimes = new Map();

  watcherInterval = setInterval(() => {
    try {
      const brainDir = getBrainDir();
      if (!fs.existsSync(brainDir)) return;

      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const sessionId = ent.name;
        const logFile = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(logFile)) continue;

        const stat = fs.statSync(logFile);
        const lastMtime = lastKnownMtimes.get(sessionId) || 0;

        if (stat.mtimeMs > lastMtime) {
          lastKnownMtimes.set(sessionId, stat.mtimeMs);
          
          // Emit update if it's the first time or recently changed
          if (lastMtime > 0) {
            const summary = inspectSessionSummary(sessionId, logFile, stat);
            io.emit('orchestrator:activity_pulse', {
              sessionId,
              summary,
              timestamp: Date.now()
            });
          }
        }
      }
    } catch (e) {}
  }, 1500);

  console.log('[+] AI Orchestrator Real-time Watcher initialized');
}

module.exports = {
  getBrainDir,
  listSessions,
  getSessionTranscript,
  getKanbanTasks,
  handleSessionAction,
  initOrchestratorWatcher
};
