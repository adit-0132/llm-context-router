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
          content: node.message.content.parts.join('\n'),
          timestamp: node.message.create_time 
            ? new Date(node.message.create_time * 1000).toISOString()
            : null,
          metadata: {
            model_slug: node.message.metadata?.model_slug,
            finish_details: node.message.metadata?.finish_details,
          }
        });
      }
    }
    
    return traverseToRoot(node.parent, collected);
  }
  
  const conversationMessages = traverseToRoot(chatgptJson.current_node);
  
  // Safe timestamp conversion
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
      is_archived: chatgptJson.is_archived,
    },
    messages: conversationMessages
  };
}

// Load from file
const fs = require('fs');
const chatgptData = JSON.parse(fs.readFileSync('./rawdata/chatgpt2.json', 'utf8'));
const llmchatData = convertChatGPTToLLMChat(chatgptData);

// Save
fs.writeFileSync('./output.llmchat', JSON.stringify(llmchatData, null, 2));
console.log('✅ Converted:', llmchatData.messages.length, 'messages');