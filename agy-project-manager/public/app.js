// AGY Control Center Client Application

// Detect Base URL prefix (e.g. /agy or /)
const BASE_PATH = window.location.pathname.startsWith('/agy') ? '/agy' : '';
const API_URL = `${BASE_PATH}/api`;

let currentUser = null;
let currentChatSessionId = null;
let pendingChatAttachments = [];
let activeEventSource = null;
let selectedProjectId = null;
let activeDelegatingTaskId = null;
let cpuChartInstance = null;
let ramChartInstance = null;
let vpsPollInterval = null;
var clientAppsCache = [];
var currentPortalCategory = 'all';

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', () => {
  initMarkdown();
  checkAuth();
  setupEventListeners();
  loadCloudflareOverview();
});

function unescapeHtml(html) {
  if (!html) return '';
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function preprocessMarkdownForMermaid(md) {
  if (!md || typeof md !== 'string') return '';
  const mermaidStartRegex = /^\s*(graph\s+(?:TD|TB|BT|RL|LR)|flowchart\s+(?:TD|TB|BT|RL|LR)|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|C4Context)\b/i;
  
  const lines = md.split('\n');
  const result = [];
  let inCodeBlock = false;
  let inMermaidBlock = false;
  let mermaidBuffer = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (inMermaidBlock) {
        result.push('```mermaid\n' + mermaidBuffer.join('\n') + '\n```');
        inMermaidBlock = false;
        mermaidBuffer = [];
      }
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (!inMermaidBlock && mermaidStartRegex.test(trimmed)) {
      inMermaidBlock = true;
      mermaidBuffer = [line];
      continue;
    }

    if (inMermaidBlock) {
      // Check if we hit the end of the diagram (markdown headings, empty lines after blank, new numbered headers)
      const isHeading = /^#{1,6}\s+/.test(trimmed);
      const isNumberedSection = /^\d+\.\s+[A-Z]/.test(trimmed);

      if (isHeading || isNumberedSection) {
        result.push('```mermaid\n' + mermaidBuffer.join('\n') + '\n```');
        inMermaidBlock = false;
        mermaidBuffer = [];
        result.push(line);
      } else {
        mermaidBuffer.push(line);
      }
      continue;
    }

    result.push(line);
  }

  if (inMermaidBlock) {
    result.push('```mermaid\n' + mermaidBuffer.join('\n') + '\n```');
  }

  return result.join('\n');
}

function renderChatMarkdown(text) {
  if (!text) return '';
  const preprocessed = preprocessMarkdownForMermaid(text);
  try {
    return marked.parse(preprocessed);
  } catch (e) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

function initMarkdown() {
  if (window.mermaid) {
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        darkMode: true,
        themeVariables: {
          darkMode: true,
          background: '#020617',
          primaryColor: '#6366f1',
          primaryTextColor: '#f8fafc',
          primaryBorderColor: '#818cf8',
          lineColor: '#94a3b8',
          secondaryColor: '#3b82f6',
          tertiaryColor: '#1e293b'
        }
      });
    } catch (e) {}
  }

  if (window.marked) {
    const renderer = new marked.Renderer();

    renderer.code = function(tokenOrCode, language, isEscaped) {
      let code = (typeof tokenOrCode === 'object' && tokenOrCode !== null) ? tokenOrCode.text : tokenOrCode;
      let lang = (typeof tokenOrCode === 'object' && tokenOrCode !== null) ? tokenOrCode.lang : language;
      if (typeof code !== 'string') code = String(code || '');
      const cleanLang = (lang || '').trim().toLowerCase();

      // Check if it is a Mermaid diagram
      if (['mermaid', 'flowchart', 'graph', 'diagram', 'codegraph'].includes(cleanLang) || /^\s*(graph\s+(?:TD|TB|BT|RL|LR)|flowchart\s+(?:TD|TB|BT|RL|LR)|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|gitGraph|C4Context)\b/i.test(code.trim())) {
        const cleanCode = code.trim();
        const diagramId = 'mermaid-' + Math.random().toString(36).substr(2, 9);
        return `<div class="mermaid-container my-4 p-4 rounded-2xl bg-slate-950/90 border border-slate-800/90 shadow-lg flex flex-col items-center justify-center overflow-x-auto"><div class="mermaid text-center w-full flex justify-center" id="${diagramId}">${escapeHtml(cleanCode)}</div></div>`;
      }

      // Syntax highlight code blocks with copy button
      let highlighted = escapeHtml(code);
      if (window.hljs) {
        try {
          const validLang = hljs.getLanguage(cleanLang) ? cleanLang : 'plaintext';
          highlighted = hljs.highlight(code, { language: validLang }).value;
        } catch (e) {}
      }

      return `
        <div class="my-3 rounded-xl overflow-hidden border border-slate-800 bg-slate-950 shadow-md">
          <div class="px-3.5 py-1.5 bg-slate-900/90 border-b border-slate-800/80 flex justify-between items-center text-[11px] text-slate-400 font-mono">
            <span>${escapeHtml(cleanLang || 'code')}</span>
            <button onclick="copyToClipboard(decodeURIComponent('${encodeURIComponent(code)}'), this)" class="hover:text-slate-200 transition flex items-center gap-1">
              <i class="fa-regular fa-copy"></i>
              <span>Salin</span>
            </button>
          </div>
          <pre class="p-3.5 text-xs overflow-x-auto"><code class="language-${escapeHtml(cleanLang)}">${highlighted}</code></pre>
        </div>
      `;
    };

    renderer.image = function(tokenOrHref, title, text) {
      let href = (typeof tokenOrHref === 'object' && tokenOrHref !== null) ? tokenOrHref.href : tokenOrHref;
      let caption = (typeof tokenOrHref === 'object' && tokenOrHref !== null) ? (tokenOrHref.text || tokenOrHref.title) : (text || title);
      if (!href) return '';
      let src = href;
      if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
        src = `${API_URL}/media?path=${encodeURIComponent(href.replace(/^file:\/\//, ''))}`;
      }
      const cleanCaption = escapeHtml(caption || 'Gambar');
      const safeSrc = escapeHtml(src);
      return `
        <div class="my-3 rounded-2xl overflow-hidden border border-slate-700/80 bg-slate-950/90 shadow-xl group max-w-lg">
          <div class="cursor-pointer overflow-hidden max-h-[420px] flex items-center justify-center bg-slate-950 relative" onclick="openImageViewer('${safeSrc}', '${cleanCaption}')">
            <img src="${safeSrc}" alt="${cleanCaption}" class="w-full h-auto object-contain transition duration-300 group-hover:scale-[1.02]" loading="lazy" />
            <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs gap-1.5 font-semibold backdrop-blur-[2px]">
              <i class="fa-solid fa-magnifying-glass-plus text-sm"></i>
              <span>Klik untuk Perbesar</span>
            </div>
          </div>
          <div class="px-3.5 py-2 bg-slate-900/90 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
            <span class="truncate font-medium flex items-center gap-1.5"><i class="fa-solid fa-image text-indigo-400"></i> ${cleanCaption}</span>
            <div class="flex items-center gap-2">
              <button type="button" onclick="openImageViewer('${safeSrc}', '${cleanCaption}')" class="px-2.5 py-1 rounded-lg bg-indigo-600/30 text-indigo-300 hover:bg-indigo-600 hover:text-white transition text-[11px] font-semibold flex items-center gap-1">
                <i class="fa-solid fa-magnifying-glass-plus"></i>
                <span>Perbesar</span>
              </button>
              <a href="${safeSrc}" download="${cleanCaption}" target="_blank" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition text-[11px] font-semibold flex items-center gap-1 no-underline">
                <i class="fa-solid fa-download"></i>
                <span>Unduh</span>
              </a>
            </div>
          </div>
        </div>
      `;
    };

    renderer.link = function(tokenOrHref, title, text) {
      let href = (typeof tokenOrHref === 'object' && tokenOrHref !== null) ? tokenOrHref.href : tokenOrHref;
      let label = (typeof tokenOrHref === 'object' && tokenOrHref !== null) ? tokenOrHref.text : text;
      if (!href) return '';
      let targetHref = href;
      const isLocal = !targetHref.startsWith('http://') && !targetHref.startsWith('https://') && !targetHref.startsWith('#');
      if (isLocal) {
        targetHref = `${API_URL}/media?path=${encodeURIComponent(targetHref.replace(/^file:\/\//, ''))}`;
      }
      return `<a href="${escapeHtml(targetHref)}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 underline font-medium transition inline-flex items-center gap-1"><span>${label || escapeHtml(href)}</span><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i></a>`;
    };

    marked.setOptions({
      renderer: renderer,
      breaks: true,
      gfm: true
    });
  }
}

async function renderMermaidInElement(el) {
  if (!window.mermaid || !el) return;
  const mermaidNodes = el.querySelectorAll('.mermaid:not([data-processed="true"])');
  if (mermaidNodes.length === 0) return;

  for (let i = 0; i < mermaidNodes.length; i++) {
    const node = mermaidNodes[i];
    // Use unescapeHtml to ensure characters like '>', '<', '&' are clean for mermaid parser
    const rawText = unescapeHtml(node.textContent || node.innerText || '').trim();
    if (!rawText) continue;

    const renderId = 'mermaid-svg-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 4);
    try {
      const { svg } = await mermaid.render(renderId, rawText);
      node.innerHTML = svg;
      node.setAttribute('data-processed', 'true');
    } catch (err) {
      console.warn('Mermaid render error for node:', err);
      node.setAttribute('data-processed', 'error');
      node.innerHTML = `<pre class="text-xs text-indigo-300 font-mono text-left bg-slate-900/80 p-3 rounded-lg border border-indigo-500/20 overflow-x-auto">${escapeHtml(rawText)}</pre>`;
    }
  }
}

// ==================== AUTHENTICATION ====================

async function checkAuth() {
  const token = localStorage.getItem('agy_token');
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      showApp();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
  if (vpsPollInterval) clearInterval(vpsPollInterval);
}

function showApp() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');

  // Update header info
  document.getElementById('navFullName').textContent = currentUser.full_name;
  document.getElementById('navRoleBadge').textContent = currentUser.role;

  // Show admin / client / dev tabs based on role
  if (currentUser.role === 'client') {
    document.querySelectorAll('.admin-only, .client-hide').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.client-only').forEach(el => el.classList.remove('hidden'));
  } else if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only, .client-hide').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.client-only').forEach(el => el.classList.add('hidden'));
  } else {
    // member / operator / viewer
    document.querySelectorAll('.admin-only, .client-only').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.client-hide').forEach(el => el.classList.remove('hidden'));
  }

  // Init features
  initCharts();
  initSocket();
  loadClientPortal();

  if (vpsPollInterval) clearInterval(vpsPollInterval);
  vpsPollInterval = setInterval(loadVpsMetrics, 3000);

  if (currentUser.role === 'client') {
    switchTab('portal');
  } else {
    loadVpsMetrics();
    loadModels();
    loadProjects();
    loadTasks();
    loadChatSessions();
    loadAgyAccounts();
    loadOrchestratorData();
  }
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  // Login Form
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    errorEl.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Memproses...</span>';

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Login gagal');
      }

      localStorage.setItem('agy_token', data.token);
      currentUser = data.user;
      showApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>Masuk ke Dashboard</span><i class="fa-solid fa-arrow-right"></i>';
    }
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, { method: 'POST' });
    } catch (e) {}
    localStorage.removeItem('agy_token');
    currentUser = null;
    showLogin();
  });

  // Tabs navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  // Mobile menu toggle
  document.getElementById('mobileMenuToggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('-translate-x-full');
  });

  // Refresh VPS
  document.getElementById('refreshVpsBtn').addEventListener('click', loadVpsMetrics);

  // Chat Form Submit & Attachments
  document.getElementById('chatForm').addEventListener('submit', handleChatSubmit);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSubmit(e);
    }
  });

  // Attach button trigger
  document.getElementById('chatAttachBtn')?.addEventListener('click', () => {
    document.getElementById('chatFileInput')?.click();
  });

  // File input change
  document.getElementById('chatFileInput')?.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadChatFiles(e.target.files);
      e.target.value = '';
    }
  });

  // ==================== CLIPBOARD PASTE (IMAGE / FILE) ====================
  const handleClipboardPaste = async (e) => {
    // Only capture if chat tab is active
    const chatTab = document.getElementById('tab-chat');
    if (!chatTab || chatTab.classList.contains('hidden')) return;

    // If focused on an input/textarea outside the chat box (like settings or search inputs), let default paste happen
    const activeEl = document.activeElement;
    if (activeEl && activeEl !== document.getElementById('chatInput') && (activeEl.tagName === 'INPUT' || (activeEl.tagName === 'TEXTAREA' && activeEl.id !== 'chatInput'))) {
      return;
    }

    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const filesToUpload = [];

    // 1. Check clipboardData.items (standard screenshot & copied image items)
    if (clipboardData.items && clipboardData.items.length > 0) {
      for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.kind === 'file' || (item.type && item.type.startsWith('image/'))) {
          const file = item.getAsFile();
          if (file) {
            let fileName = file.name || '';
            if (!fileName || fileName === 'image.png' || fileName === 'blob' || fileName.startsWith('image')) {
              const now = new Date();
              const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
              fileName = `screenshot_${timeStr}.png`;
            }
            const renamedFile = new File([file], fileName, { type: file.type || 'image/png' });
            filesToUpload.push(renamedFile);
          }
        }
      }
    }

    // 2. Fallback to clipboardData.files if items was empty
    if (filesToUpload.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if ((file.type && file.type.startsWith('image/')) || file.size > 0) {
          filesToUpload.push(file);
        }
      }
    }

    if (filesToUpload.length > 0) {
      // Prevent pasting raw image binary string into textarea
      e.preventDefault();
      await uploadChatFiles(filesToUpload);
      // Auto-focus chat input after paste
      setTimeout(() => {
        document.getElementById('chatInput')?.focus();
      }, 80);
    }
  };

  // Bind to textarea and window level for instant Ctrl+V everywhere in chat tab
  document.getElementById('chatInput')?.addEventListener('paste', handleClipboardPaste);
  window.addEventListener('paste', handleClipboardPaste);

  // Drag & drop files onto chat tab
  const chatTabEl = document.getElementById('tab-chat');
  if (chatTabEl) {
    chatTabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatTabEl.classList.add('ring-2', 'ring-indigo-500/50');
    });
    chatTabEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      chatTabEl.classList.remove('ring-2', 'ring-indigo-500/50');
    });
    chatTabEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      chatTabEl.classList.remove('ring-2', 'ring-indigo-500/50');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await uploadChatFiles(e.dataTransfer.files);
      }
    });
  }

  // New Chat Session
  document.getElementById('newChatSessionBtn').addEventListener('click', () => {
    currentChatSessionId = null;
    document.getElementById('currentChatTitle').textContent = 'Percakapan Baru';
    document.getElementById('chatMessages').innerHTML = `
      <div class="text-center py-12 text-slate-500 space-y-3">
        <div class="w-12 h-12 rounded-2xl bg-indigo-600/10 text-indigo-400 flex items-center justify-center mx-auto">
          <i class="fa-solid fa-comments text-2xl"></i>
        </div>
        <h4 class="text-base font-semibold text-slate-300">Tersambung langsung ke AGY CLI di VPS</h4>
        <p class="text-xs text-slate-400 max-w-md mx-auto">
          Ketik pesan untuk memulai sesi obrolan baru dengan asisten Antigravity.
        </p>
      </div>
    `;
  });

  // Clear Chat
  document.getElementById('clearChatBtn').addEventListener('click', async () => {
    if (currentChatSessionId && confirm('Hapus sesi percakapan ini?')) {
      await fetch(`${API_URL}/chat/sessions/${currentChatSessionId}`, {
        method: 'DELETE',
        headers: getAuthHeader()
      });
      loadChatSessions();
      document.getElementById('newChatSessionBtn').click();
    }
  });

  // Modals Buttons
  document.getElementById('newTaskModalBtn').addEventListener('click', () => {
    populateProjectSelect();
    openModal('taskModal');
  });

  document.getElementById('newProjectModalBtn').addEventListener('click', () => {
    openModal('projectModal');
  });

  document.getElementById('newUserModalBtn')?.addEventListener('click', () => {
    openModal('userModal');
  });

  // Task Form Submit
  document.getElementById('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      project_id: document.getElementById('taskProjectSelect').value || null,
      title: document.getElementById('taskTitleInput').value,
      description: document.getElementById('taskDescInput').value,
      priority: document.getElementById('taskPrioritySelect').value,
      status: document.getElementById('taskStatusSelect').value
    };

    try {
      const res = await fetch(`${API_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        closeModal('taskModal');
        document.getElementById('taskForm').reset();
        loadTasks();
      }
    } catch (e) {
      alert('Gagal membuat task: ' + e.message);
    }
  });

  // Project Form Submit
  document.getElementById('projectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('projectNameInput').value,
      path: document.getElementById('projectPathInput').value,
      description: document.getElementById('projectDescInput').value
    };

    try {
      const res = await fetch(`${API_URL}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        closeModal('projectModal');
        document.getElementById('projectForm').reset();
        loadProjects();
      }
    } catch (e) {
      alert('Gagal membuat project: ' + e.message);
    }
  });

  // User Form Submit
  document.getElementById('userForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      full_name: document.getElementById('userFullNameInput').value,
      username: document.getElementById('userUsernameInput').value,
      password: document.getElementById('userPasswordInput').value,
      role: document.getElementById('userRoleSelect').value
    };

    try {
      const res = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal membuat user');
      closeModal('userModal');
      document.getElementById('userForm').reset();
      loadUsers();
    } catch (e) {
      alert(e.message);
    }
  });

  // Change Password Form Submit
  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const old_password = document.getElementById('oldPasswordInput').value;
    const new_password = document.getElementById('newPasswordInput').value;
    const alertEl = document.getElementById('passwordAlert');

    try {
      const res = await fetch(`${API_URL}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ old_password, new_password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mengubah password');

      alertEl.className = 'p-3 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-xs text-emerald-300';
      alertEl.textContent = 'Kata sandi berhasil diperbarui!';
      alertEl.classList.remove('hidden');
      document.getElementById('changePasswordForm').reset();
    } catch (e) {
      alertEl.className = 'p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.textContent = e.message;
      alertEl.classList.remove('hidden');
    }
  });

  // Start Delegate Button
  document.getElementById('startDelegateBtn').addEventListener('click', handleStartDelegate);

  // AGY Accounts Actions
  document.getElementById('openOAuthWizardBtn')?.addEventListener('click', () => {
    openOAuthWizard();
  });

  document.getElementById('wizardStartBtn')?.addEventListener('click', () => {
    handleWizardStart();
  });

  document.getElementById('wizardCompleteBtn')?.addEventListener('click', () => {
    handleWizardComplete();
  });

  document.getElementById('wizardBackBtn')?.addEventListener('click', () => {
    document.getElementById('wizardStep1').classList.remove('hidden');
    document.getElementById('wizardStep2').classList.add('hidden');
  });

  document.getElementById('newAgyAccountModalBtn')?.addEventListener('click', () => {
    openAgyAccountModal();
  });

  document.getElementById('refreshAgyAccountsBtn')?.addEventListener('click', () => {
    loadAgyAccounts();
  });

  document.getElementById('backupCurrentAgyBtn')?.addEventListener('click', () => {
    backupCurrentAgyToken();
  });

  document.getElementById('testAgyBtn')?.addEventListener('click', () => {
    testActiveAgyAccount();
  });

  document.getElementById('autoFallbackToggle')?.addEventListener('change', (e) => {
    handleAutoFallbackToggle(e);
  });

  document.getElementById('globalDefaultModelSelect')?.addEventListener('change', async (e) => {
    const newModel = e.target.value;
    currentDefaultModel = newModel;
    updateHeaderModelBadge();
    updateModelDropdowns();
    try {
      await fetch(`${API_URL}/agy/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ default_agy_model: newModel })
      });
    } catch (err) {
      console.error('Error updating default model:', err);
    }
  });

  document.getElementById('agyAccountForm')?.addEventListener('submit', (e) => {
    handleAgyAccountSubmit(e);
  });

  // Cloudflare Buttons & Forms
  document.getElementById('refreshCloudflareBtn')?.addEventListener('click', loadCloudflareOverview);
  document.getElementById('quickTunnelForm')?.addEventListener('submit', handleStartQuickTunnel);
  document.getElementById('cfStopAllTunnelsBtn')?.addEventListener('click', handleStopAllQuickTunnels);
  document.getElementById('cfServiceRestartBtn')?.addEventListener('click', () => handleServiceAction('restart'));
  document.getElementById('cfServiceStopBtn')?.addEventListener('click', () => handleServiceAction('stop'));
  document.getElementById('cfServiceStartBtn')?.addEventListener('click', () => handleServiceAction('start'));
  document.getElementById('cfSettingsForm')?.addEventListener('submit', handleSaveCfSettings);
  document.getElementById('cfVerifyTokenBtn')?.addEventListener('click', handleVerifyCfToken);
}

function getAuthHeader() {
  const token = localStorage.getItem('agy_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function switchTab(tabName) {
  if (currentUser && currentUser.role === 'client') {
    if (tabName !== 'portal' && tabName !== 'settings') {
      tabName = 'portal';
    }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.className = 'tab-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition text-indigo-400 bg-indigo-600/10 border border-indigo-500/20';
    } else {
      btn.className = 'tab-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition text-slate-400 hover:text-white hover:bg-slate-900 border border-transparent';
    }
  });

  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.className = 'mobile-nav-btn flex flex-col items-center justify-center gap-1 py-1 px-2.5 rounded-xl text-indigo-400 bg-indigo-600/15 border border-indigo-500/30 transition font-bold scale-105';
    } else {
      btn.className = 'mobile-nav-btn flex flex-col items-center justify-center gap-1 py-1 px-2.5 rounded-xl text-slate-400 hover:text-indigo-400 active:scale-95 transition font-normal';
    }
  });

  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  const activeContent = document.getElementById(`tab-${tabName}`);
  if (activeContent) {
    activeContent.classList.remove('hidden');
    void activeContent.offsetWidth;
  }

  // Trigger loads for specific tabs
  if (tabName === 'users') loadUsers();
  if (tabName === 'audit') loadAuditLogs();
  if (tabName === 'agy-accounts') loadAgyAccounts();
  if (tabName === 'cloudflare') loadCloudflareOverview();
  if (tabName === 'orchestrator') loadOrchestratorData();
  if (tabName === 'portal') loadClientPortal();

  // Close mobile sidebar if open
  document.getElementById('sidebar')?.classList.add('-translate-x-full');
  document.getElementById('mobileChatDrawer')?.classList.add('hidden');
}

function toggleMobileChatDrawer() {
  const drawer = document.getElementById('mobileChatDrawer');
  if (!drawer) return;
  drawer.classList.toggle('hidden');
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('modal-backdrop-anim');
  const modalBox = el.querySelector('.glass') || el.firstElementChild;
  if (modalBox) {
    modalBox.classList.remove('modal-box-anim');
    void modalBox.offsetWidth; // Trigger reflow for animation restart
    modalBox.classList.add('modal-box-anim');
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('modal-backdrop-anim');
}

// ==================== REALTIME TOAST NOTIFICATIONS ====================

function showToast(message, type = 'info', icon = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  let iconClass = icon || 'fa-circle-info';
  let borderClass = 'border-slate-800';
  let bgClass = 'bg-slate-900/95';
  let textClass = 'text-indigo-400';

  if (type === 'success') {
    iconClass = icon || 'fa-circle-check';
    borderClass = 'border-emerald-500/40';
    textClass = 'text-emerald-400';
  } else if (type === 'warning') {
    iconClass = icon || 'fa-triangle-exclamation';
    borderClass = 'border-amber-500/40';
    textClass = 'text-amber-400';
  } else if (type === 'error') {
    iconClass = icon || 'fa-circle-xmark';
    borderClass = 'border-rose-500/40';
    textClass = 'text-rose-400';
  } else if (type === 'live') {
    iconClass = icon || 'fa-bolt';
    borderClass = 'border-cyan-500/40';
    textClass = 'text-cyan-400';
  }

  toast.className = `pointer-events-auto flex items-center gap-3 p-3.5 rounded-2xl ${bgClass} ${borderClass} border shadow-2xl backdrop-blur-xl text-xs text-slate-200 toast-anim-in`;
  toast.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-slate-800/80 ${textClass} flex items-center justify-center shrink-0">
      <i class="fa-solid ${iconClass} text-sm"></i>
    </div>
    <div class="flex-1 min-w-0 pr-1">
      <div class="font-bold text-white truncate">${escapeHtml(message)}</div>
      <div class="text-[10px] text-slate-400 font-mono">Live Socket Event</div>
    </div>
    <button type="button" class="text-slate-500 hover:text-white p-1 transition cursor-pointer" onclick="this.parentElement.remove()">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('toast-anim-in');
    toast.classList.add('toast-anim-out');
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// ==================== VPS MONITOR & CHARTS ====================

function initCharts() {
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { display: false },
      y: {
        min: 0,
        max: 100,
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#64748b', font: { size: 10 } }
      }
    },
    elements: {
      point: { radius: 0 },
      line: { tension: 0.4, borderWidth: 2 }
    }
  };

  const initialLabels = Array(15).fill('');
  const initialData = Array(15).fill(0);

  const cpuCtx = document.getElementById('cpuChart')?.getContext('2d');
  if (cpuCtx) {
    cpuChartInstance = new Chart(cpuCtx, {
      type: 'line',
      data: {
        labels: initialLabels,
        datasets: [{
          data: [...initialData],
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true
        }]
      },
      options: chartOptions
    });
  }

  const ramCtx = document.getElementById('ramChart')?.getContext('2d');
  if (ramCtx) {
    ramChartInstance = new Chart(ramCtx, {
      type: 'line',
      data: {
        labels: initialLabels,
        datasets: [{
          data: [...initialData],
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.1)',
          fill: true
        }]
      },
      options: chartOptions
    });
  }
}

