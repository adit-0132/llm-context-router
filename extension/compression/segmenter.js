/**
 * Structural Segmenter
 *
 * Splits raw .llmchat messages into typed semantic segments.
 *
 * Segment types:
 *   - code:      fenced code blocks (triple backticks) — treated as atomic
 *   - question:  ends with '?' or starts with interrogative words
 *   - decision:  contains decision/conclusion language
 *   - meta:      greetings, thanks, pleasantries — low value
 *   - list:      bullet/numbered list items
 *   - reasoning: default — explanations, analysis, discussion
 *
 * Each segment also carries:
 *   - isArtifact:   true for code, decisions, structured lists (the "deliverables")
 *   - codeLanguage: for code segments, the language identifier (e.g., 'javascript')
 */

import { STOPWORDS } from './stopwords.js';
import { DEFAULT_CONFIG } from './config.js';

// ── Regex patterns for segment classification ───────────────────────

const CODE_FENCE_RE = /^```[\s\S]*?^```/gm;

const DECISION_PHRASES = [
  /\b(?:let'?s?\s+(?:go\s+with|use|try|do|proceed|stick\s+with))\b/i,
  /\b(?:i'?(?:ll|m\s+going\s+to)\s+(?:use|go\s+with|implement|create|build|make))\b/i,
  /\b(?:the\s+(?:solution|answer|approach|fix|best\s+way)\s+is)\b/i,
  /\b(?:we\s+should|i\s+(?:decided|recommend|suggest))\b/i,
  /\b(?:here'?s?\s+(?:the|my)\s+(?:final|updated|revised|corrected))\b/i,
];

const META_PHRASES = [
  /^(?:thanks?|thank\s+you|thx|ty)[\s!.]*$/i,
  /^(?:sure|okay|ok|alright|got\s+it|sounds?\s+good|great|perfect|wonderful|awesome|nice)[\s!.]*$/i,
  /^(?:you'?re\s+welcome|no\s+problem|happy\s+to\s+help|glad\s+to\s+help)[\s!.]*$/i,
  /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))[\s!.,]*$/i,
  /^(?:let\s+me\s+know\s+if)\b/i,
  /^(?:feel\s+free\s+to)\b/i,
  /^(?:hope\s+(?:this|that)\s+helps?)/i,
  /^(?:is\s+there\s+anything\s+else)/i,
];

const QUESTION_STARTERS = /^(?:what|how|why|when|where|which|who|whom|whose|can|could|would|should|is|are|do|does|did|have|has|will)\b/i;

const LIST_ITEM_RE = /^(?:\s*[-*+•]|\s*\d+[.)]\s)/;

// ── Tokenizer ───────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words, stripping punctuation and stopwords.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Estimate token count (for LLM context budget tracking).
 * @param {string} text
 * @param {number} [charsPerToken]
 * @returns {number}
 */
function estimateTokens(text, charsPerToken = DEFAULT_CONFIG.charsPerToken) {
  return Math.ceil(text.length / charsPerToken);
}

// ── Segment type classification ─────────────────────────────────────

/**
 * Classify a text segment into a type.
 * @param {string} text - The segment text (NOT a code block — those are pre-classified)
 * @returns {'decision' | 'question' | 'meta' | 'list' | 'reasoning'}
 */
function classifySegment(text) {
  const trimmed = text.trim();
  if (!trimmed) return 'meta';

  // Meta: short pleasantries
  for (const re of META_PHRASES) {
    if (re.test(trimmed)) return 'meta';
  }

  // Decision: contains decision language
  for (const re of DECISION_PHRASES) {
    if (re.test(trimmed)) return 'decision';
  }

  // Question: ends with ? or starts with interrogative
  if (trimmed.endsWith('?') || QUESTION_STARTERS.test(trimmed)) {
    return 'question';
  }

  // List: every line starts with a list marker
  const lines = trimmed.split('\n').filter(l => l.trim());
  if (lines.length > 1 && lines.every(l => LIST_ITEM_RE.test(l))) {
    return 'list';
  }

  return 'reasoning';
}

// ── Main segmenter ──────────────────────────────────────────────────

/**
 * @typedef {Object} Segment
 * @property {string}  id                 - "msg_{index}_seg_{segIndex}"
 * @property {number}  messageIndex       - Index in the messages array
 * @property {string}  messageId          - UUID of the parent message
 * @property {'user'|'assistant'} role
 * @property {'code'|'reasoning'|'decision'|'question'|'meta'|'list'} type
 * @property {boolean} isArtifact         - True for deliverables (code, decisions, structured lists)
 * @property {string|null} codeLanguage   - Language identifier for code blocks, null otherwise
 * @property {string}  content            - Raw text
 * @property {string[]} tokens            - Preprocessed tokens
 * @property {number}  tokenEstimate      - Rough LLM token count
 * @property {number}  positionNormalized - 0.0 (first msg) → 1.0 (last msg)
 */

/**
 * Segment all messages in an .llmchat conversation.
 *
 * @param {Object[]} messages - The messages array from .llmchat
 * @returns {Segment[]}
 */
export function segmentMessages(messages) {
  const segments = [];
  const totalMessages = messages.length;

  messages.forEach((msg, msgIdx) => {
    const content = msg.content || '';
    if (!content.trim()) return;

    const position = totalMessages > 1
      ? msgIdx / (totalMessages - 1)
      : 0.5;

    // ── Step 1: Extract code blocks as atomic segments ────────────
    // We split the content around code fences.
    const parts = [];
    let lastIndex = 0;

    // Reset regex state
    CODE_FENCE_RE.lastIndex = 0;
    let match;

    while ((match = CODE_FENCE_RE.exec(content)) !== null) {
      // Text before the code block
      const before = content.slice(lastIndex, match.index).trim();
      if (before) {
        parts.push({ text: before, isCode: false });
      }
      // The code block itself
      parts.push({ text: match[0], isCode: true });
      lastIndex = match.index + match[0].length;
    }

    // Remaining text after last code block
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      parts.push({ text: remaining, isCode: false });
    }

    // If no parts were generated (e.g., no code blocks, but content was all whitespace)
    if (parts.length === 0 && content.trim()) {
      parts.push({ text: content.trim(), isCode: false });
    }

    // ── Step 2: Further split non-code parts into paragraphs ─────
    let segIndex = 0;

    for (const part of parts) {
      if (part.isCode) {
        // Code block: atomic segment — extract language from fence
        const langMatch = part.text.match(/^```(\w*)/);
        const codeLanguage = (langMatch && langMatch[1]) ? langMatch[1].toLowerCase() : null;

        segments.push({
          id: `msg_${msgIdx}_seg_${segIndex}`,
          messageIndex: msgIdx,
          messageId: msg.id,
          role: msg.role,
          type: 'code',
          isArtifact: true,
          codeLanguage,
          content: part.text,
          tokens: tokenize(part.text),
          tokenEstimate: estimateTokens(part.text),
          positionNormalized: position,
        });
        segIndex++;
      } else {
        // Split by double newlines (paragraphs) or significant breaks
        const paragraphs = part.text
          .split(/\n\s*\n/)
          .map(p => p.trim())
          .filter(p => p.length > 0);

        for (const para of paragraphs) {
          const type = classifySegment(para);
          // Decisions and structured lists are artifacts (deliverables)
          const isArtifact = (type === 'decision') ||
            (type === 'list' && para.split('\n').length >= 3);

          segments.push({
            id: `msg_${msgIdx}_seg_${segIndex}`,
            messageIndex: msgIdx,
            messageId: msg.id,
            role: msg.role,
            type,
            isArtifact,
            codeLanguage: null,
            content: para,
            tokens: tokenize(para),
            tokenEstimate: estimateTokens(para),
            positionNormalized: position,
          });
          segIndex++;
        }
      }
    }
  });

  return segments;
}
