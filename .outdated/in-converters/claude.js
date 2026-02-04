// claude-converter.js
function convertClaudeToLLMChat(claudeJson) {
  const messages = [];
  
  claudeJson.chat_messages.forEach((msg, index) => {
    // Extract text content
    let textContent = '';
    if (msg.content && msg.content.length > 0) {
      textContent = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n\n');
    }
    
    // Handle attachments
    const artifacts = [];
    
    // Text attachments (like uploaded files)
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
    
    // Image attachments
    if (msg.files_v2 && msg.files_v2.length > 0) {
      msg.files_v2.forEach(file => {
        artifacts.push({
          type: 'image',
          file_name: file.file_name,
          file_uuid: file.file_uuid,
          preview_url: file.preview_url,
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
        truncated: msg.truncated,
        stop_reason: msg.stop_reason,
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
      source_model: "claude-sonnet-4", // Claude doesn't expose model in API response
      conversation_id: claudeJson.uuid,
      total_messages: messages.length,
      is_starred: claudeJson.is_starred,
      settings: claudeJson.settings,
    },
    messages: messages
  };
}

// Load from file
const fs = require('fs');
const inputFile = process.argv[2];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error('Usage: node claude-converter.js <claude-json-file>');
  console.error('Example: node claude-converter.js claude_6e34081c-7953-480f-9870-d856bde7833a.json');
  process.exit(1);
}

const claudeData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const llmchatData = convertClaudeToLLMChat(claudeData);

const outputFile = inputFile.replace('.json', '.llmchat');
fs.writeFileSync(outputFile, JSON.stringify(llmchatData, null, 2));

console.log('✅ Converted:', llmchatData.messages.length, 'messages');
console.log('📁 Output:', outputFile);