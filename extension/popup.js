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
const importBtn            = document.getElementById('importBtn');
const fileInput            = document.getElementById('fileInput');
const statusDiv            = document.getElementById('status');
const platformSpan         = document.getElementById('platform');
const messageCountSpan     = document.getElementById('messageCount');

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
const artifactHint         = document.getElementById('artifactHint');

// ── State ───────────────────────────────────────────────────────────

let currentMode = 'smart'; // 'smart' | 'raw'
let compressionWorker = null;

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
  } else {
    platformSpan.textContent = 'Unsupported';
    exportBtn.disabled = true;
  }
});

// ── Quality Slider ──────────────────────────────────────────────────

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

// ── Export Button ───────────────────────────────────────────────────

exportBtn.addEventListener('click', () => {
  showStatus('Extracting conversation...', 'info');
  exportBtn.disabled = true;
  hideStats();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      showStatus('No active tab found', 'error');
      exportBtn.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: 'export' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Could not connect to page. Refresh and try again.', 'error');
        exportBtn.disabled = false;
        return;
      }

      if (!response || !response.success) {
        showStatus('Error: ' + (response?.error || 'No response'), 'error');
        exportBtn.disabled = false;
        return;
      }

      messageCountSpan.textContent = `${response.messageCount}`;

      const quality = parseInt(qualitySlider.value, 10);
      const includeArtifacts = includeArtifactsCheckbox.checked;

      if (currentMode === 'raw' || quality >= 100) {
        // Raw export — no compression
        let exportData = response.data;
        if (!includeArtifacts) {
          exportData = stripArtifacts(exportData);
        }
        downloadFile(exportData, response.platform, response.conversationId);
        showStatus(`Exported ${response.messageCount} messages (raw)`, 'success');
        exportBtn.disabled = false;
      } else {
        // Smart compression via Web Worker
        runCompression(response.data, quality, response.platform, response.conversationId, includeArtifacts);
      }
    });
  });
});

// ── Compression via Web Worker ──────────────────────────────────────

function runCompression(llmchatData, quality, platform, conversationId, includeArtifacts) {
  showProgress(true);
  updateProgress(0, 'Initializing compression...');

  // Create a module worker (Chrome MV3 supports this)
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
        downloadFile(msg.data, platform, conversationId);
        showCompressionStats(msg.stats);
        showStatus(
          `Compressed: ${msg.stats.originalTokens} → ${msg.stats.compressedTokens} tokens`,
          'success'
        );
        exportBtn.disabled = false;
        compressionWorker.terminate();
        compressionWorker = null;
        break;

      case 'error':
        showProgress(false);
        showStatus('Compression error: ' + msg.message, 'error');
        exportBtn.disabled = false;
        compressionWorker.terminate();
        compressionWorker = null;
        break;
    }
  };

  compressionWorker.onerror = (err) => {
    showProgress(false);
    showStatus('Worker error: ' + err.message, 'error');
    exportBtn.disabled = false;
    compressionWorker = null;
  };

  compressionWorker.postMessage({
    type: 'compress',
    data: llmchatData,
    quality: quality,
    includeArtifacts: includeArtifacts,
  });
}

// ── Progress UI ─────────────────────────────────────────────────────

function showProgress(visible) {
  progressContainer.classList.toggle('hidden', !visible);
}

function updateProgress(fraction, label) {
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  progressLabel.textContent = label;
}

// ── Stats Display ───────────────────────────────────────────────────

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

// ── Import Button ───────────────────────────────────────────────────

importBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showStatus('Converting...', 'info');

  try {
    const text = await file.text();
    const llmchatData = JSON.parse(text);

    if (llmchatData.standard !== 'llmchat') {
      showStatus('Not a valid .llmchat file', 'error');
      fileInput.value = '';
      return;
    }

    const markdown = convertToMarkdown(llmchatData);

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const filename = `context-porter/${file.name.replace('.llmchat', '.md')}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showStatus(`Converted ${llmchatData.messages.length} messages to markdown`, 'success');

  } catch (error) {
    showStatus('Failed to parse file: ' + error.message, 'error');
  }

  fileInput.value = '';
});

// ── Markdown Conversion ─────────────────────────────────────────────

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
  const filename = `context-porter/${platform}_${conversationId || Date.now()}.llmchat`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
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