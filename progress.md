# Context Porter — Project State

## What It Is

A Chrome extension that exports LLM conversations from ChatGPT, Claude, Gemini, and Grok into a portable `.llmchat` JSON format, then optionally compresses them using a client-side semantic pipeline before importing into another LLM as markdown.

---

## Supported Platforms

| Platform | URL | Extraction Method |
|----------|-----|-------------------|
| ChatGPT | `chatgpt.com`, `chat.openai.com` | Internal REST API (`/backend-api/conversation/:id`) with auth token intercepted by background worker |
| Claude | `claude.ai` | Internal REST API (`/api/organizations/:orgId/chat_conversations/:id`) via session cookie |
| Gemini | `gemini.google.com` | DOM scraping — 3 fallback strategies (custom elements → role attributes → sibling pairs) with HTML→markdown conversion |
| Grok | `grok.com` | Internal REST API (`/rest/app-chat/conversations/:id/load-responses`) — fetch intercepted in MAIN world to bypass CSP and origin restrictions |

---

## File Structure

```
extension/
├── manifest.json                    # MV3, host permissions for all 4 platforms
├── popup.html / popup.css / popup.js # UI: export controls, compression slider, import
├── background.js                    # Service worker: intercepts ChatGPT auth token
├── content-scripts/
│   ├── chatgpt.js                   # ChatGPT extractor + llmchat converter
│   ├── claude.js                    # Claude extractor + llmchat converter
│   ├── gemini.js                    # Gemini DOM scraper + HTML→markdown converter
│   ├── grok.js                      # Grok extractor (isolated world) + llmchat converter
│   └── grok-fetch.js                # Grok fetch interceptor (MAIN world) — bridges origin restriction
└── compression/
    ├── compression-worker.js        # Web Worker: orchestrates the 3-layer pipeline
    ├── config.js                    # All tunable parameters (frozen object + presets)
    ├── stopwords.js                 # ~175 English stopwords (Set)
    ├── segmenter.js                 # Stage 1: structural segmentation
    ├── tfidf.js                     # Stage 2: TF-IDF vectorization
    ├── analyzer.js                  # Layer 1: supersession + meta elimination
    ├── graph.js                     # TF-IDF similarity queries (cosine)
    ├── ranker.js                    # Layer 2 scoring + Layer 3 selection
    └── composer.js                  # Output assembly → .llmchat v2.0 + manifest
```

---

## .llmchat Schema

### v1.0 (raw export)
```json
{
  "version": "1.0",
  "standard": "llmchat",
  "metadata": {
    "title": "...",
    "source_platform": "claude.ai | chatgpt.com | gemini.google.com",
    "source_model": "...",
    "conversation_id": "...",
    "total_messages": 42
  },
  "messages": [
    {
      "id": "uuid",
      "role": "user | assistant",
      "content": "...",
      "timestamp": "ISO8601 | null",
      "metadata": {},
      "artifacts": []  // optional: attached files/images
    }
  ]
}
```

### v2.0 (compressed export)
Adds `compression_manifest` with kept/dropped segment counts, top topics, and per-category drop reasons (`redundant`, `meta`, `superseded`, `low_rank`).

---

## Compression Engine — 3-Layer Pipeline

The entire pipeline runs client-side in a Web Worker (no API calls, deterministic, offline-capable). The Web Worker keeps the popup UI responsive during the O(N²) computation.

### Pipeline Overview

```
Raw .llmchat
    ↓
[segmenter.js]   Stage 1: Split messages into typed segments
    ↓
[analyzer.js]    Layer 1: Remove superseded code + meta/pleasantries
    ↓
[ranker.js]      Layer 2: Score segments (novelty × recency × role weight)
    ↓
[ranker.js]      Layer 3: Select segments (anchors → dependencies → density fill)
    ↓
[composer.js]    Reassemble → .llmchat v2.0 with compression manifest
```

---

### Stage 1 — Structural Segmentation (`segmenter.js`)

Splits each message into typed, atomic `Segment` objects:

```
Segment {
  id:                 "msg_003_seg_02"
  messageIndex:       3
  messageId:          "uuid"
  role:               "user" | "assistant"
  type:               "code" | "document" | "reasoning" | "decision" | "question" | "meta" | "list"
  isArtifact:         true for code, documents, decisions, structured lists (≥3 items)
  codeLanguage:       "javascript" | null
  artifactFileName:   filename for document segments | null
  content:            raw text
  tokens:             lowercase words, punctuation stripped, stopwords removed
  tokenEstimate:      chars / 4
  positionNormalized: 0.0 (first message) → 1.0 (last message)
}
```

