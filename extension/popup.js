/**
 * Context Porter — Popup Controller
 *
 * Handles:
 *   - Platform detection
 *   - Quality slider + mode toggle
 *   - Export with compression (via Web Worker) or raw
 *   - Import .llmchat → markdown conversion
 *   - Progress updates and stats display
 */

// ── DOM References ──────────────────────────────────────────────────

const exportBtn            = document.getElementById('exportBtn');
const exportAllBtn         = document.getElementById('exportAllBtn');
const copyBtn              = document.getElementById('copyBtn');
const importBtn            = document.getElementById('importBtn');
const pasteBtn             = document.getElementById('pasteBtn');
const fileInput            = document.getElementById('fileInput');
const statusDiv            = document.getElementById('status');
const platformSpan         = document.getElementById('platform');
const exportProgressSpan   = document.getElementById('exportProgress');

const qualitySlider        = document.getElementById('qualitySlider');
const qualityValue         = document.getElementById('qualityValue');
const modeSmartBtn         = document.getElementById('modeSmartBtn');
const modeRawBtn           = document.getElementById('modeRawBtn');

const progressContainer    = document.getElementById('progressContainer');
const progressFill         = document.getElementById('progressFill');
const progressLabel        = document.getElementById('progressLabel');

const compressionStats     = document.getElementById('compressionStats');
const statOriginal         = document.getElementById('statOriginal');
const statCompressed       = document.getElementById('statCompressed');
const statRatio            = document.getElementById('statRatio');
const statSegments         = document.getElementById('statSegments');
const statTime             = document.getElementById('statTime');

const includeArtifactsCheckbox = document.getElementById('includeArtifacts');
const contextNameInput     = document.getElementById('contextName');

// ── State ───────────────────────────────────────────────────────────

let currentMode = 'smart'; // 'smart' | 'raw'
let compressionWorker = null;
let progressInterval = null;
let exportTabId = null;

// ── Platform Detection ──────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || !tabs[0] || !tabs[0].url) {
    platformSpan.textContent = 'No tab detected';
    exportBtn.disabled = true;
    return;
  }

  const url = tabs[0].url;

  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
    platformSpan.textContent = 'ChatGPT';
  } else if (url.includes('claude.ai')) {
    platformSpan.textContent = 'Claude';
  } else if (url.includes('gemini.google.com')) {
    platformSpan.textContent = 'Gemini';
  } else if (url.includes('grok.com')) {
    platformSpan.textContent = 'Grok';
  } else {
    platformSpan.textContent = 'Unsupported';
    exportBtn.disabled = true;
    copyBtn.disabled = true;
  }
});

// ── Resume active export on popup reopen ────────────────────────────
chrome.storage.session.get('exportProgress', (data) => {
  const p = data.exportProgress;
  if (!p) return;

  if (p.active) {
    setBusy(true);
    showStatus(`Export in progress (${p.platform})…`, 'info');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) startProgressPolling(tabs[0].id);
    });
  } else if (p.complete) {
    setBusy(true);
    showStatus('Export complete, packaging…', 'info');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) retrieveAndDownload(tabs[0].id, p.platform);
    });
  } else if (p.error) {
    showStatus('Export failed: ' + p.error, 'error');
    chrome.storage.session.remove('exportProgress');
  }
});

// Quality Slider

qualitySlider.addEventListener('input', () => {
  const val = parseInt(qualitySlider.value, 10);
  qualityValue.textContent = `${val}%`;

  // Auto-switch to raw if slider is at 100
  if (val >= 100 && currentMode !== 'raw') {
    setMode('raw');
  } else if (val < 100 && currentMode === 'raw') {
    setMode('smart');
  }
});

// Tick labels are clickable presets
document.querySelectorAll('.slider-ticks span').forEach(tick => {
  tick.addEventListener('click', () => {
    const val = parseInt(tick.dataset.val, 10);
    qualitySlider.value = val;
    qualityValue.textContent = `${val}%`;
    qualitySlider.dispatchEvent(new Event('input'));
  });
});

