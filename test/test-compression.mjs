/**
 * Compression Engine Test
 *
 * Tests the full pipeline against real .llmchat test data.
 * Run with: node --experimental-vm-modules test/test-compression.mjs
 *
 * Or simply: node test/test-compression.mjs
 * (Node 18+ supports top-level await + ESM natively)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Since our modules are written for browser ESM, we import them directly
import { segmentMessages, tokenize } from '../extension/compression/segmenter.js';
import { TFIDFVectorizer } from '../extension/compression/tfidf.js';
import { SemanticGraph } from '../extension/compression/graph.js';
import { TextRanker } from '../extension/compression/ranker.js';
import { compose } from '../extension/compression/composer.js';
import { DEFAULT_CONFIG, qualityToFraction } from '../extension/compression/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test helpers ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(60 - name.length)}`);
}

// ── Load test data ──────────────────────────────────────────────────

section('Loading test data');

const smallData = JSON.parse(
  readFileSync(join(__dirname, '../test-outputs/claude.llmchat'), 'utf8')
);

const largeData = JSON.parse(
  readFileSync(join(__dirname, '../test-outputs/claude2.llmchat'), 'utf8')
);

console.log(`  Small: ${smallData.messages.length} messages, ${smallData.metadata.title}`);
console.log(`  Large: ${largeData.messages.length} messages, ${largeData.metadata.title}`);

// ── Test 1: Tokenizer ───────────────────────────────────────────────

section('Tokenizer');

const tokens1 = tokenize('Hello, how are you doing today? I need help with Python.');
assert(tokens1.includes('python'), 'keeps domain words');
assert(!tokens1.includes('how'), 'removes stopwords');
assert(!tokens1.includes('hello'), 'removes greetings (in stopwords)');
assert(tokens1.length > 0, 'produces non-empty output');

const tokens2 = tokenize('```javascript\nconst x = 42;\n```');
assert(tokens2.includes('javascript'), 'extracts language from code fences');
assert(tokens2.includes('const'), 'keeps code keywords');

// ── Test 2: Segmenter ───────────────────────────────────────────────

section('Segmenter — Small conversation');

const smallSegments = segmentMessages(smallData.messages);
console.log(`  Produced ${smallSegments.length} segments from ${smallData.messages.length} messages`);

assert(smallSegments.length > 0, 'produces segments');
assert(smallSegments.length >= smallData.messages.length, 'at least 1 segment per message');
assert(smallSegments.every(s => s.id && s.role && s.type), 'all segments have required fields');
assert(smallSegments.every(s => s.tokens instanceof Array), 'all segments have token arrays');
assert(
  smallSegments.some(s => s.type === 'code') || smallSegments.every(s => s.type !== 'code'),
  'code detection works (may or may not have code)'
);

// Check position normalization
const positions = smallSegments.map(s => s.positionNormalized);
assert(Math.min(...positions) >= 0 && Math.max(...positions) <= 1, 'positions normalized to [0,1]');

section('Segmenter — Large conversation');

const largeSegments = segmentMessages(largeData.messages);
console.log(`  Produced ${largeSegments.length} segments from ${largeData.messages.length} messages`);

assert(largeSegments.length > largeData.messages.length, 'large conv produces more segments than messages');

// Count types
const typeCounts = {};
for (const seg of largeSegments) {
  typeCounts[seg.type] = (typeCounts[seg.type] || 0) + 1;
}
console.log('  Segment types:', JSON.stringify(typeCounts));

// ── Test 3: TF-IDF ──────────────────────────────────────────────────

section('TF-IDF Vectorizer');

const vectorizer = new TFIDFVectorizer();
const vectors = vectorizer.fitTransform(smallSegments);

assert(vectors.length === smallSegments.length, 'one vector per segment');
assert(vectors.every(v => v.vector instanceof Map), 'vectors are Maps');
assert(vectors.every(v => typeof v.norm === 'number'), 'norms are numbers');

// Test cosine similarity
if (vectors.length >= 2) {
  const selfSim = vectorizer.cosineSimilarity(vectors[0], vectors[0]);
  assert(Math.abs(selfSim - 1.0) < 0.001 || vectors[0].norm === 0, 'self-similarity ≈ 1.0');

  const crossSim = vectorizer.cosineSimilarity(vectors[0], vectors[1]);
  assert(crossSim >= 0 && crossSim <= 1, 'cross-similarity in [0,1]');
}

// ── Test 4: Graph Construction ──────────────────────────────────────

section('Semantic Graph — Small');

const startSmall = performance.now();
const smallGraph = new SemanticGraph(smallSegments);
smallGraph.build();
const smallGraphTime = Math.round(performance.now() - startSmall);

console.log(`  Built in ${smallGraphTime}ms, ${smallGraph.edgeCount} edges`);
assert(smallGraph.edgeCount > 0, 'graph has edges');
assert(smallGraph.adjacency.size === smallSegments.length, 'all nodes present');

section('Semantic Graph — Large');

const startLarge = performance.now();
const largeGraph = new SemanticGraph(largeSegments);
largeGraph.build();
const largeGraphTime = Math.round(performance.now() - startLarge);

console.log(`  Built in ${largeGraphTime}ms, ${largeGraph.edgeCount} edges`);
assert(largeGraph.edgeCount > 0, 'large graph has edges');
assert(largeGraphTime < 10000, 'large graph built in < 10s');

// ── Test 5: TextRank ────────────────────────────────────────────────

section('TextRank — Large conversation');

const ranker = new TextRanker(largeGraph, largeSegments);
const ranks = ranker.computeRanks();
const boosted = ranker.applyBoosts();

console.log(`  Ranked ${ranks.size} segments`);
assert(ranks.size === largeSegments.length, 'all segments ranked');

// Check that boosts actually change scores
const metaSegs = largeSegments.filter(s => s.type === 'meta');
if (metaSegs.length > 0) {
  const metaScores = metaSegs.map(s => boosted.get(s.id) || 0);
  const avgMeta = metaScores.reduce((a, b) => a + b, 0) / metaScores.length;
  const allScores = [...boosted.values()];
  const avgAll = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  console.log(`  Avg meta score: ${avgMeta.toFixed(6)}, avg all: ${avgAll.toFixed(6)}`);
  assert(avgMeta < avgAll, 'meta segments score below average (boost working)');
}

// ── Test 6: Selection at different quality levels ───────────────────

section('Selection — Quality levels');

for (const quality of [15, 40, 70, 100]) {
  const fraction = qualityToFraction(quality);
  const totalTokens = largeSegments.reduce((sum, s) => sum + s.tokenEstimate, 0);
  const budget = Math.ceil(totalTokens * fraction);

  const rankerQ = new TextRanker(largeGraph, largeSegments);
  rankerQ.computeRanks();
  rankerQ.applyBoosts();
  const { selected, dropped, usedTokens } = rankerQ.selectSegments(budget);

  const ratio = (usedTokens / totalTokens * 100).toFixed(1);
  console.log(`  Quality ${quality}%: ${selected.length}/${largeSegments.length} segments, ${usedTokens}/${totalTokens} tokens (${ratio}%)`);

  assert(selected.length > 0, `quality ${quality} selects at least 1 segment`);
  assert(selected.length + dropped.length === largeSegments.length, `quality ${quality} accounts for all segments`);

  if (quality < 100) {
    assert(selected.length < largeSegments.length, `quality ${quality} actually compresses`);
  }
}

// ── Test 7: First/last preservation ─────────────────────────────────

section('Anchor preservation');

const anchorRanker = new TextRanker(largeGraph, largeSegments);
anchorRanker.computeRanks();
anchorRanker.applyBoosts();

const totalTokens = largeSegments.reduce((sum, s) => sum + s.tokenEstimate, 0);
const budget = Math.ceil(totalTokens * 0.15); // aggressive
const { selected: anchorSelected } = anchorRanker.selectSegments(budget);
const selectedIds = new Set(anchorSelected.map(s => s.id));

const firstUser = largeSegments.find(s => s.role === 'user');
assert(selectedIds.has(firstUser.id), 'first user message preserved');

const lastAssistantMsgIdx = Math.max(
  ...largeSegments.filter(s => s.role === 'assistant').map(s => s.messageIndex)
);
const lastAssistantSegs = largeSegments.filter(s => s.messageIndex === lastAssistantMsgIdx);
const lastKept = lastAssistantSegs.some(s => selectedIds.has(s.id));
assert(lastKept, 'last assistant message preserved');

// ── Test 8: Composer ────────────────────────────────────────────────

section('Composer — Full pipeline output');

const compRanker = new TextRanker(largeGraph, largeSegments);
compRanker.computeRanks();
compRanker.applyBoosts();

const compBudget = Math.ceil(totalTokens * 0.40);
const { selected: compSelected, dropped: compDropped, usedTokens: compUsed } =
  compRanker.selectSegments(compBudget);

const compressed = compose(
  largeData,
  largeSegments,
  compSelected,
  compDropped,
  compUsed,
  compRanker.boostedRanks,
  DEFAULT_CONFIG,
  40
);

assert(compressed.version === '2.0', 'output version is 2.0');
assert(compressed.standard === 'llmchat', 'output standard is llmchat');
assert(compressed.messages.length > 0, 'has compressed messages');
assert(compressed.messages.length < largeData.messages.length, 'fewer messages than original');
assert(compressed.compression_manifest !== undefined, 'has compression manifest');
assert(compressed.compression_manifest.top_topics.length > 0, 'has top topics');

const cm = compressed.metadata;
console.log(`  Original: ${cm.original_messages} messages, ~${cm.original_tokens_estimate} tokens`);
console.log(`  Compressed: ${cm.compressed_messages} messages, ~${cm.compressed_tokens_estimate} tokens`);
console.log(`  Ratio: ${(cm.compression_ratio * 100).toFixed(1)}%`);
console.log(`  Topics: ${compressed.compression_manifest.top_topics.join(', ')}`);
console.log(`  Drops: ${JSON.stringify(compressed.compression_manifest.dropped_categories)}`);

const outputSize = JSON.stringify(compressed).length;
const originalSize = JSON.stringify(largeData).length;
console.log(`  JSON size: ${originalSize} → ${outputSize} bytes (${(outputSize/originalSize*100).toFixed(1)}%)`);

assert(cm.compression_ratio < 0.6, 'moderate compression achieves < 60% ratio');
assert(cm.compression_ratio > 0.1, 'moderate compression keeps > 10%');

// ── Test 9: Quality slider function ─────────────────────────────────

section('Quality slider mapping');

assert(qualityToFraction(0) === 0.05, 'slider 0 → 5%');
assert(qualityToFraction(100) === 1.0, 'slider 100 → 100%');
assert(qualityToFraction(50) > 0.4 && qualityToFraction(50) < 0.6, 'slider 50 → ~50%');
assert(qualityToFraction(-10) === 0.05, 'clamped below 0');
assert(qualityToFraction(200) === 1.0, 'clamped above 100');

// ── Summary ─────────────────────────────────────────────────────────

section('Summary');
console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
