# Context Porter

A browser extension for migrating LLM conversations between ChatGPT and Claude without losing context.

## Problem

When you hit context limits or want to switch between AI platforms, you lose your entire conversation history. Copy-pasting is tedious and loses formatting, attachments, and metadata.

## Solution

Context Porter extracts conversations from ChatGPT, Claude, Gemini et Grok converts them to a universal `.llmchat` format, and allows seamless import to either platform.

---

## Features

- **One-click export** from ChatGPT, Claude, Gemini and Grok
- **Universal format** (.llmchat) preserves full conversation history
- **Cross-platform migration** - start on ChatGPT, continue on Claude (or vice versa)
- **Preserves context** - messages, timestamps, attachments, code blocks
- **Markdown export** for manual upload when needed

---

## Installation

### From Source

1. Clone this repository:
```bash
   git clone https://github.com/yourusername/context-porter.git
   cd context-porter
```

2. Install dependencies:
```bash
   npm install
```

3. Load extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `extension/` directory

---

## Usage

### Exporting a Conversation

1. Open a chat on ChatGPT or Claude
2. Click the Context Porter extension icon
3. Click "Export Chat"
4. Save the `.llmchat` file

### Importing to Another Platform

#### Option 1: Direct Import (Coming Soon)
The extension will support one-click import.

#### Option 2: Manual Import (Current)
1. Convert `.llmchat` to markdown:
```bash
   node llmchat-to-markdown.js conversation.llmchat
```

2. Upload the generated `.md` file to ChatGPT or Claude using their file upload feature

3. Add a prompt like: "Continue helping me with this topic"

---

## The .llmchat Format

A standardized JSON format for LLM conversations:
```json
{
  "version": "1.0",
  "standard": "llmchat",
  "metadata": {
    "title": "Conversation title",
    "created": "2026-01-29T20:16:05Z",
    "source_platform": "chatgpt.com",
    "source_model": "gpt-4",
    "total_messages": 10
  },
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "Message text",
      "timestamp": "2026-01-29T20:16:05Z",
      "artifacts": []
    }
  ]
}
```

---

## Development

### Project Structure
```
context-porter/
├── extension/              # Chrome extension files
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   └── content-scripts/
│       ├── chatgpt.js
│       └── claude.js
├── converters/             # Conversion scripts
│   ├── chatgpt-to-llmchat.js
│   ├── claude-to-llmchat.js
│   └── llmchat-to-markdown.js
└── README.md
```

### Conversion Pipeline

1. **Extract** - Content scripts scrape conversation data from ChatGPT/Claude
2. **Convert** - Transform platform-specific JSON to `.llmchat` format
3. **Import** - Convert `.llmchat` to markdown for upload

### Supported Platforms

| Platform | Export | Import |
|----------|--------|--------|
| ChatGPT  | ✓      | ✓      |
| Claude   | ✓      | ✓      |
| Gemini   | Planned| Planned|
| Perplexity| Planned| Planned|

---

## Manual Conversion (Without Extension)

### ChatGPT Export

1. Open ChatGPT conversation
2. Open browser console (F12)
3. Run the extraction script:
```javascript
   // See docs/manual-export.md for full script
```
4. Convert to .llmchat:
```bash
   node converters/chatgpt-to-llmchat.js chatgpt_export.json
```

### Claude Export

1. Open Claude conversation
2. Open browser console (F12)
3. Run the extraction script:
```javascript
   // See docs/manual-export.md for full script
```
4. Convert to .llmchat:
```bash
   node converters/claude-to-llmchat.js claude_export.json
```

---

## Limitations

### What's Preserved
- Message text and formatting
- Conversation structure and order
- Timestamps
- Text attachments and code blocks
- Basic metadata (model used, creation date)

### What's Not Preserved
- Platform-specific features (ChatGPT Canvas, Claude Artifacts as interactive elements)
- Images (stored as references, not embedded)
- Branched conversation paths (only active branch exported)
- Real-time web search results
- Custom GPT configurations

---

## Authentication

The extension uses your existing browser session cookies. It never stores or transmits credentials. All processing happens locally.

**Security notes:**
- Conversations are exported locally only
- No data sent to external servers
- Auth tokens extracted from active sessions expire naturally
- Clear browser data to invalidate tokens

---

## Contributing

Contributions welcome. Focus areas:

1. **Additional platforms** - Gemini, Perplexity, Grok support
2. **Direct import** - Eliminate manual markdown upload step
3. **Artifact preservation** - Better handling of platform-specific features
4. **Compression** - Smart summarization for oversized conversations

### Development Setup
```bash
git clone https://github.com/yourusername/context-porter.git
cd context-porter
npm install
npm run build
```

---

## License

MIT License - see LICENSE file

---

## Roadmap

- [x] ChatGPT export
- [x] Claude export  
- [x] .llmchat format specification
- [x] Markdown conversion
- [ ] Chrome extension packaging
- [ ] Firefox support
- [ ] Direct import (no markdown intermediary)
- [ ] Conversation compression for context limits
- [ ] Artifact format translation
- [ ] Additional platform support

---

## FAQ

**Q: Why not just copy-paste?**  
A: Copy-paste loses formatting, code blocks, attachments, and metadata. Also tedious for long conversations.

**Q: Does this work with free tier accounts?**  
A: Yes. Export works regardless of account tier. Import requires file upload capability (available on most free tiers).

**Q: Can I edit .llmchat files?**  
A: Yes, they're just JSON. Edit with any text editor, then convert to markdown.

**Q: What if the destination LLM doesn't support file upload?**  
A: Paste the markdown content directly into the chat. May hit character limits on very long conversations.

**Q: Is my data sent anywhere?**  
A: No. All conversion happens locally in your browser or via local Node.js scripts.

---

## Acknowledgments

Built to solve the friction of switching between LLM platforms while maintaining conversation continuity.

Inspired by the need for conversation portability across AI tools.
