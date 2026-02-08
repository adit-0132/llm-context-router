/**
 * Compression Worker
 *
 * Runs the entire compression pipeline off the main thread in a Web Worker.
 * Receives raw .llmchat data + configuration, posts back progress updates
 * and the final compressed result.
 *
 * Message protocol:
 *
 *   → Worker receives:
 *     { type: 'compress', data: llmchatJSON, quality: 0–100, config?: {} }
 *
 *   ← Worker sends:
 *     { type: 'progress', stage: string, fraction: 0–1 }
 *     { type: 'result',   data: compressedLLMChat, stats: {} }
 *     { type: 'error',    message: string }
 */

// In a Web Worker, we can't use ES module imports directly in all browsers.
// We inline-import using importScripts for maximum compatibility, but the
// modules are written as ES modules for clean structure. The worker entry
// point uses a self-contained approach.

// ── Inline imports (bundled or loaded via importScripts) ─────────
// For Chrome MV3 extensions, module workers ARE supported.
// We use `type: 'module'` when creating the worker.

import { DEFAULT_CONFIG, qualityToFraction } from './config.js';
import { segmentMessages } from './segmenter.js';
import { SemanticGraph } from './graph.js';
import { TextRanker } from './ranker.js';
import { compose } from './composer.js';

// ── Worker message handler ──────────────────────────────────────

self.onmessage = function (event) {
  const { type, data, quality, config: userConfig } = event.data;

  if (type !== 'compress') {
    self.postMessage({ type: 'error', message: `Unknown message type: ${type}` });
    return;
  }

  try {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const startTime = performance.now();

    // ── Stage 1: Segmentation ────────────────────────────────────
    self.postMessage({ type: 'progress', stage: 'Segmenting messages...', fraction: 0 });

    const segments = segmentMessages(data.messages);
    const totalOriginalTokens = segments.reduce((sum, s) => sum + s.tokenEstimate, 0);

    self.postMessage({
      type: 'progress',
      stage: `Segmented into ${segments.length} segments`,
      fraction: 0.15,
    });

    // ── Check: if quality is 100 (raw), skip compression ─────────
    if (quality >= 100) {
      self.postMessage({
        type: 'result',
        data: { ...data, version: '2.0' },
        stats: {
          segments: segments.length,
          originalTokens: totalOriginalTokens,
          compressedTokens: totalOriginalTokens,
          ratio: 1.0,
          elapsed: performance.now() - startTime,
        }
      });
      return;
    }

    // ── Stage 2 & 3: Graph construction (includes TF-IDF) ───────
    self.postMessage({ type: 'progress', stage: 'Building semantic graph...', fraction: 0.20 });

    const graph = new SemanticGraph(segments, config);
    graph.build((fraction) => {
      // Map graph progress to 0.20 – 0.60
      self.postMessage({
        type: 'progress',
        stage: 'Computing edge weights...',
        fraction: 0.20 + fraction * 0.40,
      });
    });

    self.postMessage({
      type: 'progress',
      stage: `Graph built: ${graph.edgeCount} edges`,
      fraction: 0.60,
    });

    // ── Stage 4: Ranking ─────────────────────────────────────────
    self.postMessage({ type: 'progress', stage: 'Running TextRank...', fraction: 0.65 });

    const ranker = new TextRanker(graph, segments, config);
    ranker.computeRanks();
    ranker.applyBoosts();

    self.postMessage({ type: 'progress', stage: 'Selecting segments...', fraction: 0.80 });

    // Compute token budget from quality slider
    const budgetFraction = qualityToFraction(quality);
    const tokenBudget = Math.ceil(totalOriginalTokens * budgetFraction);

    const { selected, dropped, usedTokens } = ranker.selectSegments(tokenBudget);

    self.postMessage({
      type: 'progress',
      stage: `Selected ${selected.length}/${segments.length} segments`,
      fraction: 0.90,
    });

    // ── Stage 5: Compose output ──────────────────────────────────
    self.postMessage({ type: 'progress', stage: 'Composing output...', fraction: 0.95 });

    const compressed = compose(
      data,
      segments,
      selected,
      dropped,
      usedTokens,
      ranker.boostedRanks,
      config,
      quality
    );

    const elapsed = performance.now() - startTime;

    self.postMessage({
      type: 'result',
      data: compressed,
      stats: {
        segments: segments.length,
        selectedSegments: selected.length,
        droppedSegments: dropped.length,
        originalTokens: totalOriginalTokens,
        compressedTokens: usedTokens,
        ratio: parseFloat((usedTokens / totalOriginalTokens).toFixed(3)),
        edges: graph.edgeCount,
        elapsed: Math.round(elapsed),
      }
    });

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
