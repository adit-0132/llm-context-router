// llmchat-to-markdown.js
function convertLLMChatToMarkdown(llmchatData, targetPlatform = 'generic') {
  let markdown = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  markdown += `*Imported from ${llmchatData.metadata.source_platform}*\n`;
  markdown += `*${llmchatData.messages.length} messages total*\n\n`;
  markdown += `---\n\n`;
  
  llmchatData.messages.forEach((msg, idx) => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    markdown += `### ${role}\n\n`;
    markdown += `${msg.content}\n\n`;
    
    // Handle artifacts
    if (msg.artifacts && msg.artifacts.length > 0) {
      msg.artifacts.forEach(artifact => {
        if (artifact.type === 'document' && artifact.content) {
          markdown += `**Attached: ${artifact.file_name}**\n\n`;
          markdown += `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
        } else if (artifact.type === 'image') {
          markdown += `*[Image: ${artifact.file_name}]*\n\n`;
        }
      });
    }
    
    markdown += `---\n\n`;
  });
  
  markdown += `*Continue the conversation:*\n`;
  
  return markdown;
}

const fs = require('fs');
const inputFile = process.argv[2];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error('Usage: node llmchat-to-markdown.js <llmchat-file>');
  process.exit(1);
}

const llmchatData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const markdown = convertLLMChatToMarkdown(llmchatData);

const outputFile = inputFile.replace('.llmchat', '.md');
fs.writeFileSync(outputFile, markdown);

console.log('✅ Converted to markdown');
console.log('📁 Output:', outputFile);
console.log('📝 Upload this file to ChatGPT or Claude to continue');