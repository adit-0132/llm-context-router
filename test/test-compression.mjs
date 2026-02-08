/**
 * Compression Engine Test — v2
 *
 * Tests the 3-layer pipeline:
 *   Layer 1: Structural analysis (supersession, meta elimination)
 *   Layer 2: Information-theoretic scoring
 *   Layer 3: Dependency-aware selection
 *
 * Run: node test/test-compression.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { segmentMessages, tokenize } from '../extension/compression/segmenter.js';
import { TFIDFVectorizer } from '../extension/compression/tfidf.js';
import { analyze, detectSupersession, detectMeta } from '../extension/compression/analyzer.js';
import { Scorer, Selector } from '../extension/compression/ranker.js';
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

const tokens2 = tokenize('```javascript\nconst x = 42;\n```');
assert(tokens2.includes('javascript'), 'extracts language from code fences');

// ── Test 2: Segmenter (with new fields) ─────────────────────────────

section('Segmenter');

const largeSegments = segmentMessages(largeData.messages);
console.log(`  Produced ${largeSegments.length} segments from ${largeData.messages.length} messages`);

assert(largeSegments.length > 0, 'produces segments');
assert(largeSegments.every(s => typeof s.isArtifact === 'boolean'), 'all segments have isArtifact');
assert(largeSegments.every(s => 'codeLanguage' in s), 'all segments have codeLanguage field');

const codeSegs = largeSegments.filter(s => s.type === 'code');
assert(codeSegs.every(s => s.isArtifact === true), 'all code segments are artifacts');
console.log(`  Code segments: ${codeSegs.length}`);

// Check code language detection
const withLang = codeSegs.filter(s => s.codeLanguage !== null);
console.log(`  Code with detected language: ${withLang.length}/${codeSegs.length}`);
if (withLang.length > 0) {
  const langs = [...new Set(withLang.map(s => s.codeLanguage))];
  console.log(`  Languages found: ${langs.join(', ')}`);
}

const typeCounts = {};
for (const seg of largeSegments) typeCounts[seg.type] = (typeCounts[seg.type] || 0) + 1;
console.log(`  Types: ${JSON.stringify(typeCounts)}`);

// ── Test 3: Layer 1 — Supersession Detection ────────────────────────

section('Layer 1 — Code Supersession');

const { supersededIds, supersessionPairs } = detectSupersession(largeSegments);
console.log(`  Superseded code blocks: ${supersededIds.size}`);
console.log(`  Supersession pairs: ${supersessionPairs.length}`);

assert(supersededIds.size > 0, 'detects some superseded code blocks');

// Show some pairs
supersessionPairs.slice(0, 3).forEach(p => {
  console.log(`    ${p.stale} → ${p.replacement} (jaccard: ${p.similarity})`);
});

// Verify: superseded blocks appear BEFORE their replacements
for (const pair of supersessionPairs) {
  const stale = largeSegments.find(s => s.id === pair.stale);
  const replacement = largeSegments.find(s => s.id === pair.replacement);
  assert(
    stale.positionNormalized <= replacement.positionNormalized,
    `${pair.stale} is older than ${pair.replacement}`
  );
}

// ── Test 4: Layer 1 — Meta Elimination ──────────────────────────────

section('Layer 1 — Meta Elimination');

const metaIds = detectMeta(largeSegments);
console.log(`  Meta/acknowledgment segments eliminated: ${metaIds.size}`);

// Check that no code blocks are in meta
for (const id of metaIds) {
  const seg = largeSegments.find(s => s.id === id);
  assert(seg.type !== 'code', `meta ${id} is not a code block`);
}

// ── Test 5: Full Layer 1 Analysis ───────────────────────────────────

section('Layer 1 — Full Analysis');

const analysis = analyze(largeSegments);
console.log(`  Live segments: ${analysis.liveSegments.length}`);
console.log(`  Eliminated: ${analysis.eliminatedSegments.length}`);
console.log(`    - Superseded: ${analysis.supersededIds.size}`);
console.log(`    - Meta: ${analysis.metaIds.size}`);

assert(
  analysis.liveSegments.length + analysis.eliminatedSegments.length === largeSegments.length,
  'live + eliminated = total'
);
assert(
  analysis.liveSegments.length < largeSegments.length,
  'analysis actually removes some segments'
);

// ── Test 6: Layer 2 — Scoring ───────────────────────────────────────

section('Layer 2 — Information Scoring');

const scorer = new Scorer(analysis.liveSegments);
scorer.computeScores();

assert(scorer.scores.size === analysis.liveSegments.length, 'all live segments scored');

// THE KEY TEST: assistant messages with code should score HIGHER than user prompts
const liveCodeSegs = analysis.liveSegments.filter(s => s.type === 'code' && s.role === 'assistant');
const liveUserReasoningSegs = analysis.liveSegments.filter(s => s.type === 'reasoning' && s.role === 'user');

if (liveCodeSegs.length > 0 && liveUserReasoningSegs.length > 0) {
  const avgCodeScore = liveCodeSegs.reduce((sum, s) => sum + (scorer.scores.get(s.id) || 0), 0) / liveCodeSegs.length;
  const avgUserScore = liveUserReasoningSegs.reduce((sum, s) => sum + (scorer.scores.get(s.id) || 0), 0) / liveUserReasoningSegs.length;
  console.log(`  Avg assistant+code score: ${avgCodeScore.toExponential(3)}`);
  console.log(`  Avg user reasoning score: ${avgUserScore.toExponential(3)}`);
  assert(avgCodeScore > avgUserScore, 'assistant code scores HIGHER than user prompts (the v1 bug is fixed!)');
}

// Top 10 ranked segments
const sorted = [...analysis.liveSegments].sort((a, b) =>
  (scorer.scores.get(b.id) || 0) - (scorer.scores.get(a.id) || 0)
);
console.log('  Top 10 segments:');
sorted.slice(0, 10).forEach((s, i) => {
  const score = scorer.scores.get(s.id);
  console.log(`    ${i+1}. type=${s.type} role=${s.role} msg=${s.messageIndex} pos=${s.positionNormalized.toFixed(2)} score=${score.toExponential(3)}`);
});

// Count how many of top 15 are assistant code
const top15 = sorted.slice(0, 15);
const top15AssistantCode = top15.filter(s => s.type === 'code' && s.role === 'assistant');
console.log(`  Top 15: ${top15AssistantCode.length}/15 are assistant code blocks`);
assert(top15AssistantCode.length >= 3, 'at least 3 of top 15 are assistant code (vs 1-2 in v1)');

// ── Test 7: Layer 3 — Selection at different quality levels ─────────

section('Layer 3 — Selection at quality levels');

const totalTokens = largeSegments.reduce((sum, s) => sum + s.tokenEstimate, 0);

for (const quality of [15, 40, 70]) {
  const fraction = qualityToFraction(quality);
  const budget = Math.ceil(totalTokens * fraction);

  const sel = new Selector(scorer, analysis.liveSegments);
  const { selected, dropped, usedTokens } = sel.select(budget);

  const codeKept = selected.filter(s => s.type === 'code');
  const nonSupersededCode = analysis.liveSegments.filter(s => s.type === 'code');
  const codeKeptPct = nonSupersededCode.length > 0
    ? (codeKept.length / nonSupersededCode.length * 100).toFixed(0)
    : 'N/A';

  console.log(`  Quality ${quality}%: ${selected.length} selected, ${usedTokens}/${totalTokens} tokens (${(usedTokens/totalTokens*100).toFixed(1)}%), code kept: ${codeKept.length}/${nonSupersededCode.length} (${codeKeptPct}%)`);

  assert(selected.length > 0, `quality ${quality} selects at least 1 segment`);
  assert(selected.length + dropped.length === analysis.liveSegments.length, `quality ${quality} accounts for all live segments`);
}

// THE KEY TEST: at 40% quality, code blocks should be heavily prioritized
{
  const fraction = qualityToFraction(40);
  const budget = Math.ceil(totalTokens * fraction);
  const sel = new Selector(scorer, analysis.liveSegments);
  const { selected } = sel.select(budget);

  const codeKept = selected.filter(s => s.type === 'code');
  const nonSupersededCode = analysis.liveSegments.filter(s => s.type === 'code');
  const codeKeptPct = nonSupersededCode.length > 0
    ? codeKept.length / nonSupersededCode.length * 100
    : 0;

  assert(codeKeptPct >= 70, `at 40% quality, ≥70% of non-superseded code is kept (got ${codeKeptPct.toFixed(0)}%)`);
}

// ── Test 8: Anchor preservation ─────────────────────────────────────

section('Anchor preservation');

{
  const fraction = qualityToFraction(15); // aggressive
  const budget = Math.ceil(totalTokens * fraction);
  const sel = new Selector(scorer, analysis.liveSegments);
  const { selected } = sel.select(budget);
  const selectedIds = new Set(selected.map(s => s.id));

  const firstUser = analysis.liveSegments.find(s => s.role === 'user');
  assert(selectedIds.has(firstUser.id), 'first user message preserved');

  const lastAssistantMsgIdx = Math.max(
    ...analysis.liveSegments.filter(s => s.role === 'assistant').map(s => s.messageIndex)
  );
  const lastKept = analysis.liveSegments
    .filter(s => s.messageIndex === lastAssistantMsgIdx)
    .some(s => selectedIds.has(s.id));
  assert(lastKept, 'last assistant message preserved');
}

// ── Test 9: Composer ────────────────────────────────────────────────

section('Composer — Full pipeline output');

{
  const fraction = qualityToFraction(40);
  const budget = Math.ceil(totalTokens * fraction);
  const sel = new Selector(scorer, analysis.liveSegments);
  const { selected, dropped, usedTokens } = sel.select(budget);

  const allDropped = [...analysis.eliminatedSegments, ...dropped];

  const compressed = compose(
    largeData,
    largeSegments,
    selected,
    allDropped,
    usedTokens,
    scorer.scores,
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
  console.log(`  JSON size: ${originalSize} → ${outputSize} bytes (${(outputSize / originalSize * 100).toFixed(1)}%)`);

  assert(cm.compression_ratio < 0.6, 'moderate compression achieves < 60% ratio');
  assert(cm.compression_ratio > 0.1, 'moderate compression keeps > 10%');
}

// ── Test 10: Quality slider function ────────────────────────────────

section('Quality slider mapping');

assert(qualityToFraction(0) === 0.05, 'slider 0 → 5%');
assert(qualityToFraction(100) === 1.0, 'slider 100 → 100%');
assert(qualityToFraction(50) > 0.4 && qualityToFraction(50) < 0.6, 'slider 50 → ~50%');

// ── Test 11: v1 vs v2 comparison ────────────────────────────────────

section('v2 vs v1 comparison (code prioritization)');

{
  // In v1, user prompts dominated the top 15. In v2, code should dominate.
  const top15Types = sorted.slice(0, 15).map(s => `${s.role}:${s.type}`);
  const assistantCodeCount = top15Types.filter(t => t === 'assistant:code').length;
  const userReasoningCount = top15Types.filter(t => t === 'user:reasoning').length;

  console.log(`  Top 15 breakdown: ${assistantCodeCount} assistant:code, ${userReasoningCount} user:reasoning`);
  assert(
    assistantCodeCount > userReasoningCount,
    'v2 prioritizes assistant code OVER user reasoning in top 15 (v1 was opposite)'
  );
}

// ── Summary ─────────────────────────────────────────────────────────

section('Summary');
console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
