// Claude content script - extracts conversation data

// Bridge: allow triggering export_all from page context (for testing & automation)
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'context-porter-export-all') return;
  console.log('[ContextPorter] Export All triggered via postMessage');
  const result = await exportAllClaudeConversations();
  window.postMessage({ type: 'context-porter-export-all-result', result }, '*');
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'export') {
    exportClaudeConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'export_all') {
    chrome.storage.session.set({ exportProgress: { active: true, platform: 'claude', current: 0, total: 0 } });
    sendResponse({ started: true });
    exportAllClaudeConversations().then(result => {
      chrome.storage.local.set({ exportAllResult: result }, () => {
        chrome.storage.session.set({ exportProgress: { active: false, complete: true, platform: 'claude' } });
      });
    }).catch(err => {
      chrome.storage.session.set({ exportProgress: { active: false, error: err.message } });
    });
    return false;
  }
});

async function exportClaudeConversation() {
  try {
    const pathname = window.location.pathname;

    const shareMatch = pathname.match(/\/share\/([a-f0-9-]+)/);
    if (shareMatch) {
      return exportSharedConversation(shareMatch[1]);
    }

    const chatMatch = pathname.match(/\/chat\/([a-f0-9-]+)/);
    if (!chatMatch) {
      return { success: false, error: 'Open a conversation first' };
    }

    const conversationId = chatMatch[1];
    console.log('[ContextPorter] Conversation ID:', conversationId);

    // Get org ID from cookie
    const orgIdMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]+)/);
    if (!orgIdMatch) {
      return { success: false, error: 'Could not find org ID in cookies' };
    }

    const orgId = orgIdMatch[1];
    console.log('[ContextPorter] Org ID:', orgId);

    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`;
    console.log('[ContextPorter] Fetching:', url);

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json',
        'anthropic-client-version': '1.0.0',
        'content-type': 'application/json',
      }
    });

    console.log('[ContextPorter] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ContextPorter] Error response:', errorText);
      return { success: false, error: `API returned ${response.status}: ${errorText}` };
    }

    const rawData = await response.json();
    console.log('[ContextPorter] Raw data received, messages:', rawData.chat_messages?.length);

    const llmchatData = convertClaudeToLLMChat(rawData);
    console.log('[ContextPorter] Converted, messages:', llmchatData.messages.length);

    return {
      success: true,
      platform: 'claude',
      conversationId: conversationId,
      messageCount: llmchatData.messages.length,
      data: llmchatData
    };

  } catch (error) {
    console.error('[ContextPorter] Error:', error);
    return { success: false, error: error.message };
  }
}

async function exportSharedConversation(shareId) {
  console.log('[ContextPorter] Shared conversation ID:', shareId);

  // Try API first using the viewer's org ID
  const orgIdMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]+)/);
  if (orgIdMatch) {
    try {
      const url = `https://claude.ai/api/organizations/${orgIdMatch[1]}/chat_snapshots/${shareId}?rendering_mode=messages&render_all_tools=true`;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'accept': 'application/json', 'anthropic-client-version': '1.0.0' },
      });
      if (response.ok) {
        const rawData = await response.json();
        const llmchatData = convertSnapshotToLLMChat(rawData, shareId);
        return { success: true, platform: 'claude', conversationId: shareId, messageCount: llmchatData.messages.length, data: llmchatData };
      }
    } catch (_) {}
  }

  // Fallback: DOM scraping
  const messages = extractSharedMessagesFromDOM();
  if (messages.length === 0) {
    return { success: false, error: 'Could not extract messages from shared page' };
  }

  const title = document.querySelector('h1, title')?.textContent?.trim() || 'Shared Conversation';
  const llmchatData = {
    version: "1.0",
    standard: "llmchat",
    metadata: { title, source_platform: "claude.ai", source_model: "claude", conversation_id: shareId, total_messages: messages.length },
    messages,
  };
  return { success: true, platform: 'claude', conversationId: shareId, messageCount: messages.length, data: llmchatData };
}