// ── Mode Toggle ─────────────────────────────────────────────────────

modeSmartBtn.addEventListener('click', () => setMode('smart'));
modeRawBtn.addEventListener('click', () => setMode('raw'));

function setMode(mode) {
  currentMode = mode;
  modeSmartBtn.classList.toggle('active', mode === 'smart');
  modeRawBtn.classList.toggle('active', mode === 'raw');

  // When switching to raw, set slider to 100
  if (mode === 'raw') {
    qualitySlider.value = 100;
    qualityValue.textContent = '100%';
  }
}

// Export Buttons
// Both Download and Copy share the same extraction + compression pipeline.
// They differ only in the final sink: file download vs. clipboard write.

exportBtn.addEventListener('click', () => runExport('download'));
copyBtn.addEventListener('click',   () => runExport('clipboard'));

// Export all chats (ZIP)
if (exportAllBtn) {
  exportAllBtn.addEventListener('click', () => {
    showStatus('Fetching all conversations…', 'info');
    setBusy(true);
    exportProgressSpan.textContent = '0%';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showStatus('No active tab found', 'error');
        setBusy(false);
        exportProgressSpan.textContent = '—';
        return;
      }

      const tabId = tabs[0].id;

      chrome.tabs.sendMessage(tabId, { action: 'export_all' }, async (response) => {
        if (chrome.runtime.lastError) {
          showStatus('Could not connect to page. Refresh and try again.', 'error');
          setBusy(false);
          exportProgressSpan.textContent = '—';
          return;
        }

        if (!response) {
          showStatus('No response from content script', 'error');
          setBusy(false);
          exportProgressSpan.textContent = '—';
          return;
        }

        // Content script is handling it async (Claude/ChatGPT)
        if (response.started) {
          startProgressPolling(tabId);
          return;
        }

        // Gemini: needs sequential navigation from popup
        if (response.needsSequentialExport) {
          await handleSequentialExport(tabId, response);
          return;
        }

        // Shouldn't reach here, but handle legacy direct-result format
        if (response.success) {
          await packAndDownloadZip(response);
        } else {
          showStatus('Error: ' + (response.error || 'Unknown'), 'error');
          setBusy(false);
          exportProgressSpan.textContent = '—';
        }
      });
    });
  });
}

async function handleSequentialExport(tabId, listResponse) {
  const convList = listResponse.conversations;
  const platform = listResponse.platform || 'chats';
  const baseUrl = listResponse.baseUrl || 'https://gemini.google.com/app';
  const results = [];
  const originalUrl = await getTabUrl(tabId);

  for (let i = 0; i < convList.length; i++) {
    const conv = convList[i];
    const pct = Math.round(((i) / convList.length) * 100);
    exportProgressSpan.textContent = `${pct}%`;
    chrome.storage.session.set({ exportProgress: { active: true, platform, current: i, total: convList.length } });
    showStatus(`Exporting ${i + 1}/${convList.length}: ${conv.title.slice(0, 30)}…`, 'info');

    try {
      // Navigate tab to this conversation
      const convUrl = `${baseUrl}/${conv.id}`;
      await navigateAndWait(tabId, convUrl);

      // Poll until the content script reports messages (SPA render time varies)
      const exportResult = await pollForExport(tabId, 15);

      if (exportResult && exportResult.success) {
        const safeName = (exportResult.data?.metadata?.title || conv.title || 'Untitled')
          .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
        results.push({ filename: `${safeName}_${platform}.llmchat`, data: exportResult.data });
      }
    } catch (err) {
      console.warn('[ContextPorter] Error exporting', conv.id, err.message);
    }
  }

  // Navigate back to original URL
  if (originalUrl) {
    try { await navigateAndWait(tabId, originalUrl); } catch (_) {}
  }

  if (results.length === 0) {
    showStatus('No conversations could be exported', 'error');
    setBusy(false);
    return;
  }

  await packAndDownloadZip({
    platform,
    totalFound: convList.length,
    exported: results.length,
    conversations: results
  });
}

