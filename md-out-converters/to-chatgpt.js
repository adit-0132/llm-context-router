// llmchat-to-chatgpt.js
function convertLLMChatToChatGPT(llmchatData) {
  let markdown = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  markdown += `*Imported from ${llmchatData.metadata.source_platform} on ${new Date().toISOString().split('T')[0]}*\n\n`;
  markdown += `---\n\n`;
  
  llmchatData.messages.forEach((msg, idx) => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    markdown += `## ${role} (Message ${idx + 1})\n\n`;
    markdown += `${msg.content}\n\n`;
    
    // Handle artifacts (attachments/files)
    if (msg.artifacts && msg.artifacts.length > 0) {
      msg.artifacts.forEach(artifact => {
        if (artifact.type === 'document' && artifact.content) {
          markdown += `### Attached Document: ${artifact.file_name}\n\n`;
          markdown += `\`\`\`${artifact.file_type || 'text'}\n`;
          markdown += `${artifact.content}\n`;
          markdown += `\`\`\`\n\n`;
        } else if (artifact.type === 'image') {
          markdown += `*[Image attachment: ${artifact.file_name}]*\n\n`;
        }
      });
    }
    
    markdown += `---\n\n`;
  });
  
  markdown += `**Continue the conversation below:**\n\n`;
  
  return markdown;
}

const fs = require('fs');
const inputFile = process.argv[2];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error('Usage: node llmchat-to-chatgpt.js <llmchat-file>');
  process.exit(1);
}

const llmchatData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const markdown = convertLLMChatToChatGPT(llmchatData);

const outputFile = inputFile.replace('.llmchat', '_for_chatgpt.md');
fs.writeFileSync(outputFile, markdown);

console.log('✅ Converted to ChatGPT format');
console.log('📁 Output:', outputFile);
console.log('📝 Upload this markdown file to ChatGPT to continue the conversation');