// ==================== REALTIME COMMUNICATION (RCT / SOCKET.IO) ====================

let socket = null;

function initSocket() {
  if (socket && socket.connected) return;
  const token = localStorage.getItem('agy_token');
  const socketPath = window.location.pathname.startsWith('/agy') ? '/agy/socket.io' : '/socket.io';

  try {
    socket = io({
      path: socketPath,
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 50,
      reconnectionDelay: 1000
    });

    socket.on('connect', () => {
      console.log('⚡ [RCT LIVE] WebSocket Connected via Socket.IO:', socket.id);
      updateRctStatus(true);
      socket.emit('vps:refresh');
    });

    socket.on('disconnect', () => {
      console.warn('⚠️ [RCT] WebSocket Disconnected');
      updateRctStatus(false);
    });

    socket.on('rct:connected', (data) => {
      console.log('⚡ [RCT LIVE] Handshake OK:', data);
    });

    // Real-Time High Frequency VPS Stream (Every 1.5s)
    socket.on('vps:stats', (data) => {
      if (!data) return;
      renderVpsMetrics(data);
    });

    // Real-Time AGY Account Status broadcast
    socket.on('agy:status_changed', (data) => {
      console.log('🔄 [RCT] AGY Status broadcast:', data);
      loadAgyAccounts();
      showToast(data?.message || 'Status Akun AGY diperbarui secara realtime', 'live', 'fa-arrows-rotate');
    });

    // Real-Time Task update broadcast
    socket.on('task:updated', (data) => {
      loadProjects();
      loadTasks();
      showToast(data?.title ? `Task "${data.title}" diperbarui` : 'Daftar tugas diperbarui secara realtime', 'success', 'fa-list-check');
    });

    // Real-Time Project update broadcast
    socket.on('project:updated', (data) => {
      loadProjects();
      showToast('Project diperbarui secara realtime', 'info', 'fa-diagram-project');
    });

    // Real-Time Client Portal Apps broadcast
    socket.on('portal:apps_updated', (data) => {
      console.log('⚡ [RCT] Client Apps Updated broadcast:', data);
      loadClientPortal();
      loadVpsMetrics();
      showToast(data?.name ? `Aplikasi "${data.name}" diperbarui` : 'Aplikasi klien diperbarui secara realtime', 'live', 'fa-shapes');
    });

    // Real-Time Users Management broadcast
    socket.on('users:updated', (data) => {
      console.log('⚡ [RCT] Users Updated broadcast:', data);
      if (document.getElementById('tab-users') && !document.getElementById('tab-users').classList.contains('hidden')) {
        loadUsers();
      }
      showToast('Data user diperbarui', 'info', 'fa-users');
    });

    // Real-Time Cloudflare Tunnel update broadcast
    socket.on('cloudflare:tunnel_update', (data) => {
      console.log('⚡ [RCT] Cloudflare Tunnel update:', data);
      loadCloudflareOverview();
      loadClientPortal();
      showToast(data?.message || 'Cloudflare Tunnel diperbarui', 'live', 'fa-bolt');
    });

    // Real-Time Telegram broadcast & link events
    socket.on('telegram:user_linked', (data) => {
      console.log('⚡ [Telegram] User linked event:', data);
      if (currentUser && currentUser.id === data.userId) {
        loadTelegramAuthInfo();
        showToast('Akun Telegram Anda berhasil ditautkan!', 'success', 'fa-brands fa-telegram');
      }
      loadUsers();
    });

    socket.on('telegram:user_unlinked', (data) => {
      if (currentUser && currentUser.id === data.userId) {
        loadTelegramAuthInfo();
        showToast('Tautan akun Telegram telah dilepas.', 'info', 'fa-solid fa-unlink');
      }
      loadUsers();
    });

    socket.on('telegram:config_updated', (data) => {
      showToast('Konfigurasi Telegram Bot diperbarui.', 'info', 'fa-brands fa-telegram');
    });

    // Real-Time AI Orchestrator broadcast
    socket.on('orchestrator:activity_pulse', (data) => {
      handleOrchestratorActivityPulse(data);
    });

    socket.on('orchestrator:session_update', () => {
      loadOrchestratorData();
    });

    socket.on('orchestrator:kanban_refresh', (kanban) => {
      renderOrchestratorKanban(kanban);
    });
  } catch (err) {
    console.error('Socket init error:', err);
    updateRctStatus(false);
  }
}

function updateRctStatus(isOnline) {
  const desk = document.getElementById('rctSocketBadge');
  const mob = document.getElementById('mobileRctBadge');
  if (desk) {
    desk.className = isOnline 
      ? 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[11px] font-bold font-mono'
      : 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[11px] font-bold font-mono';
    desk.innerHTML = isOnline 
      ? '<span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span></span><span>RCT LIVE</span>'
      : '<span class="h-2 w-2 rounded-full bg-rose-500"></span><span>RCT OFFLINE</span>';
  }
  if (mob) {
    mob.className = isOnline 
      ? 'flex items-center gap-1 px-2 py-1 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono text-[9px] font-bold'
      : 'flex items-center gap-1 px-2 py-1 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/30 font-mono text-[9px] font-bold';
    mob.innerHTML = isOnline 
      ? '<span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping"></span><span>RCT</span>'
      : '<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span><span>OFF</span>';
  }
}

function renderVpsMetrics(data) {
  if (!data) return;

  // Top Header
  const headerHostname = document.getElementById('headerHostname');
  const headerCpu = document.getElementById('headerCpu');
  const headerRam = document.getElementById('headerRam');
  const headerUptime = document.getElementById('headerUptime');

  if (headerHostname) headerHostname.textContent = data.hostname || 'VPS';
  if (headerCpu) headerCpu.textContent = `${data.cpu?.usagePercent || 0}%`;
  if (headerRam) headerRam.textContent = `${data.memory?.percent || 0}%`;
  if (headerUptime) headerUptime.textContent = data.uptime || '-';

  // Gauges
  const cpuPct = data.cpu?.usagePercent ?? data.cpu?.usage_percent ?? 0;
  const vpsCpuPercent = document.getElementById('vpsCpuPercent');
  const vpsCpuModel = document.getElementById('vpsCpuModel');
  const vpsCpuBar = document.getElementById('vpsCpuBar');
  if (vpsCpuPercent) vpsCpuPercent.textContent = `${cpuPct}%`;
  if (vpsCpuModel) vpsCpuModel.textContent = `${data.cpu?.cores || 1} Cores - ${data.cpu?.model?.split('@')[0] || ''}`;
  if (vpsCpuBar) vpsCpuBar.style.width = `${cpuPct}%`;

  const ramPct = data.memory?.percent ?? data.ram?.usage_percent ?? 0;
  const ramUsedBytes = data.memory?.used ?? (data.ram?.used_mb ? data.ram.used_mb * 1024 * 1024 : 0);
  const ramTotalBytes = data.memory?.total ?? (data.ram?.total_mb ? data.ram.total_mb * 1024 * 1024 : 1);
  const ramUsedGb = (ramUsedBytes / (1024 ** 3)).toFixed(1);
  const ramTotalGb = (ramTotalBytes / (1024 ** 3)).toFixed(1);
  const vpsRamPercent = document.getElementById('vpsRamPercent');
  const vpsRamDetails = document.getElementById('vpsRamDetails');
  const vpsRamBar = document.getElementById('vpsRamBar');
  if (vpsRamPercent) vpsRamPercent.textContent = `${ramPct}%`;
  if (vpsRamDetails) vpsRamDetails.textContent = `Used: ${ramUsedGb} / ${ramTotalGb} GB`;
  if (vpsRamBar) vpsRamBar.style.width = `${ramPct}%`;

  const diskPct = data.disk?.percent ?? data.disk?.usage_percent ?? 0;
  const diskUsedBytes = data.disk?.used ?? (data.disk?.used_gb ? data.disk.used_gb * (1024 ** 3) : 0);
  const diskTotalBytes = data.disk?.total ?? (data.disk?.total_gb ? data.disk.total_gb * (1024 ** 3) : 1);
  const diskUsedGb = (diskUsedBytes / (1024 ** 3)).toFixed(1);
  const diskTotalGb = (diskTotalBytes / (1024 ** 3)).toFixed(1);
  const vpsDiskPercent = document.getElementById('vpsDiskPercent');
  const vpsDiskDetails = document.getElementById('vpsDiskDetails');
  const vpsDiskBar = document.getElementById('vpsDiskBar');
  if (vpsDiskPercent) vpsDiskPercent.textContent = `${diskPct}%`;
  if (vpsDiskDetails) vpsDiskDetails.textContent = `Used: ${diskUsedGb} / ${diskTotalGb} GB`;
  if (vpsDiskBar) vpsDiskBar.style.width = `${diskPct}%`;

  const vpsUptime = document.getElementById('vpsUptime');
  const vpsLoadAvg = document.getElementById('vpsLoadAvg');
  const vpsPlatform = document.getElementById('vpsPlatform');
  if (vpsUptime) vpsUptime.textContent = data.uptime || '-';
  const loadStr = data.cpu?.loadAverage?.map(l => (typeof l === 'number' ? l.toFixed(2) : l)).join(', ') || '0.00, 0.00, 0.00';
  if (vpsLoadAvg) vpsLoadAvg.textContent = `Load Avg: ${loadStr}`;
  if (vpsPlatform) vpsPlatform.textContent = data.platform || '-';

  // Update Live Charts
  if (cpuChartInstance) {
    const cpuDataset = cpuChartInstance.data.datasets[0].data;
    cpuDataset.shift();
    cpuDataset.push(cpuPct);
    cpuChartInstance.update('none');
  }
  if (ramChartInstance) {
    const ramDataset = ramChartInstance.data.datasets[0].data;
    ramDataset.shift();
    ramDataset.push(ramPct);
    ramChartInstance.update('none');
  }

  // Update PM2 Table
  renderPm2Table(data.pm2 || []);

  // Update Client Portal Cards in-place without disrupting UI or clicks
  updatePortalCardsLiveTelemetry(data.pm2 || []);
}

function updatePortalCardsLiveTelemetry(pm2List) {
  const portalGrid = document.getElementById('portalAppsGrid');
  if (!portalGrid || !clientAppsCache.length) return;

  const pm2Map = new Map((pm2List || []).map(p => [p.name, p]));

  clientAppsCache.forEach(app => {
    const card = portalGrid.querySelector(`div[data-app-id="${app.id}"]`);
    if (!card) return;

    const pm2 = app.pm2_service_name ? pm2Map.get(app.pm2_service_name) : null;
    const isOnline = pm2 && pm2.status === 'online';

    // 1. Status indicator in quota box
    const statusTextEl = card.querySelector('.portal-card-status-text');
    if (statusTextEl) {
      const expectedText = isOnline ? '🟢 Online' : 'Standby / Port Active';
      if (statusTextEl.textContent !== expectedText) {
        statusTextEl.textContent = expectedText;
        statusTextEl.className = `portal-card-status-text font-mono text-[11px] ${isOnline ? 'text-emerald-400' : 'text-slate-500'}`;
      }
    }

    // 2. PM2 Badge in metadata tags
    const pm2BadgeEl = card.querySelector('.portal-card-pm2-badge');
    if (pm2BadgeEl && app.pm2_service_name) {
      const expectedClass = `portal-card-pm2-badge px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono ${isOnline ? 'text-emerald-400' : 'text-slate-400'}`;
      if (pm2BadgeEl.className !== expectedClass) pm2BadgeEl.className = expectedClass;
    }

    // 3. RAM Quota & Bar
    const ramUsageMb = pm2?.memory ? parseFloat((pm2.memory / (1024 * 1024)).toFixed(1)) : 0;
    const ramLimitMb = parseInt(app.ram_limit_mb || 1024, 10);
    const ramPct = Math.min(100, Math.round((ramUsageMb / ramLimitMb) * 100));

    const ramTextEl = card.querySelector('.portal-card-ram-text');
    if (ramTextEl) {
      const formatted = `${ramUsageMb} MB / <span class="text-slate-400 font-normal">${ramLimitMb} MB (${ramPct}%)</span>`;
      if (ramTextEl.innerHTML !== formatted) ramTextEl.innerHTML = formatted;
    }
    const ramBarEl = card.querySelector('.portal-card-ram-bar');
    if (ramBarEl) {
      ramBarEl.style.width = `${ramPct}%`;
      let ramBarColor = 'bg-cyan-500';
      if (ramPct > 90) ramBarColor = 'bg-rose-500';
      else if (ramPct > 75) ramBarColor = 'bg-amber-500';
      ramBarEl.className = `portal-card-ram-bar ${ramBarColor} h-1.5 rounded-full transition-all duration-500`;
    }

    // 4. CPU Usage
    const cpuEl = card.querySelector('.portal-card-cpu-text');
    if (cpuEl) {
      const cpuVal = pm2?.cpu !== undefined ? `${pm2.cpu}%` : '0%';
      const maxVal = app.cpu_limit_pct || 100;
      const formatted = `${cpuVal} <span class="text-[10px] text-slate-500 font-normal">/ max ${maxVal}%</span>`;
      if (cpuEl.innerHTML !== formatted) cpuEl.innerHTML = formatted;
    }

    // 5. Restarts Count
    const restartsEl = card.querySelector('.portal-card-restarts-text');
    if (restartsEl) {
      const restartsVal = pm2?.restarts !== undefined ? `${pm2.restarts}x` : '0x';
      if (restartsEl.textContent !== restartsVal) restartsEl.textContent = restartsVal;
    }
  });
}

