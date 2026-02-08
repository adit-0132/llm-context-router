// llmchat-to-markdown.js — Handles both v1.0 and v2.0 (compressed) schemas

function convertLLMChatToMarkdown(llmchatData, targetPlatform = 'generic') {
  const isCompressed = llmchatData.version === '2.0' && llmchatData.compression_manifest;

  let markdown = `# Previous Conversation: ${llmchatData.metadata.title}\n\n`;
  markdown += `*Imported from ${llmchatData.metadata.source_platform}*\n`;

  if (isCompressed) {
    const m = llmchatData.metadata;
    const manifest = llmchatData.compression_manifest;
    markdown += `*Compressed: ${m.original_messages} messages → ${m.compressed_messages} messages*\n`;
    markdown += `*Compression: kept ${Math.round(m.compression_ratio * 100)}% of original content*\n`;
    markdown += `*Method: ${m.compression_method} (quality: ${m.quality_level}%)*\n`;

    if (manifest.top_topics && manifest.top_topics.length > 0) {
      markdown += `*Key topics: ${manifest.top_topics.join(', ')}*\n`;
    }

    markdown += `\n> Note: This conversation has been semantically compressed.\n`;
    markdown += `> ${manifest.dropped_segments} segments were removed:\n`;
    markdown += `> ${manifest.dropped_categories.redundant} redundant, `;
    markdown += `${manifest.dropped_categories.meta} meta/pleasantries, `;
    markdown += `${manifest.dropped_categories.superseded} superseded, `;
    markdown += `${manifest.dropped_categories.low_rank} low-relevance.\n`;
  } else {
    markdown += `*${llmchatData.messages.length} messages total*\n`;
  }

  markdown += `\n---\n\n`;

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

if (llmchatData.version === '2.0') {
  const m = llmchatData.metadata;
  console.log(`📊 Compressed: ${m.original_messages} → ${m.compressed_messages} messages (${Math.round(m.compression_ratio * 100)}% kept)`);
}

console.log('📝 Upload this file to ChatGPT or Claude to continue');