**Type classification rules (regex-based, no ML):**
- `code`: fenced triple-backtick blocks — always atomic, never split
- `document`: attached files (PDFs, text uploads) — atomic artifacts
- `decision`: matches phrases like "let's go with", "I'll use", "the solution is"
- `question`: ends with `?` or starts with an interrogative word
- `meta`: greetings, thanks, affirmations, pleasantries
- `list`: every line starts with `-`, `*`, `1.`, etc.
- `reasoning`: everything else (default)

---

### Layer 1 — Structural Analysis (`analyzer.js`)

Deterministic cleanup before any scoring. Zero math — pure pattern matching.

#### Code Supersession Detection
Detects when a code block is an older version of a later code block.

```
supersedes(codeA, codeB) =
    codeA appears BEFORE codeB
    AND same language (or both unspecified)
    AND Jaccard(tokens(codeA), tokens(codeB)) > 0.30
```

Jaccard similarity: `|A ∩ B| / |A ∪ B|` on token sets. Threshold 0.30 catches rewrites (which share ~30%+ identifiers) without false-positiving unrelated code blocks.

Superseded (stale) segments are removed from the candidate pool entirely. In practice eliminates ~20 obsolete code blocks from a 90-message coding conversation.

#### Meta Elimination
Segments classified as `meta` are removed entirely (not just penalized). Also removes short user acknowledgments: `role === 'user'`, `length ≤ 80 chars`, no `?`, type is `reasoning`, ≤6 words.

---

### Layer 2 — Information-Theoretic Scoring (`ranker.js → Scorer`)

Each surviving segment gets a composite score:

```
score = (novelty × recency × roleWeight) + (artifactBoost × recency)
```

**novelty** — average IDF of the segment's terms. High IDF = rare in conversation = novel information. Measures how much new information the segment contributes vs. what's already been said.

**recency** — exponential decay from end of conversation:
```
recency = e^(-λ × (1 - position))    λ = 2.0
  position 1.0 (latest):  recency = 1.000
  position 0.5 (middle):  recency = 0.368
  position 0.0 (oldest):  recency = 0.135
```

**roleWeight** — role and content type multipliers:
| Segment Type | Weight |
|---|---|
| Assistant with code / artifact | 2.0 |
| Assistant with decision | 1.8 |
| User with question / requirement | 1.5 |
| User / assistant default | 0.8 |
| Assistant explanation only | 0.6 |
| User short acknowledgment | 0.2 |

**artifactBoost** — flat additive `3.0 × recency` for any `isArtifact` segment. Prevents code blocks (which are long and low-density) from losing to short high-density text segments.

This scoring directly fixes the v1 TextRank problem where user prompts outranked assistant code: an assistant code block now scores ~3–4× higher than a same-length user prompt.

---

### Layer 3 — Dependency-Aware Selection (`ranker.js → Selector`)

Replaces top-down greedy selection with a backward dependency resolution algorithm.

#### Step 1: Seed Anchors (always kept)
- First user message — problem statement
- All segments of the last assistant message — current state
- All non-superseded code blocks from the last 30% of the conversation

#### Step 2: Resolve Dependencies
For each anchor, find earlier segments that introduced concepts it depends on:

```
for each rare_term in anchor.tokens:        // IDF > median IDF
    originSegment = earliest segment containing rare_term
    if originSegment != anchor AND originSegment is earlier:
        pull it in as a dependency
```

Cap: max 5 dependencies per anchor (prevents combinatorial explosion). Rare terms are sorted by IDF descending so the rarest (most meaningful) terms drive dependency resolution.

#### Step 3: Density-Sorted Fill
Fill remaining token budget from the leftover pool:
1. Sort by `density = score / tokenEstimate` (information per token — a knapsack formulation)
2. For each candidate: skip if `max cosine_similarity(candidate, any_selected) > 0.70` (MMR diversity constraint)
3. Stop at token budget

---

### Configuration (`config.js`)

All parameters are tunable and exposed as a frozen `DEFAULT_CONFIG` object:

| Parameter | Default | Description |
|---|---|---|
| `supersessionJaccardThreshold` | 0.30 | Min token overlap to declare code superseded |
| `recencyDecayLambda` | 2.0 | Exponential decay rate (half-life ≈ 35% from end) |
| `anchorWindowFraction` | 0.30 | Last N% of conversation for anchor code blocks |
| `dependencyIdfPercentile` | 0.50 | IDF above this percentile = "rare" for dep resolution |
| `maxDependenciesPerAnchor` | 5 | Cap on dependencies pulled per anchor |
| `diversityThreshold` | 0.70 | MMR cosine cutoff for diversity fill |
| `charsPerToken` | 4 | Token estimation |
| `roleWeights.*` | (see above) | Per-role multipliers |

