// Grok content script - extracts conversation data via internal REST API

const GROK_ORIGIN = 'https://grok.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 10000;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'export') {
    exportGrokConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function exportGrokConversation() {
  try {
    const match = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (!match || !UUID_RE.test(match[1])) {
      return { success: false, error: 'Open a conversation first' };
    }
    const conversationId = match[1];

    const rawData = await fetchInPageContext(conversationId);
    const llmchatData = convertGrokToLLMChat(rawData, conversationId);

    return {
      success: true,
      platform: 'grok',
      conversationId,
      messageCount: llmchatData.messages.length,
      data: llmchatData,
    };

  } catch (error) {
    console.error('[ContextPorter] Grok export error:', error);
    return { success: false, error: error.message };
  }
}

// Delegate fetch to grok-fetch.js (MAIN world) via postMessage.
// Uses a unique msgId so concurrent exports don't cross-wire.
// Times out after FETCH_TIMEOUT_MS to avoid hanging indefinitely.
function fetchInPageContext(conversationId) {
  return new Promise((resolve, reject) => {
    const msgId = `__cp_grok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for Grok data. Reload the page and try again.'));
    }, FETCH_TIMEOUT_MS);

    function onMessage(e) {
      if (e.origin !== GROK_ORIGIN) return;
      if (!e.data || e.data.type !== msgId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (e.data.ok) resolve(e.data.data);
      else reject(new Error(e.data.error));
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: '__cp_grok_fetch', conversationId, msgId }, GROK_ORIGIN);
  });
}

function convertGrokToLLMChat(rawData, conversationId) {
  const responses = rawData.responses || [];
  const messages = [];

  let sourceModel = 'grok';
  for (const resp of responses) {
    if (resp.model) { sourceModel = resp.model; break; }
  }

  for (const resp of responses) {
    if (resp.isControl || resp.partial) continue;
    if (!resp.message && !resp.fileAttachments?.length) continue;

    // Grok uses 'human' for user; everything else is assistant
    const role = resp.sender === 'human' ? 'user' : 'assistant';

    const message = {
      id: resp.responseId,
      role,
      content: resp.message || '',
      timestamp: resp.createTime || null,
      metadata: {
        model: resp.model || null,
        parentResponseId: resp.parentResponseId || null,
      },
    };

    const artifacts = [];

    if (resp.fileAttachmentsMetadata?.length > 0) {
      for (const meta of resp.fileAttachmentsMetadata) {
        artifacts.push({
          type: meta.fileMimeType?.startsWith('image/') ? 'image' : 'document',
          file_name: meta.fileName || meta.fileMetadataId,
          file_type: meta.fileMimeType || null,
          content: '[Content not extracted]',
        });
      }
    }

    if (resp.generatedImageUrls?.length > 0) {
      for (const url of resp.generatedImageUrls) {
        artifacts.push({ type: 'image', file_name: 'generated_image', file_id: url });
      }
    }

    if (artifacts.length > 0) message.artifacts = artifacts;

    messages.push(message);
  }

  return {
    version: '1.0',
    standard: 'llmchat',
    metadata: {
      title: document.title.replace(/\s*[\|–\-]\s*Grok.*$/i, '').trim() || 'Grok Conversation',
      created: new Date().toISOString(),
      source_platform: 'grok.com',
      source_model: sourceModel,
      conversation_id: conversationId,
      total_messages: messages.length,
    },
    messages,
  };
}
