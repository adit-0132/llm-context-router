// llmchat-to-claude.js — Handles both v1.0 and v2.0 (compressed) schemas

function convertLLMChatToClaude(llmchatData) {
  const isCompressed = llmchatData.version === '2.0' && llmchatData.compression_manifest;

  let markdown = `# Continuing conversation: ${llmchatData.metadata.title}\n\n`;
  markdown += `*Originally from ${llmchatData.metadata.source_platform}`;

  if (isCompressed) {
    const m = llmchatData.metadata;
    markdown += `, ${m.original_messages} messages compressed to ${m.compressed_messages}`;
    markdown += ` (${Math.round(m.compression_ratio * 100)}% of original)*\n\n`;

    const manifest = llmchatData.compression_manifest;
    if (manifest.top_topics && manifest.top_topics.length > 0) {
      markdown += `*Key topics: ${manifest.top_topics.join(', ')}*\n\n`;
    }
  } else {
    markdown += `, ${llmchatData.messages.length} messages*\n\n`;
  }

  llmchatData.messages.forEach((msg) => {
    const prefix = msg.role === 'user' ? '**You:**' : '**Assistant:**';
    markdown += `${prefix}\n${msg.content}\n\n`;

    if (msg.artifacts && msg.artifacts.length > 0) {
      msg.artifacts.forEach(artifact => {
        if (artifact.type === 'document' && artifact.content) {
          markdown += `<details>\n<summary>📎 ${artifact.file_name}</summary>\n\n`;
          markdown += `\`\`\`\n${artifact.content}\n\`\`\`\n\n`;
          markdown += `</details>\n\n`;
        }
      });
    }
  });

  markdown += `---\n\n*Please continue helping with this topic.*\n`;

  return markdown;
}

const fs = require('fs');
const inputFile = process.argv[2];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error('Usage: node llmchat-to-claude.js <llmchat-file>');
  process.exit(1);
}

const llmchatData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const markdown = convertLLMChatToClaude(llmchatData);

const outputFile = inputFile.replace('.llmchat', '_for_claude.md');
fs.writeFileSync(outputFile, markdown);

console.log('✅ Converted to Claude format');
console.log('📁 Output:', outputFile);

if (llmchatData.version === '2.0') {
  const m = llmchatData.metadata;
  console.log(`📊 Compressed: ${m.original_messages} → ${m.compressed_messages} messages (${Math.round(m.compression_ratio * 100)}% kept)`);
}

console.log('📝 Upload this markdown file to Claude to continue the conversation');