**Quality presets** (mapped to popup slider):
| Slider | Keep Fraction | Use Case |
|---|---|---|
| 15% | ~15% of tokens | Aggressive — key decisions and final code only |
| 40% | ~40% of tokens | Moderate (default) |
| 70% | ~70% of tokens | Conservative — near-complete context |
| 100% | 100% | Raw export, no compression |

---

## Grok Extractor (`content-scripts/grok.js` + `grok-fetch.js`)

Grok uses a clean REST API (`POST /rest/app-chat/conversations/:id/load-responses`) but two obstacles required a two-file approach:

1. **Origin restriction** — Grok's server returns `{"responses": []}` for requests with `origin: chrome-extension://...`. A content script in MAIN world (`grok-fetch.js`) wraps `window.fetch` at `document_start` so the fetch runs with `origin: https://grok.com`.

2. **CSP** — Grok's Content Security Policy blocks inline script injection, ruling out the `<script>` tag approach. Instead, `grok-fetch.js` is registered as a MAIN world content script file (exempt from page CSP).

**Two-file bridge:**
- `grok-fetch.js` (MAIN, `document_start`): wraps `window.fetch` to intercept and cache `load-responses` responses per conversation ID; responds to `postMessage` requests from the isolated world
- `grok.js` (ISOLATED, `document_idle`): handles `chrome.runtime` messages from popup, delegates fetch to `grok-fetch.js` via `postMessage`, converts response to `.llmchat`

**Response structure** (`responses[]` array, flat — no tree traversal needed):
- `sender`: `"human"` → `user`, anything else → `assistant`
- `model`: detected from first assistant response (e.g. `"grok-3"`)
- `fileAttachmentsMetadata`: mapped to `.llmchat` artifacts (document/image)
- `generatedImageUrls`: mapped to image artifacts
- `isControl` / `partial` responses filtered out

**Security hardening:**
- `conversationId` validated as UUID before use in URL
- `postMessage` origin locked to `https://grok.com` in both directions
- Fetch cache keyed per conversation ID (no stale data across navigation)
- 10s timeout on `fetchInPageContext` promise to prevent silent hangs

---

## Gemini Extractor (`content-scripts/gemini.js`)

Since Gemini's internal API requires complex auth not accessible from a content script, extraction is DOM-based with three fallback strategies:

**Strategy 1** (primary): `conversation-turn` custom elements containing `user-query` and `model-response` children. Handles multiple draft responses by selecting the visible one (`aria-hidden !== 'true'`).

**Strategy 2**: `[data-message-author-role]` attributed elements (fallback for DOM restructuring).

**Strategy 3**: Interleaved `user-query` / `model-response` sibling elements.

**HTML → Markdown conversion** (`htmlToMarkdown`): Recursively walks the rendered DOM and converts:
- `<pre><code>` → fenced code block with language detection (from class or label element)
- `<h1>`–`<h6>` → `#` prefixed headings
- `<ul>/<ol>/<li>` → `-` / `1.` lists
- `<strong>/<em>` → `**bold**` / `*italic*`
- `<blockquote>` → `> ` prefixed lines
- `<table>/<tr>/<td>` → `| cell | cell |` rows

---

## Popup UI

| Control | Behavior |
|---|---|
| Platform badge | Auto-detected from tab URL (ChatGPT / Claude / Gemini / Grok / Unsupported) |
| Quality slider | 15% / 40% / 70% / 100% presets; 100% auto-switches to Raw mode |
| Smart / Raw toggle | Smart runs compression worker; Raw downloads unmodified `.llmchat` |
| Include Artifacts checkbox | Strips attached document content from export when unchecked |
| Progress bar | Streamed from Web Worker via `postMessage` (`progress` events) |
| Compression stats panel | Original tokens → compressed tokens, ratio, segments kept, elapsed ms, superseded/meta counts |

---

## Measured Results (90-message Claude conversation, 262KB)

```
Segmentation:       639 segments from 90 messages
Graph build:        404ms, 185,973 edges (v1 — no longer used for ranking)

Quality 15%:   69 segments,  7,362 tokens (19.3% of original)
Quality 40%:  104 segments, 16,445 tokens (43.0% of original)
Quality 70%:  396 segments, 27,344 tokens (71.5% of original)
Quality 100%: 543 segments, 34,038 tokens (89.0% of original)

Full pipeline at 40%:
  90 messages → 71 messages
  ~38,244 tokens → ~15,298 tokens (40.0% ratio)
  262,368 bytes → 112,114 bytes (42.7%)
  Topics: json, javascript, conversation, console, chatgpt
```

All 49 unit tests pass (segmenter, tfidf, graph, ranker, composer) against real conversation fixtures.
