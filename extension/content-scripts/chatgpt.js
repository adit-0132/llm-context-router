// ChatGPT content script - extracts conversation data

// Bridge: allow triggering export_all from page context (for testing & automation)
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'context-porter-export-all') return;
  console.log('[ContextPorter] Export All triggered via postMessage');
  const result = await exportAllChatGPTConversations();
  window.postMessage({ type: 'context-porter-export-all-result', result }, '*');
});

// Listen for export requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportChatGPTConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'export_all') {
    chrome.storage.session.set({ exportProgress: { active: true, platform: 'chatgpt', current: 0, total: 0 } });
    sendResponse({ started: true });
    exportAllChatGPTConversations().then(result => {
      chrome.storage.local.set({ exportAllResult: result }, () => {
        chrome.storage.session.set({ exportProgress: { active: false, complete: true, platform: 'chatgpt' } });
      });
    }).catch(err => {
      chrome.storage.session.set({ exportProgress: { active: false, error: err.message } });
    });
    return false;
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

async function exportAllChatGPTConversations() {
  try {
    const authToken = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getChatGPTAuth' }, (response) => {
        resolve(response?.token || null);
      });
    });

    if (!authToken) {
      return { success: false, error: 'Auth token not found. Refresh the page first.' };
    }

    console.log('[ContextPorter] Export All — fetching conversation list');

    const allConversations = [];
    let offset = 0;
    const limit = 28;

    while (true) {
      const listUrl = `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
      const listRes = await fetch(listUrl, {
        credentials: 'include',
        headers: {
          'accept': 'application/json',
          'authorization': authToken,
        }
      });

      if (!listRes.ok) {
        return { success: false, error: `Failed to list conversations: ${listRes.status}` };
      }

      const page = await listRes.json();
      const items = page.items || [];
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
      chrome.storage.session.set({ exportProgress: { active: true, platform: 'chatgpt', current: i, total: allConversations.length } });
      try {
        const resp = await fetch(`https://chatgpt.com/backend-api/conversation/${conv.id}`, {
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'authorization': authToken,
          }
        });

        if (!resp.ok) {
          console.warn('[ContextPorter] Skip', conv.id, resp.status);
          continue;
        }

        const raw = await resp.json();
        const llmchat = convertChatGPTToLLMChat(raw);
        const title = (llmchat.metadata.title || 'Untitled')
          .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

        results.push({ filename: `${title}_chatgpt.llmchat`, data: llmchat });
      } catch (err) {
        console.warn('[ContextPorter] Error fetching', conv.id, err.message);
      }
    }

    console.log('[ContextPorter] Exported', results.length, 'of', allConversations.length);

    return {
      success: true,
      platform: 'chatgpt',
      totalFound: allConversations.length,
      exported: results.length,
      conversations: results
    };
  } catch (error) {
    console.error('[ContextPorter] Export All error:', error);
    return { success: false, error: error.message };
  }
}

function convertChatGPTToLLMChat(chatgptJson) {
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