function convertSnapshotToLLMChat(snapshot, shareId) {
  const messages = [];

  for (const msg of (snapshot.chat_messages || [])) {
    const textContent = (msg.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n\n')
      .trim();

    if (!textContent) continue;

    messages.push({
      id: msg.uuid,
      role: msg.sender === 'human' ? 'user' : 'assistant',
      content: textContent,
      timestamp: msg.created_at || null,
      metadata: { index: msg.index, stop_reason: msg.stop_reason || null },
    });
  }

  return {
    version: "1.0",
    standard: "llmchat",
    metadata: {
      title: snapshot.snapshot_name || 'Shared Conversation',
      created: snapshot.created_at || null,
      source_platform: "claude.ai",
      source_model: "claude",
      conversation_id: snapshot.conversation_uuid || shareId,
      total_messages: messages.length,
    },
    messages,
  };
}

function extractSharedMessagesFromDOM() {
  // Strategy 1: data-testid attributes (most reliable)
  const humanTurns = document.querySelectorAll('[data-testid="human-turn"]');
  const aiTurns = document.querySelectorAll('[data-testid="ai-turn"]');
  if (humanTurns.length > 0 || aiTurns.length > 0) {
    return extractFromTestIdTurns();
  }

  // Strategy 2: interleaved turn containers by role class
  const turns = document.querySelectorAll('.human-turn, .ai-turn, [class*="humanTurn"], [class*="aiTurn"]');
  if (turns.length > 0) {
    return extractFromClassTurns(turns);
  }

  // Strategy 3: look for message role attributes
  const roleEls = document.querySelectorAll('[data-message-author-role]');
  if (roleEls.length > 0) {
    return Array.from(roleEls).map((el, i) => ({
      id: `shared_msg_${i}`,
      role: el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant',
      content: el.innerText.trim(),
      timestamp: null,
      metadata: {},
    })).filter(m => m.content);
  }

  return [];
}

function extractFromTestIdTurns() {
  // Collect all turns in DOM order, tagging each with its role
  const all = document.querySelectorAll('[data-testid="human-turn"], [data-testid="ai-turn"]');
  const messages = [];

  Array.from(all).forEach((el, i) => {
    const isHuman = el.getAttribute('data-testid') === 'human-turn';
    const content = extractTurnText(el, isHuman);
    if (!content) return;
    messages.push({
      id: `shared_msg_${i}`,
      role: isHuman ? 'user' : 'assistant',
      content,
      timestamp: null,
      metadata: {},
    });
  });

  return messages;
}

function extractFromClassTurns(turns) {
  const messages = [];
  Array.from(turns).forEach((el, i) => {
    const cls = el.className || '';
    const isHuman = /human/i.test(cls);
    const content = extractTurnText(el, isHuman);
    if (!content) return;
    messages.push({
      id: `shared_msg_${i}`,
      role: isHuman ? 'user' : 'assistant',
      content,
      timestamp: null,
      metadata: {},
    });
  });
  return messages;
}

function extractTurnText(el, isHuman) {
  const clone = el.cloneNode(true);

  // Remove action buttons and UI chrome
  clone.querySelectorAll('button, [role="button"], .copy-button, .action-bar').forEach(n => n.remove());

  if (isHuman) {
    return clone.innerText.trim();
  }

  // For assistant: prefer the prose/markdown container
  const prose = clone.querySelector('.prose, [class*="prose"], .markdown, [class*="markdown"]');
  return (prose || clone).innerText.trim();
}

async function exportAllClaudeConversations() {
  try {
    const orgIdMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]+)/);
    if (!orgIdMatch) {
      return { success: false, error: 'Could not find org ID in cookies' };
    }
    const orgId = orgIdMatch[1];
    console.log('[ContextPorter] Export All — org:', orgId);

    const allConversations = [];
    let offset = 0;
    const limit = 30;

    while (true) {
      const listUrl = `https://claude.ai/api/organizations/${orgId}/chat_conversations_v2?limit=${limit}&offset=${offset}&consistency=eventual`;
      const listRes = await fetch(listUrl, {
        credentials: 'include',
        headers: { 'accept': 'application/json', 'anthropic-client-version': '1.0.0' }
      });

      if (!listRes.ok) {
        return { success: false, error: `Failed to list conversations: ${listRes.status}` };
      }

      const page = await listRes.json();
      const items = Array.isArray(page) ? page : (page.data || []);
      if (items.length === 0) break;
      allConversations.push(...items);
      if (items.length < limit) break;
      offset += limit;
    }

    console.log('[ContextPorter] Found', allConversations.length, 'conversations');

    if (allConversations.length === 0) {
      return { success: false, error: 'No conversations found' };
    }

    const results = [];
    for (let i = 0; i < allConversations.length; i++) {
      const conv = allConversations[i];
      chrome.storage.session.set({ exportProgress: { active: true, platform: 'claude', current: i, total: allConversations.length } });
      try {
        const apiUrl = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conv.uuid}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`;
        const resp = await fetch(apiUrl, {
          credentials: 'include',
          headers: { 'accept': 'application/json', 'anthropic-client-version': '1.0.0', 'content-type': 'application/json' }
        });

        if (!resp.ok) {
          console.warn('[ContextPorter] Skip', conv.uuid, resp.status);
          continue;
        }

        const raw = await resp.json();
        const llmchat = convertClaudeToLLMChat(raw);
        const title = (llmchat.metadata.title || 'Untitled')
          .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

        results.push({ filename: `${title}_claude.llmchat`, data: llmchat });
      } catch (err) {
        console.warn('[ContextPorter] Error fetching', conv.uuid, err.message);
      }
    }

    return {
      success: true,
      platform: 'claude',
      totalFound: allConversations.length,
      exported: results.length,
      conversations: results
    };
  } catch (error) {
    console.error('[ContextPorter] Export All error:', error);
    return { success: false, error: error.message };
  }
}

function convertClaudeToLLMChat(claudeJson) {
  const messages = [];

  if (!claudeJson.chat_messages || !Array.isArray(claudeJson.chat_messages)) {
    console.error('[ContextPorter] No chat_messages found in response');
    return { version: "1.0", standard: "llmchat", metadata: {}, messages: [] };
  }

  claudeJson.chat_messages.forEach((msg) => {
    let textContent = '';

    if (msg.content && msg.content.length > 0) {
      textContent = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n\n');
    }

    // Skip empty messages
    if (!textContent.trim()) return;

    const artifacts = [];

    if (msg.attachments && msg.attachments.length > 0) {
      msg.attachments.forEach(att => {
        artifacts.push({
          type: 'document',
          file_name: att.file_name,
          file_type: att.file_type,
          content: att.extracted_content || '[Content not extracted]',
        });
      });
    }

    if (msg.files_v2 && msg.files_v2.length > 0) {
      msg.files_v2.forEach(file => {
        if (file.file_kind === 'image') {
          artifacts.push({
            type: 'image',
            file_name: file.file_name,
            file_uuid: file.file_uuid,
          });
        }
      });
    }

    const message = {
      id: msg.uuid,
      role: msg.sender === 'human' ? 'user' : 'assistant',
      content: textContent,
      timestamp: msg.created_at,
      metadata: {
        index: msg.index,
        stop_reason: msg.stop_reason || null,
      }
    };

    if (artifacts.length > 0) {
      message.artifacts = artifacts;
    }

    messages.push(message);
  });

  return {
    version: "1.0",
    standard: "llmchat",
    metadata: {
      title: claudeJson.name || "Untitled Conversation",
      created: claudeJson.created_at || null,
      updated: claudeJson.updated_at || null,
      source_platform: "claude.ai",
      source_model: "claude",
      conversation_id: claudeJson.uuid,
      total_messages: messages.length,
    },
    messages: messages
  };
}