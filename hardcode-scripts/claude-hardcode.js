// claude-extractor.js
(async () => {
  // Extract org_id and conversation_id from URL
  const urlMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
  
  if (!urlMatch) {
    console.error('Not on a Claude chat page. Open a conversation first.');
    return;
  }
  
  const conversationId = urlMatch[1];
  
  // Get org ID from cookie (lastActiveOrg)
  const orgIdMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]+)/);
  
  if (!orgIdMatch) {
    console.error('Could not find organization ID in cookies');
    return;
  }
  
  const orgId = orgIdMatch[1];
  
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`;
  
  console.log('Fetching conversation:', conversationId);
  
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'accept': 'application/json',
      'anthropic-client-version': '1.0.0',
      'anthropic-device-id': 'd13c0be4-6642-41da-984d-d01a7b710c0a', // Your device ID
      'content-type': 'application/json',
    }
  });
  
  if (!response.ok) {
    console.error('Failed:', response.status, response.statusText);
    const error = await response.text();
    console.error('Error:', error);
    return;
  }
  
  const data = await response.json();
  
  // Download
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `claude_${conversationId}.json`;
  a.click();
  
  console.log('✅ Downloaded Claude conversation');
  console.log('Messages:', data.chat_messages?.length || 'unknown');
})();