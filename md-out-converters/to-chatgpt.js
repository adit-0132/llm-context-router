// llmchat-to-chatgpt.js — Handles both v1.0 and v2.0 (compressed) schemas

function convertLLMChatToChatGPT(llmchatData) {
  const isCompressed = llmchatData.version === '2.0' && llmchatData.compression_manifest;

  let markdown = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  markdown += `*Imported from ${llmchatData.metadata.source_platform}`;
  markdown += ` on ${new Date().toISOString().split('T')[0]}*\n`;

  if (isCompressed) {
    const m = llmchatData.metadata;
    markdown += `*Compressed: ${m.original_messages} messages → ${m.compressed_messages} messages`;
    markdown += ` (${Math.round(m.compression_ratio * 100)}% of original)*\n`;

    const manifest = llmchatData.compression_manifest;
    if (manifest.top_topics && manifest.top_topics.length > 0) {
      markdown += `*Key topics: ${manifest.top_topics.join(', ')}*\n`;
    }
  }

  markdown += `\n---\n\n`;

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

if (llmchatData.version === '2.0') {
  const m = llmchatData.metadata;
  console.log(`📊 Compressed: ${m.original_messages} → ${m.compressed_messages} messages (${Math.round(m.compression_ratio * 100)}% kept)`);
}

console.log('📝 Upload this markdown file to ChatGPT to continue the conversation');