async function packAndDownloadZip(response) {
  try {
    showStatus(`Packing ${response.exported || response.conversations.length} conversations into ZIP…`, 'info');

    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip library not loaded');
    }

    const zip = new JSZip();
    for (const conv of response.conversations) {
      zip.file(conv.filename, JSON.stringify(conv.data, null, 2));
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const platform = response.platform || 'chats';
    a.download = (getContextName() || `${platform}_chats`) + '.zip';
    a.click();
    URL.revokeObjectURL(url);

    showStatus(`Exported ${response.exported || response.conversations.length}/${response.totalFound || response.conversations.length} conversations`, 'success');
  } catch (err) {
    showStatus('ZIP creation failed: ' + err.message, 'error');
  } finally {
    exportProgressSpan.textContent = '—';
    chrome.storage.session.remove('exportProgress');
    setBusy(false);
  }
}

function startProgressPolling(tabId) {
  exportTabId = tabId;
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(async () => {
    const data = await chrome.storage.session.get('exportProgress');
    const p = data.exportProgress;
    if (!p) return;

    if (p.active) {
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      exportProgressSpan.textContent = `${pct}%`;
      if (p.total > 0) showStatus(`Exporting ${p.current}/${p.total} (${p.platform})…`, 'info');
    } else if (p.complete) {
      clearInterval(progressInterval);
      progressInterval = null;
      exportProgressSpan.textContent = '100%';
      await retrieveAndDownload(exportTabId || tabId, p.platform);
    } else if (p.error) {
      clearInterval(progressInterval);
      progressInterval = null;
      showStatus('Export failed: ' + p.error, 'error');
      exportProgressSpan.textContent = '—';
      chrome.storage.session.remove('exportProgress');
      setBusy(false);
    }
  }, 500);
}

async function retrieveAndDownload(tabId, platform) {
  showStatus('Packaging ZIP…', 'info');
  try {
    const data = await chrome.storage.local.get('exportAllResult');
    const result = data.exportAllResult;
    if (result && result.success) {
      await packAndDownloadZip(result);
      chrome.storage.local.remove('exportAllResult');
    } else {
      showStatus('Export finished but result was empty. Try again.', 'error');
      exportProgressSpan.textContent = '—';
      chrome.storage.session.remove('exportProgress');
      chrome.storage.local.remove('exportAllResult');
      setBusy(false);
    }
  } catch (err) {
    showStatus('Failed to package ZIP: ' + err.message, 'error');
    exportProgressSpan.textContent = '—';
    chrome.storage.session.remove('exportProgress');
    chrome.storage.local.remove('exportAllResult');
    setBusy(false);
  }
}

function getTabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(tab?.url || null));
  });
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Safety timeout: 30s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(); // resolve anyway to continue with next conversation
      }, 30000);
    });
  });
}

// Poll the tab for a successful export, retrying as the SPA renders.
async function pollForExport(tabId, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(1000);
    const result = await sendMessageToTab(tabId, { action: 'export' });
    if (result && result.success) return result;
  }
  return null;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runExport(sink) {
  showStatus('Extracting conversation...', 'info');
  setBusy(true);
  hideStats();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      showStatus('No active tab found', 'error');
      setBusy(false);
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: 'export' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Could not connect to page. Refresh and try again.', 'error');
        setBusy(false);
        return;
      }

      if (!response || !response.success) {
        showStatus('Error: ' + (response?.error || 'No response'), 'error');
        setBusy(false);
        return;
      }

      const quality = parseInt(qualitySlider.value, 10);
      const includeArtifacts = includeArtifactsCheckbox.checked;

      if (currentMode === 'raw' || quality >= 100) {
        let exportData = response.data;
        if (!includeArtifacts) {
          exportData = stripArtifacts(exportData);
        }
        deliver(exportData, response.platform, response.conversationId, response.messageCount, sink, 'raw');
      } else {
        runCompression(response.data, quality, response.platform, response.conversationId, includeArtifacts, sink);
      }
    });
  });
}

// Compression via Web Worker

