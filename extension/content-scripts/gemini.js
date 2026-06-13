// Gemini content script - extracts conversation data

// Bridge: allow triggering export_all from page context (for testing & automation)
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'context-porter-export-all') return;
  console.log('[ContextPorter] Export All triggered via postMessage');
  const result = await exportAllGeminiConversations();
  window.postMessage({ type: 'context-porter-export-all-result', result }, '*');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'export') {
    exportGeminiConversation()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'export_all') {
    exportAllGeminiConversations()
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function exportGeminiConversation() {
  try {
    const urlMatch = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
    if (!urlMatch) {
      return { success: false, error: 'Open a conversation first' };
    }

    const conversationId = urlMatch[1];
    console.log('[ContextPorter] Gemini conversation ID:', conversationId);

    const messages = extractMessagesFromDOM();

    if (messages.length === 0) {
      return { success: false, error: 'No messages found. Wait for the page to fully load and try again.' };
    }

    // Strip " - Gemini" suffix from page title
    const title = document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').trim() || 'Untitled Conversation';

    // Try to detect model name from UI
    const modelEl = document.querySelector(
      '.model-picker-trigger, [data-model-name], .model-name-label, .gds-label'
    );
    const sourceModel = modelEl?.textContent?.trim() || modelEl?.dataset?.modelName || 'gemini';

    console.log('[ContextPorter] Extracted', messages.length, 'messages');

    return {
      success: true,
      platform: 'gemini',
      conversationId,
      messageCount: messages.length,
      data: {
        version: '1.0',
        standard: 'llmchat',
        metadata: {
          title,
          created: null,
          updated: null,
          source_platform: 'gemini.google.com',
          source_model: sourceModel,
          conversation_id: conversationId,
          total_messages: messages.length,
        },
        messages,
      },
    };
  } catch (error) {
    console.error('[ContextPorter] Error:', error);
    return { success: false, error: error.message };
  }
}

async function exportAllGeminiConversations() {
  try {
    // Scrape sidebar for all conversation links
    const conversations = scrapeConversationList();
    console.log('[ContextPorter] Export All — found', conversations.length, 'conversations in sidebar');

    if (conversations.length === 0) {
      return { success: false, error: 'No conversations found in sidebar. Open the sidebar and try again.' };
    }

    // Gemini is a pure SPA — no API to fetch conversation data directly.
    // Return the conversation list so popup.js can navigate to each one
    // sequentially and collect exports via the single-chat `export` action.
    return {
      success: true,
      platform: 'gemini',
      needsSequentialExport: true,
      baseUrl: 'https://gemini.google.com/app',
      totalFound: conversations.length,
      conversations
    };
  } catch (error) {
    console.error('[ContextPorter] Export All error:', error);
    return { success: false, error: error.message };
  }
}

function scrapeConversationList() {
  // Match only sidebar conversation links (relative paths starting with /app/)
  // Exclude external links (e.g. Google account URLs that happen to contain /app/)
  const links = document.querySelectorAll('a[href^="/app/"]');
  const seen = new Set();
  const conversations = [];

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const title = link.textContent.trim() || 'Untitled';
    conversations.push({ id, title });
  }

  return conversations;
}

function extractMessagesFromDOM() {
  // Strategy 1: conversation-turn custom elements (Gemini's Angular component structure)
  const turns = document.querySelectorAll('conversation-turn');
  if (turns.length > 0) {
    console.log('[ContextPorter] Strategy 1: found', turns.length, 'conversation-turn elements');
    return extractFromTurns(turns);
  }

  // Strategy 2: role-marked message containers
  const roleMessages = document.querySelectorAll('[data-message-author-role]');
  if (roleMessages.length > 0) {
    console.log('[ContextPorter] Strategy 2: found', roleMessages.length, 'role-attributed elements');
    return extractFromRoleElements(roleMessages);
  }

  // Strategy 3: interleaved user-query / model-response siblings
  const queryEls = document.querySelectorAll('user-query, .user-query');
  const responseEls = document.querySelectorAll('model-response, .model-response');
  if (queryEls.length > 0 || responseEls.length > 0) {
    console.log('[ContextPorter] Strategy 3: found', queryEls.length, 'queries,', responseEls.length, 'responses');
    return extractFromSiblingPairs(queryEls, responseEls);
  }

  console.warn('[ContextPorter] No known Gemini DOM structure detected');
  return [];
}

// ── Strategy 1 ────────────────────────────────────────────────────────

function extractFromTurns(turns) {
  const messages = [];

  turns.forEach((turn, index) => {
    const userEl = turn.querySelector('user-query');
    if (userEl) {
      const text = extractUserText(userEl);
      if (text) {
        messages.push({
          id: `gemini-user-${index}`,
          role: 'user',
          content: text,
          timestamp: null,
          metadata: { index },
        });
      }
    }

    // Gemini sometimes shows multiple response drafts; pick the visible one
    const modelEls = turn.querySelectorAll('model-response');
    const visibleModel = Array.from(modelEls).find(
      el => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
    ) || modelEls[0];

    if (visibleModel) {
      const text = extractModelText(visibleModel);
      if (text) {
        messages.push({
          id: `gemini-assistant-${index}`,
          role: 'assistant',
          content: text,
          timestamp: null,
          metadata: { index },
        });
      }
    }
  });

  return messages;
}

// ── Strategy 2 ────────────────────────────────────────────────────────

