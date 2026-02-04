// Claude content script - extracts conversation data

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportClaudeConversation().then(sendResponse);
    return true;
  }
});

async function exportClaudeConversation() {
  try {
    const urlMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
    
    if (!urlMatch) {
      return { success: false, error: 'Not on a conversation page' };
    }
    
    const conversationId = urlMatch[1];
    
    // Get org ID from cookie
    const orgIdMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]+)/);
    
    if (!orgIdMatch) {
      return { success: false, error: 'Organization ID not found' };
    }
    
    const orgId = orgIdMatch[1];
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
    
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json',
        'anthropic-client-version': '1.0.0',
        'content-type': 'application/json',
      }
    });
    
    if (!response.ok) {
      return { success: false, error: 'Failed to fetch conversation' };
    }
    
    const rawData = await response.json();
    const llmchatData = convertClaudeToLLMChat(rawData);
    
    return {
      success: true,
      platform: 'claude',
      conversationId: conversationId,
      messageCount: llmchatData.messages.length,
      data: llmchatData
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function convertClaudeToLLMChat(claudeJson) {
  const messages = [];
  
  claudeJson.chat_messages.forEach((msg) => {
    let textContent = '';
    if (msg.content && msg.content.length > 0) {
      textContent = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n\n');
    }
    
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
    
    const message = {
      id: msg.uuid,
      role: msg.sender === 'human' ? 'user' : 'assistant',
      content: textContent,
      timestamp: msg.created_at,
      metadata: {
        index: msg.index,
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
      created: claudeJson.created_at,
      updated: claudeJson.updated_at,
      source_platform: "claude.ai",
      source_model: "claude-sonnet-4",
      conversation_id: claudeJson.uuid,
      total_messages: messages.length,
    },
    messages: messages
  };
}