function runCompression(llmchatData, quality, platform, conversationId, includeArtifacts, sink) {
  showProgress(true);
  updateProgress(0, 'Initializing compression...');

  compressionWorker = new Worker(
    chrome.runtime.getURL('compression/compression-worker.js'),
    { type: 'module' }
  );

  compressionWorker.onmessage = (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'progress':
        updateProgress(msg.fraction, msg.stage);
        break;

      case 'result':
        showProgress(false);
        showCompressionStats(msg.stats);
        deliver(msg.data, platform, conversationId, null, sink, 'compressed', msg.stats);
        compressionWorker.terminate();
        compressionWorker = null;
        break;

      case 'error':
        showProgress(false);
        showStatus('Compression error: ' + msg.message, 'error');
        setBusy(false);
        compressionWorker.terminate();
        compressionWorker = null;
        break;
    }
  };

  compressionWorker.onerror = (err) => {
    showProgress(false);
    showStatus('Worker error: ' + err.message, 'error');
    setBusy(false);
    compressionWorker = null;
  };

  compressionWorker.postMessage({
    type: 'compress',
    data: llmchatData,
    quality: quality,
    includeArtifacts: includeArtifacts,
  });
}

// Output sink — download or copy. Platform-agnostic: operates on .llmchat JSON.
async function deliver(data, platform, conversationId, messageCount, sink, kind, stats) {
  if (sink === 'clipboard') {
    try {
      await copyToClipboard(data);
      const label = kind === 'compressed'
        ? `Copied compressed chat (${stats.originalTokens} → ${stats.compressedTokens} tokens)`
        : `Copied ${messageCount} messages to clipboard`;
      showStatus(label, 'success');
    } catch (err) {
      showStatus('Clipboard copy failed: ' + err.message, 'error');
    }
  } else {
    downloadFile(data, platform, conversationId);
    const label = kind === 'compressed'
      ? `Compressed: ${stats.originalTokens} → ${stats.compressedTokens} tokens`
      : `Exported ${messageCount} messages (raw)`;
    showStatus(label, 'success');
  }
  setBusy(false);
}

function setBusy(busy) {
  exportBtn.disabled = busy;
  copyBtn.disabled   = busy;
}

// Progress UI 

function showProgress(visible) {
  progressContainer.classList.toggle('hidden', !visible);
}

function updateProgress(fraction, label) {
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  progressLabel.textContent = label;
}

// Stats Display

function showCompressionStats(stats) {
  compressionStats.classList.remove('hidden');

  statOriginal.textContent = formatTokens(stats.originalTokens);
  statCompressed.textContent = formatTokens(stats.compressedTokens);
  statRatio.textContent = `${Math.round(stats.ratio * 100)}%`;
  statSegments.textContent = `${stats.selectedSegments}/${stats.segments} segments`;

  const details = [`${stats.elapsed}ms`];
  if (stats.supersededCode > 0) details.push(`${stats.supersededCode} old code removed`);
  if (stats.eliminatedMeta > 0) details.push(`${stats.eliminatedMeta} meta removed`);
  statTime.textContent = details.join(' · ');
}

function hideStats() {
  compressionStats.classList.add('hidden');
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// Import Button

importBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const baseName = file.name.replace(/\.llmchat$/, '');
    processLlmchatText(text, baseName);
  } catch (error) {
    showStatus('Failed to read file: ' + error.message, 'error');
  }

  fileInput.value = '';
});

pasteBtn.addEventListener('click', async () => {
  showStatus('Reading clipboard...', 'info');
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showStatus('Clipboard is empty', 'error');
      return;
    }
    processLlmchatText(text, `pasted_${Date.now()}`);
  } catch (err) {
    showStatus('Clipboard read failed: ' + err.message, 'error');
  }
});

