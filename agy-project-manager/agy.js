const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const {
  isAutoFallbackEnabled,
  getActiveAccount,
  getNextFallbackAccount,
  switchActiveAccount,
  markAccountQuotaExceeded,
  syncDiskTokenToActiveAccount,
  incrementAccountUsage,
  isQuotaExhaustedError,
  getAgyBin,
  getCleanEnv
} = require('./agyAccounts');

function getDefaultModels() {
  return [
    { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low Effort - Fast)' },
    { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
    { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High Thinking)' },
    { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
    { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
  ];
}

function getAvailableModels() {
  try {
    const cleanEnv = getCleanEnv();
    const agyBin = getAgyBin();

    const out = execSync(`"${agyBin}" models`, { encoding: 'utf-8', timeout: 10000, env: cleanEnv });
    const lines = out.split('\n');
    const models = [];
    for (const line of lines) {
      const clean = line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/, '').trim();
      if (!clean) continue;
      const match = clean.match(/^([a-zA-Z0-9\._\-]+)\s+(.+)$/);
      if (match) {
        models.push({ id: match[1].trim(), name: match[2].trim() });
      }
    }
    return models.length ? models : getDefaultModels();
  } catch (e) {
    return getDefaultModels();
  }
}

function streamAgyCore({
  prompt,
  conversationId,
  model,
  effort = 'low',
  workspaceDir = process.env.WORKSPACE_DIR || process.cwd() || os.homedir(),
  onEvent,
  onDone,
  onError,
  retryCount = 0,
  maxRetries = 5
}) {
  const activeAcc = getActiveAccount();
  if (activeAcc) {
    incrementAccountUsage(activeAcc.id);
  }

  const args = ['-p', prompt, '--output-format', 'stream-json'];

  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  const selectedModel = (model || '').trim();
  if (selectedModel) {
    args.push('--model', selectedModel);
    // If model name already ends with effort level, don't pass duplicate --effort flag
    const hasEmbeddedEffort = /-(high|medium|low|thinking)$/i.test(selectedModel);
    if (!hasEmbeddedEffort && effort) {
      args.push('--effort', effort);
    }
  } else if (effort) {
    args.push('--effort', effort);
  }

  args.push('--dangerously-skip-permissions');

  const cleanEnv = getCleanEnv();
  const agyBin = getAgyBin();
  const targetCwd = (workspaceDir && fs.existsSync(workspaceDir)) ? workspaceDir : (process.env.WORKSPACE_DIR || os.homedir());
  const isBatOrCmd = agyBin.endsWith('.cmd') || agyBin.endsWith('.bat');
  const useShell = isBatOrCmd;

  let activeChild = spawn(agyBin, args, {
    cwd: targetCwd,
    env: cleanEnv,
    shell: useShell,
    windowsHide: true
  });

  let fullResponse = '';
  let finalConvId = conversationId;
  let hasEnded = false;
  let stderrData = '';
  let subController = null;

  const rl = readline.createInterface({
    input: activeChild.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const eventType = event.event;

      if (eventType === 'init') {
        finalConvId = event.conversation_id || finalConvId;
        onEvent && onEvent({ type: 'init', conversation_id: finalConvId, account: activeAcc?.name });
      } else if (eventType === 'step_update') {
        const step = event.step_update || {};
        if (step.step_type === 'tool') {
          onEvent && onEvent({
            type: 'tool',
            name: step.tool_name,
            state: step.state,
            info: step.tool_info
          });
        } else if (step.step_type === 'agent_response' && step.text_delta) {
          fullResponse += step.text_delta;
          onEvent && onEvent({
            type: 'delta',
            text: step.text_delta,
            conversation_id: finalConvId
          });
        }
      } else if (eventType === 'result') {
        const result = event.result || {};
        finalConvId = result.conversation_id || finalConvId;
        if (result.status === 'ERROR') {
          handleFailure(result.error || 'AGY execution error');
          return;
        }
        if (result.response) {
          fullResponse = result.response;
        }
        onEvent && onEvent({
          type: 'result',
          status: result.status,
          response: fullResponse,
          conversation_id: finalConvId,
          duration: result.duration_seconds
        });
      }
    } catch (err) {
      if (isQuotaExhaustedError(line)) {
        stderrData += '\n' + line;
      }
      onEvent && onEvent({ type: 'raw', text: line });
    }
  });

  activeChild.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
  });

  const handleFailure = (errReason) => {
    if (hasEnded) return;

    const combinedError = `${errReason} ${stderrData} ${fullResponse}`.trim();
    const isQuota = isQuotaExhaustedError(combinedError);
    const fallbackEnabled = isAutoFallbackEnabled();

    if (isQuota && fallbackEnabled && retryCount < maxRetries) {
      const currentAcc = getActiveAccount();
      if (currentAcc) {
        markAccountQuotaExceeded(currentAcc.id, combinedError);
      }

      const nextAcc = getNextFallbackAccount(currentAcc?.id);
      if (nextAcc) {
        try {
          switchActiveAccount(nextAcc.id, 'Auto fallback on quota limit');
          console.log(`[Auto-Fallback] Limit reached on ${currentAcc?.name || 'current account'}. Switched to: ${nextAcc.name}`);

          onEvent && onEvent({
            type: 'fallback_switch',
            message: `⚠️ Limit token/kuota tercapai pada ${currentAcc?.name || 'akun saat ini'}. Otomatis beralih ke akun "${nextAcc.name}" dan mencoba ulang...`,
            old_account: currentAcc?.name,
            new_account: nextAcc.name,
            retry_count: retryCount + 1
          });

          // Re-trigger with new account
          subController = streamAgyCore({
            prompt,
            conversationId,
            model,
            effort,
            workspaceDir: targetCwd,
            onEvent,
            onDone,
            onError,
            retryCount: retryCount + 1,
            maxRetries
          });
          return;
        } catch (switchErr) {
          console.error('[Auto-Fallback] Failed to switch account:', switchErr.message);
        }
      } else {
        console.warn('[Auto-Fallback] No other fallback accounts available in pool');
        onEvent && onEvent({
          type: 'fallback_exhausted',
          message: 'Semua akun AGY di fallback pool telah mencapai limit token atau kuota.'
        });
      }
    }

    hasEnded = true;
    onError && onError(new Error(stderrData || errReason || 'AGY process failed'));
  };

  activeChild.on('close', (code) => {
    if (hasEnded || subController) return;

    if (code !== 0 && !fullResponse) {
      handleFailure(stderrData || `AGY process exited with code ${code}`);
    } else {
      // Sync disk token in case AGY refreshed it during this turn
      syncDiskTokenToActiveAccount();

      hasEnded = true;
      onDone && onDone({
        response: fullResponse || stderrData || '(Tidak ada output dari AGY)',
        conversation_id: finalConvId,
        exitCode: code,
        account: activeAcc?.name
      });
    }
  });

  activeChild.on('error', (err) => {
    if (hasEnded || subController) return;
    handleFailure(err.message);
  });

  return {
    kill: () => {
      try {
        if (subController) {
          subController.kill();
        } else if (activeChild) {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${activeChild.pid} /T /F`);
          } else {
            activeChild.kill('SIGTERM');
          }
        }
      } catch (e) {}
    }
  };
}

function streamAgy(options) {
  return streamAgyCore(options);
}

module.exports = {
  getDefaultModels,
  getAvailableModels,
  streamAgy,
  streamAgyCore
};