function extractFromRoleElements(roleMessages) {
  const messages = [];

  roleMessages.forEach((el, index) => {
    const role = el.dataset.messageAuthorRole;
    if (role !== 'user' && role !== 'model' && role !== 'assistant') return;

    const normalizedRole = role === 'model' ? 'assistant' : role;
    const text = normalizedRole === 'user' ? extractUserText(el) : extractModelText(el);

    if (text) {
      messages.push({
        id: `gemini-${normalizedRole}-${index}`,
        role: normalizedRole,
        content: text,
        timestamp: null,
        metadata: { index },
      });
    }
  });

  return messages;
}

// ── Strategy 3 ────────────────────────────────────────────────────────

function extractFromSiblingPairs(queryEls, responseEls) {
  const messages = [];
  const count = Math.max(queryEls.length, responseEls.length);

  for (let i = 0; i < count; i++) {
    if (queryEls[i]) {
      const text = extractUserText(queryEls[i]);
      if (text) {
        messages.push({
          id: `gemini-user-${i}`,
          role: 'user',
          content: text,
          timestamp: null,
          metadata: { index: i },
        });
      }
    }

    if (responseEls[i]) {
      const text = extractModelText(responseEls[i]);
      if (text) {
        messages.push({
          id: `gemini-assistant-${i}`,
          role: 'assistant',
          content: text,
          timestamp: null,
          metadata: { index: i },
        });
      }
    }
  }

  return messages;
}

// ── Text Extraction ───────────────────────────────────────────────────

function extractUserText(el) {
  const clone = el.cloneNode(true);

  // Remove action buttons and UI chrome
  clone.querySelectorAll([
    'button',
    '[aria-hidden="true"]',
    '.edit-button',
    '.action-button',
    '.user-actions',
    'toolbar',
  ].join(', ')).forEach(e => e.remove());

  // Prefer explicit query content container if present
  const contentEl =
    clone.querySelector('.query-text, .query-content, .user-query-text, p') || clone;

  return (contentEl.textContent || '').trim();
}

function extractModelText(el) {
  const clone = el.cloneNode(true);

  // Remove UI chrome: feedback buttons, copy buttons, toolbars
  clone.querySelectorAll([
    'button',
    'toolbar',
    '.feedback-container',
    '.trailing-actions',
    '.response-footer',
    '.copy-button',
    '.options-container',
    '.export-button',
    '[aria-label*="thumb"]',
    '[aria-label*="copy"]',
    '[aria-label*="Share"]',
    'regenerate-button',
    '.draft-navigation',
  ].join(', ')).forEach(e => e.remove());

  // Find the rendered markdown container
  const contentEl =
    clone.querySelector('.markdown') ||
    clone.querySelector('message-content') ||
    clone.querySelector('.response-content') ||
    clone.querySelector('.model-response-text') ||
    clone.querySelector('.formatted-response') ||
    clone;

  return htmlToMarkdown(contentEl).trim();
}

// ── HTML → Markdown Conversion ────────────────────────────────────────

function htmlToMarkdown(root) {
  return processNode(root).replace(/\n{3,}/g, '\n\n').trim();
}

function processNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  // Skip hidden elements
  if (node.getAttribute('aria-hidden') === 'true') return '';

  // Fenced code blocks
  if (tag === 'pre') {
    const codeEl = node.querySelector('code');
    // Detect language from class like "language-python" or a label element
    const langClass = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
    const langLabel = node.querySelector('.code-block-language, [class*="language-label"]')?.textContent?.trim() || '';
    const lang = langClass || langLabel;
    const code = codeEl ? codeEl.textContent : node.textContent;
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }

  // Inline code
  if (tag === 'code') {
    return `\`${node.textContent}\``;
  }

  // Headings
  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1], 10);
    const hashes = '#'.repeat(level);
    const inner = Array.from(node.childNodes).map(processNode).join('');
    return `\n${hashes} ${inner.trim()}\n`;
  }

  // List items
  if (tag === 'li') {
    const parentTag = node.parentElement?.tagName?.toLowerCase();
    const bullet = parentTag === 'ol' ? '1.' : '-';
    const inner = Array.from(node.childNodes).map(processNode).join('').trim();
    return `\n${bullet} ${inner}`;
  }

  // Ordered / unordered list wrappers
  if (tag === 'ul' || tag === 'ol') {
    const inner = Array.from(node.childNodes).map(processNode).join('');
    return `\n${inner}\n`;
  }

  // Paragraphs and block-level elements
  if (tag === 'p' || tag === 'div' || tag === 'section') {
    const inner = Array.from(node.childNodes).map(processNode).join('');
    const trimmed = inner.trim();
    return trimmed ? `\n${trimmed}\n` : '';
  }

  // Line break
  if (tag === 'br') return '\n';

  // Bold
  if (tag === 'strong' || tag === 'b') {
    const inner = Array.from(node.childNodes).map(processNode).join('');
    return `**${inner}**`;
  }

  // Italic
  if (tag === 'em' || tag === 'i') {
    const inner = Array.from(node.childNodes).map(processNode).join('');
    return `*${inner}*`;
  }

  // Blockquote
  if (tag === 'blockquote') {
    const inner = Array.from(node.childNodes).map(processNode).join('').trim();
    return '\n' + inner.split('\n').map(l => `> ${l}`).join('\n') + '\n';
  }

  // Horizontal rule
  if (tag === 'hr') return '\n---\n';

  // Tables (simplified: collapse to plain text rows)
  if (tag === 'tr') {
    const cells = Array.from(node.querySelectorAll('td, th')).map(
      td => td.textContent.trim()
    );
    return `\n| ${cells.join(' | ')} |`;
  }

  // Default: recurse into children
  return Array.from(node.childNodes).map(processNode).join('');
}
