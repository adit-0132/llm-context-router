/**
 * Compression Worker — v2
 *
 * Runs the 3-layer compression pipeline off the main thread in a Web Worker.
 *
 * Pipeline:
 *   1. Segment    → split messages into typed segments
 *   2. Analyze    → Layer 1: supersession detection + meta elimination
 *   3. Score      → Layer 2: novelty × density × recency × role_weight
 *   4. Select     → Layer 3: anchors → dependencies → density fill
 *   5. Compose    → reassemble into compressed .llmchat v2.0
 *
 * Message protocol:
 *   → { type: 'compress', data: llmchatJSON, quality: 0–100, config?: {} }
 *   ← { type: 'progress', stage: string, fraction: 0–1 }
 *   ← { type: 'result',   data: compressedLLMChat, stats: {} }
 *   ← { type: 'error',    message: string }
 */

import { DEFAULT_CONFIG, qualityToFraction } from './config.js';
import { segmentMessages } from './segmenter.js';
import { analyze } from './analyzer.js';
import { Scorer, Selector } from './ranker.js';
import { compose } from './composer.js';

self.onmessage = function (event) {
  const { type, data, quality, config: userConfig, includeArtifacts } = event.data;

  if (type !== 'compress') {
    self.postMessage({ type: 'error', message: `Unknown message type: ${type}` });
    return;
  }

  try {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const startTime = performance.now();

    // ── Stage 1: Segmentation ────────────────────────────────────
    self.postMessage({ type: 'progress', stage: 'Segmenting messages...', fraction: 0 });

    const segmentOptions = { includeArtifacts: includeArtifacts !== false };
    const allSegments = segmentMessages(data.messages, segmentOptions);
    const totalOriginalTokens = allSegments.reduce((sum, s) => sum + s.tokenEstimate, 0);

    self.postMessage({
      type: 'progress',
      stage: `Segmented into ${allSegments.length} segments`,
      fraction: 0.10,
    });

    // ── Check: if quality is 100 (raw), skip compression ─────────
    if (quality >= 100) {
      self.postMessage({
        type: 'result',
        data: { ...data, version: '2.0' },
        stats: {
          segments: allSegments.length,
          originalTokens: totalOriginalTokens,
          compressedTokens: totalOriginalTokens,
          ratio: 1.0,
          elapsed: performance.now() - startTime,
        }
      });
      return;
    }

    // ── Stage 2: Layer 1 — Structural Analysis ───────────────────
    self.postMessage({ type: 'progress', stage: 'Analyzing structure...', fraction: 0.15 });

    const analysis = analyze(allSegments, config);

    self.postMessage({
      type: 'progress',
      stage: `Eliminated ${analysis.eliminatedSegments.length} segments (${analysis.supersededIds.size} superseded, ${analysis.metaIds.size} meta)`,
      fraction: 0.25,
    });

    // ── Stage 3: Layer 2 — Information Scoring ───────────────────
    self.postMessage({ type: 'progress', stage: 'Scoring information density...', fraction: 0.30 });

    const scorer = new Scorer(analysis.liveSegments, config);
    scorer.computeScores();

    self.postMessage({
      type: 'progress',
      stage: `Scored ${analysis.liveSegments.length} live segments`,
      fraction: 0.55,
    });

    // ── Stage 4: Layer 3 — Dependency-Aware Selection ────────────
    self.postMessage({ type: 'progress', stage: 'Selecting with dependency resolution...', fraction: 0.60 });

    // Compute token budget from quality slider (applied to original total,
    // so the user's slider maps to the full conversation)
    const budgetFraction = qualityToFraction(quality);
    const tokenBudget = Math.ceil(totalOriginalTokens * budgetFraction);

    const selector = new Selector(scorer, analysis.liveSegments, config);
    const { selected, dropped, usedTokens } = selector.select(tokenBudget);

    self.postMessage({
      type: 'progress',
      stage: `Selected ${selected.length}/${allSegments.length} segments`,
      fraction: 0.85,
    });

    // ── Stage 5: Compose Output ──────────────────────────────────
    self.postMessage({ type: 'progress', stage: 'Composing output...', fraction: 0.90 });

    // Combine dropped from selection + eliminated from analysis
    const allDropped = [...analysis.eliminatedSegments, ...dropped];

    const compressed = compose(
      data,
      allSegments,
      selected,
      allDropped,
      usedTokens,
      scorer.scores,
      config,
      quality
    );

    const elapsed = performance.now() - startTime;

    self.postMessage({
      type: 'result',
      data: compressed,
      stats: {
        segments: allSegments.length,
        liveSegments: analysis.liveSegments.length,
        selectedSegments: selected.length,
        droppedSegments: allDropped.length,
        supersededCode: analysis.supersededIds.size,
        eliminatedMeta: analysis.metaIds.size,
        originalTokens: totalOriginalTokens,
        compressedTokens: usedTokens,
        ratio: parseFloat((usedTokens / totalOriginalTokens).toFixed(3)),
        elapsed: Math.round(elapsed),
      }
    });

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
