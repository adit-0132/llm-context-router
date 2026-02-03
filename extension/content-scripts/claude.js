// Claude content script - extracts conversation data

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportClaudeConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open
  }
});

async function exportClaudeConversation() {
  try {
    // Check if we're on a chat page
    const urlMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
    if (!urlMatch) {
      return { success: false, error: 'Open a conversation first' };
    }

    const conversationId = urlMatch[1];
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
      source_model: "claude-sonnet-4",
      conversation_id: claudeJson.uuid,
      total_messages: messages.length,
    },
    messages: messages
  };
}