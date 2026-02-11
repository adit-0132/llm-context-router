// ChatGPT content script - extracts conversation data

// Listen for export requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportChatGPTConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function exportChatGPTConversation() {
  try {
    const chatId = window.location.pathname.split('/c/')[1];
    if (!chatId) {
      return { success: false, error: 'Open a conversation first' };
    }

    console.log('[ContextPorter] Chat ID:', chatId);

    // Get auth token from background script (it intercepts API calls)
    const authToken = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getChatGPTAuth' }, (response) => {
        resolve(response?.token || null);
      });
    });

    console.log('[ContextPorter] Auth token found:', !!authToken);

    const url = `https://chatgpt.com/backend-api/conversation/${chatId}`;

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json',
        'authorization': authToken,
      }
    });

    console.log('[ContextPorter] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ContextPorter] Error:', errorText);
      
      // If 401, token might be invalid
      if (response.status === 401) {
        return { success: false, error: 'Auth token expired. Refresh the page and try again.' };
      }
      
      return { success: false, error: `API returned ${response.status}` };
    }

    const rawData = await response.json();
    console.log('[ContextPorter] Raw data received');

    const llmchatData = convertChatGPTToLLMChat(rawData);
    console.log('[ContextPorter] Converted, messages:', llmchatData.messages.length);

    return {
      success: true,
      platform: 'chatgpt',
      conversationId: chatId,
      messageCount: llmchatData.messages.length,
      data: llmchatData
    };

  } catch (error) {
    console.error('[ContextPorter] Error:', error);
    return { success: false, error: error.message };
  }
}

function convertChatGPTToLLMChat(chatgptJson) {
  const messages = [];

  function traverseToRoot(nodeId, collected = []) {
    if (!nodeId || nodeId === 'client-created-root') return collected;

    const node = chatgptJson.mapping[nodeId];
    if (!node) return collected;

    if (node.message &&
        node.message.content &&
        node.message.content.parts &&
        node.message.content.parts.length > 0 &&
        node.message.content.parts[0] !== "" &&
        !node.message.metadata?.is_visually_hidden_from_conversation) {

      const role = node.message.author.role;

      if (role === 'user' || role === 'assistant') {
        const message = {
          id: node.message.id,
          role: role,
          content: node.message.content.parts
            .filter(p => typeof p === 'string')
            .join('\n'),
          timestamp: node.message.create_time
            ? new Date(node.message.create_time * 1000).toISOString()
            : null,
          metadata: {
            model_slug: node.message.metadata?.model_slug || null,
          }
        };

        // ── Extract file attachments ─────────────────────────────
        const artifacts = [];

        // Parse metadata.attachments (uploaded files like PDFs, CSVs, etc.)
        const attachments = node.message.metadata?.attachments;
        if (attachments && Array.isArray(attachments)) {
          for (const att of attachments) {
            if (att.mime_type && att.mime_type.startsWith('image/')) {
              artifacts.push({
                type: 'image',
                file_name: att.name || att.id || 'image',
                file_id: att.id || null,
              });
            } else {
              // Document attachment (PDF, text, CSV, etc.)
              // ChatGPT sometimes includes extracted text in the content parts
              let extractedContent = null;

              // Check if any non-string parts contain the file's text
              const textParts = node.message.content?.parts?.filter(
                p => typeof p === 'object' && p !== null && p.text
              );
              if (textParts && textParts.length > 0) {
                extractedContent = textParts.map(p => p.text).join('\n');
              }

              artifacts.push({
                type: 'document',
                file_name: att.name || att.id || 'document',
                file_type: att.mime_type || null,
                file_size: att.size || null,
                content: extractedContent || '[Content not extracted]',
              });
            }
          }
        }

        // Parse multimodal image parts (inline images in GPT-4 Vision)
        if (node.message.content?.parts) {
          for (const part of node.message.content.parts) {
            if (typeof part === 'object' && part !== null) {
              if (part.content_type === 'image_asset_pointer' ||
                  part.asset_pointer) {
                artifacts.push({
                  type: 'image',
                  file_name: part.metadata?.dalle?.prompt
                    ? `DALL-E: ${part.metadata.dalle.prompt.substring(0, 50)}`
                    : 'image',
                  file_id: part.asset_pointer || null,
                });
              }
            }
          }
        }

        if (artifacts.length > 0) {
          message.artifacts = artifacts;
        }

        collected.unshift(message);
      }
    }

    return traverseToRoot(node.parent, collected);
  }

  const conversationMessages = traverseToRoot(chatgptJson.current_node);

  function safeTimestamp(unixTime) {
    if (!unixTime) return new Date().toISOString();
    const date = new Date(unixTime * 1000);
    return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  return {
    version: "1.0",
    standard: "llmchat",
    metadata: {
      title: chatgptJson.title || "Untitled Conversation",
      created: safeTimestamp(chatgptJson.create_time),
      updated: safeTimestamp(chatgptJson.update_time),
      source_platform: "chatgpt.com",
      source_model: chatgptJson.default_model_slug || "gpt-4",
      conversation_id: chatgptJson.conversation_id,
      total_messages: conversationMessages.length,
    },
    messages: conversationMessages
  };
}