// Shared path for file-upload and paste-from-clipboard imports.
function processLlmchatText(text, baseName) {
  showStatus('Converting...', 'info');

  let llmchatData;
  try {
    llmchatData = JSON.parse(text);
  } catch (err) {
    showStatus('Not valid JSON: ' + err.message, 'error');
    return;
  }

  if (llmchatData.standard !== 'llmchat') {
    showStatus('Not a valid .llmchat payload', 'error');
    return;
  }

  const markdown = convertToMarkdown(llmchatData);
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const finalName = getContextName() || suffixedTitle(llmchatData.metadata) || baseName;
  const filename = `context-porter/${finalName}.md`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showStatus(`Converted ${llmchatData.messages.length} messages to markdown`, 'success');
}

// Markdown Conversion

function convertToMarkdown(llmchatData) {
  const isCompressed = llmchatData.version === '2.0' && llmchatData.compression_manifest;

  let md = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  md += `*Imported from ${llmchatData.metadata.source_platform}*\n`;

  if (isCompressed) {
    const m = llmchatData.metadata;
    const manifest = llmchatData.compression_manifest;
    md += `*Compressed: ${m.original_messages} messages → ${m.compressed_messages} messages*\n`;
    md += `*Compression ratio: ${Math.round(m.compression_ratio * 100)}% of original*\n`;
    md += `*Method: Semantic Graph + TextRank (quality: ${m.quality_level}%)*\n`;

    if (manifest.top_topics && manifest.top_topics.length > 0) {
      md += `*Key topics: ${manifest.top_topics.join(', ')}*\n`;
    }
  } else {
    md += `*${llmchatData.messages.length} messages*\n`;
  }

  md += `\n---\n\n`;

  llmchatData.messages.forEach((msg) => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    md += `### ${role}\n\n`;
    md += `${msg.content}\n\n`;

    if (msg.artifacts && msg.artifacts.length > 0) {
      msg.artifacts.forEach(artifact => {
        if (artifact.type === 'document' && artifact.content) {
          md += `**Attached: ${artifact.file_name}**\n\n`;
          md += `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
        } else if (artifact.type === 'image') {
          md += `*[Image: ${artifact.file_name}]*\n\n`;
        }
      });
    }

    md += `---\n\n`;
  });

  md += `*Continue the conversation:*\n`;
  return md;
}

// ── Utilities ───────────────────────────────────────────────────────

function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;

  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      statusDiv.className = 'status';
    }, 4000);
  }
}

function downloadFile(data, platform, conversationId) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const baseName = getContextName()
    || suffixedTitle(data.metadata, platform)
    || `${platform}_${conversationId || Date.now()}`;
  const filename = `context-porter/${baseName}.llmchat`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Returns sanitized name from the input, or null if empty.
function getContextName() {
  const raw = contextNameInput.value.trim();
  if (!raw) return null;
  return sanitizeName(raw);
}

// Strips filesystem-unsafe characters (/, \, :, *, ?, ", <, >, |) and collapses whitespace.
function sanitizeName(raw) {
  return raw.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 60);
}

// Default filename when no custom name is given: "<chat title>_<platform>".
// Returns null if the chat has no usable title, so callers can fall back further.
// platformOverride wins; otherwise the platform is derived from source_platform
// (e.g. "claude.ai" → "claude").
function suffixedTitle(metadata, platformOverride) {
  const title = metadata?.title;
  if (!title) return null;
  const clean = sanitizeName(title);
  if (!clean) return null;
  const platform = platformOverride || (metadata.source_platform || '').split('.')[0];
  return platform ? `${clean}_${platform}` : clean;
}

// Global clipboard sink — works for any .llmchat regardless of source platform.
// Uses navigator.clipboard.writeText (async, requires extension popup focus, which we have).
async function copyToClipboard(data) {
  const json = JSON.stringify(data, null, 2);
  await navigator.clipboard.writeText(json);
}

/**
 * Strip all artifacts from .llmchat data (when checkbox is unchecked).
 * Returns a new object — does not mutate the original.
 */
function stripArtifacts(data) {
  return {
    ...data,
    messages: data.messages.map(msg => {
      if (!msg.artifacts) return msg;
      const { artifacts, ...rest } = msg;
      return rest;
    })
  };
}