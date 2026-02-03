// ChatGPT content script - extracts conversation data

// Step 1: Inject interceptor into page context to capture auth token
// Content scripts run in isolated context, so we need to inject into the actual page
const interceptor = document.createElement('script');
interceptor.textContent = `
  (function() {
    window.__CHATGPT_AUTH_TOKEN__ = null;

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);

      // Grab auth token from any request that has it
      const options = args[1] || {};
      const headers = options.headers || {};

      if (headers['authorization']) {
        window.__CHATGPT_AUTH_TOKEN__ = headers['authorization'];
      }

      // Also check if it's a Request object
      if (args[0] instanceof Request && args[0].headers.get('authorization')) {
        window.__CHATGPT_AUTH_TOKEN__ = args[0].headers.get('authorization');
      }

      return response;
    };

    // Also intercept XMLHttpRequest just in case
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      if (name.toLowerCase() === 'authorization') {
        window.__CHATGPT_AUTH_TOKEN__ = value;
      }
      return originalSetHeader.apply(this, arguments);
    };

    console.log('[ContextPorter] Interceptor installed. Waiting for auth token...');
  })();
`;
document.head.appendChild(interceptor);

// Step 2: Listen for export requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportChatGPTConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Step 3: Read the token from the page context via another injected script
async function getAuthToken() {
  return new Promise((resolve) => {
    const reader = document.createElement('script');
    reader.textContent = `
      (function() {
        const event = new CustomEvent('__CP_AUTH_TOKEN__', {
          detail: { token: window.__CHATGPT_AUTH_TOKEN__ }
        });
        document.dispatchEvent(event);
      })();
    `;
    
    // Listen for the token
    const handler = (e) => {
      document.removeEventListener('__CP_AUTH_TOKEN__', handler);
      resolve(e.detail.token);
    };
    document.addEventListener('__CP_AUTH_TOKEN__', handler);

    document.head.appendChild(reader);
    document.head.removeChild(reader);
  });
}

async function exportChatGPTConversation() {
  try {
    const chatId = window.location.pathname.split('/c/')[1];
    if (!chatId) {
      return { success: false, error: 'Open a conversation first' };
    }

    console.log('[ContextPorter] Chat ID:', chatId);

    // Try to get the auth token
    const authToken = await getAuthToken();
    console.log('[ContextPorter] Auth token found:', !!authToken);

    if (!authToken) {
      // Token not captured yet - trigger a page action to generate one
      // Ask user to send a message or wait
      return { 
        success: false, 
        error: 'Auth token not captured yet. Send a message in the chat first, then try again.' 
      };
    }

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
      return { success: false, error: `API returned ${response.status}` };
    }

    const rawData = await response.json();
    console.log('[ContextPorter] Raw data received, mapping keys:', Object.keys(rawData.mapping || {}).length);

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
        collected.unshift({
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
        });
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