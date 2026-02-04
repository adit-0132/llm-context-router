// Background service worker - intercepts ChatGPT API calls to capture auth token

let chatgptAuthToken = null;

// Listen for ChatGPT API requests and extract auth header
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'authorization');
    
    if (authHeader && authHeader.value) {
      chatgptAuthToken = authHeader.value;
      console.log('[ContextPorter Background] Captured ChatGPT auth token');
    }
  },
  { 
    urls: [
      "https://chatgpt.com/backend-api/*",
      "https://chat.openai.com/backend-api/*"
    ] 
  },
  ["requestHeaders"]
);

// Provide token to content scripts when requested
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getChatGPTAuth') {
    sendResponse({ token: chatgptAuthToken });
  }
});

console.log('[ContextPorter Background] Service worker started');