async function loadVpsMetrics() {
  try {
    const res = await fetch(`${API_URL}/vps/metrics`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    renderVpsMetrics(data);
  } catch (err) {
    console.error('Failed to load VPS metrics:', err);
  }
}

let lastPm2Signature = '';

function renderPm2Table(pm2List) {
  const tbody = document.getElementById('pm2TableBody');
  if (!tbody) return;
  const countBadge = document.getElementById('pm2CountBadge');

  const standaloneApps = (clientAppsCache || []).filter(a => !a.pm2_service_name);
  if (countBadge) {
    countBadge.textContent = `${pm2List.length} PM2 • ${standaloneApps.length} Standalone`;
  }

  if (!pm2List.length && !standaloneApps.length) {
    if (lastPm2Signature !== 'empty') {
      lastPm2Signature = 'empty';
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="px-6 py-8 text-center text-slate-500">
            <div class="space-y-2">
              <p>Tidak ada service PM2 atau aplikasi standalone yang aktif.</p>
              <div class="flex items-center justify-center gap-2">
                <button type="button" onclick="openClientAppModal()" title="Daftarkan App Standalone" class="p-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl transition inline-flex items-center justify-center cursor-pointer shadow-md shadow-cyan-600/20 active:scale-95">
                  <i class="fa-solid fa-plus text-sm"></i>
                </button>
                <button type="button" onclick="autoSyncPm2Services()" title="Auto-Discover & Daftarkan ke PM2" class="p-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition inline-flex items-center justify-center cursor-pointer shadow-md shadow-indigo-600/20 active:scale-95">
                  <i class="fa-solid fa-wand-magic-sparkles text-sm"></i>
                </button>
              </div>
            </div>
          </td>
        </tr>
      `;
    }
    return;
  }

  // Structural signature (IDs and names) to detect if services were added or removed
  const currentSignature = pm2List.map(p => `${p.id}:${p.name}`).join('|') + '##' + standaloneApps.map(a => `${a.id}:${a.name}`).join('|');
  const existingRows = tbody.querySelectorAll('tr[data-pm2-name]');

  // Full render ONLY when structure changes or first mount
  if (currentSignature !== lastPm2Signature || existingRows.length !== pm2List.length) {
    lastPm2Signature = currentSignature;

    const pm2RowsHtml = pm2List.map((p) => {
      const isOnline = p.status === 'online';
      const statusBadge = isOnline
        ? '<span class="pm2-status-badge px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 inline-flex items-center"><i class="fa-solid fa-circle-dot text-[9px] mr-1 animate-pulse"></i>online</span>'
        : `<span class="pm2-status-badge px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30 inline-flex items-center">${escapeHtml(p.status)}</span>`;

      const memMb = (p.memory / (1024 * 1024)).toFixed(1);
      const matchedApp = (clientAppsCache || []).find(a => a.pm2_service_name === p.name);

      let clientCell = '';
      if (matchedApp) {
        const icon = matchedApp.icon || 'fa-shapes';
        clientCell = `
          <button type="button" onclick="openPm2LinkModal('${escapeAttr(p.name)}')" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 transition text-xs font-semibold max-w-[220px] truncate cursor-pointer group" title="${escapeHtml(matchedApp.client_name)} (${escapeHtml(matchedApp.name)}) - Klik untuk kelola">
            <i class="fa-solid ${escapeAttr(icon)} text-[11px] text-cyan-400 shrink-0"></i>
            <span class="truncate">${escapeHtml(matchedApp.client_name)}</span>
            <span class="text-slate-400 font-normal text-[10px] truncate">(${escapeHtml(matchedApp.name)})</span>
            <i class="fa-solid fa-chevron-down text-[9px] opacity-60 group-hover:opacity-100 ml-0.5"></i>
          </button>
        `;
      } else {
        clientCell = `
          <button type="button" onclick="openPm2LinkModal('${escapeAttr(p.name)}')" class="p-2 rounded-xl bg-slate-800/80 hover:bg-cyan-500/15 text-slate-400 hover:text-cyan-300 border border-slate-700/70 hover:border-cyan-500/30 transition text-xs font-medium cursor-pointer" title="Tautkan PM2 ke Klien / Aplikasi">
            <i class="fa-solid fa-link text-xs"></i>
          </button>
        `;
      }

      return `
        <tr data-pm2-name="${escapeAttr(p.name)}" class="hover:bg-slate-800/40 transition">
          <td class="px-6 py-3 font-mono text-xs text-slate-400">#${p.id}</td>
          <td class="px-6 py-3 font-bold text-white flex items-center gap-2">
            <i class="fa-solid fa-cube text-indigo-400 text-xs"></i>
            <span>${escapeHtml(p.name)}</span>
          </td>
          <td class="px-6 py-3 pm2-client-col">${clientCell}</td>
          <td class="px-6 py-3 pm2-status-col">${statusBadge}</td>
          <td class="px-6 py-3 font-mono text-xs text-slate-300 pm2-cpu-col">${p.cpu}%</td>
          <td class="px-6 py-3 font-mono text-xs text-slate-300 pm2-mem-col">${memMb} MB</td>
          <td class="px-6 py-3 font-mono text-xs text-slate-400 pm2-restarts-col">${p.restarts}x</td>
          <td class="px-6 py-3 text-right space-x-1.5 pm2-actions-col">
            <button onclick="viewPm2Logs('${escapeAttr(p.name)}')" title="Lihat Logs" class="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/20 text-slate-400 hover:text-indigo-400 border border-slate-700 transition cursor-pointer">
              <i class="fa-solid fa-terminal text-xs"></i>
            </button>
            <button onclick="restartPm2('${escapeAttr(p.name)}')" title="Restart Service" class="p-1.5 rounded-lg bg-slate-800 hover:bg-amber-600/20 text-slate-400 hover:text-amber-400 border border-slate-700 transition cursor-pointer">
              <i class="fa-solid fa-rotate-right text-xs"></i>
            </button>
            ${isOnline ? `
              <button onclick="stopPm2('${escapeAttr(p.name)}')" title="Hentikan Service" class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 border border-slate-700 transition cursor-pointer">
                <i class="fa-solid fa-pause text-xs"></i>
              </button>
            ` : ''}
          </td>
        </tr>
      `;
    }).join('');

    const standaloneRowsHtml = standaloneApps.map((a) => {
      const icon = a.icon || 'fa-rocket';
      return `
        <tr data-standalone-id="${a.id}" class="hover:bg-slate-800/40 transition bg-slate-900/15 border-l-2 border-l-cyan-500/50">
          <td class="px-6 py-3 font-mono text-xs text-slate-500">Port ${a.internal_port}</td>
          <td class="px-6 py-3 font-bold text-white flex items-center gap-2">
            <i class="fa-solid ${escapeAttr(icon)} text-cyan-400 text-xs"></i>
            <span>${escapeHtml(a.name)}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">Standalone</span>
          </td>
          <td class="px-6 py-3">
            <span class="text-xs text-slate-300 font-medium">${escapeHtml(a.client_name)}</span>
          </td>
          <td class="px-6 py-3">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 inline-flex items-center">
              <i class="fa-solid fa-circle-dot text-[9px] mr-1"></i>Port ${a.internal_port}
            </span>
          </td>
          <td class="px-6 py-3 font-mono text-xs text-slate-400">Max ${a.cpu_limit_pct || 100}%</td>
          <td class="px-6 py-3 font-mono text-xs text-slate-400">${a.ram_limit_mb || 1024} MB Quota</td>
          <td class="px-6 py-3 font-mono text-xs text-slate-500">-</td>
          <td class="px-6 py-3 text-right space-x-1.5">
            <button onclick="openQuickTunnelModal(${a.internal_port}, '${escapeAttr(a.name)}')" title="Hubungkan Cloudflare Quick Tunnel" class="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 transition cursor-pointer">
              <i class="fa-solid fa-bolt text-xs"></i>
            </button>
            <button onclick="openClientAppModal(${a.id})" title="Edit Data & Kuota" class="p-1.5 rounded-lg bg-slate-800 hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-400 border border-slate-700 transition cursor-pointer">
              <i class="fa-solid fa-pen text-xs"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = pm2RowsHtml + standaloneRowsHtml;
    return;
  }

  // High-frequency In-Place Patching: update text nodes without rebuilding DOM or triggering CSS reflow animations
  pm2List.forEach((p) => {
    const row = tbody.querySelector(`tr[data-pm2-name="${CSS.escape(p.name)}"]`);
    if (!row) return;

    const isOnline = p.status === 'online';
    const cpuEl = row.querySelector('.pm2-cpu-col');
    const memEl = row.querySelector('.pm2-mem-col');
    const restartsEl = row.querySelector('.pm2-restarts-col');
    const statusCol = row.querySelector('.pm2-status-col');

    const memMb = (p.memory / (1024 * 1024)).toFixed(1);

    if (cpuEl && cpuEl.textContent !== `${p.cpu}%`) {
      cpuEl.textContent = `${p.cpu}%`;
    }
    if (memEl && memEl.textContent !== `${memMb} MB`) {
      memEl.textContent = `${memMb} MB`;
    }
    if (restartsEl && restartsEl.textContent !== `${p.restarts}x`) {
      restartsEl.textContent = `${p.restarts}x`;
    }
    if (statusCol) {
      const currentStatusText = isOnline ? 'online' : p.status;
      const badge = statusCol.querySelector('.pm2-status-badge');
      if (!badge || !badge.textContent.includes(currentStatusText)) {
        statusCol.innerHTML = isOnline
          ? '<span class="pm2-status-badge px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 inline-flex items-center"><i class="fa-solid fa-circle-dot text-[9px] mr-1 animate-pulse"></i>online</span>'
          : `<span class="pm2-status-badge px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30 inline-flex items-center">${escapeHtml(p.status)}</span>`;
      }
    }
  });
}

async function autoSyncPm2Services() {
  try {
    const res = await fetch(`${API_URL}/vps/pm2/auto-sync`, {
      method: 'POST',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal sinkronisasi');
    alert(data.message || 'Auto-Discover & Sinkronisasi PM2 selesai!');
    loadVpsMetrics();
  } catch (e) {
    alert(e.message);
  }
}

async function restartPm2(name) {
  if (!confirm(`Restart PM2 service "${name}"?`)) return;
  try {
    const res = await fetch(`${API_URL}/vps/pm2/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ nameOrId: name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal restart');
    alert(`Service "${name}" berhasil di-restart.`);
    loadVpsMetrics();
  } catch (e) {
    alert(e.message);
  }
}

async function stopPm2(name) {
  if (!confirm(`Hentikan (Stop) PM2 service "${name}"?`)) return;
  try {
    const res = await fetch(`${API_URL}/vps/pm2/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ nameOrId: name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal stop service');
    alert(`Service "${name}" berhasil dihentikan.`);
    loadVpsMetrics();
  } catch (e) {
    alert(e.message);
  }
}

async function viewPm2Logs(name) {
  document.getElementById('pm2LogsTitle').textContent = `Logs: ${name}`;
  document.getElementById('pm2LogsContent').textContent = 'Mengambil log realtime...';
  openModal('pm2LogsModal');

  try {
    const res = await fetch(`${API_URL}/vps/pm2/logs?nameOrId=${encodeURIComponent(name)}&lines=70`, {
      headers: getAuthHeader()
    });
    const data = await res.json();
    document.getElementById('pm2LogsContent').textContent = data.logs || '(Log kosong)';
  } catch (e) {
    document.getElementById('pm2LogsContent').textContent = 'Gagal mengambil log: ' + e.message;
  }
}

// ==================== MODELS ====================

let cachedAvailableModels = [];
let currentDefaultModel = 'gemini-3.7-flash-low';

async function loadModels() {
  try {
    const [resModels, resSettings] = await Promise.all([
      fetch(`${API_URL}/models`, { headers: getAuthHeader() }),
      fetch(`${API_URL}/agy/settings`, { headers: getAuthHeader() })
    ]);

    if (resModels.ok) {
      const data = await resModels.json();
      cachedAvailableModels = data.models || [];
    }

    if (resSettings.ok) {
      const setts = await resSettings.json();
      if (setts.default_agy_model) {
        currentDefaultModel = setts.default_agy_model;
      }
    }

    updateModelDropdowns();
    updateHeaderModelBadge();
  } catch (e) {
    console.error('Error loading models:', e);
  }
}

function updateHeaderModelBadge() {
  const found = cachedAvailableModels.find(m => m.id === currentDefaultModel);
  const modelName = found ? found.name : (currentDefaultModel || 'Gemini 3.7 Flash');
  const badge = document.getElementById('headerAgyModel');
  if (badge) badge.textContent = modelName;
  const mobileBadge = document.getElementById('mobileHeaderAgyModel');
  if (mobileBadge) mobileBadge.textContent = modelName;
}

function updateModelDropdowns() {
  const globalSelect = document.getElementById('globalDefaultModelSelect');
  if (globalSelect && cachedAvailableModels.length) {
    globalSelect.innerHTML = cachedAvailableModels.map(m => `
      <option value="${m.id}" ${m.id === currentDefaultModel ? 'selected' : ''}>${escapeHtml(m.name)}</option>
    `).join('');
  }

  const selects = [
    document.getElementById('chatModelSelect'),
    document.getElementById('delegateModel')
  ];

  selects.forEach(select => {
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = `<option value="">Default (${escapeHtml(getModelDisplayName(currentDefaultModel))})</option>` + cachedAvailableModels.map(m => `
      <option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>${escapeHtml(m.name || m.id)}</option>
    `).join('');
  });
}

function getModelDisplayName(modelId) {
  if (!modelId) return currentDefaultModel ? getModelDisplayName(currentDefaultModel) : 'Gemini 3.7 Flash';
  const found = cachedAvailableModels.find(m => m.id === modelId);
  return found ? found.name : modelId;
}

// ==================== CHAT WITH AGY ====================

async function loadChatSessions() {
  try {
    const res = await fetch(`${API_URL}/chat/sessions`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions || [];
    const container = document.getElementById('chatSessionsList');
    const mobileContainer = document.getElementById('mobileChatSessionsList');

    if (!sessions.length) {
      const emptyHtml = `<div class="p-4 text-center text-xs text-slate-500">Belum ada riwayat chat.</div>`;
      if (container) container.innerHTML = emptyHtml;
      if (mobileContainer) mobileContainer.innerHTML = emptyHtml;
      return;
    }

    const html = sessions.map(s => {
      const isActive = s.id === currentChatSessionId;
      return `
        <div onclick="selectChatSession(${s.id}); toggleMobileChatDrawer();" class="p-2.5 rounded-xl cursor-pointer transition text-xs flex items-center justify-between group ${isActive ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 font-bold' : 'hover:bg-slate-900 text-slate-400 hover:text-slate-200 border border-transparent'}">
          <div class="truncate flex-1 pr-2">
            <i class="fa-regular fa-message mr-1.5 ${isActive ? 'text-indigo-400' : 'text-slate-500'}"></i>
            <span>${escapeHtml(s.title)}</span>
          </div>
        </div>
      `;
    }).join('');

    if (container) container.innerHTML = html;
    if (mobileContainer) mobileContainer.innerHTML = html;
  } catch (e) {}
}

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getFileIconClass(name = '', mimetype = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) || mimetype.startsWith('image/')) return 'fa-solid fa-image text-emerald-400';
  if (['pdf'].includes(ext)) return 'fa-solid fa-file-pdf text-rose-400';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json', 'sh', 'sql', 'php', 'c', 'cpp', 'rs', 'go'].includes(ext)) return 'fa-solid fa-file-code text-indigo-400';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'fa-solid fa-file-zipper text-amber-400';
  if (['txt', 'log', 'md', 'csv'].includes(ext)) return 'fa-solid fa-file-lines text-cyan-400';
  return 'fa-solid fa-file text-slate-400';
}

function renderChatAttachmentTray() {
  const tray = document.getElementById('chatAttachmentTray');
  if (!tray) return;
  if (!pendingChatAttachments.length) {
    tray.classList.add('hidden');
    tray.innerHTML = '';
    return;
  }
  tray.classList.remove('hidden');
  tray.innerHTML = pendingChatAttachments.map((att, idx) => {
    const isImg = att.isImage || (att.mimetype && att.mimetype.startsWith('image/'));
    return `
      <div class="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-200 group">
        ${isImg ? `
          <img src="${att.url}" alt="${escapeHtml(att.originalName)}" class="w-6 h-6 object-cover rounded-md border border-slate-600 cursor-pointer" onclick="openImageViewer('${att.url}', '${escapeHtml(att.originalName)}')" />
        ` : `
          <i class="${getFileIconClass(att.originalName, att.mimetype)}"></i>
        `}
        <span class="max-w-[120px] sm:max-w-[180px] truncate font-medium">${escapeHtml(att.originalName)}</span>
        <span class="text-[10px] text-slate-400 font-mono">(${formatBytes(att.size)})</span>
        <button type="button" onclick="removePendingAttachment(${idx})" class="text-slate-400 hover:text-rose-400 ml-1 p-0.5 rounded transition">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;
  }).join('');
}

function removePendingAttachment(idx) {
  pendingChatAttachments.splice(idx, 1);
  renderChatAttachmentTray();
}

async function uploadChatFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const formData = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    formData.append('files', f, f.name || 'attachment.png');
  }

  const tray = document.getElementById('chatAttachmentTray');
  if (tray) {
    tray.classList.remove('hidden');
    tray.innerHTML = `
      <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-950/70 border border-indigo-500/40 text-xs text-indigo-200 animate-pulse shadow-sm">
        <i class="fa-solid fa-spinner fa-spin text-indigo-400"></i>
        <span>Mengunggah ${fileList.length} lampiran foto/file...</span>
      </div>
    `;
  }

  try {
    const res = await fetch(`${API_URL}/chat/upload`, {
      method: 'POST',
      headers: {
        ...getAuthHeader()
      },
      body: formData
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      alert(errData.error || 'Gagal mengunggah file');
      renderChatAttachmentTray();
      return;
    }
    const data = await res.json();
    if (data.files && data.files.length) {
      pendingChatAttachments.push(...data.files);
    }
    renderChatAttachmentTray();
  } catch (err) {
    alert('Gagal mengunggah file: ' + err.message);
    renderChatAttachmentTray();
  }
}

function openImageViewer(url, name = '') {
  const modal = document.getElementById('imageViewerModal');
  const img = document.getElementById('imageViewerImg');
  const caption = document.getElementById('imageViewerCaption');
  const dlBtn = document.getElementById('imageViewerDownloadBtn');
  if (!modal || !img) return;

  img.src = url;
  if (caption) caption.textContent = name;
  if (dlBtn) {
    dlBtn.href = url;
    dlBtn.download = name || 'image';
  }
  modal.classList.remove('hidden');
}

function closeImageViewer() {
  const modal = document.getElementById('imageViewerModal');
  if (modal) modal.classList.add('hidden');
}

async function selectChatSession(sessionId) {
  currentChatSessionId = sessionId;
  loadChatSessions();

  try {
    const res = await fetch(`${API_URL}/chat/sessions/${sessionId}/messages`, {
      headers: getAuthHeader()
    });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('currentChatTitle').textContent = data.session?.title || 'Chat';

    const container = document.getElementById('chatMessages');
    const messages = data.messages || [];

    if (!messages.length) {
      container.innerHTML = `<div class="text-center py-12 text-slate-500 text-xs">Belum ada pesan di percakapan ini.</div>`;
      return;
    }

    container.innerHTML = messages.map(m => formatChatMessage(m.sender, m.message, m.model || data.session?.model, '', m.attachments)).join('');
    container.scrollTop = container.scrollHeight;
    await renderMermaidInElement(container);
  } catch (e) {}
}

function formatChatMessage(sender, text, model = '', effort = '', attachments = []) {
  const isUser = sender === 'user';
  const parsedText = isUser ? escapeHtml(text).replace(/\n/g, '<br>') : renderChatMarkdown(text);
  const displayModel = model || currentDefaultModel || 'gemini-3.7-flash-low';

  let attList = [];
  if (Array.isArray(attachments)) {
    attList = attachments;
  } else if (typeof attachments === 'string' && attachments.trim()) {
    try {
      attList = JSON.parse(attachments);
    } catch(e) {}
  }

  const images = attList.filter(a => a.isImage || (a.mimetype && a.mimetype.startsWith('image/')));
  const otherFiles = attList.filter(a => !a.isImage && (!a.mimetype || !a.mimetype.startsWith('image/')));

  let attachmentsHtml = '';
  if (images.length > 0) {
    attachmentsHtml += `
      <div class="mt-2.5 grid grid-cols-2 sm:grid-cols-3 gap-2">
        ${images.map(img => `
          <div class="relative group rounded-xl overflow-hidden border border-slate-700/80 bg-slate-950 cursor-pointer shadow-md" onclick="openImageViewer('${img.url}', '${escapeHtml(img.originalName)}')">
            <img src="${img.url}" alt="${escapeHtml(img.originalName)}" class="w-full h-28 sm:h-36 object-cover transition duration-200 group-hover:scale-105" loading="lazy" />
            <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs gap-1 font-semibold">
              <i class="fa-solid fa-magnifying-glass-plus"></i>
              <span>Perbesar</span>
            </div>
            <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-slate-950/90 via-slate-950/50 to-transparent p-1.5 text-[10px] text-slate-200 truncate">
              ${escapeHtml(img.originalName)}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (otherFiles.length > 0) {
    attachmentsHtml += `
      <div class="mt-2 space-y-1.5">
        ${otherFiles.map(file => `
          <a href="${file.url}" download="${escapeHtml(file.originalName)}" target="_blank" class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-950/60 hover:bg-slate-900 border border-slate-700/80 transition text-xs group no-underline text-slate-200">
            <div class="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center flex-shrink-0">
              <i class="${getFileIconClass(file.originalName, file.mimetype)}"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-medium truncate group-hover:text-indigo-300 transition text-white">${escapeHtml(file.originalName)}</div>
              <div class="text-[10px] text-slate-400 font-mono">${formatBytes(file.size)}</div>
            </div>
            <div class="p-1.5 text-slate-400 group-hover:text-white transition">
              <i class="fa-solid fa-arrow-down-to-bracket text-xs"></i>
            </div>
          </a>
        `).join('')}
      </div>
    `;
  }

  return `
    <div class="flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}">
      ${!isUser ? `
        <div class="w-8 h-8 rounded-xl bg-indigo-600/20 text-indigo-400 flex items-center justify-center flex-shrink-0 border border-indigo-500/30">
          <i class="fa-solid fa-brain text-sm"></i>
        </div>
      ` : ''}
      <div class="max-w-2xl rounded-2xl p-4 text-sm ${isUser ? 'bg-indigo-600 text-white rounded-tr-none' : 'glass text-slate-200 rounded-tl-none border border-slate-800 prose prose-invert'}">
        ${!isUser ? `
          <div class="flex items-center gap-2 mb-2 pb-1.5 border-b border-slate-800/80 text-[11px] not-prose">
            <span class="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold font-mono flex items-center gap-1.5">
              <i class="fa-solid fa-microchip text-[10px]"></i>
              <span>${escapeHtml(getModelDisplayName(displayModel))}</span>
            </span>
            ${effort ? `<span class="text-slate-400 text-[10px] uppercase font-mono">• ${escapeHtml(effort)}</span>` : ''}
          </div>
        ` : ''}
        <div>${parsedText}</div>
        ${attachmentsHtml}
      </div>
      ${isUser ? `
        <div class="w-8 h-8 rounded-xl bg-slate-800 text-slate-300 flex items-center justify-center flex-shrink-0">
          <i class="fa-solid fa-user text-sm"></i>
        </div>
      ` : ''}
    </div>
  `;
}

async function handleChatSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  const sendingAttachments = [...pendingChatAttachments];

  if (!text && sendingAttachments.length === 0) return;

  input.value = '';
  input.style.height = 'auto';
  pendingChatAttachments = [];
  renderChatAttachmentTray();

  const selectedModel = document.getElementById('chatModelSelect').value || currentDefaultModel;
  const selectedEffort = document.getElementById('chatEffortSelect').value;

  const displayText = text || 'Tolong analisis lampiran file/foto yang saya sertakan.';

  const container = document.getElementById('chatMessages');
  container.innerHTML += formatChatMessage('user', displayText, '', '', sendingAttachments);
  container.scrollTop = container.scrollHeight;

  // Assistant placeholder message
  const assistantMsgId = 'msg-' + Date.now();
  const assistantHtml = `
    <div class="flex gap-3 justify-start" id="${assistantMsgId}">
      <div class="w-8 h-8 rounded-xl bg-indigo-600/20 text-indigo-400 flex items-center justify-center flex-shrink-0 border border-indigo-500/30">
        <i class="fa-solid fa-brain text-sm"></i>
      </div>
      <div class="max-w-2xl rounded-2xl p-4 text-sm glass text-slate-200 rounded-tl-none border border-slate-800 prose prose-invert">
        <div class="flex items-center gap-2 mb-2 pb-1.5 border-b border-slate-800/80 text-[11px] not-prose">
          <span class="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold font-mono flex items-center gap-1.5">
            <i class="fa-solid fa-microchip text-[10px]"></i>
            <span>${escapeHtml(getModelDisplayName(selectedModel))}</span>
          </span>
          <span class="text-slate-400 text-[10px] uppercase font-mono">• ${escapeHtml(selectedEffort)}</span>
        </div>
        <div class="message-body">
          <span class="inline-flex items-center gap-1.5 text-xs text-indigo-400">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Menghubungkan ke AGY CLI...</span>
          </span>
        </div>
      </div>
    </div>
  `;
  container.innerHTML += assistantHtml;
  container.scrollTop = container.scrollHeight;

  const bodyEl = document.querySelector(`#${assistantMsgId} .message-body`);
  const toolBanner = document.getElementById('chatToolBanner');
  const toolText = document.getElementById('chatToolText');

  let accumulatedText = '';

  const payload = {
    session_id: currentChatSessionId,
    prompt: text,
    attachments: sendingAttachments,
    model: document.getElementById('chatModelSelect').value,
    effort: selectedEffort,
    workspace_dir: '/home/Prime-Projectx'
  };

  try {
    const response = await fetch(`${API_URL}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify(payload)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        try {
          const ev = JSON.parse(jsonStr);

          if (ev.type === 'session_init') {
            if (!currentChatSessionId) {
              currentChatSessionId = ev.session.id;
              loadChatSessions();
            }
          } else if (ev.type === 'tool' && ev.state === 'ACTIVE') {
            toolBanner.classList.remove('hidden');
            toolText.textContent = `Menjalankan tool: ${ev.name || 'proses'}...`;
          } else if (ev.type === 'fallback_switch') {
            toolBanner.classList.remove('hidden');
            toolText.innerHTML = `<i class="fa-solid fa-arrows-rotate fa-spin mr-1"></i> ${escapeHtml(ev.message)}`;
            bodyEl.innerHTML += `<div class="p-2.5 my-2 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-300 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(ev.message)}</span></div>`;
            container.scrollTop = container.scrollHeight;
            loadAgyAccounts();
          } else if (ev.type === 'fallback_exhausted') {
            toolBanner.classList.add('hidden');
            bodyEl.innerHTML += `<div class="p-2.5 my-2 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-center gap-2"><i class="fa-solid fa-circle-xmark"></i><span>${escapeHtml(ev.message)}</span></div>`;
            container.scrollTop = container.scrollHeight;
            loadAgyAccounts();
          } else if (ev.type === 'delta') {
            toolBanner.classList.add('hidden');
            accumulatedText += ev.text;
            bodyEl.innerHTML = renderChatMarkdown(accumulatedText);
            container.scrollTop = container.scrollHeight;
          } else if (ev.type === 'done' || ev.type === 'result') {
            toolBanner.classList.add('hidden');
            if (ev.response) {
              accumulatedText = ev.response;
            }
            bodyEl.innerHTML = renderChatMarkdown(accumulatedText);

            // If the agent generated artifacts / images during this turn, render them
            if (ev.attachments && Array.isArray(ev.attachments) && ev.attachments.length > 0) {
              const images = ev.attachments.filter(a => a.isImage);
              const files = ev.attachments.filter(a => !a.isImage);
              let attHtml = '';
              if (images.length > 0) {
                attHtml += `
                  <div class="mt-3 pt-2.5 border-t border-slate-800/80">
                    <div class="text-[11px] font-bold text-indigo-400 mb-2 flex items-center gap-1.5">
                      <i class="fa-solid fa-wand-magic-sparkles"></i>
                      <span>Artefak & Gambar Dihasilkan (${images.length})</span>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      ${images.map(img => `
                        <div class="relative group rounded-xl overflow-hidden border border-slate-700/80 bg-slate-950 shadow-md">
                          <div class="cursor-pointer overflow-hidden h-40 flex items-center justify-center bg-slate-950" onclick="openImageViewer('${img.url}', '${escapeHtml(img.originalName)}')">
                            <img src="${img.url}" alt="${escapeHtml(img.originalName)}" class="w-full h-full object-contain transition duration-200 group-hover:scale-105" loading="lazy" />
                          </div>
                          <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs gap-2 font-semibold pointer-events-none">
                            <span class="px-2.5 py-1 rounded-lg bg-indigo-600/80 backdrop-blur-sm flex items-center gap-1">
                              <i class="fa-solid fa-magnifying-glass-plus"></i> Perbesar
                            </span>
                          </div>
                          <div class="p-2 bg-slate-900/90 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-200">
                            <span class="truncate max-w-[140px] font-medium">${escapeHtml(img.originalName)}</span>
                            <a href="${img.url}" download="${escapeHtml(img.originalName)}" target="_blank" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white transition flex items-center gap-1 no-underline">
                              <i class="fa-solid fa-download"></i> Unduh
                            </a>
                          </div>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                `;
              }
              if (files.length > 0) {
                attHtml += `
                  <div class="mt-2 space-y-1.5">
                    ${files.map(file => `
                      <a href="${file.url}" download="${escapeHtml(file.originalName)}" target="_blank" class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-950/60 hover:bg-slate-900 border border-slate-700/80 transition text-xs group no-underline text-slate-200">
                        <div class="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center flex-shrink-0">
                          <i class="fa-solid fa-file-lines"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="font-medium truncate group-hover:text-indigo-300 transition text-white">${escapeHtml(file.originalName)}</div>
                          <div class="text-[10px] text-slate-400 font-mono">${formatBytes(file.size)}</div>
                        </div>
                        <div class="p-1.5 text-slate-400 group-hover:text-white transition">
                          <i class="fa-solid fa-arrow-down-to-bracket text-xs"></i>
                        </div>
                      </a>
                    `).join('')}
                  </div>
                `;
              }
              bodyEl.innerHTML += attHtml;
            }

            container.scrollTop = container.scrollHeight;
            renderMermaidInElement(bodyEl);
          } else if (ev.type === 'error') {
            toolBanner.classList.add('hidden');
            bodyEl.innerHTML = `<span class="text-rose-400">Error: ${ev.error}</span>`;
          }
        } catch (err) {}
      }
    }
  } catch (err) {
    toolBanner.classList.add('hidden');
    bodyEl.innerHTML = `<span class="text-rose-400">Error: ${err.message}</span>`;
  }
}

// ==================== PROJECTS & TASKS ====================

let taskFilterMode = 'project'; // 'project' | 'session'
let selectedSessionFilterId = null;

function setTaskFilterMode(mode) {
  taskFilterMode = mode;
  const projectBtn = document.getElementById('taskFilterModeProjectBtn');
  const sessionBtn = document.getElementById('taskFilterModeSessionBtn');
  const projectContainer = document.getElementById('projectsPillsContainer');
  const sessionContainer = document.getElementById('taskSessionPillsContainer');
  const activeLabel = document.getElementById('taskActiveFilterText');

  if (mode === 'project') {
    if (projectBtn) projectBtn.className = 'px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 bg-indigo-600 text-white shadow';
    if (sessionBtn) sessionBtn.className = 'px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 text-slate-400 hover:text-white';
    if (projectContainer) projectContainer.classList.remove('hidden');
    if (sessionContainer) sessionContainer.classList.add('hidden');
    if (activeLabel) activeLabel.textContent = 'Semua Project';
    selectedSessionFilterId = null;
    loadProjects();
    loadTasks();
  } else {
    if (projectBtn) projectBtn.className = 'px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 text-slate-400 hover:text-white';
    if (sessionBtn) sessionBtn.className = 'px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow';
    if (projectContainer) projectContainer.classList.add('hidden');
    if (sessionContainer) sessionContainer.classList.remove('hidden');
    if (activeLabel) activeLabel.textContent = 'Semua Sesi';
    selectedProjectId = null;
    loadSessionFilterPills();
    loadTasks();
  }
}

async function loadProjects() {
  try {
    const res = await fetch(`${API_URL}/projects`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const projects = data.projects || [];

    const container = document.getElementById('projectsPillsContainer');
    if (!container) return;

    container.innerHTML = `
      <button onclick="filterProject(null)" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${selectedProjectId === null ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}">
        <i class="fa-solid fa-layer-group text-[10px]"></i>
        <span>Semua Project (${projects.length})</span>
      </button>
    ` + projects.map(p => `
      <button onclick="filterProject(${p.id}, '${escapeAttr(p.name)}')" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${selectedProjectId === p.id ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}">
        <i class="fa-solid fa-folder text-[10px] text-indigo-400"></i>
        <span>${escapeHtml(p.name)}</span>
      </button>
    `).join('');
  } catch (e) {}
}

function filterProject(projectId, projectName = '') {
  selectedProjectId = projectId;
  const activeLabel = document.getElementById('taskActiveFilterText');
  if (activeLabel) {
    activeLabel.textContent = projectId ? projectName : 'Semua Project';
  }
  loadProjects();
  loadTasks();
}

async function loadSessionFilterPills() {
  const container = document.getElementById('taskSessionPillsContainer');
  if (!container) return;

  try {
    if (!orchestratorSessions || orchestratorSessions.length === 0) {
      const res = await fetch(`${API_URL}/orchestrator/sessions`, { headers: getAuthHeader() });
      if (res.ok) {
        const data = await res.json();
        orchestratorSessions = data.sessions || [];
      }
    }

    const sessions = orchestratorSessions || [];
    let pillsHtml = `
      <button onclick="filterTaskBySession(null)" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${selectedSessionFilterId === null ? 'bg-purple-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}">
        <i class="fa-solid fa-layer-group text-[10px]"></i>
        <span>Semua Sesi (${sessions.length})</span>
      </button>
    `;

    pillsHtml += sessions.map(s => {
      const isSelected = selectedSessionFilterId === s.id;
      const isLive = s.status === 'running';
      const liveDot = isLive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>' : '';
      const statusIcon = isLive ? '🟢' : (s.status === 'paused' ? '⏸️' : (s.status === 'stopped' ? '🛑' : '✅'));
      const label = s.title ? s.title.slice(0, 32) : `Sesi ${s.id.slice(0, 8)}`;

      return `
        <button onclick="filterTaskBySession('${s.id}')" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-2 ${isSelected ? 'bg-purple-600 text-white shadow-md ring-1 ring-purple-400/50' : 'bg-slate-800/90 text-slate-300 hover:text-white border border-slate-700/60'}">
          ${liveDot}
          <span>${statusIcon}</span>
          <span class="truncate max-w-[200px]">${escapeHtml(label)}</span>
          <span class="px-1.5 py-0.2 rounded bg-slate-900/80 text-[10px] font-mono text-purple-300 font-bold">${s.stepsCount || 0} steps</span>
        </button>
      `;
    }).join('');

    container.innerHTML = pillsHtml;
  } catch (err) {
    console.error('Error loading session filter pills:', err);
  }
}

function filterTaskBySession(sessionId) {
  selectedSessionFilterId = sessionId;
  const activeLabel = document.getElementById('taskActiveFilterText');
  if (activeLabel) {
    if (!sessionId) {
      activeLabel.textContent = 'Semua Sesi';
    } else {
      const sess = orchestratorSessions.find(s => s.id === sessionId);
      activeLabel.textContent = sess ? (sess.title ? sess.title.slice(0, 25) : sess.id.slice(0, 8)) : sessionId.slice(0, 8);
    }
  }
  loadSessionFilterPills();
  loadTasks();
}

async function populateProjectSelect() {
  try {
    const res = await fetch(`${API_URL}/projects`, { headers: getAuthHeader() });
    const data = await res.json();
    const select = document.getElementById('taskProjectSelect');
    select.innerHTML = (data.projects || []).map(p => `
      <option value="${p.id}" ${p.id === selectedProjectId ? 'selected' : ''}>${p.name}</option>
    `).join('');
  } catch (e) {}
}

async function loadTasks() {
  const cols = {
    todo: document.getElementById('colTodo'),
    in_progress: document.getElementById('colInProgress'),
    review: document.getElementById('colReview'),
    done: document.getElementById('colDone')
  };

  const counts = { todo: 0, in_progress: 0, review: 0, done: 0 };
  Object.values(cols).forEach(c => { if (c) c.innerHTML = ''; });

  if (taskFilterMode === 'session') {
    // Load from unified orchestrator kanban for sessions
    try {
      const res = await fetch(`${API_URL}/orchestrator/kanban`, { headers: getAuthHeader() });
      if (!res.ok) return;
      const kanban = await res.json();

      const filterBySess = (cards) => {
        if (!cards) return [];
        if (!selectedSessionFilterId) return cards;
        return cards.filter(c => c.id === selectedSessionFilterId || c.sessionId === selectedSessionFilterId);
      };

      const todoCards = filterBySess(kanban.todo || []);
      const inProgCards = filterBySess(kanban.in_progress || []);
      const pausedCards = filterBySess(kanban.paused || []);
      const compCards = filterBySess(kanban.completed || []);

      counts.todo = todoCards.length;
      counts.in_progress = inProgCards.length;
      counts.review = pausedCards.length; // Review maps to paused / waiting in session mode
      counts.done = compCards.length;

      const renderSessionTaskCard = (c) => {
        const isHigh = c.priority === 'high';
        const isMed = c.priority === 'medium';
        const prioBadge = isHigh
          ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono">HIGH</span>'
          : (isMed ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono">MEDIUM</span>' : '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-slate-800 text-slate-400 font-mono">LOW</span>');

        return `
          <div class="glass p-3.5 rounded-xl border border-slate-800 hover:border-slate-700/80 transition space-y-2.5 shadow-sm">
            <div class="flex items-center justify-between gap-1.5 flex-wrap">
              <span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-purple-500/15 text-purple-300 border border-purple-500/20">
                <i class="fa-solid fa-terminal text-[8px] mr-1"></i>SESI CLI
              </span>
              ${prioBadge}
            </div>
            <h5 class="text-xs font-bold text-slate-100 leading-snug tracking-tight">${escapeHtml(c.title || 'Task Sesi')}</h5>
            <p class="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mt-0.5">${escapeHtml(c.description || '-')}</p>
            <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
              <span class="text-[10px] text-slate-500 font-mono">${c.stepsCount || 0} steps</span>
              <button onclick="inspectSessionTrajectory('${c.id}'); switchTab('orchestrator');" class="px-2 py-1 rounded-lg bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30 transition text-[10px] font-bold flex items-center gap-1 cursor-pointer active:scale-95">
                <i class="fa-solid fa-eye text-[9px]"></i>
                <span>Lihat Sesi</span>
              </button>
            </div>
          </div>
        `;
      };

      if (cols.todo) cols.todo.innerHTML = todoCards.map(renderSessionTaskCard).join('') || '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task</div>';
      if (cols.in_progress) cols.in_progress.innerHTML = inProgCards.map(renderSessionTaskCard).join('') || '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task live</div>';
      if (cols.review) cols.review.innerHTML = pausedCards.map(renderSessionTaskCard).join('') || '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task paused</div>';
      if (cols.done) cols.done.innerHTML = compCards.slice(0, 12).map(renderSessionTaskCard).join('') || '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task selesai</div>';

      document.getElementById('countTodo').textContent = counts.todo;
      document.getElementById('countInProgress').textContent = counts.in_progress;
      document.getElementById('countReview').textContent = counts.review;
      document.getElementById('countDone').textContent = counts.done;
    } catch (e) {}
    return;
  }

  // Standard Project Mode
  let url = `${API_URL}/tasks`;
  if (selectedProjectId) {
    url += `?project_id=${selectedProjectId}`;
  }

  try {
    const res = await fetch(url, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const tasks = data.tasks || [];

    tasks.forEach(t => {
      const status = t.status || 'todo';
      if (counts[status] !== undefined) counts[status]++;
      if (cols[status]) {
        cols[status].innerHTML += renderTaskCard(t);
      }
    });

    Object.keys(cols).forEach(k => {
      if (cols[k] && !cols[k].innerHTML) {
        cols[k].innerHTML = '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task</div>';
      }
    });

    document.getElementById('countTodo').textContent = counts.todo;
    document.getElementById('countInProgress').textContent = counts.in_progress;
    document.getElementById('countReview').textContent = counts.review;
    document.getElementById('countDone').textContent = counts.done;
  } catch (e) {}
}

function renderTaskCard(t) {
  const priorityColors = {
    low: 'text-slate-400 bg-slate-800/80 border-slate-700/60',
    medium: 'text-sky-300 bg-sky-500/15 border-sky-500/30',
    high: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
    urgent: 'text-rose-300 bg-rose-500/15 border-rose-500/30'
  };

  const agyBadge = t.agy_status === 'completed'
    ? '<span class="text-[10px] px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-md font-bold font-mono"><i class="fa-solid fa-check mr-1"></i>AGY Done</span>'
    : t.agy_status === 'running'
    ? '<span class="text-[10px] px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 rounded-md font-bold font-mono animate-pulse"><i class="fa-solid fa-spinner fa-spin mr-1"></i>AGY Running</span>'
    : '';

  return `
    <div class="p-4 rounded-xl glass border border-slate-800 hover:border-slate-700/80 transition space-y-2.5 shadow-sm">
      <div class="flex items-center justify-between">
        <span class="text-[10px] px-2 py-0.5 rounded-md border uppercase font-bold tracking-wider font-mono ${priorityColors[t.priority] || priorityColors.medium}">
          ${t.priority}
        </span>
        ${agyBadge}
      </div>

      <h5 class="text-xs font-bold text-slate-100 leading-snug tracking-tight">${escapeHtml(t.title)}</h5>
      ${t.description ? `<p class="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mt-0.5">${escapeHtml(t.description)}</p>` : ''}

      <div class="pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2">
        <!-- Status Dropdown -->
        <select onchange="updateTaskStatus(${t.id}, this.value)" class="bg-slate-900 border border-slate-700/80 text-slate-300 text-[11px] font-medium rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500 transition cursor-pointer">
          <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>To Do</option>
          <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
          <option value="review" ${t.status === 'review' ? 'selected' : ''}>Review</option>
          <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
        </select>

        <!-- Actions -->
        <div class="flex items-center gap-1.5">
          <button onclick="openDelegateModal(${t.id}, '${escapeAttr(t.title)}')" title="Delegasikan ke AGY" class="p-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600 hover:text-white border border-indigo-500/30 transition text-xs active:scale-95 cursor-pointer">
            <i class="fa-solid fa-bolt"></i>
          </button>
          <button onclick="deleteTask(${t.id})" title="Hapus Task" class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition text-xs active:scale-95 cursor-pointer">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

async function updateTaskStatus(taskId, status) {
  try {
    await fetch(`${API_URL}/tasks/${taskId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ status })
    });
    loadTasks();
  } catch (e) {}
}

async function deleteTask(taskId) {
  if (!confirm('Hapus task ini?')) return;
  try {
    await fetch(`${API_URL}/tasks/${taskId}`, {
      method: 'DELETE',
      headers: getAuthHeader()
    });
    loadTasks();
  } catch (e) {}
}

// ==================== DELEGATE TASK TO AGY ====================

function openDelegateModal(taskId, title) {
  activeDelegatingTaskId = taskId;
  document.getElementById('delegateTaskTitle').textContent = title;
  document.getElementById('delegatePrompt').value = '';
  document.getElementById('delegateOutputBox').textContent = 'Klik "Mulai Jalankan Tugas" untuk mendelegasikan ke AGY CLI...';
  document.getElementById('delegateStatusBadge').textContent = 'IDLE';
  document.getElementById('delegateStatusBadge').className = 'text-[10px] font-bold text-slate-500';
  document.getElementById('startDelegateBtn').disabled = false;
  openModal('delegateModal');
}

async function handleStartDelegate() {
  if (!activeDelegatingTaskId) return;

  const btn = document.getElementById('startDelegateBtn');
  const outputBox = document.getElementById('delegateOutputBox');
  const badge = document.getElementById('delegateStatusBadge');

  btn.disabled = true;
  badge.textContent = 'RUNNING';
  badge.className = 'text-[10px] font-bold text-amber-400 animate-pulse';
  outputBox.textContent = 'Memulai proses delegasi AGY...\n';

  const customPrompt = document.getElementById('delegatePrompt').value;
  const effort = document.getElementById('delegateEffort').value;
  const model = document.getElementById('delegateModel').value;

  try {
    const response = await fetch(`${API_URL}/tasks/${activeDelegatingTaskId}/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ customPrompt, effort, model })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'delta') {
            outputBox.textContent += ev.text;
            outputBox.scrollTop = outputBox.scrollHeight;
          } else if (ev.type === 'fallback_switch') {
            outputBox.textContent += `\n[🔄 AUTO-FALLBACK: ${ev.message}]\n`;
            outputBox.scrollTop = outputBox.scrollHeight;
            loadAgyAccounts();
          } else if (ev.type === 'fallback_exhausted') {
            outputBox.textContent += `\n[❌ AUTO-FALLBACK: ${ev.message}]\n`;
            outputBox.scrollTop = outputBox.scrollHeight;
            loadAgyAccounts();
          } else if (ev.type === 'tool') {
            outputBox.textContent += `\n[Tool: ${ev.name} - ${ev.state}]\n`;
            outputBox.scrollTop = outputBox.scrollHeight;
          } else if (ev.type === 'completed') {
            badge.textContent = 'SUCCESS';
            badge.className = 'text-[10px] font-bold text-emerald-400';
            btn.disabled = false;
            loadTasks();
          } else if (ev.type === 'error') {
            badge.textContent = 'FAILED';
            badge.className = 'text-[10px] font-bold text-rose-400';
            outputBox.textContent += `\nError: ${ev.error}\n`;
            btn.disabled = false;
            loadTasks();
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    badge.textContent = 'FAILED';
    badge.className = 'text-[10px] font-bold text-rose-400';
    outputBox.textContent += `\nError: ${err.message}\n`;
    btn.disabled = false;
  }
}

// ==================== USER MANAGEMENT ====================

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  try {
    const res = await fetch(`${API_URL}/users`, { headers: getAuthHeader() });
    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Gagal memuat data pengguna.</td></tr>`;
      return;
    }
    const data = await res.json();
    const users = data.users || [];

    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Belum ada pengguna terdaftar.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="px-6 py-3 font-mono text-xs text-slate-400">${u.id}</td>
        <td class="px-6 py-3 font-bold text-white">${escapeHtml(u.full_name || '')}</td>
        <td class="px-6 py-3 font-mono text-xs text-slate-300">@${escapeHtml(u.username || '')}</td>
        <td class="px-6 py-3">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${u.role === 'admin' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-slate-800 text-slate-300'}">
            ${escapeHtml(u.role || 'member')}
          </span>
        </td>
        <td class="px-6 py-3 text-xs text-slate-400">${u.created_at || '-'}</td>
        <td class="px-6 py-3 text-right space-x-2">
          <button onclick="resetUserPassword(${u.id})" title="Reset Password" class="p-1.5 rounded-lg bg-slate-800 hover:bg-amber-500/20 text-slate-400 hover:text-amber-400 transition text-xs">
            <i class="fa-solid fa-key"></i>
          </button>
          ${currentUser && u.id !== currentUser.id ? `
            <button onclick="deleteUser(${u.id})" title="Hapus User" class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition text-xs">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          ` : ''}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-rose-400">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function resetUserPassword(userId) {
  const newPass = prompt('Masukkan password baru (minimal 6 karakter):');
  if (!newPass) return;
  if (newPass.length < 6) return alert('Password minimal 6 karakter');

  try {
    const res = await fetch(`${API_URL}/users/${userId}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ password: newPass })
    });
    if (res.ok) alert('Password user berhasil di-reset.');
  } catch (e) {
    alert(e.message);
  }
}

async function deleteUser(userId) {
  if (!confirm('Hapus user ini?')) return;
  try {
    const res = await fetch(`${API_URL}/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeader()
    });
    if (res.ok) loadUsers();
  } catch (e) {
    alert(e.message);
  }
}

// ==================== AUDIT LOGS ====================

async function loadAuditLogs() {
  try {
    const res = await fetch(`${API_URL}/audit`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const logs = data.logs || [];
    const tbody = document.getElementById('auditTableBody');

    if (!logs.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500">Belum ada catatan log.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => `
      <tr class="hover:bg-slate-800/40 transition text-xs">
        <td class="px-6 py-3 text-slate-400 font-mono">${l.created_at}</td>
        <td class="px-6 py-3 font-semibold text-white">@${l.username}</td>
        <td class="px-6 py-3"><span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">${l.action}</span></td>
        <td class="px-6 py-3 text-slate-300">${escapeHtml(l.details || '')}</td>
        <td class="px-6 py-3 text-slate-500 font-mono">${l.ip_address || '-'}</td>
      </tr>
    `).join('');
  } catch (e) {}
}

// ==================== AGY ACCOUNTS & AUTO-FALLBACK ====================

let agyAccountsCache = [];

async function loadAgyAccounts() {
  try {
    const res = await fetch(`${API_URL}/agy/accounts`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    agyAccountsCache = data.accounts || [];
    const activeAccount = data.active_account;
    const autoFallbackEnabled = data.auto_fallback_enabled;

    // Update Header active account badge
    const headerAcc = document.getElementById('headerAgyAccount');
    const headerBadge = document.getElementById('headerAgyBadge');
    const mobHeaderAcc = document.getElementById('mobileHeaderAgyAccount');
    const mobHeaderBadge = document.getElementById('mobileHeaderAgyBadge');

    if (activeAccount) {
      if (headerAcc) headerAcc.textContent = activeAccount.name;
      if (mobHeaderAcc) mobHeaderAcc.textContent = activeAccount.name;

      let badgeText = 'READY';
      let badgeClass = 'px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400 font-bold';
      let mobBadgeClass = 'px-1 py-0.2 text-[9px] rounded bg-emerald-500/20 text-emerald-400 font-bold';

      if (activeAccount.status === 'quota_exceeded') {
        badgeText = 'LIMIT';
        badgeClass = 'px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-400 font-bold';
        mobBadgeClass = 'px-1 py-0.2 text-[9px] rounded bg-amber-500/20 text-amber-400 font-bold';
      } else if (activeAccount.status === 'error') {
        badgeText = 'ERROR';
        badgeClass = 'px-1.5 py-0.5 text-[10px] rounded bg-rose-500/20 text-rose-400 font-bold';
        mobBadgeClass = 'px-1 py-0.2 text-[9px] rounded bg-rose-500/20 text-rose-400 font-bold';
      }

      if (headerBadge) {
        headerBadge.textContent = badgeText;
        headerBadge.className = badgeClass;
      }
      if (mobHeaderBadge) {
        mobHeaderBadge.textContent = badgeText;
        mobHeaderBadge.className = mobBadgeClass;
      }
    } else {
      if (headerAcc) headerAcc.textContent = 'Belum Ada Akun';
      if (mobHeaderAcc) mobHeaderAcc.textContent = 'Belum Ada Akun';
      if (headerBadge) {
        headerBadge.textContent = 'NONE';
        headerBadge.className = 'px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-slate-400 font-bold';
      }
      if (mobHeaderBadge) {
        mobHeaderBadge.textContent = 'NONE';
        mobHeaderBadge.className = 'px-1 py-0.2 text-[9px] rounded bg-slate-800 text-slate-400 font-bold';
      }
    }

    // Update Master Fallback toggle
    const toggle = document.getElementById('autoFallbackToggle');
    const toggleLabel = document.getElementById('autoFallbackStatusLabel');
    if (toggle) {
      toggle.checked = !!autoFallbackEnabled;
      if (toggleLabel) {
        toggleLabel.textContent = autoFallbackEnabled ? 'Aktif (Otomatis)' : 'Nonaktif';
        toggleLabel.className = `text-sm font-bold ${autoFallbackEnabled ? 'text-emerald-400' : 'text-slate-400'}`;
      }
    }

    // Update Active Account card
    const cardName = document.getElementById('cardActiveAccountName');
    const cardEmail = document.getElementById('cardActiveAccountEmail');
    const cardBadge = document.getElementById('cardActiveAccountStatusBadge');
    if (cardName && cardEmail && cardBadge) {
      if (activeAccount) {
        cardName.innerHTML = `
          <div class="flex items-center gap-2">
            ${activeAccount.avatar_url ? `<img src="${escapeAttr(activeAccount.avatar_url)}" class="w-6 h-6 rounded-full border border-slate-700 shrink-0"/>` : '<i class="fa-solid fa-user-astronaut text-indigo-400 text-sm"></i>'}
            <span class="truncate">${escapeHtml(activeAccount.name)}</span>
          </div>
        `;
        cardEmail.innerHTML = `
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono text-slate-300">${escapeHtml(activeAccount.email || 'Tanpa email')}</span>
            ${activeAccount.model ? `<span class="px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 text-[10px] font-semibold">${escapeHtml(activeAccount.model)}</span>` : ''}
          </div>
        `;
        if (activeAccount.status === 'quota_exceeded') {
          cardBadge.textContent = 'LIMIT TERCAPAI';
          cardBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400';
        } else if (activeAccount.status === 'error') {
          cardBadge.textContent = 'ERROR';
          cardBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400';
        } else {
          cardBadge.textContent = 'READY / SIAP';
          cardBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400';
        }
      } else {
        cardName.textContent = 'Belum ada akun aktif';
        cardEmail.textContent = '-';
        cardBadge.textContent = 'NONE';
        cardBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400';
      }
    }

    // Update pool counters
    const totalCountEl = document.getElementById('agyTotalAccountsCount');
    const readyCountEl = document.getElementById('agyReadyCount');
    const limitCountEl = document.getElementById('agyLimitCount');
    if (totalCountEl) totalCountEl.textContent = `${agyAccountsCache.length} Akun`;
    if (readyCountEl) readyCountEl.textContent = agyAccountsCache.filter(a => a.status === 'ready').length;
    if (limitCountEl) limitCountEl.textContent = agyAccountsCache.filter(a => a.status === 'quota_exceeded').length;

    // Render Mobile Cards (Phones)
    const mobileCardsContainer = document.getElementById('agyAccountsCardsMobile');
    if (mobileCardsContainer) {
      if (!agyAccountsCache.length) {
        mobileCardsContainer.innerHTML = `<div class="p-6 text-center text-slate-500 text-xs">Belum ada akun AGY yang terdaftar. Klik "+ Login Google (1-Klik)" di atas.</div>`;
      } else {
        mobileCardsContainer.innerHTML = agyAccountsCache.map(acc => {
          const isActive = !!acc.is_active;
          let statusBadge = '';
          if (acc.status === 'ready') {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><i class="fa-solid fa-circle-check text-[9px] mr-1"></i>Ready</span>';
          } else if (acc.status === 'quota_exceeded') {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30"><i class="fa-solid fa-triangle-exclamation text-[9px] mr-1"></i>Limit</span>';
          } else if (acc.status === 'disabled') {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-400">Disabled</span>';
          } else {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30">Error</span>';
          }

          const avatarHtml = acc.avatar_url
            ? `<img src="${escapeAttr(acc.avatar_url)}" alt="${escapeAttr(acc.name)}" class="w-8 h-8 rounded-full object-cover border border-slate-700 shrink-0"/>`
            : `<div class="w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 flex items-center justify-center text-xs shrink-0"><i class="fa-brands fa-google"></i></div>`;

          const modelBadge = acc.model
            ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">${escapeHtml(acc.model)}</span>`
            : '';

          return `
            <div class="p-4 rounded-2xl border transition ${isActive ? 'bg-indigo-950/40 border-indigo-500/40 shadow-lg shadow-indigo-950/50' : 'glass border-slate-800'} space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                  ${avatarHtml}
                  <div class="min-w-0">
                    <div class="font-bold text-white text-sm flex items-center gap-1.5 flex-wrap">
                      <span class="truncate">${escapeHtml(acc.name)}</span>
                      ${isActive ? '<span class="px-2 py-0.2 rounded text-[9px] font-bold bg-indigo-500 text-white">AKTIF</span>' : ''}
                    </div>
                    <div class="text-xs text-slate-300 mt-0.5 font-mono truncate max-w-[220px] flex items-center gap-1">
                      <i class="fa-regular fa-envelope text-[10px] text-indigo-400"></i>
                      <span>${escapeHtml(acc.email || '(tanpa email)')}</span>
                    </div>
                  </div>
                </div>
                <div>${statusBadge}</div>
              </div>

              ${modelBadge ? `<div class="flex items-center gap-1.5 pt-1">${modelBadge}</div>` : ''}

              ${acc.last_error ? `<div class="p-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-[11px] text-amber-300">${escapeHtml(acc.last_error)}</div>` : ''}

              <div class="flex items-center justify-between text-xs pt-2 border-t border-slate-800/80 text-slate-400">
                <div class="flex items-center gap-2">
                  <span>Auto-Fallback:</span>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" ${acc.auto_fallback ? 'checked' : ''} onchange="toggleAgyAccountFallback(${acc.id}, this.checked)" class="sr-only peer">
                    <div class="w-8 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>
                <div class="text-[11px] font-mono text-slate-500">${acc.usage_count || 0}x dipakai</div>
              </div>

              <div class="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                ${!isActive ? `
                  <button onclick="activateAgyAccount(${acc.id})" title="Gunakan Akun Ini" class="flex-1 py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition flex items-center justify-center active:scale-95 cursor-pointer">
                    <i class="fa-solid fa-play text-xs"></i>
                  </button>
                ` : `
                  <div class="flex-1 py-2 px-3 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center" title="Sedang Digunakan">
                    <i class="fa-solid fa-circle-check text-xs"></i>
                  </div>
                `}

                ${acc.status === 'quota_exceeded' || acc.status === 'error' ? `
                  <button onclick="resetAgyAccountStatus(${acc.id})" title="Reset Status" class="p-2.5 rounded-xl bg-slate-800 text-emerald-400 border border-slate-700 active:scale-95 text-xs">
                    <i class="fa-solid fa-arrows-rotate"></i>
                  </button>
                ` : ''}

                <button onclick="openAgyAccountModal(${acc.id})" title="Edit Akun" class="p-2.5 rounded-xl bg-slate-800 text-slate-300 border border-slate-700 active:scale-95 text-xs">
                  <i class="fa-solid fa-pen"></i>
                </button>

                ${agyAccountsCache.length > 1 ? `
                  <button onclick="deleteAgyAccount(${acc.id})" title="Hapus Akun" class="p-2.5 rounded-xl bg-slate-800 text-rose-400 border border-slate-700 active:scale-95 text-xs">
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                ` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Render Table (Desktop)
    const tbody = document.getElementById('agyAccountsTableBody');
    if (!tbody) return;

    if (!agyAccountsCache.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-slate-500">Belum ada akun AGY yang terdaftar.</td></tr>`;
      return;
    }

    tbody.innerHTML = agyAccountsCache.map(acc => {
      const isActive = !!acc.is_active;
      let statusBadge = '';
      if (acc.status === 'ready') {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><i class="fa-solid fa-circle-check text-[10px] mr-1"></i>Ready</span>';
      } else if (acc.status === 'quota_exceeded') {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30" title="' + escapeAttr(acc.last_error || '') + '"><i class="fa-solid fa-triangle-exclamation text-[10px] mr-1"></i>Limit Kuota</span>';
      } else if (acc.status === 'disabled') {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-400"><i class="fa-solid fa-ban text-[10px] mr-1"></i>Disabled</span>';
      } else {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30"><i class="fa-solid fa-circle-xmark text-[10px] mr-1"></i>Error</span>';
      }

      const avatarHtml = acc.avatar_url
        ? `<img src="${escapeAttr(acc.avatar_url)}" alt="${escapeAttr(acc.name)}" class="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0 shadow-sm" onerror="this.outerHTML='<div class=\\'w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white font-bold text-xs shrink-0\\'>${escapeHtml((acc.name || 'A').slice(0, 1))}</div>'"/>`
        : `<div class="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-sm">
             <i class="fa-brands fa-google text-xs"></i>
           </div>`;

      const cliVersionBadge = acc.cli_version
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">v${escapeHtml(acc.cli_version)}</span>`
        : '';

      const modelBadge = acc.model
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">${escapeHtml(acc.model)}</span>`
        : '';

      return `
        <tr class="hover:bg-slate-800/40 transition ${isActive ? 'bg-indigo-950/20' : ''}">
          <td class="px-6 py-3">
            <div class="flex items-center gap-3">
              ${avatarHtml}
              <div class="min-w-0">
                <div class="font-bold text-white flex items-center gap-2 flex-wrap">
                  <span class="truncate">${escapeHtml(acc.name)}</span>
                  ${isActive ? '<span class="px-2 py-0.2 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">AKTIF</span>' : ''}
                  ${cliVersionBadge}
                </div>
                <div class="text-xs text-slate-400 mt-0.5 flex items-center gap-2 font-mono flex-wrap">
                  <span class="flex items-center gap-1 text-slate-300">
                    <i class="fa-regular fa-envelope text-[11px] text-indigo-400"></i>
                    <span>${escapeHtml(acc.email || '(tanpa email)')}</span>
                  </span>
                  ${modelBadge}
                </div>
                ${acc.last_error ? `<div class="text-[11px] text-amber-400/80 mt-1 truncate max-w-xs" title="${escapeAttr(acc.last_error)}">Info: ${escapeHtml(acc.last_error)}</div>` : ''}
              </div>
            </div>
          </td>

          <td class="px-6 py-3 text-center">
            ${isActive ? `
              <span title="Sedang Dipakai" class="inline-flex items-center justify-center p-2 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <i class="fa-solid fa-circle-check text-xs"></i>
              </span>
            ` : `
              <button onclick="activateAgyAccount(${acc.id})" title="Gunakan Akun Ini" class="p-2 rounded-xl bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white border border-slate-700 transition cursor-pointer active:scale-95">
                <i class="fa-solid fa-play text-xs"></i>
              </button>
            `}
          </td>

          <td class="px-6 py-3 text-center">
            ${statusBadge}
          </td>

          <td class="px-6 py-3 text-center">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" ${acc.auto_fallback ? 'checked' : ''} onchange="toggleAgyAccountFallback(${acc.id}, this.checked)" class="sr-only peer">
              <div class="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </td>

          <td class="px-6 py-3 text-xs font-mono text-slate-300">
            ${acc.usage_count || 0}x dipakai
          </td>

          <td class="px-6 py-3 text-xs font-mono text-slate-400">
            ${acc.last_used_at || '-'}
          </td>

          <td class="px-6 py-3 text-right space-x-1.5">
            ${acc.status === 'quota_exceeded' || acc.status === 'error' ? `
              <button onclick="resetAgyAccountStatus(${acc.id})" title="Reset Status Kuota ke Ready" class="p-1.5 rounded-lg bg-slate-800 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-400 border border-slate-700 transition text-xs">
                <i class="fa-solid fa-arrows-rotate"></i>
              </button>
            ` : ''}

            <button onclick="openAgyAccountModal(${acc.id})" title="Edit Akun" class="p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-500/20 text-slate-400 hover:text-indigo-400 border border-slate-700 transition text-xs">
              <i class="fa-solid fa-pen"></i>
            </button>

            ${agyAccountsCache.length > 1 ? `
              <button onclick="deleteAgyAccount(${acc.id})" title="Hapus Akun" class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-slate-700 transition text-xs">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            ` : ''}
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error loading AGY accounts:', err);
  }
}

function openAgyAccountModal(accountId = null) {
  const modalTitle = document.getElementById('agyAccountModalTitle');
  const editId = document.getElementById('agyAccountEditId');
  const nameInput = document.getElementById('agyAccountNameInput');
  const emailInput = document.getElementById('agyAccountEmailInput');
  const tokenInput = document.getElementById('agyAccountTokenInput');
  const fallbackCheck = document.getElementById('agyAccountFallbackCheck');
  const setActiveWrap = document.getElementById('agyAccountSetActiveWrapper');
  const setActiveCheck = document.getElementById('agyAccountSetActiveCheck');
  const errorEl = document.getElementById('agyAccountError');

  errorEl.classList.add('hidden');

  if (accountId) {
    const acc = agyAccountsCache.find(a => a.id === accountId);
    if (!acc) return;
    modalTitle.textContent = 'Edit Akun AGY';
    editId.value = acc.id;
    nameInput.value = acc.name || '';
    emailInput.value = acc.email || '';
    tokenInput.value = '';
    tokenInput.placeholder = '(Biarkan kosong jika tidak ingin mengubah token JSON)';
    tokenInput.required = false;
    fallbackCheck.checked = !!acc.auto_fallback;
    setActiveWrap.classList.add('hidden');
  } else {
    modalTitle.textContent = 'Tambah Akun AGY Baru';
    editId.value = '';
    nameInput.value = '';
    emailInput.value = '';
    tokenInput.value = '';
    tokenInput.placeholder = '{"token":{"access_token":"ya29...","token_type":"Bearer","refresh_token":"1//..."},"auth_method":"consumer"}';
    tokenInput.required = true;
    fallbackCheck.checked = true;
    setActiveWrap.classList.remove('hidden');
    setActiveCheck.checked = false;
  }

  openModal('agyAccountModal');
}

async function handleAgyAccountSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('agyAccountEditId').value;
  const name = document.getElementById('agyAccountNameInput').value.trim();
  const email = document.getElementById('agyAccountEmailInput').value.trim();
  const token_json = document.getElementById('agyAccountTokenInput').value.trim();
  const auto_fallback = document.getElementById('agyAccountFallbackCheck').checked ? 1 : 0;
  const set_active = document.getElementById('agyAccountSetActiveCheck').checked;
  const errorEl = document.getElementById('agyAccountError');
  const btn = document.getElementById('agyAccountSubmitBtn');

  errorEl.classList.add('hidden');

  if (token_json) {
    try {
      JSON.parse(token_json);
    } catch (err) {
      errorEl.textContent = 'Token JSON tidak valid: Pastikan format JSON lengkap dan benar.';
      errorEl.classList.remove('hidden');
      return;
    }
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i><span>Menyimpan...</span>';

  try {
    let res;
    if (editId) {
      const payload = { name, email, auto_fallback };
      if (token_json) payload.token_json = token_json;
      res = await fetch(`${API_URL}/agy/accounts/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_URL}/agy/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ name, email, token_json, auto_fallback, set_active })
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan akun');

    closeModal('agyAccountModal');
    loadAgyAccounts();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Simpan Akun AGY</span>';
  }
}

async function activateAgyAccount(id) {
  const acc = agyAccountsCache.find(a => a.id === id);
  if (!confirm(`Ganti akun AGY aktif ke "${acc?.name || 'akun ini'}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/agy/accounts/${id}/activate`, {
      method: 'POST',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengganti akun');
    loadAgyAccounts();
  } catch (err) {
    alert('Gagal mengganti akun: ' + err.message);
  }
}

async function resetAgyAccountStatus(id) {
  try {
    const res = await fetch(`${API_URL}/agy/accounts/${id}/reset-status`, {
      method: 'POST',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal reset status');
    loadAgyAccounts();
  } catch (err) {
    alert(err.message);
  }
}

async function toggleAgyAccountFallback(id, enabled) {
  try {
    await fetch(`${API_URL}/agy/accounts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ auto_fallback: enabled ? 1 : 0 })
    });
    loadAgyAccounts();
  } catch (err) {
    console.error('Error toggling fallback:', err);
  }
}

async function deleteAgyAccount(id) {
  const acc = agyAccountsCache.find(a => a.id === id);
  if (!confirm(`Hapus akun AGY "${acc?.name || 'ini'}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/agy/accounts/${id}`, {
      method: 'DELETE',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus akun');
    loadAgyAccounts();
  } catch (err) {
    alert(err.message);
  }
}

async function backupCurrentAgyToken() {
  const name = prompt('Beri nama untuk backup token AGY aktif di VPS:', 'Akun VPS Utama');
  if (name === null) return;

  try {
    const res = await fetch(`${API_URL}/agy/accounts/backup-current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ name, email: 'vps@local' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal backup token');
    alert('Token AGY VPS berhasil disimpan ke database!');
    loadAgyAccounts();
  } catch (err) {
    alert(err.message);
  }
}

async function testActiveAgyAccount() {
  const content = document.getElementById('testAgyContent');
  content.innerHTML = '<span class="text-indigo-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Mengirim permintaan uji ke AGY CLI...</span>';
  openModal('testAgyModal');

  try {
    const res = await fetch(`${API_URL}/agy/test`, {
      method: 'POST',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();

    if (data.success) {
      content.innerHTML = `
        <div class="text-emerald-400 font-bold mb-2"><i class="fa-solid fa-circle-check mr-1.5"></i>Uji Respon Berhasil!</div>
        <div class="text-slate-300">Akun: <b class="text-white">${escapeHtml(data.account)}</b></div>
        <div class="text-slate-400 mt-1">Pesan: ${escapeHtml(data.message)}</div>
        <div class="mt-3 p-3 bg-slate-900 rounded-lg border border-slate-800 text-slate-300 font-mono text-xs">
          Output: ${escapeHtml(data.output)}
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="text-rose-400 font-bold mb-2"><i class="fa-solid fa-circle-xmark mr-1.5"></i>Uji Respon Gagal!</div>
        <div class="text-slate-300">Akun: <b class="text-white">${escapeHtml(data.account || 'Unknown')}</b></div>
        <div class="text-rose-300 mt-1">${escapeHtml(data.message || data.error)}</div>
        <div class="mt-3 p-3 bg-rose-950/40 rounded-lg border border-rose-800/40 text-rose-300 font-mono text-xs">
          ${escapeHtml(data.error || 'No output')}
        </div>
      `;
    }
  } catch (err) {
    content.innerHTML = `<span class="text-rose-400"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Error: ${escapeHtml(err.message)}</span>`;
  }
}

async function handleAutoFallbackToggle(e) {
  const enabled = e.target.checked;
  const label = document.getElementById('autoFallbackStatusLabel');
  if (label) {
    label.textContent = enabled ? 'Aktif (Otomatis)' : 'Nonaktif';
    label.className = `text-sm font-bold ${enabled ? 'text-emerald-400' : 'text-slate-400'}`;
  }

  try {
    await fetch(`${API_URL}/agy/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ auto_fallback_enabled: enabled })
    });
  } catch (err) {
    console.error('Error saving fallback setting:', err);
  }
}

// ==================== 1-CLICK GOOGLE OAUTH WIZARD ====================

let currentOAuthSessionId = null;

function openOAuthWizard() {
  currentOAuthSessionId = null;
  const nameInput = document.getElementById('wizardAccountName');
  const emailInput = document.getElementById('wizardAccountEmail');
  const apiKeyInput = document.getElementById('wizardApiKeyInput');
  const setActiveCheck = document.getElementById('wizardSetActiveCheck');
  const error1 = document.getElementById('wizardStep1Error');

  if (error1) error1.classList.add('hidden');

  const nextNum = agyAccountsCache.length + 1;
  if (nameInput) nameInput.value = `Akun Cadangan ${nextNum}`;
  if (emailInput) emailInput.value = '';
  if (apiKeyInput) apiKeyInput.value = '';
  if (setActiveCheck) setActiveCheck.checked = true;

  openModal('agyOAuthWizardModal');
}

async function handleWizardSaveApiKey() {
  const name = document.getElementById('wizardAccountName')?.value.trim() || 'Akun Google';
  const email = document.getElementById('wizardAccountEmail')?.value.trim() || '';
  const apiKey = document.getElementById('wizardApiKeyInput')?.value.trim() || '';
  const setActive = document.getElementById('wizardSetActiveCheck')?.checked || false;
  const errorEl = document.getElementById('wizardStep1Error');
  const btn = document.getElementById('wizardStartBtn');

  if (errorEl) errorEl.classList.add('hidden');

  if (!name) {
    if (errorEl) {
      errorEl.textContent = 'Nama akun wajib diisi';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  if (!apiKey) {
    if (errorEl) {
      errorEl.textContent = 'Google API Key wajib diisi. Silakan klik tombol "Buka Google AI Studio" di atas untuk menyalin API Key gratis Anda.';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i><span>Menghubungkan Akun...</span>';
  }

  try {
    const res = await fetch(`${API_URL}/agy/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({
        name,
        email,
        token_json: apiKey,
        auto_fallback: 1,
        set_active: setActive
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan akun');

    closeModal('agyOAuthWizardModal');
    loadAgyAccounts();
    alert(`✓ Akun Google "${name}" (${email || 'Gemini API'}) berhasil dihubungkan dan berstatus READY!`);
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-circle-check text-sm"></i><span>Simpan & Hubungkan Akun</span>';
    }
  }
}

// ==================== UTILS ====================

// ==================== CLOUDFLARE DEPLOYMENT & TUNNELS ====================

let currentQuickTunnels = [];

function setQuickPort(port, name) {
  const portInput = document.getElementById('quickTunnelPortInput');
  const nameInput = document.getElementById('quickTunnelNameInput');
  if (portInput) portInput.value = port;
  if (nameInput && name) nameInput.value = name;
}

async function loadCloudflareOverview() {
  try {
    const res = await fetch(`${API_URL}/cloudflare/overview`, {
      headers: { ...getAuthHeader() }
    });
    if (!res.ok) throw new Error('Gagal mengambil data Cloudflare');
    const data = await res.json();

    // CLI Version & Binary
    const verEl = document.getElementById('cfCliVersion');
    const pathEl = document.getElementById('cfCliPath');
    const badgeEl = document.getElementById('cfCliBadge');
    if (verEl) verEl.textContent = data.version || 'Tidak terdeteksi';
    if (pathEl) pathEl.textContent = data.binaryPath || '-';
    if (badgeEl) {
      if (data.installed) {
        badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400';
        badgeEl.textContent = 'TERPASANG';
      } else {
        badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400';
        badgeEl.textContent = 'BELUM TERPASANG';
      }
    }

    // Service Daemon
    const svcStatusEl = document.getElementById('cfServiceStatus');
    const svcDotEl = document.getElementById('cfServiceDot');
    const svcNameEl = document.getElementById('cfServiceName');
    const svc = data.service || {};
    if (svcStatusEl) svcStatusEl.textContent = svc.status || 'Unknown';
    if (svcNameEl) svcNameEl.textContent = `Service: ${svc.displayName || svc.name || 'Cloudflared'}`;
    if (svcDotEl) {
      if (svc.status === 'Running') {
        svcDotEl.className = 'h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse';
        if (svcStatusEl) svcStatusEl.className = 'text-base font-bold text-emerald-400';
      } else if (svc.status === 'Stopped') {
        svcDotEl.className = 'h-2.5 w-2.5 rounded-full bg-rose-500';
        if (svcStatusEl) svcStatusEl.className = 'text-base font-bold text-rose-400';
      } else {
        svcDotEl.className = 'h-2.5 w-2.5 rounded-full bg-slate-500';
        if (svcStatusEl) svcStatusEl.className = 'text-base font-bold text-slate-400';
      }
    }

    // Active Quick Tunnels
    currentQuickTunnels = data.quickTunnels || [];
    const countEl = document.getElementById('cfActiveTunnelsCount');
    const runningCount = currentQuickTunnels.filter(t => t.status === 'connected' || t.status === 'starting').length;
    if (countEl) countEl.textContent = runningCount;

    renderQuickTunnels(currentQuickTunnels);

    // Settings config
    const cfg = data.config || {};
    const tokenInput = document.getElementById('cfApiTokenInput');
    const accountInput = document.getElementById('cfAccountIdInput');
    const hintEl = document.getElementById('cfMaskedTokenHint');
    if (accountInput && !accountInput.value && cfg.accountId) {
      accountInput.value = cfg.accountId;
    }
    if (hintEl) {
      if (cfg.hasApiToken) {
        hintEl.innerHTML = `Token tersimpan: <code class="text-indigo-300 font-mono">${cfg.maskedApiToken}</code> (Kosongkan jika tidak ingin mengubah).`;
      } else {
        hintEl.textContent = 'Token disimpan secara terenkripsi di database lokal.';
      }
    }
  } catch (err) {
    console.error('Error loadCloudflareOverview:', err);
  }
}

function renderQuickTunnels(tunnels) {
  const container = document.getElementById('activeQuickTunnelsList');
  if (!container) return;

  const active = (tunnels || []).filter(t => t.status === 'connected' || t.status === 'starting');

  if (active.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500 bg-slate-950/40 rounded-xl border border-slate-800/80 space-y-3">
        <div class="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto border border-amber-500/20">
          <i class="fa-solid fa-bolt text-xl"></i>
        </div>
        <div>
          <h5 class="text-sm font-semibold text-slate-300">Belum ada Quick Tunnel yang aktif</h5>
          <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Publikasikan port aplikasi lokal ke internet secara instan dalam 1 klik.</p>
        </div>
        <button type="button" onclick="openModal('quickTunnelModal')" title="Buka Quick Tunnel" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-amber-400 hover:text-amber-300 rounded-xl border border-slate-700 transition inline-flex items-center justify-center cursor-pointer active:scale-95 shadow-sm">
          <i class="fa-solid fa-plus text-sm"></i>
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = active.map(t => {
    const isConnected = t.status === 'connected';
    const badgeClass = isConnected ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse';
    const badgeText = isConnected ? 'ONLINE' : 'CONNECTING...';
    const isAuto = t.autoPublish !== false;

    return `
      <div class="glass p-4 rounded-xl border border-slate-800 space-y-3">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-md border ${badgeClass} flex items-center gap-1.5">
              <span class="inline-block w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}"></span>
              ${badgeText}
            </span>
            <span class="text-sm font-bold text-white truncate">${escapeHtml(t.name || 'Quick Tunnel')}</span>
            <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-300">Port ${t.port}</span>
            <button onclick="toggleTunnelAutoPublish(${t.port}, ${!isAuto})" class="p-1.5 rounded-lg text-xs font-bold border transition flex items-center justify-center cursor-pointer ${isAuto ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20' : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300'}" title="Auto-Publish: ${isAuto ? 'AKTIF' : 'OFF'} (Klik untuk ubah)">
              <i class="fa-solid fa-bolt text-xs ${isAuto ? 'text-amber-400' : ''}"></i>
            </button>
          </div>

          <div class="flex items-center gap-2 self-end sm:self-center shrink-0">
            <button onclick="handleStopQuickTunnel('${t.id}')" title="Matikan Tunnel" class="p-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/30 rounded-lg text-xs font-semibold transition flex items-center justify-center cursor-pointer active:scale-95">
              <i class="fa-solid fa-power-off text-xs"></i>
            </button>
          </div>
        </div>

        <div class="flex items-center gap-2 text-xs text-slate-400">
          <i class="fa-solid fa-network-wired text-slate-500 text-[11px]"></i>
          <span>Target Lokal:</span>
          <span class="font-mono text-slate-200 font-medium">${escapeHtml(t.targetUrl)}</span>
        </div>

        ${t.url ? `
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-slate-950/70 p-2.5 px-3 rounded-xl border border-amber-500/20">
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <i class="fa-solid fa-globe text-amber-400 text-xs shrink-0"></i>
              <a href="${t.url}" target="_blank" class="font-mono font-bold text-amber-300 hover:text-amber-200 hover:underline text-xs truncate" title="${t.url}">${t.url}</a>
            </div>
            <div class="flex items-center gap-2 self-end sm:self-center shrink-0">
              <button onclick="broadcastTunnelToTelegram(${t.port})" title="Kirim Link ke Telegram Klien" class="p-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 rounded-lg text-xs font-semibold transition flex items-center justify-center cursor-pointer active:scale-95">
                <i class="fa-brands fa-telegram text-xs"></i>
              </button>
              <button onclick="copyToClipboard('${t.url}', this)" title="Salin URL" class="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition flex items-center justify-center cursor-pointer active:scale-95">
                <i class="fa-regular fa-copy text-xs"></i>
              </button>
              <a href="${t.url}" target="_blank" title="Buka Link di Tab Baru" class="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition flex items-center justify-center shadow-sm shadow-indigo-600/30 active:scale-95">
                <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
              </a>
            </div>
          </div>
        ` : `
          <div class="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-400 flex items-center gap-2">
            <i class="fa-solid fa-spinner fa-spin text-xs"></i>
            <span>Sedang menghubungkan ke Cloudflare Edge Network... Mohon tunggu beberapa detik.</span>
          </div>
        `}
      </div>
    `;
  }).join('');
}

// ==================== 1-CLICK QUICK TUNNEL SELECTOR & HELPERS ====================

async function openQuickTunnelModal(targetPort = null, targetName = null) {
  const alertEl = document.getElementById('quickTunnelAlert');
  if (alertEl) alertEl.classList.add('hidden');

  try {
    if (!clientAppsCache || !clientAppsCache.length) {
      const res = await fetch(`${API_URL}/client-apps`, { headers: getAuthHeader() });
      const data = await res.json();
      clientAppsCache = data.apps || [];
    }
  } catch (_) {}

  await populateQuickTunnelAppOptions(targetPort, targetName);
  openModal('quickTunnelModal');
}

async function populateQuickTunnelAppOptions(targetPort = null, targetName = null) {
  const selectEl = document.getElementById('quickTunnelAppSelect');
  const gridEl = document.getElementById('quickTunnelUntunneledGrid');
  const portInput = document.getElementById('quickTunnelPortInput');
  const nameInput = document.getElementById('quickTunnelNameInput');

  // Find active quick tunnel ports
  const activePorts = new Set((cloudflareDataCache?.quick_tunnels || []).filter(t => t.status === 'connected').map(t => t.port));

  // Combine clientAppsCache with PM2 services from metrics
  let pm2List = [];
  try {
    if (vpsMetricsCache?.pm2) {
      pm2List = vpsMetricsCache.pm2;
    } else {
      const res = await fetch(`${API_URL}/vps/metrics`, { headers: getAuthHeader() });
      const data = await res.json();
      pm2List = data.pm2 || [];
    }
  } catch (_) {}

  const combinedApps = [...(clientAppsCache || [])];

  // Merge any standalone PM2 services
  pm2List.forEach(pm => {
    if (!combinedApps.some(a => a.pm2_service_name === pm.name)) {
      const defaultPort = pm.name === 'quorra-learning-space' ? 5000 : (pm.name === 'pakarti-riken-report' ? 8562 : (pm.name === 'agy-telegram-bot' ? 8080 : 5678));
      combinedApps.push({
        id: `pm2_${pm.name}`,
        name: pm.name.toUpperCase(),
        internal_port: defaultPort,
        pm2_service_name: pm.name,
        client_name: 'PM2 Service',
        icon: 'fa-cube'
      });
    }
  });

  // Gather untunneled apps
  const untunneledApps = combinedApps.filter(app => !activePorts.has(app.internal_port));

  if (selectEl) {
    let optionsHtml = '<option value="">-- Pilih Aplikasi / Service Terdaftar --</option>';
    untunneledApps.forEach(app => {
      const pm2Label = app.pm2_service_name ? `[PM2: ${app.pm2_service_name}]` : '[Standalone]';
      optionsHtml += `<option value="${app.id}" data-port="${app.internal_port}" data-name="${escapeAttr(app.name)}">${escapeHtml(app.name)} (Port ${app.internal_port}) ${pm2Label}</option>`;
    });
    optionsHtml += '<option value="custom">⚙️ Input Port Kustom Secara Manual</option>';
    selectEl.innerHTML = optionsHtml;
  }

  if (gridEl) {
    if (!untunneledApps.length) {
      gridEl.innerHTML = `
        <div class="col-span-full p-3 text-center text-xs text-slate-500 bg-slate-900/50 rounded-xl border border-slate-800">
          Semua aplikasi terdaftar sudah memiliki tunnel aktif. Anda dapat menginput port kustom manual di bawah.
        </div>
      `;
    } else {
      gridEl.innerHTML = untunneledApps.map(app => {
        const icon = app.icon || 'fa-rocket';
        const pm2Label = app.pm2_service_name ? `PM2: ${app.pm2_service_name}` : 'Standalone';
        const isSelected = targetPort && targetPort === app.internal_port;
        return `
          <button type="button" onclick="setQuickPort(${app.internal_port}, '${escapeAttr(app.name)}', '${escapeAttr(app.id)}')" class="quick-app-card p-2.5 rounded-xl text-left transition flex items-center gap-2.5 border ${isSelected ? 'bg-amber-500/20 border-amber-500/50 text-white shadow-md' : 'bg-slate-900/80 hover:bg-slate-800 border-slate-800 hover:border-amber-500/40 text-slate-300'} group cursor-pointer active:scale-95">
            <div class="w-8 h-8 rounded-lg bg-slate-800 text-amber-400 flex items-center justify-center shrink-0 border border-slate-700">
              <i class="fa-solid ${escapeAttr(icon)} text-xs"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold text-slate-200 group-hover:text-white truncate">${escapeHtml(app.name)}</div>
              <div class="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono mt-0.5">
                <span class="text-amber-400 font-bold">Port ${app.internal_port}</span>
                <span>•</span>
                <span class="text-slate-400 truncate">${pm2Label}</span>
              </div>
            </div>
          </button>
        `;
      }).join('');
    }
  }

  // Pre-fill
  if (targetPort) {
    setQuickPort(targetPort, targetName || `App Port ${targetPort}`);
  } else if (untunneledApps.length > 0) {
    setQuickPort(untunneledApps[0].internal_port, untunneledApps[0].name, untunneledApps[0].id);
  } else {
    if (portInput) portInput.value = '8562';
    if (nameInput) nameInput.value = 'Web Application';
  }
}

function onQuickTunnelAppSelected(appId) {
  if (!appId || appId === 'custom') {
    const portInput = document.getElementById('quickTunnelPortInput');
    const nameInput = document.getElementById('quickTunnelNameInput');
    if (portInput) portInput.value = '';
    if (nameInput) nameInput.value = '';
    return;
  }
  const app = (clientAppsCache || []).find(a => String(a.id) === String(appId));
  if (app) {
    setQuickPort(app.internal_port, app.name, app.id);
  }
}

function setQuickPort(port, name, appId = null) {
  const portInput = document.getElementById('quickTunnelPortInput');
  const nameInput = document.getElementById('quickTunnelNameInput');
  const selectEl = document.getElementById('quickTunnelAppSelect');

  if (portInput) portInput.value = port;
  if (nameInput) nameInput.value = name;

  if (selectEl) {
    if (appId) selectEl.value = appId;
    else {
      const match = (clientAppsCache || []).find(a => a.internal_port === port);
      if (match) selectEl.value = match.id;
      else selectEl.value = 'custom';
    }
  }

  // Highlight active button
  document.querySelectorAll('.quick-app-card').forEach(card => {
    if (card.getAttribute('onclick')?.includes(`setQuickPort(${port}`)) {
      card.className = 'quick-app-card p-2.5 rounded-xl text-left transition flex items-center gap-2.5 border bg-amber-500/20 border-amber-500/50 text-white shadow-md group cursor-pointer active:scale-95';
    } else {
      card.className = 'quick-app-card p-2.5 rounded-xl text-left transition flex items-center gap-2.5 border bg-slate-900/80 hover:bg-slate-800 border-slate-800 hover:border-amber-500/40 text-slate-300 group cursor-pointer active:scale-95';
    }
  });
}

async function toggleTunnelAutoPublish(port, autoPublish) {
  try {
    const res = await fetch(`${API_URL}/cloudflare/quicktunnel/toggle-auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ port: parseInt(port, 10), auto_publish: autoPublish })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengubah pengaturan');
    loadCloudflareOverview();
  } catch (err) {
    alert(err.message);
  }
}

async function handleStartQuickTunnel(e) {
  e.preventDefault();
  const port = document.getElementById('quickTunnelPortInput').value;
  const name = document.getElementById('quickTunnelNameInput').value;
  const autoPublish = document.getElementById('quickTunnelAutoPublish')?.checked ?? true;
  const btn = document.getElementById('startQuickTunnelBtn');
  const alertEl = document.getElementById('quickTunnelAlert');

  if (alertEl) alertEl.classList.add('hidden');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Menghubungkan...</span>';
  }

  try {
    const res = await fetch(`${API_URL}/cloudflare/quicktunnel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ port: parseInt(port, 10), name, auto_publish: autoPublish })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memulai tunnel');

    if (alertEl) {
      alertEl.className = 'p-3 bg-emerald-500/15 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center justify-between gap-3';
      alertEl.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <i class="fa-solid fa-circle-check text-emerald-400 text-sm shrink-0"></i>
          <div class="truncate">
            <span class="font-bold">Tunnel Berhasil Aktif:</span>
            <a href="${data.tunnel.url}" target="_blank" class="underline font-mono text-amber-300 ml-1 hover:text-amber-200">${data.tunnel.url}</a>
          </div>
        </div>
      `;
      alertEl.classList.remove('hidden');
    }

    if (data.tunnel?.url) {
      navigator.clipboard.writeText(data.tunnel.url).catch(() => {});
    }

    // Close modal after brief moment and refresh overview
    setTimeout(() => {
      closeModal('quickTunnelModal');
      if (alertEl) alertEl.classList.add('hidden');
    }, 1200);

    loadCloudflareOverview();
  } catch (err) {
    if (alertEl) {
      alertEl.className = 'p-3 bg-rose-500/15 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-center justify-between gap-3';
      alertEl.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <i class="fa-solid fa-circle-exclamation text-rose-400 text-sm shrink-0"></i>
          <span>${escapeHtml(err.message)}</span>
        </div>
        <button type="button" onclick="this.parentElement.classList.add('hidden')" class="text-slate-400 hover:text-white p-1 cursor-pointer">
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      `;
      alertEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-play"></i><span>Publish ke Internet Sekarang</span>';
    }
  }
}

async function handleStopQuickTunnel(id) {
  if (!confirm('Apakah Anda yakin ingin mematikan tunnel ini?')) return;
  try {
    const res = await fetch(`${API_URL}/cloudflare/quicktunnel/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mematikan tunnel');
    loadCloudflareOverview();
  } catch (err) {
    alert(err.message);
  }
}

async function handleStopAllQuickTunnels() {
  if (!confirm('Matikan semua Quick Tunnel yang sedang aktif?')) return;
  try {
    const res = await fetch(`${API_URL}/cloudflare/quicktunnel/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ all: true })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mematikan semua tunnel');
    loadCloudflareOverview();
  } catch (err) {
    alert(err.message);
  }
}

async function handleServiceAction(action) {
  const actionNames = { restart: 'me-restart', stop: 'mematikan', start: 'menjalankan' };
  if (!confirm(`Apakah Anda yakin ingin ${actionNames[action] || action} service Cloudflared?`)) return;

  try {
    const res = await fetch(`${API_URL}/cloudflare/service/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengeksekusi service action');
    alert(data.message || `Service berhasil di-${action}`);
    loadCloudflareOverview();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function handleSaveCfSettings(e) {
  e.preventDefault();
  const apiToken = document.getElementById('cfApiTokenInput').value;
  const accountId = document.getElementById('cfAccountIdInput').value;
  const alertEl = document.getElementById('cfSettingsAlert');

  try {
    const res = await fetch(`${API_URL}/cloudflare/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ apiToken, accountId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan pengaturan');

    if (alertEl) {
      alertEl.className = 'p-3 bg-emerald-500/15 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2';
      alertEl.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i><span>Pengaturan Cloudflare berhasil disimpan!</span>';
      alertEl.classList.remove('hidden');
    }
    loadCloudflareOverview();
    setTimeout(() => {
      closeModal('cfSettingsModal');
      if (alertEl) alertEl.classList.add('hidden');
    }, 1200);
  } catch (err) {
    if (alertEl) {
      alertEl.className = 'p-3 bg-rose-500/15 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-center gap-2';
      alertEl.innerHTML = `<i class="fa-solid fa-circle-exclamation text-rose-400"></i><span>${escapeHtml(err.message)}</span>`;
      alertEl.classList.remove('hidden');
    }
  }
}

async function handleVerifyCfToken() {
  const apiToken = document.getElementById('cfApiTokenInput').value;
  const alertEl = document.getElementById('cfSettingsAlert');

  if (alertEl) {
    alertEl.className = 'p-3.5 bg-slate-800 border border-slate-700 rounded-xl text-xs text-slate-300 flex items-center gap-2';
    alertEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Memverifikasi token ke Cloudflare API...</span>';
    alertEl.classList.remove('hidden');
  }

  try {
    const res = await fetch(`${API_URL}/cloudflare/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ apiToken: apiToken || undefined })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Token tidak valid');

    if (alertEl) {
      alertEl.className = 'p-3.5 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-xs text-emerald-300';
      alertEl.textContent = `✓ ${data.message} (Status: ${data.details?.status || 'Active'})`;
      alertEl.classList.remove('hidden');
    }
  } catch (err) {
    if (alertEl) {
      alertEl.className = 'p-3.5 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.textContent = 'Gagal verifikasi: ' + err.message;
      alertEl.classList.remove('hidden');
    }
  }
}

function copyToClipboard(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnEl) {
      const origHtml = btnEl.innerHTML;
      btnEl.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i><span>Tersalin!</span>';
      setTimeout(() => {
        btnEl.innerHTML = origHtml;
      }, 2000);
    }
  }).catch(() => {
    alert('URL: ' + text);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ==================== AI ORCHESTRATOR & MISSION CONTROL ====================

let orchestratorSessions = [];
let currentOrchestratorSessionId = null;
let currentOrchestratorView = 'kanban'; // 'kanban' | 'trajectory'
let orchestratorKanbanFilterSessionId = null; // null = all sessions
let cachedOrchestratorKanban = null;

async function loadOrchestratorData() {
  try {
    const [sessRes, kanbanRes] = await Promise.all([
      fetch(`${API_URL}/orchestrator/sessions`, { headers: getAuthHeader() }),
      fetch(`${API_URL}/orchestrator/kanban`, { headers: getAuthHeader() })
    ]);

    if (sessRes.ok) {
      const sessData = await sessRes.json();
      orchestratorSessions = sessData.sessions || [];
      populateOrchestratorSessionSelect();
      renderOrchestratorSessionPills();
      if (taskFilterMode === 'session') {
        loadSessionFilterPills();
      }
    }

    if (kanbanRes.ok) {
      const kanban = await kanbanRes.json();
      cachedOrchestratorKanban = kanban;
      renderOrchestratorKanban(kanban);
    }

    if (currentOrchestratorSessionId) {
      loadOrchestratorSessionTranscript(currentOrchestratorSessionId);
    } else if (orchestratorSessions.length > 0) {
      currentOrchestratorSessionId = orchestratorSessions[0].id;
      const select = document.getElementById('orchestratorSessionSelect');
      if (select) select.value = currentOrchestratorSessionId;
      loadOrchestratorSessionTranscript(currentOrchestratorSessionId);
    }
  } catch (err) {
    console.error('Error loading orchestrator data:', err);
  }
}

function renderOrchestratorSessionPills() {
  const container = document.getElementById('orchSessionPillsContainer');
  if (!container) return;

  const sessions = orchestratorSessions || [];
  if (sessions.length === 0) {
    container.innerHTML = '<span class="text-xs text-slate-500 py-1 font-medium">Tidak ada sesi CLI terdeteksi</span>';
    return;
  }

  let html = `
    <button onclick="filterOrchestratorKanbanBySession(null)" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${orchestratorKanbanFilterSessionId === null ? 'bg-purple-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}">
      <i class="fa-solid fa-layer-group text-[10px]"></i>
      <span>Semua Sesi (${sessions.length})</span>
    </button>
  `;

  html += sessions.map(s => {
    const isSelected = orchestratorKanbanFilterSessionId === s.id;
    const isLive = s.status === 'running';
    const liveDot = isLive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>' : '';
    const statusIcon = isLive ? '🟢' : (s.status === 'paused' ? '⏸️' : (s.status === 'stopped' ? '🛑' : '✅'));
    const label = s.title ? s.title.slice(0, 32) : `Sesi ${s.id.slice(0, 8)}`;

    return `
      <button onclick="filterOrchestratorKanbanBySession('${s.id}')" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition flex items-center gap-2 ${isSelected ? 'bg-purple-600 text-white shadow-md ring-1 ring-purple-400/50' : 'bg-slate-800/90 text-slate-300 hover:text-white border border-slate-700/60'}">
        ${liveDot}
        <span>${statusIcon}</span>
        <span class="truncate max-w-[200px]">${escapeHtml(label)}</span>
        <span class="px-1.5 py-0.2 rounded bg-slate-900/80 text-[10px] font-mono text-purple-300 font-bold">${s.stepsCount || 0} steps</span>
      </button>
    `;
  }).join('');

  container.innerHTML = html;
}

function filterOrchestratorKanbanBySession(sessionId) {
  orchestratorKanbanFilterSessionId = sessionId;
  renderOrchestratorSessionPills();
  if (sessionId) {
    currentOrchestratorSessionId = sessionId;
    const select = document.getElementById('orchestratorSessionSelect');
    if (select) select.value = sessionId;
    if (currentOrchestratorView === 'trajectory') {
      loadOrchestratorSessionTranscript(sessionId);
    }
  }
  if (cachedOrchestratorKanban) {
    renderOrchestratorKanban(cachedOrchestratorKanban);
  }
}

function populateOrchestratorSessionSelect() {
  const select = document.getElementById('orchestratorSessionSelect');
  if (!select) return;

  if (orchestratorSessions.length === 0) {
    select.innerHTML = '<option value="">Tidak ada sesi CLI terdeteksi</option>';
    return;
  }

  const prevVal = currentOrchestratorSessionId || select.value;
  select.innerHTML = orchestratorSessions.map((s, idx) => {
    const isLive = s.status === 'running';
    const badge = isLive ? '🟢 LIVE' : (s.status === 'paused' ? '⏸️ PAUSED' : (s.status === 'stopped' ? '🛑 STOPPED' : '✅ SELESAI'));
    const label = `${badge} | ${s.title ? s.title.slice(0, 40) : s.id.slice(0, 8)} (${s.stepsCount} steps)`;
    const isSelected = (prevVal && s.id === prevVal) || (!prevVal && idx === 0);
    return `<option value="${s.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');

  if (!currentOrchestratorSessionId && orchestratorSessions.length > 0) {
    currentOrchestratorSessionId = select.value || orchestratorSessions[0].id;
  }
}

function onOrchestratorSessionChange(sessionId) {
  currentOrchestratorSessionId = sessionId;
  if (sessionId) {
    loadOrchestratorSessionTranscript(sessionId);
  }
}

function switchOrchestratorView(view) {
  currentOrchestratorView = view;
  const kanbanView = document.getElementById('orchestratorKanbanView');
  const trajectoryView = document.getElementById('orchestratorTrajectoryView');
  const kanbanBtn = document.getElementById('orchViewKanbanBtn');
  const trajectoryBtn = document.getElementById('orchViewTrajectoryBtn');

  if (view === 'kanban') {
    if (kanbanView) kanbanView.classList.remove('hidden');
    if (trajectoryView) trajectoryView.classList.add('hidden');
    if (kanbanBtn) kanbanBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow';
    if (trajectoryBtn) trajectoryBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 text-slate-400 hover:text-white';
  } else {
    if (kanbanView) kanbanView.classList.add('hidden');
    if (trajectoryView) trajectoryView.classList.remove('hidden');
    if (trajectoryBtn) trajectoryBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow';
    if (kanbanBtn) kanbanBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 text-slate-400 hover:text-white';
    if (currentOrchestratorSessionId) {
      loadOrchestratorSessionTranscript(currentOrchestratorSessionId);
    }
  }
}

function renderOrchestratorKanban(kanban) {
  if (!kanban) return;

  const cols = {
    todo: document.getElementById('orchColTodo'),
    in_progress: document.getElementById('orchColInProgress'),
    paused: document.getElementById('orchColPaused'),
    completed: document.getElementById('orchColCompleted')
  };

  const counts = {
    todo: document.getElementById('orchCountTodo'),
    in_progress: document.getElementById('orchCountInProgress'),
    paused: document.getElementById('orchCountPaused'),
    completed: document.getElementById('orchCountCompleted')
  };

  const filterCards = (cards) => {
    if (!cards) return [];
    if (!orchestratorKanbanFilterSessionId) return cards;
    return cards.filter(c => c.id === orchestratorKanbanFilterSessionId || c.sessionId === orchestratorKanbanFilterSessionId);
  };

  const todoList = filterCards(kanban.todo || []);
  const inProgList = filterCards(kanban.in_progress || []);
  const pausedList = filterCards(kanban.paused || []);
  const compList = filterCards(kanban.completed || []);

  if (counts.todo) counts.todo.textContent = todoList.length;
  if (counts.in_progress) counts.in_progress.textContent = inProgList.length;
  if (counts.paused) counts.paused.textContent = pausedList.length;
  if (counts.completed) counts.completed.textContent = compList.length;

  const renderCard = (c) => {
    const isHigh = c.priority === 'high';
    const isMed = c.priority === 'medium';
    const prioBadge = isHigh
      ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">HIGH</span>'
      : (isMed ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">MEDIUM</span>' : '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-slate-800 text-slate-400">LOW</span>');

    const sourceBadge = c.source === 'cli_session'
      ? '<span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-purple-500/15 text-purple-300 border border-purple-500/20"><i class="fa-solid fa-terminal text-[8px] mr-1"></i>CLI SESI</span>'
      : `<span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/20"><i class="fa-solid fa-folder-tree text-[8px] mr-1"></i>${escapeHtml(c.projectName || 'PROJECT')}</span>`;

    const activeToolBadge = c.activeTool ? `<span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-amber-300 truncate max-w-[140px]"><i class="fa-solid fa-wrench text-[9px] mr-1"></i>${escapeHtml(c.activeTool)}</span>` : '';

    return `
      <div class="glass p-3.5 rounded-xl border border-slate-800 hover:border-slate-700 transition space-y-2.5 shadow-sm">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-1.5">
            ${sourceBadge}
            ${prioBadge}
          </div>
          <span class="text-[10px] text-slate-500 font-mono">${c.stepsCount ? `${c.stepsCount} steps` : ''}</span>
        </div>

        <div>
          <h4 class="text-xs font-bold text-white line-clamp-2">${escapeHtml(c.title || 'Task Sesi')}</h4>
          <p class="text-[11px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">${escapeHtml(c.description || '-')}</p>
        </div>

        <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 gap-2">
          ${activeToolBadge || '<span class="text-[10px] text-slate-500 font-mono">Standby</span>'}

          <div class="flex items-center gap-1 shrink-0">
            ${c.source === 'cli_session' ? `
              <button onclick="inspectSessionTrajectory('${c.id}')" title="Buka Live Trajectory" class="p-1.5 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-purple-300 text-xs border border-slate-800 hover:border-purple-500/40 transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-eye text-[11px]"></i>
              </button>
              <button onclick="setSessionPriority('${isHigh ? 'medium' : 'high'}', '${c.id}')" title="Ubah Prioritas" class="p-1.5 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 ${isHigh ? 'text-amber-400' : 'text-slate-400 hover:text-amber-300'} text-xs border border-slate-800 transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-bolt text-[11px]"></i>
              </button>
              <button onclick="toggleSessionPause('${c.id}')" title="Pause / Resume" class="p-1.5 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs border border-slate-800 transition active:scale-95 cursor-pointer">
                <i class="fa-solid ${c.status === 'paused' ? 'fa-play text-emerald-400' : 'fa-pause text-amber-400'} text-[11px]"></i>
              </button>
              <button onclick="killActiveSession('${c.id}')" title="Hentikan / Kill" class="p-1.5 px-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs border border-rose-500/20 transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-stop text-[11px]"></i>
              </button>
            ` : `
              <button onclick="switchTab('projects')" title="Buka Task di Project Manager" class="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-indigo-300 border border-slate-800 transition cursor-pointer flex items-center justify-center active:scale-95">
                <i class="fa-solid fa-list-check text-xs"></i>
              </button>
            `}
          </div>
        </div>
      </div>
    `;
  };

  if (cols.todo) {
    cols.todo.innerHTML = (kanban.todo && kanban.todo.length > 0)
      ? kanban.todo.map(renderCard).join('')
      : '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada antrean tugas</div>';
  }

  if (cols.in_progress) {
    cols.in_progress.innerHTML = (kanban.in_progress && kanban.in_progress.length > 0)
      ? kanban.in_progress.map(renderCard).join('')
      : '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task yang sedang berjalan</div>';
  }

  if (cols.paused) {
    cols.paused.innerHTML = (kanban.paused && kanban.paused.length > 0)
      ? kanban.paused.map(renderCard).join('')
      : '<div class="p-6 text-center text-slate-600 text-xs">Tidak ada task yang di-pause</div>';
  }

  if (cols.completed) {
    cols.completed.innerHTML = (kanban.completed && kanban.completed.length > 0)
      ? kanban.completed.slice(0, 12).map(renderCard).join('')
      : '<div class="p-6 text-center text-slate-600 text-xs">Belum ada riwayat selesai</div>';
  }
}

async function loadOrchestratorSessionTranscript(sessionId) {
  if (!sessionId) return;
  const feed = document.getElementById('orchStepsFeed');
  if (!feed) return;

  try {
    const res = await fetch(`${API_URL}/orchestrator/sessions/${sessionId}`, { headers: getAuthHeader() });
    if (!res.ok) throw new Error('Gagal mengambil transcript sesi');
    const data = await res.json();
    const session = data.session;
    const steps = data.steps || [];

    // Update session info header & telemetry metrics
    const titleEl = document.getElementById('orchSessionTitle');
    const idTag = document.getElementById('orchSessionIdTag');
    const timeTag = document.getElementById('orchSessionUpdatedTag');
    const metricStatus = document.getElementById('orchMetricStatus');
    const metricPriority = document.getElementById('orchMetricPriority');
    const metricAccount = document.getElementById('orchMetricAccount');
    const metricTokens = document.getElementById('orchMetricTokens');
    const metricTokenPct = document.getElementById('orchMetricTokenPct');
    const metricTokenBar = document.getElementById('orchMetricTokenBar');
    const metricTokenDetails = document.getElementById('orchMetricTokenDetails');
    const metricQuota = document.getElementById('orchMetricQuota');
    const metricFallbackBadge = document.getElementById('orchMetricFallbackBadge');
    const metricUsageCount = document.getElementById('orchMetricUsageCount');
    const metricTool = document.getElementById('orchMetricTool');
    const metricSteps = document.getElementById('orchMetricSteps');
    const metricModel = document.getElementById('orchMetricModel');
    const pauseBtn = document.getElementById('orchPauseBtn');

    if (titleEl && session) titleEl.textContent = session.title || `Sesi ${session.id.slice(0, 8)}`;
    if (idTag && session) idTag.textContent = `ID: ${session.id.slice(0, 12)}...`;
    if (timeTag && session) timeTag.textContent = new Date(session.lastActiveAt).toLocaleTimeString();
    
    if (metricStatus && session) {
      const isOnline = session.status === 'running';
      metricStatus.className = isOnline ? 'px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono' : 'px-2 py-0.5 rounded text-xs font-bold bg-slate-800 text-slate-400 font-mono';
      metricStatus.textContent = session.status.toUpperCase();
    }

    if (metricPriority && session) {
      metricPriority.textContent = `${(session.priority || 'medium').toUpperCase()}`;
    }

    if (metricAccount && session) {
      metricAccount.textContent = session.account?.name || 'Akun Utama (Local Disk)';
    }

    // Token Telemetry
    if (session && session.tokens) {
      const t = session.tokens;
      if (metricTokens) metricTokens.textContent = t.totalFormatted ? `${t.totalFormatted} Tokens` : `${t.totalTokens} Tokens`;
      if (metricTokenPct) metricTokenPct.textContent = `${t.contextUsagePercent}%`;
      if (metricTokenBar) metricTokenBar.style.width = `${Math.min(100, Math.max(2, t.contextUsagePercent))}%`;
      if (metricTokenDetails) {
        metricTokenDetails.textContent = `In: ${t.inputTokens >= 1000 ? (t.inputTokens/1000).toFixed(1) + 'K' : t.inputTokens} | Out: ${t.outputTokens >= 1000 ? (t.outputTokens/1000).toFixed(1) + 'K' : t.outputTokens} | Tool: ${t.toolTokens >= 1000 ? (t.toolTokens/1000).toFixed(1) + 'K' : t.toolTokens}`;
      }
    }

    // Account Quota Telemetry
    if (session && session.account) {
      const acc = session.account;
      if (metricQuota) {
        const isQuotaOk = !acc.isQuotaExceeded;
        metricQuota.className = isQuotaOk
          ? 'px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono flex items-center gap-1'
          : 'px-2 py-0.5 rounded text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono flex items-center gap-1';
        metricQuota.innerHTML = isQuotaOk 
          ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>100% SIAP</span>' 
          : '<span class="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping"></span><span>KUOTA HABIS</span>';
      }
      if (metricFallbackBadge) {
        metricFallbackBadge.textContent = acc.autoFallback ? 'FALLBACK ON' : 'FALLBACK OFF';
        metricFallbackBadge.className = acc.autoFallback
          ? 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono'
          : 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 font-mono';
      }
      if (metricUsageCount) {
        metricUsageCount.textContent = `Total Panggilan: ${acc.usageCount || steps.length} queries`;
      }
    }

    if (metricTool && session) {
      metricTool.textContent = session.activeTool || 'Standby';
    }
    if (metricSteps) {
      metricSteps.textContent = `${steps.length} Langkah / Steps`;
    }
    if (metricModel && session) {
      metricModel.textContent = session.model || 'Gemini 3.7 Flash';
    }
    if (pauseBtn && session) {
      const isPaused = session.status === 'paused';
      pauseBtn.innerHTML = `<i class="fa-solid ${isPaused ? 'fa-play text-emerald-400' : 'fa-pause text-amber-400'} text-xs"></i><span>${isPaused ? 'Resume' : 'Pause'}</span>`;
    }

    if (steps.length === 0) {
      feed.innerHTML = `
        <div class="p-8 text-center text-slate-500 glass rounded-2xl border border-slate-800">
          <i class="fa-solid fa-terminal text-2xl mb-2 text-slate-600"></i>
          <p class="text-xs">Belum ada langkah atau aktivitas yang tercatat pada sesi ini.</p>
        </div>
      `;
      return;
    }

    feed.innerHTML = steps.map(s => renderStepCard(s)).join('');
  } catch (err) {
    console.error('Error loading session transcript:', err);
  }
}

function renderStepCard(step) {
  const timeStr = step.created_at ? new Date(step.created_at).toLocaleTimeString() : '';

  // 1. USER INPUT
  if (step.type === 'USER_INPUT') {
    return `
      <div class="glass p-4 rounded-2xl border border-indigo-500/30 bg-indigo-950/20 space-y-2">
        <div class="flex items-center justify-between text-xs text-indigo-300">
          <span class="font-bold flex items-center gap-2">
            <i class="fa-solid fa-circle-user text-sm text-indigo-400"></i>
            <span>User Prompt & Request</span>
          </span>
          <span class="font-mono text-[10px] text-slate-400">${timeStr} • Step #${step.step_index}</span>
        </div>
        <div class="text-xs text-slate-200 font-medium whitespace-pre-wrap leading-relaxed">${escapeHtml(step.content)}</div>
      </div>
    `;
  }

  // 2. MODEL PLANNER RESPONSE (THINKING + TOOL CALLS + CONTENT)
  let thinkingHtml = '';
  if (step.thinking) {
    thinkingHtml = `
      <details class="glass rounded-xl border border-purple-500/30 bg-purple-950/20 group overflow-hidden">
        <summary class="p-3 cursor-pointer flex items-center justify-between text-xs font-bold text-purple-300 select-none hover:bg-purple-900/20 transition">
          <div class="flex items-center gap-2">
            <i class="fa-solid fa-brain text-purple-400"></i>
            <span>Proses Berpikir & Chain of Thought</span>
          </div>
          <span class="text-[10px] font-mono text-purple-400 group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <div class="p-3.5 pt-0 border-t border-purple-500/20 text-xs text-slate-300 leading-relaxed font-sans whitespace-pre-wrap">
          ${escapeHtml(step.thinking)}
        </div>
      </details>
    `;
  }

  let toolCallsHtml = '';
  if (step.tool_calls && step.tool_calls.length > 0) {
    toolCallsHtml = step.tool_calls.map(tc => {
      let argsPreview = '';
      if (tc.args) {
        if (typeof tc.args === 'string') {
          argsPreview = tc.args.slice(0, 180);
        } else if (tc.args.CommandLine) {
          argsPreview = `CommandLine: ${tc.args.CommandLine}`;
        } else if (tc.args.TargetFile) {
          argsPreview = `TargetFile: ${tc.args.TargetFile}`;
        } else if (tc.args.Query) {
          argsPreview = `Query: ${tc.args.Query}`;
        } else {
          argsPreview = JSON.stringify(tc.args).slice(0, 180);
        }
      }

      const rawJsonString = JSON.stringify(tc.args || {}, null, 2);

      return `
        <div class="glass p-3.5 rounded-xl border border-amber-500/30 bg-amber-950/10 space-y-2">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1 shrink-0">
                <i class="fa-solid fa-screwdriver-wrench text-[9px]"></i>
                <span>${escapeHtml(tc.name)}</span>
              </span>
              <span class="text-xs font-semibold text-slate-200 truncate">${escapeHtml(tc.summary || tc.action || 'Tool Execution')}</span>
            </div>
            <button type="button" onclick="showOrchestratorPayloadModal('${escapeAttr(tc.name)}', '${escapeAttr(tc.summary || tc.action)}', \`${escapeAttr(rawJsonString)}\`)" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-[10px] text-amber-300 font-bold border border-slate-700 transition flex items-center gap-1 cursor-pointer active:scale-95 shrink-0">
              <i class="fa-solid fa-eye text-[9px]"></i>
              <span>Payload</span>
            </button>
          </div>
          ${argsPreview ? `<div class="p-2 rounded-lg bg-slate-950 border border-slate-800/80 font-mono text-[11px] text-amber-200/90 truncate">${escapeHtml(argsPreview)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  let contentHtml = '';
  if (step.content) {
    contentHtml = `
      <div class="glass p-4 rounded-2xl border border-slate-800 bg-slate-950/40 space-y-2">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span class="font-bold flex items-center gap-2 text-indigo-300">
            <i class="fa-solid fa-robot text-sm text-indigo-400"></i>
            <span>Respons Asisten AGY</span>
          </span>
          <span class="font-mono text-[10px] text-slate-500">${timeStr} • Step #${step.step_index}</span>
        </div>
        <div class="prose prose-invert max-w-none text-xs text-slate-200 leading-relaxed">
          ${renderChatMarkdown(step.content)}
        </div>
      </div>
    `;
  }

  return `
    <div class="space-y-2.5">
      ${thinkingHtml}
      ${toolCallsHtml}
      ${contentHtml}
    </div>
  `;
}

function showOrchestratorPayloadModal(title, subtitle, jsonStr) {
  const modal = document.getElementById('orchDetailModal');
  const titleEl = document.getElementById('orchDetailTitle');
  const subEl = document.getElementById('orchDetailSubtitle');
  const contentEl = document.getElementById('orchDetailContent');

  if (titleEl) titleEl.textContent = `Tool: ${title}`;
  if (subEl) subEl.textContent = subtitle || 'Parameter & Payload';
  if (contentEl) contentEl.textContent = jsonStr;

  openModal('orchDetailModal');
}

function inspectSessionTrajectory(sessionId) {
  currentOrchestratorSessionId = sessionId;
  const select = document.getElementById('orchestratorSessionSelect');
  if (select) select.value = sessionId;
  switchOrchestratorView('trajectory');
}

async function setSessionPriority(priority, targetSessionId) {
  const sessId = targetSessionId || currentOrchestratorSessionId;
  if (!sessId) return;

  try {
    const res = await fetch(`${API_URL}/orchestrator/sessions/${sessId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ action: 'priority', payload: { priority } })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengubah prioritas');
    loadOrchestratorData();
  } catch (err) {
    alert(err.message);
  }
}

async function toggleSessionPause(targetSessionId) {
  const sessId = targetSessionId || currentOrchestratorSessionId;
  if (!sessId) return;

  const current = orchestratorSessions.find(s => s.id === sessId);
  const isPaused = current?.status === 'paused';
  const action = isPaused ? 'resume' : 'pause';

  try {
    const res = await fetch(`${API_URL}/orchestrator/sessions/${sessId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Gagal ${action} sesi`);
    loadOrchestratorData();
  } catch (err) {
    alert(err.message);
  }
}

async function killActiveSession(targetSessionId) {
  const sessId = targetSessionId || currentOrchestratorSessionId;
  if (!sessId) return;
  if (!confirm('Hentikan / Kill eksekusi task sesi ini?')) return;

  try {
    const res = await fetch(`${API_URL}/orchestrator/sessions/${sessId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ action: 'kill' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghentikan sesi');
    loadOrchestratorData();
  } catch (err) {
    alert(err.message);
  }
}

async function sendOrchestratorPrompt() {
  const input = document.getElementById('orchQuickReplyInput');
  if (!input || !input.value.trim()) return;

  const prompt = input.value.trim();
  input.value = '';

  try {
    if (socket && socket.connected) {
      socket.emit('chat:send', {
        session_id: null,
        prompt: prompt,
        model: currentDefaultModel || 'gemini-3.7-flash-low',
        effort: 'low'
      });
      setTimeout(() => loadOrchestratorData(), 800);
    }
  } catch (err) {
    alert('Gagal mengirim prompt: ' + err.message);
  }
}

function handleOrchestratorActivityPulse(data) {
  if (!data) return;
  if (currentOrchestratorView === 'trajectory' && currentOrchestratorSessionId === data.sessionId) {
    loadOrchestratorSessionTranscript(data.sessionId);
  } else {
    loadOrchestratorData();
  }
}

// Expose AGY & Orchestrator functions to global window scope
window.openOAuthWizard = openOAuthWizard;
window.handleWizardStart = handleWizardStart;
window.handleWizardComplete = handleWizardComplete;
window.openAgyAccountModal = openAgyAccountModal;
window.activateAgyAccount = activateAgyAccount;
window.resetAgyAccountStatus = resetAgyAccountStatus;
window.toggleAgyAccountFallback = toggleAgyAccountFallback;
window.deleteAgyAccount = deleteAgyAccount;
window.backupCurrentAgyToken = backupCurrentAgyToken;
window.testActiveAgyAccount = testActiveAgyAccount;
window.loadAgyAccounts = loadAgyAccounts;
window.openModal = openModal;
window.closeModal = closeModal;
window.toggleMobileChatDrawer = toggleMobileChatDrawer;
window.switchTab = switchTab;
window.setQuickPort = setQuickPort;
window.loadCloudflareOverview = loadCloudflareOverview;
window.handleStopQuickTunnel = handleStopQuickTunnel;
window.copyToClipboard = copyToClipboard;
window.toggleTunnelAutoPublish = toggleTunnelAutoPublish;

// Orchestrator & Task Filter Global Window Exports
window.loadOrchestratorData = loadOrchestratorData;
window.onOrchestratorSessionChange = onOrchestratorSessionChange;
window.switchOrchestratorView = switchOrchestratorView;
window.inspectSessionTrajectory = inspectSessionTrajectory;
window.setSessionPriority = setSessionPriority;
window.toggleSessionPause = toggleSessionPause;
window.killActiveSession = killActiveSession;
window.sendOrchestratorPrompt = sendOrchestratorPrompt;
window.showOrchestratorPayloadModal = showOrchestratorPayloadModal;
window.setTaskFilterMode = setTaskFilterMode;
window.filterProject = filterProject;
window.filterTaskBySession = filterTaskBySession;
window.filterOrchestratorKanbanBySession = filterOrchestratorKanbanBySession;

// ==================== CLIENT PORTAL & APP GATEWAY ====================

async function loadClientPortal() {
  try {
    const res = await fetch(`${API_URL}/client-apps`, {
      headers: { ...getAuthHeader() }
    });
    if (!res.ok) throw new Error('Gagal mengambil data aplikasi klien');
    const data = await res.json();
    clientAppsCache = data.apps || [];

    // Calculate Summary Stats
    const totalApps = clientAppsCache.length;
    const onlineTunnels = clientAppsCache.filter(a => a.is_tunnel_live || a.active_url).length;
    const uniqueClients = new Set(clientAppsCache.map(a => a.client_name)).size;

    const totalAppsEl = document.getElementById('portalTotalApps');
    const onlineTunnelsEl = document.getElementById('portalOnlineTunnels');
    const totalClientsEl = document.getElementById('portalTotalClients');
    const serverHealthEl = document.getElementById('portalServerHealth');

    if (totalAppsEl) totalAppsEl.textContent = `${totalApps} Apps`;
    if (onlineTunnelsEl) onlineTunnelsEl.textContent = `${onlineTunnels} Live`;
    if (totalClientsEl) totalClientsEl.textContent = `${uniqueClients} Klien`;
    if (serverHealthEl) {
      const pm2Online = clientAppsCache.some(a => a.pm2_info && a.pm2_info.status === 'online');
      serverHealthEl.textContent = pm2Online ? '100% Siap (PM2)' : 'Siap';
    }

    renderPortalAppsGrid(clientAppsCache);
    loadVpsMetrics();
  } catch (err) {
    console.error('Error loading client portal:', err);
    const grid = document.getElementById('portalAppsGrid');
    if (grid) {
      grid.innerHTML = `<div class="p-8 text-center text-rose-400 glass rounded-2xl border border-rose-800/40 col-span-full">${escapeHtml(err.message)}</div>`;
    }
  }
}

function setPortalCategory(category) {
  currentPortalCategory = category;
  document.querySelectorAll('.portal-cat-btn').forEach(btn => {
    const cat = btn.getAttribute('data-cat');
    if (cat === category) {
      btn.className = 'portal-cat-btn px-3 py-1.5 rounded-xl text-xs font-bold transition bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 whitespace-nowrap active:scale-95 cursor-pointer';
    } else {
      btn.className = 'portal-cat-btn px-3 py-1.5 rounded-xl text-xs font-semibold transition bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800 whitespace-nowrap active:scale-95 cursor-pointer';
    }
  });
  filterPortalApps();
}

function filterPortalApps() {
  const query = (document.getElementById('portalSearchInput')?.value || '').toLowerCase().trim();
  let filtered = clientAppsCache;

  if (currentPortalCategory && currentPortalCategory !== 'all') {
    filtered = filtered.filter(a => a.category === currentPortalCategory);
  }

  if (query) {
    filtered = filtered.filter(a =>
      (a.name || '').toLowerCase().includes(query) ||
      (a.client_name || '').toLowerCase().includes(query) ||
      (a.description || '').toLowerCase().includes(query) ||
      (a.internal_port && a.internal_port.toString().includes(query)) ||
      (a.active_url || '').toLowerCase().includes(query)
    );
  }

  renderPortalAppsGrid(filtered);
}

function renderPortalAppsGrid(apps) {
  const grid = document.getElementById('portalAppsGrid');
  if (!grid) return;

  const canManage = currentUser && currentUser.role !== 'client';

  if (!apps.length) {
    grid.innerHTML = `
      <div class="p-12 text-center text-slate-500 glass rounded-2xl border border-slate-800/80 col-span-full space-y-3">
        <div class="w-12 h-12 rounded-2xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center mx-auto border border-cyan-500/20">
          <i class="fa-solid fa-shapes text-xl"></i>
        </div>
        <div>
          <h4 class="text-sm font-bold text-slate-300">Belum Ada Aplikasi Klien Ditemukan</h4>
          <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Daftarkan aplikasi server untuk ditautkan ke klien dan dipublikasikan via Cloudflare Tunnel.</p>
        </div>
        ${canManage ? `
          <button type="button" onclick="openClientAppModal()" title="Daftarkan Aplikasi Klien" class="p-2.5 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white rounded-xl transition inline-flex items-center justify-center cursor-pointer shadow-md shadow-cyan-600/20 active:scale-95">
            <i class="fa-solid fa-plus text-sm"></i>
          </button>
        ` : ''}
      </div>
    `;
    return;
  }

  grid.innerHTML = apps.map((app, idx) => {
    const isLive = Boolean(app.is_tunnel_live);
    const hasUrl = Boolean(app.active_url);
    const pm2 = app.pm2_info || {};
    const memMb = pm2.memory ? (pm2.memory / (1024 * 1024)).toFixed(1) : '-';

    let statusBadge = '';
    if (isLive) {
      statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>ONLINE</span></span>';
    } else if (hasUrl) {
      statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-cyan-400"></span><span>CONFIGURED</span></span>';
    } else {
      statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span><span>LOCAL ONLY</span></span>';
    }

    const quota = app.quota || {
      ram_usage_mb: memMb !== '-' ? parseFloat(memMb) : 0,
      ram_limit_mb: app.ram_limit_mb || 1024,
      ram_pct: Math.min(100, Math.round(((memMb !== '-' ? parseFloat(memMb) : 0) / (app.ram_limit_mb || 1024)) * 100)),
      storage_usage_gb: 0.15,
      storage_limit_gb: app.storage_limit_gb || 10,
      storage_pct: 2,
      cpu_usage: pm2.cpu || 0,
      cpu_limit: app.cpu_limit_pct || 100
    };

    let ramBarColor = 'bg-cyan-500';
    if (quota.ram_pct > 90) ramBarColor = 'bg-rose-500';
    else if (quota.ram_pct > 75) ramBarColor = 'bg-amber-500';

    let storageBarColor = 'bg-purple-500';
    if (quota.storage_pct > 90) storageBarColor = 'bg-rose-500';
    else if (quota.storage_pct > 75) storageBarColor = 'bg-amber-500';

    const iconClass = app.icon || 'fa-rocket';
    const staggerClass = `stagger-${(idx % 6) + 1}`;

    return `
      <div data-app-id="${app.id}" class="glass motion-card motion-enter ${staggerClass} p-5 rounded-2xl border border-slate-800/90 hover:border-cyan-500/40 transition duration-300 flex flex-col justify-between space-y-4 relative group shadow-xl">
        <!-- Top Row: Icon, Titles, Status & Edit Action -->
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-600/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center text-xl shrink-0 group-hover:scale-105 transition">
                <i class="fa-solid ${escapeAttr(iconClass)}"></i>
              </div>
              <div class="min-w-0">
                <h4 class="text-sm font-bold text-white truncate group-hover:text-cyan-300 transition">${escapeHtml(app.name)}</h4>
                <div class="flex items-center gap-1.5 mt-0.5 text-xs">
                  <span class="font-semibold text-slate-300 truncate">${escapeHtml(app.client_name)}</span>
                  ${app.client_email ? `<span class="text-slate-500 font-mono text-[10px]">(${escapeHtml(app.client_email)})</span>` : ''}
                </div>
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-1.5">
              ${statusBadge}
              ${canManage ? `
                <button type="button" onclick="openClientAppModal(${app.id})" class="p-1.5 rounded-lg bg-slate-800 hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-300 border border-slate-700 transition cursor-pointer" title="Edit Aplikasi & Kuota Resource">
                  <i class="fa-solid fa-pen-to-square text-xs"></i>
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Description -->
          <p class="text-xs text-slate-400 line-clamp-2 leading-relaxed">${escapeHtml(app.description || 'Tidak ada deskripsi.')}</p>

          <!-- Badges Strip: Category & Port -->
          <div class="flex items-center gap-2 flex-wrap text-xs">
            <span class="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-semibold text-slate-300">
              <i class="fa-solid fa-tag text-[10px] text-cyan-400 mr-1"></i>${escapeHtml(app.category || 'Web App')}
            </span>
            <span class="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-300">
              <i class="fa-solid fa-network-wired text-[10px] text-indigo-400 mr-1"></i>Port ${app.internal_port}
            </span>
            ${app.pm2_service_name ? `
              <span class="portal-card-pm2-badge px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono ${pm2.status === 'online' ? 'text-emerald-400' : 'text-slate-400'}">
                <i class="fa-solid fa-cube text-[10px] mr-1"></i>PM2: ${escapeHtml(app.pm2_service_name)}
              </span>
            ` : ''}
          </div>
        </div>

        <!-- Telemetry & Resource Quotas Gauge -->
        <div class="p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80 space-y-3">
          <div class="flex items-center justify-between text-[11px] text-slate-400">
            <span class="font-semibold text-slate-300 uppercase tracking-wider text-[10px] flex items-center gap-1.5">
              <i class="fa-solid fa-chart-pie text-cyan-400"></i>
              <span>Resource & Kuota:</span>
            </span>
            <span class="portal-card-status-text font-mono text-[11px] ${pm2.status === 'online' ? 'text-emerald-400' : 'text-slate-500'}">${pm2.status === 'online' ? '🟢 Online' : 'Standby / Port Active'}</span>
          </div>

          <!-- Quota Meters (RAM & Storage) -->
          <div class="space-y-2 text-xs">
            <!-- RAM Usage vs Quota -->
            <div>
              <div class="flex items-center justify-between text-[11px] mb-1 font-mono">
                <span class="text-slate-400"><i class="fa-solid fa-memory text-cyan-400 mr-1"></i>RAM:</span>
                <span class="portal-card-ram-text text-white font-bold">${quota.ram_usage_mb} MB / <span class="text-slate-400 font-normal">${quota.ram_limit_mb} MB (${quota.ram_pct}%)</span></span>
              </div>
              <div class="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden border border-slate-800">
                <div class="portal-card-ram-bar ${ramBarColor} h-1.5 rounded-full transition-all duration-500" style="width: ${quota.ram_pct}%"></div>
              </div>
            </div>

            <!-- Storage Usage vs Quota -->
            <div>
              <div class="flex items-center justify-between text-[11px] mb-1 font-mono">
                <span class="text-slate-400"><i class="fa-solid fa-hard-drive text-purple-400 mr-1"></i>Storage:</span>
                <span class="portal-card-storage-text text-white font-bold">${quota.storage_usage_gb} GB / <span class="text-slate-400 font-normal">${quota.storage_limit_gb} GB (${quota.storage_pct}%)</span></span>
              </div>
              <div class="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden border border-slate-800">
                <div class="portal-card-storage-bar ${storageBarColor} h-1.5 rounded-full transition-all duration-500" style="width: ${quota.storage_pct}%"></div>
              </div>
            </div>
          </div>

          <!-- Bottom Micro Gauges: CPU & Restarts -->
          <div class="grid grid-cols-2 gap-2 text-center text-xs pt-1 border-t border-slate-900">
            <div class="bg-slate-900/90 p-1.5 rounded-xl border border-slate-800/80">
              <div class="text-[9px] text-slate-500 uppercase font-semibold">CPU Usage</div>
              <div class="portal-card-cpu-text font-bold text-white font-mono text-xs mt-0.5">${pm2.cpu !== undefined ? `${pm2.cpu}%` : '0%'} <span class="text-[10px] text-slate-500 font-normal">/ max ${quota.cpu_limit}%</span></div>
            </div>
            <div class="bg-slate-900/90 p-1.5 rounded-xl border border-slate-800/80">
              <div class="text-[9px] text-slate-500 uppercase font-semibold">Restarts</div>
              <div class="portal-card-restarts-text font-bold text-slate-300 font-mono text-xs mt-0.5">${pm2.restarts !== undefined ? `${pm2.restarts}x` : '0x'}</div>
            </div>
          </div>
        </div>

        <!-- Launch & Access Gateway Section -->
        <div class="pt-2 space-y-2">
          ${hasUrl ? `
            <div class="flex items-center gap-1.5 p-2 bg-slate-900 rounded-xl border border-slate-800 font-mono text-xs text-cyan-300 select-all overflow-hidden">
              <i class="fa-solid fa-link text-slate-500 text-[11px] ml-1 shrink-0"></i>
              <span class="truncate flex-1 text-[11px]">${escapeHtml(app.active_url)}</span>
              <button onclick="copyToClipboard('${escapeAttr(app.active_url)}')" title="Salin URL" class="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition shrink-0 cursor-pointer flex items-center justify-center">
                <i class="fa-regular fa-copy text-xs"></i>
              </button>
            </div>

            <div class="flex items-center gap-2">
              <a href="${escapeAttr(app.active_url)}" target="_blank" rel="noopener noreferrer" title="Buka Aplikasi Klien" class="flex-1 py-2.5 px-4 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/20 active:scale-95 no-underline">
                <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
              </a>
              <button type="button" onclick="broadcastClientAppToTelegram(${app.id})" class="p-2.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs transition cursor-pointer flex items-center justify-center active:scale-95" title="Kirim Link ke Telegram Klien">
                <i class="fa-brands fa-telegram text-xs"></i>
              </button>
              <button type="button" onclick="startClientAppTunnel(${app.id})" class="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-400 border border-slate-700 text-xs transition cursor-pointer flex items-center justify-center active:scale-95" title="Perbarui / Refresh Tunnel">
                <i class="fa-solid fa-arrows-rotate text-xs"></i>
              </button>
            </div>
          ` : `
            <button type="button" onclick="startClientAppTunnel(${app.id})" title="Hubungkan Cloudflare Tunnel" class="w-full py-2.5 px-4 bg-gradient-to-r from-amber-600 to-orange-500 hover:from-amber-500 hover:to-orange-400 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-amber-600/20 active:scale-95 cursor-pointer">
              <i class="fa-solid fa-bolt text-sm"></i>
            </button>
          `}

          <!-- Admin Options Footer -->
          ${canManage ? `
            <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
              <span class="text-[11px] text-slate-500 font-mono">Port ${app.internal_port}</span>
              <div class="flex items-center gap-1.5">
                <button type="button" onclick="openClientAppModal(${app.id})" title="Edit Data & Kuota" class="p-2 rounded-lg bg-slate-800 hover:bg-cyan-500/20 text-slate-300 hover:text-cyan-300 border border-slate-700 transition flex items-center justify-center cursor-pointer active:scale-95">
                  <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button type="button" onclick="deleteClientApp(${app.id})" title="Hapus Aplikasi" class="p-2 rounded-lg bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 border border-slate-700 transition flex items-center justify-center cursor-pointer active:scale-95">
                  <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function openClientAppModal(appId = null) {
  const modalTitle = document.getElementById('clientAppModalTitle');
  const editId = document.getElementById('clientAppEditId');
  const nameInput = document.getElementById('clientAppNameInput');
  const clientNameInput = document.getElementById('clientAppClientNameInput');
  const emailInput = document.getElementById('clientAppEmailInput');
  const categorySelect = document.getElementById('clientAppCategorySelect');
  const iconSelect = document.getElementById('clientAppIconSelect');
  const portInput = document.getElementById('clientAppPortInput');
  const pm2Select = document.getElementById('clientAppPm2Select');
  const publicUrlInput = document.getElementById('clientAppPublicUrlInput');
  const descInput = document.getElementById('clientAppDescriptionInput');
  const userSelect = document.getElementById('clientAppUserSelect');
  const ramInput = document.getElementById('clientAppRamLimitInput');
  const storageInput = document.getElementById('clientAppStorageLimitInput');
  const cpuInput = document.getElementById('clientAppCpuLimitInput');
  const dirInput = document.getElementById('clientAppDirInput');
  const statusSelect = document.getElementById('clientAppStatusSelect');
  const alertEl = document.getElementById('clientAppAlert');

  if (alertEl) alertEl.classList.add('hidden');

  // Populate Users for client assignment
  if (userSelect) {
    fetch(`${API_URL}/users`, { headers: getAuthHeader() })
      .then(res => res.json())
      .then(data => {
        const users = data.users || [];
        userSelect.innerHTML = '<option value="">(Semua / Publik Portal)</option>' +
          users.map(u => `<option value="${u.id}">${escapeHtml(u.full_name)} (@${escapeHtml(u.username)}) - Role: ${u.role}</option>`).join('');
        if (appId) {
          const app = clientAppsCache.find(a => a.id === appId);
          if (app && app.assigned_user_id) userSelect.value = app.assigned_user_id;
        }
      })
      .catch(() => {});
  }

  // Populate PM2 options dynamically from vps metrics
  if (pm2Select) {
    fetch(`${API_URL}/vps/metrics`, { headers: getAuthHeader() })
      .then(res => res.json())
      .then(data => {
        const pm2List = data.pm2 || [];
        pm2Select.innerHTML = '<option value="">(Tanpa PM2 / Standalone)</option>' +
          pm2List.map(p => `<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)} (${p.status})</option>`).join('');
        if (appId) {
          const app = clientAppsCache.find(a => a.id === appId);
          if (app && app.pm2_service_name) pm2Select.value = app.pm2_service_name;
        }
      })
      .catch(() => {});
  }

  if (appId) {
    const app = clientAppsCache.find(a => a.id === appId);
    if (!app) return;
    if (modalTitle) modalTitle.textContent = 'Edit Data & Kuota Aplikasi Klien';
    if (editId) editId.value = app.id;
    if (nameInput) nameInput.value = app.name || '';
    if (clientNameInput) clientNameInput.value = app.client_name || '';
    if (emailInput) emailInput.value = app.client_email || '';
    if (categorySelect) categorySelect.value = app.category || 'Web Application';
    if (iconSelect) iconSelect.value = app.icon || 'fa-rocket';
    if (portInput) portInput.value = app.internal_port || '';
    if (publicUrlInput) publicUrlInput.value = app.public_url || '';
    if (descInput) descInput.value = app.description || '';
    if (ramInput) ramInput.value = app.ram_limit_mb || 1024;
    if (storageInput) storageInput.value = app.storage_limit_gb || 10;
    if (cpuInput) cpuInput.value = app.cpu_limit_pct || 100;
    if (dirInput) dirInput.value = app.app_dir || '';
    if (statusSelect) statusSelect.value = app.status || 'active';
  } else {
    if (modalTitle) modalTitle.textContent = 'Daftarkan Aplikasi Klien Baru';
    if (editId) editId.value = '';
    if (nameInput) nameInput.value = '';
    if (clientNameInput) clientNameInput.value = '';
    if (emailInput) emailInput.value = '';
    if (categorySelect) categorySelect.value = 'Web Application';
    if (iconSelect) iconSelect.value = 'fa-rocket';
    if (portInput) portInput.value = '';
    if (publicUrlInput) publicUrlInput.value = '';
    if (descInput) descInput.value = '';
    if (ramInput) ramInput.value = '1024';
    if (storageInput) storageInput.value = '10';
    if (cpuInput) cpuInput.value = '100';
    if (dirInput) dirInput.value = '';
    if (statusSelect) statusSelect.value = 'active';
  }

  openModal('clientAppModal');
}

async function handleClientAppSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('clientAppEditId').value;
  const name = document.getElementById('clientAppNameInput').value.trim();
  const client_name = document.getElementById('clientAppClientNameInput').value.trim();
  const client_email = document.getElementById('clientAppEmailInput').value.trim();
  const category = document.getElementById('clientAppCategorySelect').value;
  const icon = document.getElementById('clientAppIconSelect').value;
  const internal_port = document.getElementById('clientAppPortInput').value;
  const pm2_service_name = document.getElementById('clientAppPm2Select').value.trim();
  const public_url = document.getElementById('clientAppPublicUrlInput').value.trim();
  const description = document.getElementById('clientAppDescriptionInput').value.trim();
  const assigned_user_id = document.getElementById('clientAppUserSelect')?.value || null;
  const ram_limit_mb = document.getElementById('clientAppRamLimitInput')?.value || 1024;
  const storage_limit_gb = document.getElementById('clientAppStorageLimitInput')?.value || 10;
  const cpu_limit_pct = document.getElementById('clientAppCpuLimitInput')?.value || 100;
  const app_dir = document.getElementById('clientAppDirInput')?.value.trim() || '';
  const status = document.getElementById('clientAppStatusSelect')?.value || 'active';

  const alertEl = document.getElementById('clientAppAlert');
  const btn = document.getElementById('saveClientAppBtn');

  if (alertEl) alertEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i><span>Menyimpan...</span>';

  try {
    const payload = {
      name,
      client_name,
      client_email,
      category,
      icon,
      internal_port,
      pm2_service_name,
      public_url,
      description,
      assigned_user_id: assigned_user_id ? parseInt(assigned_user_id, 10) : null,
      ram_limit_mb: parseInt(ram_limit_mb, 10),
      storage_limit_gb: parseInt(storage_limit_gb, 10),
      cpu_limit_pct: parseInt(cpu_limit_pct, 10),
      app_dir,
      status
    };

    let res;
    if (editId) {
      res = await fetch(`${API_URL}/client-apps/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_URL}/client-apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan aplikasi klien');

    closeModal('clientAppModal');
    loadClientPortal();
    showToast(`✓ Aplikasi "${name}" berhasil disimpan!`, 'success', 'fa-circle-check');
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = err.message;
      alertEl.className = 'p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Simpan Aplikasi Klien</span>';
  }
}

async function deleteClientApp(id) {
  const app = clientAppsCache.find(a => a.id === id);
  if (!confirm(`Hapus aplikasi klien "${app?.name || 'ini'}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/client-apps/${id}`, {
      method: 'DELETE',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus aplikasi klien');
    loadClientPortal();
  } catch (err) {
    alert('Gagal menghapus: ' + err.message);
  }
}

async function startClientAppTunnel(id) {
  const app = clientAppsCache.find(a => a.id === id);
  const appName = app?.name || 'Aplikasi';

  try {
    const res = await fetch(`${API_URL}/client-apps/${id}/start-tunnel`, {
      method: 'POST',
      headers: { ...getAuthHeader() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengaktifkan Cloudflare Tunnel');
    alert(`✓ Cloudflare Tunnel untuk "${appName}" aktif!\nURL: ${data.url}`);
    loadClientPortal();
  } catch (err) {
    alert('Gagal mengaktifkan tunnel: ' + err.message);
  }
}

// Portal Global Window Exports
window.loadClientPortal = loadClientPortal;
window.setPortalCategory = setPortalCategory;
window.filterPortalApps = filterPortalApps;
window.openClientAppModal = openClientAppModal;
window.handleClientAppSubmit = handleClientAppSubmit;
window.deleteClientApp = deleteClientApp;
window.startClientAppTunnel = startClientAppTunnel;

// ==================== PM2 & CLIENT APP LINKING ====================

let pm2LinkTargetServiceName = '';

function openPm2LinkModal(serviceName) {
  pm2LinkTargetServiceName = serviceName;
  const targetHidden = document.getElementById('pm2LinkTargetServiceName');
  const titleSub = document.getElementById('pm2LinkServiceNameSubtitle');
  const searchInput = document.getElementById('pm2LinkSearchInput');
  const alertEl = document.getElementById('pm2LinkAlert');
  const newPort = document.getElementById('pm2NewAppPort');

  if (targetHidden) targetHidden.value = serviceName;
  if (titleSub) titleSub.textContent = `Service PM2: ${serviceName}`;
  if (searchInput) searchInput.value = '';
  if (alertEl) alertEl.classList.add('hidden');
  if (newPort) newPort.value = '8080';

  renderPm2LinkAppList(clientAppsCache || []);
  openModal('pm2LinkModal');
}

function filterPm2LinkOptions() {
  const query = (document.getElementById('pm2LinkSearchInput')?.value || '').toLowerCase().trim();
  let filtered = clientAppsCache || [];
  if (query) {
    filtered = filtered.filter(a =>
      (a.name || '').toLowerCase().includes(query) ||
      (a.client_name || '').toLowerCase().includes(query) ||
      (a.category || '').toLowerCase().includes(query) ||
      (a.internal_port && a.internal_port.toString().includes(query))
    );
  }
  renderPm2LinkAppList(filtered);
}

function renderPm2LinkAppList(apps) {
  const container = document.getElementById('pm2LinkAppList');
  if (!container) return;

  if (!apps.length) {
    container.innerHTML = `
      <div class="p-4 text-center text-xs text-slate-500 bg-slate-950/60 rounded-xl border border-slate-800">
        Tidak ada aplikasi yang cocok. Silakan daftarkan aplikasi baru di form bawah.
      </div>
    `;
    return;
  }

  container.innerHTML = apps.map(app => {
    const isCurrentlyLinked = app.pm2_service_name === pm2LinkTargetServiceName;
    return `
      <div class="p-3 rounded-xl border transition flex items-center justify-between gap-3 ${isCurrentlyLinked ? 'bg-cyan-950/30 border-cyan-500/40 text-cyan-300' : 'bg-slate-950/70 border-slate-800 hover:border-cyan-500/30 text-slate-200'}">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
            <i class="fa-solid ${escapeAttr(app.icon || 'fa-rocket')} text-sm"></i>
          </div>
          <div class="min-w-0">
            <div class="font-bold text-xs text-white truncate flex items-center gap-1.5">
              <span>${escapeHtml(app.name)}</span>
              ${isCurrentlyLinked ? '<span class="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold">TERTAUT</span>' : ''}
            </div>
            <div class="text-[11px] text-slate-400 truncate">Klien: <span class="text-slate-300 font-semibold">${escapeHtml(app.client_name)}</span> • Port ${app.internal_port}</div>
          </div>
        </div>
        <button type="button" onclick="linkPm2ToExistingApp(${app.id})" title="${isCurrentlyLinked ? 'Tertaut' : 'Pilih & Tautkan'}" class="p-2 rounded-lg text-xs font-bold transition shrink-0 cursor-pointer active:scale-95 flex items-center justify-center ${isCurrentlyLinked ? 'bg-cyan-600 text-white shadow-md shadow-cyan-600/30' : 'bg-slate-800 hover:bg-cyan-600 text-slate-300 hover:text-white border border-slate-700'}">
          <i class="fa-solid ${isCurrentlyLinked ? 'fa-check' : 'fa-link'} text-xs"></i>
        </button>
      </div>
    `;
  }).join('');
}

async function linkPm2ToExistingApp(clientAppId) {
  const serviceName = pm2LinkTargetServiceName;
  const alertEl = document.getElementById('pm2LinkAlert');
  if (alertEl) alertEl.classList.add('hidden');

  try {
    const res = await fetch(`${API_URL}/client-apps/link-pm2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ pm2_service_name: serviceName, client_app_id: clientAppId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menautkan PM2');

    closeModal('pm2LinkModal');
    await loadClientPortal();
    loadVpsMetrics();
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = err.message;
      alertEl.className = 'p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.classList.remove('hidden');
    }
  }
}

async function handleCreateAndLinkPm2() {
  const serviceName = pm2LinkTargetServiceName;
  const name = document.getElementById('pm2NewAppName')?.value.trim();
  const client_name = document.getElementById('pm2NewClientName')?.value.trim();
  const internal_port = document.getElementById('pm2NewAppPort')?.value.trim();
  const category = document.getElementById('pm2NewAppCategory')?.value;
  const alertEl = document.getElementById('pm2LinkAlert');

  if (!name || !client_name) {
    if (alertEl) {
      alertEl.textContent = 'Nama Aplikasi dan Nama Klien wajib diisi';
      alertEl.className = 'p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.classList.remove('hidden');
    }
    return;
  }

  try {
    const res = await fetch(`${API_URL}/client-apps/link-pm2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({
        pm2_service_name: serviceName,
        new_client_app: {
          name,
          client_name,
          internal_port: parseInt(internal_port || 8080, 10),
          category: category || 'Web Application'
        }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal membuat dan menautkan aplikasi');

    closeModal('pm2LinkModal');
    await loadClientPortal();
    loadVpsMetrics();
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = err.message;
      alertEl.className = 'p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300';
      alertEl.classList.remove('hidden');
    }
  }
}

async function handleUnlinkPm2() {
  const serviceName = pm2LinkTargetServiceName;
  if (!confirm(`Lepas tautan client dari service PM2 "${serviceName}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/client-apps/link-pm2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ pm2_service_name: serviceName, unlink: true })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal melepas tautan PM2');

    closeModal('pm2LinkModal');
    await loadClientPortal();
    loadVpsMetrics();
  } catch (err) {
    alert('Gagal melepas tautan: ' + err.message);
  }
}

// ==================== USER MANAGEMENT & AUDIT ====================

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  try {
    const res = await fetch(`${API_URL}/users`, { headers: getAuthHeader() });
    if (!res.ok) throw new Error('Gagal mengambil data user');
    const data = await res.json();
    const users = data.users || [];

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Belum ada user terdaftar.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => {
      let roleBadge = '';
      if (u.role === 'admin') {
        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 font-mono">admin</span>';
      } else if (u.role === 'client') {
        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">client</span>';
      } else if (u.role === 'operator') {
        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono">operator</span>';
      } else {
        roleBadge = '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700 font-mono">member</span>';
      }

      return `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="px-6 py-4 font-mono text-xs text-slate-400">#${u.id}</td>
          <td class="px-6 py-4 font-bold text-white">${escapeHtml(u.full_name)}</td>
          <td class="px-6 py-4 font-mono text-xs text-slate-300">
            <div class="flex items-center gap-1.5">
              <span>@${escapeHtml(u.username)}</span>
              ${u.telegram_chat_id ? `
                <span class="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] flex items-center gap-1 font-sans" title="Telegram: ${escapeAttr(u.telegram_username || u.telegram_chat_id)}">
                  <i class="fa-brands fa-telegram text-xs"></i>
                  <span>${escapeHtml(u.telegram_username || 'Linked')}</span>
                </span>
              ` : ''}
            </div>
          </td>
          <td class="px-6 py-4">${roleBadge}</td>
          <td class="px-6 py-4 text-xs text-slate-400">${escapeHtml(u.created_at || '-')}</td>
          <td class="px-6 py-4 text-right">
            <button onclick="openResetPasswordModal(${u.id}, '${escapeAttr(u.username)}')" title="Reset Password" class="p-1.5 rounded-lg bg-slate-800 hover:bg-amber-600/20 text-slate-400 hover:text-amber-400 border border-slate-700 transition cursor-pointer">
              <i class="fa-solid fa-key text-xs"></i>
            </button>
            ${u.id !== currentUser?.id ? `
              <button onclick="deleteUser(${u.id}, '${escapeAttr(u.username)}')" title="Hapus User" class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 border border-slate-700 transition cursor-pointer ml-1">
                <i class="fa-solid fa-trash-can text-xs"></i>
              </button>
            ` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteUser(userId, username) {
  if (!confirm(`Hapus user "@${username}"?`)) return;
  try {
    const res = await fetch(`${API_URL}/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeader()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus user');
    loadUsers();
  } catch (err) {
    alert('Gagal menghapus user: ' + err.message);
  }
}

async function openResetPasswordModal(userId, username) {
  const newPass = prompt(`Masukkan password baru untuk user "@${username}" (min. 6 karakter):`);
  if (!newPass) return;
  if (newPass.length < 6) {
    alert('Password minimal 6 karakter');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/users/${userId}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ password: newPass })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal reset password');
    alert(`✓ Password untuk @${username} berhasil di-reset!`);
  } catch (err) {
    alert('Gagal reset password: ' + err.message);
  }
}

async function loadAuditLogs() {
  const tbody = document.getElementById('auditTableBody');
  if (!tbody) return;
  try {
    const res = await fetch(`${API_URL}/audit`, { headers: getAuthHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const logs = data.logs || [];
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500">Belum ada audit log.</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="px-6 py-3 font-mono text-xs text-slate-400">#${l.id}</td>
        <td class="px-6 py-3 font-semibold text-slate-200">@${escapeHtml(l.username || 'system')}</td>
        <td class="px-6 py-3 font-mono text-xs text-indigo-300 font-bold">${escapeHtml(l.action)}</td>
        <td class="px-6 py-3 text-xs text-slate-400 max-w-xs truncate">${escapeHtml(l.details || '')}</td>
        <td class="px-6 py-3 text-xs text-slate-500 font-mono">${escapeHtml(l.created_at || '-')}</td>
      </tr>
    `).join('');
  } catch (err) {}
}

// PM2 Link & User Global Window Exports
window.openPm2LinkModal = openPm2LinkModal;
window.filterPm2LinkOptions = filterPm2LinkOptions;
window.linkPm2ToExistingApp = linkPm2ToExistingApp;
window.handleCreateAndLinkPm2 = handleCreateAndLinkPm2;
window.handleUnlinkPm2 = handleUnlinkPm2;
window.loadUsers = loadUsers;
window.deleteUser = deleteUser;
window.openResetPasswordModal = openResetPasswordModal;
window.loadAuditLogs = loadAuditLogs;

// ==================== LEGAL, EULA & TERMS MODAL ====================

function openLegalModal(tab = 'tos') {
  switchLegalTab(tab);
  openModal('legalTermsModal');
}

function switchLegalTab(tab) {
  const validTabs = ['tos', 'eula', 'privacy', 'sla'];
  const targetTab = validTabs.includes(tab) ? tab : 'tos';

  // Toggle sections
  document.querySelectorAll('.legal-section').forEach(sec => sec.classList.add('hidden'));
  const targetSec = document.getElementById(`legalSection-${targetTab}`);
  if (targetSec) targetSec.classList.remove('hidden');

  // Toggle button active states
  document.querySelectorAll('.legal-nav-btn').forEach(btn => {
    btn.className = 'legal-nav-btn px-3.5 py-2 rounded-xl font-medium text-slate-400 hover:text-white bg-slate-900 border border-slate-800 transition whitespace-nowrap active:scale-95 cursor-pointer';
  });
  const activeBtn = document.getElementById(`legalTabBtn-${targetTab}`);
  if (activeBtn) {
    activeBtn.className = 'legal-nav-btn px-3.5 py-2 rounded-xl font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 transition whitespace-nowrap active:scale-95 cursor-pointer';
  }
}

window.openLegalModal = openLegalModal;
window.switchLegalTab = switchLegalTab;

// Quick Tunnel Global Window Exports
window.openQuickTunnelModal = openQuickTunnelModal;
window.populateQuickTunnelAppOptions = populateQuickTunnelAppOptions;
window.onQuickTunnelAppSelected = onQuickTunnelAppSelected;
window.setQuickPort = setQuickPort;

// ==================== TELEGRAM BOT & CLIENT AUTH CONTROLLER ====================

let telegramCurrentAuthData = null;

async function openTelegramAuthModal() {
  openModal('telegramAuthModal');
  await loadTelegramAuthInfo();
}

async function loadTelegramAuthInfo() {
  const badge = document.getElementById('telegramStatusBadge');
  const text = document.getElementById('telegramStatusText');
  const userInfo = document.getElementById('telegramConnectedUserInfo');
  const usernameText = document.getElementById('telegramUsernameText');
  const chatIdText = document.getElementById('telegramChatIdText');
  const anchor = document.getElementById('telegramDeepLinkAnchor');
  const codeInput = document.getElementById('telegramConnectCodeInput');
  const mention = document.getElementById('telegramBotUsernameMention');
  const unlinkBtn = document.getElementById('telegramUnlinkBtn');

  if (text) text.textContent = 'Memuat status...';

  try {
    const res = await fetch(`${API_URL}/telegram/auth-link`, { headers: getAuthHeader() });
    if (!res.ok) throw new Error('Gagal mengambil data autorisasi Telegram');
    const data = await res.json();
    telegramCurrentAuthData = data;

    if (data.is_linked) {
      if (badge) badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5';
      if (text) text.textContent = 'Terhubung';
      if (userInfo) userInfo.classList.remove('hidden');
      if (usernameText) usernameText.textContent = data.telegram_username || '(Tanpa username)';
      if (chatIdText) chatIdText.textContent = data.telegram_chat_id || '-';
      if (unlinkBtn) unlinkBtn.classList.remove('hidden');
    } else {
      if (badge) badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-300 border border-amber-500/20 flex items-center gap-1.5';
      if (text) text.textContent = 'Belum Terhubung';
      if (userInfo) userInfo.classList.add('hidden');
      if (unlinkBtn) unlinkBtn.classList.add('hidden');
    }

    if (codeInput) codeInput.value = data.connect_command || `/connect ${data.auth_token}`;
    if (mention) mention.textContent = data.bot_username ? `@${data.bot_username}` : 'Bot AGY Hub';

    if (anchor) {
      if (data.deep_link) {
        anchor.href = data.deep_link;
        anchor.classList.remove('opacity-50', 'pointer-events-none');
      } else {
        anchor.href = '#';
        anchor.classList.add('opacity-50', 'pointer-events-none');
      }
    }
  } catch (err) {
    if (text) text.textContent = 'Error';
    console.error('[Telegram] Error loading auth info:', err);
  }
}

function copyTelegramConnectCode(btn) {
  const input = document.getElementById('telegramConnectCodeInput');
  if (!input) return;
  copyToClipboard(input.value, btn);
}

async function handleUnlinkTelegram() {
  if (!confirm('Putuskan tautan akun Telegram ini? Anda tidak akan menerima notifikasi Cloudflare otomatis sampai ditautkan kembali.')) return;
  
  try {
    const res = await fetch(`${API_URL}/telegram/unlink`, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal melepas akun Telegram');

    showToast('Tautan akun Telegram berhasil dilepas.', 'info', 'fa-solid fa-unlink');
    await loadTelegramAuthInfo();
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

async function openTelegramSettingsModal() {
  openModal('telegramSettingsModal');
  const tokenInput = document.getElementById('telegramBotTokenInput');
  const activeCheck = document.getElementById('telegramActiveCheck');
  const adminChatInput = document.getElementById('telegramAdminChatIdInput');
  const alertBox = document.getElementById('telegramSettingsAlert');
  if (alertBox) alertBox.classList.add('hidden');

  try {
    const res = await fetch(`${API_URL}/telegram/status`, { headers: getAuthHeader() });
    if (!res.ok) throw new Error('Gagal mengambil status bot Telegram');
    const data = await res.json();
    const config = data.config || {};

    if (tokenInput) tokenInput.value = config.has_token ? config.bot_token : '';
    if (activeCheck) activeCheck.checked = Boolean(config.is_active);
    if (adminChatInput) adminChatInput.value = config.admin_chat_id || '';
  } catch (err) {
    console.error('[Telegram] Error fetching status:', err);
  }
}

async function handleTelegramSettingsSubmit(e) {
  e.preventDefault();
  const tokenInput = document.getElementById('telegramBotTokenInput');
  const activeCheck = document.getElementById('telegramActiveCheck');
  const adminChatInput = document.getElementById('telegramAdminChatIdInput');
  const alertBox = document.getElementById('telegramSettingsAlert');

  const payload = {
    is_active: activeCheck ? activeCheck.checked : true,
    admin_chat_id: adminChatInput ? adminChatInput.value.trim() : ''
  };

  // Only send bot_token if it's not masked or was modified
  if (tokenInput && tokenInput.value && !tokenInput.value.includes('...') && !tokenInput.value.includes('•')) {
    payload.bot_token = tokenInput.value.trim();
  }

  try {
    const res = await fetch(`${API_URL}/telegram/config`, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await res.json(); } catch (_) { throw new Error(`HTTP Error ${res.status}: Gagal memproses respon server`); }
    if (!res.ok) throw new Error(data.error || data.message || 'Gagal menyimpan pengaturan');

    if (alertBox) {
      alertBox.className = 'p-3 rounded-xl text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
      alertBox.textContent = data.message || 'Pengaturan berhasil disimpan!';
      alertBox.classList.remove('hidden');
    }

    showToast('Konfigurasi Telegram Bot aktif!', 'success', 'fa-brands fa-telegram');
    setTimeout(() => closeModal('telegramSettingsModal'), 1200);
  } catch (err) {
    if (alertBox) {
      alertBox.className = 'p-3 rounded-xl text-xs bg-rose-500/10 text-rose-300 border border-rose-500/20';
      alertBox.textContent = err.message;
      alertBox.classList.remove('hidden');
    }
  }
}

async function handleTestTelegramBot() {
  const tokenInput = document.getElementById('telegramBotTokenInput');
  const adminChatInput = document.getElementById('telegramAdminChatIdInput');
  const alertBox = document.getElementById('telegramSettingsAlert');
  const testBtn = document.getElementById('testTelegramBotBtn');

  const payload = {
    chat_id: adminChatInput ? adminChatInput.value.trim() : null
  };
  if (tokenInput && tokenInput.value && !tokenInput.value.includes('...') && !tokenInput.value.includes('•')) {
    payload.bot_token = tokenInput.value.trim();
  }

  if (testBtn) testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-sm"></i>';

  try {
    const res = await fetch(`${API_URL}/telegram/test`, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await res.json(); } catch (_) { throw new Error(`HTTP Error ${res.status}: Gagal menguji bot`); }
    if (!res.ok) throw new Error(data.error || data.message || 'Uji koneksi gagal');

    if (alertBox) {
      alertBox.className = 'p-3 rounded-xl text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
      alertBox.textContent = data.message || `Bot @${data.bot?.bot_username} aktif!`;
      alertBox.classList.remove('hidden');
    }
    showToast(`Bot @${data.bot?.bot_username} terhubung lancar!`, 'success', 'fa-brands fa-telegram');
  } catch (err) {
    if (alertBox) {
      alertBox.className = 'p-3 rounded-xl text-xs bg-rose-500/10 text-rose-300 border border-rose-500/20';
      alertBox.textContent = err.message;
      alertBox.classList.remove('hidden');
    }
  } finally {
    if (testBtn) testBtn.innerHTML = '<i class="fa-solid fa-bolt text-sm"></i>';
  }
}

async function broadcastTunnelToTelegram(port) {
  try {
    showToast('Mengirim link Cloudflare ke Telegram klien...', 'info', 'fa-brands fa-telegram');
    const res = await fetch(`${API_URL}/telegram/broadcast-link`, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ port })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal broadcast link');

    showToast(data.message || 'Link berhasil dikirim ke Telegram klien!', 'success', 'fa-brands fa-telegram');
  } catch (err) {
    showToast(err.message, 'error', 'fa-solid fa-circle-exclamation');
  }
}

async function broadcastClientAppToTelegram(appId) {
  try {
    showToast('Mengirim link Cloudflare ke Telegram klien...', 'info', 'fa-brands fa-telegram');
    const res = await fetch(`${API_URL}/telegram/broadcast-link`, {
      method: 'POST',
      headers: { ...getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_app_id: appId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal broadcast link');

    showToast(data.message || 'Link berhasil dikirim ke Telegram klien!', 'success', 'fa-brands fa-telegram');
  } catch (err) {
    showToast(err.message, 'error', 'fa-solid fa-circle-exclamation');
  }
}

// Window Global Exports for Telegram
window.openTelegramAuthModal = openTelegramAuthModal;
window.loadTelegramAuthInfo = loadTelegramAuthInfo;
window.copyTelegramConnectCode = copyTelegramConnectCode;
window.handleUnlinkTelegram = handleUnlinkTelegram;
window.openTelegramSettingsModal = openTelegramSettingsModal;
window.handleTelegramSettingsSubmit = handleTelegramSettingsSubmit;
window.handleTestTelegramBot = handleTestTelegramBot;
window.broadcastTunnelToTelegram = broadcastTunnelToTelegram;
window.broadcastClientAppToTelegram = broadcastClientAppToTelegram;






