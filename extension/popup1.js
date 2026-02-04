const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');
const platformSpan = document.getElementById('platform');
const messageCountSpan = document.getElementById('messageCount');

// Check current platform on load
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
  } else {
    platformSpan.textContent = 'Unsupported platform';
    exportBtn.disabled = true;
  }
});

// Export button
exportBtn.addEventListener('click', () => {
  showStatus('Extracting conversation...', 'info');
  exportBtn.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      showStatus('No active tab found', 'error');
      exportBtn.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: 'export' }, (response) => {
      exportBtn.disabled = false;

      // Handle messaging errors
      if (chrome.runtime.lastError) {
        showStatus('Could not connect to page. Refresh and try again.', 'error');
        return;
      }

      if (!response) {
        showStatus('No response from page. Refresh and try again.', 'error');
        return;
      }

      if (!response.success) {
        showStatus('Error: ' + (response.error || 'Unknown error'), 'error');
        return;
      }

      // Download using blob URL + anchor tag instead of chrome.downloads
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const filename = `${response.platform}_${response.conversationId || Date.now()}.llmchat`;

      // Create a temporary anchor and click it
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Cleanup blob url
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      messageCountSpan.textContent = `${response.messageCount} messages`;
      showStatus(`Exported ${response.messageCount} messages`, 'success');
    });
  });
});

// Import button
importBtn.addEventListener('click', () => {
  fileInput.click();
});

// File input handler
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

    // Download markdown
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const filename = file.name.replace('.llmchat', '.md');

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

// Utility functions
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;

  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      statusDiv.className = 'status';
    }, 3000);
  }
}

function convertToMarkdown(llmchatData) {
  let md = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  md += `*Imported from ${llmchatData.metadata.source_platform}*\n`;
  md += `*${llmchatData.messages.length} messages*\n\n`;
  md += `---\n\n`;

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