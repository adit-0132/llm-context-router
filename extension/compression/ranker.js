/**
 * TextRank Ranker + Greedy Selector
 *
 * Two responsibilities:
 *
 * 1. **TextRank**: Run PageRank on the weighted semantic graph to compute
 *    an importance score for every segment. Segments that are "central"
 *    (connected to many other important segments) rank high.
 *
 * 2. **Greedy Selection (MMR-style)**: Pick segments top-down by score,
 *    but enforce a diversity constraint — skip candidates that are too
 *    similar to already-selected segments. This avoids redundancy.
 *
 * Special rules:
 *   - First user message + last assistant message are always preserved
 *   - Final code blocks get a 2× boost
 *   - Decision segments get 1.5×
 *   - Meta/pleasantry segments get 0.1×
 *   - Segments in the last 25% get a recency boost
 */

import { DEFAULT_CONFIG } from './config.js';

// ── TextRank (PageRank on semantic graph) ───────────────────────────

export class TextRanker {
  /**
   * @param {import('./graph.js').SemanticGraph} graph
   * @param {import('./segmenter.js').Segment[]} segments
   * @param {Object} [config]
   */
  constructor(graph, segments, config = {}) {
    this.graph = graph;
    this.segments = segments;
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Map<string, number>} segmentId → raw PageRank score */
    this.rawRanks = new Map();

    /** @type {Map<string, number>} segmentId → boosted score */
    this.boostedRanks = new Map();
  }

  /**
   * Run power-iteration PageRank.
   *
   * PR(v) = (1 - d) + d × Σ [ w(u,v) / Σ_out(u) × PR(u) ]
   *
   * where d = damping factor, w(u,v) = edge weight,
   * Σ_out(u) = sum of all outgoing edge weights from u.
   *
   * @returns {Map<string, number>} segmentId → score
   */
  computeRanks() {
    const { segments, config } = this;
    const d = config.dampingFactor;
    const n = segments.length;

    if (n === 0) return new Map();

    // Initialize all scores to 1/n
    const scores = new Map();
    for (const seg of segments) {
      scores.set(seg.id, 1 / n);
    }

    // Precompute outgoing weight sums for each node
    const outWeightSum = new Map();
    for (const seg of segments) {
      const neighbors = this.graph.getNeighbors(seg.id);
      let sum = 0;
      for (const w of neighbors.values()) sum += w;
      outWeightSum.set(seg.id, sum || 1); // avoid div-by-zero
    }

    // Power iteration
    for (let iter = 0; iter < config.maxIterations; iter++) {
      const newScores = new Map();
      let maxDelta = 0;

      for (const seg of segments) {
        const neighbors = this.graph.getNeighbors(seg.id);
        let incoming = 0;

        for (const [neighborId, weight] of neighbors) {
          const neighborScore = scores.get(neighborId) || 0;
          const neighborOutSum = outWeightSum.get(neighborId) || 1;
          incoming += (weight / neighborOutSum) * neighborScore;
        }

        const newScore = (1 - d) / n + d * incoming;
        newScores.set(seg.id, newScore);

        const delta = Math.abs(newScore - (scores.get(seg.id) || 0));
        if (delta > maxDelta) maxDelta = delta;
      }

      // Update scores
      for (const [id, score] of newScores) {
        scores.set(id, score);
      }

      // Check convergence
      if (maxDelta < config.convergenceThreshold) {
        break;
      }
    }

    this.rawRanks = scores;
    return scores;
  }

  /**
   * Apply type-based and position-based boost multipliers.
   *
   * @returns {Map<string, number>} segmentId → boosted score
   */
  applyBoosts() {
    const { segments, config } = this;
    const boosted = new Map();

    // Find the highest message index to determine "final" code blocks
    const maxMsgIndex = Math.max(...segments.map(s => s.messageIndex));
    const finalThreshold = maxMsgIndex * (1 - config.recencyWindow);

    for (const seg of segments) {
      let score = this.rawRanks.get(seg.id) || 0;

      // ── Type-based boost ───────────────────────────────────────
      if (seg.type === 'code' && seg.messageIndex >= finalThreshold) {
        score *= config.boosts.code_final;
      } else {
        const boost = config.boosts[seg.type];
        if (boost !== undefined) {
          score *= boost;
        }
      }

      // ── Recency boost ──────────────────────────────────────────
      if (seg.positionNormalized >= (1 - config.recencyWindow)) {
        score *= config.recencyMultiplier;
      }

      boosted.set(seg.id, score);
    }

    this.boostedRanks = boosted;
    return boosted;
  }

  /**
   * Greedy selection with MMR-style diversity constraint.
   *
   * Algorithm:
   *   1. Sort segments by boosted score (descending)
   *   2. Always include first user msg + last assistant msg segments
   *   3. For each candidate:
   *      - If its max cosine similarity with any already-selected
   *        segment exceeds `diversityThreshold`, skip it (redundant)
   *      - Otherwise, add it to the selection
   *   4. Stop when token budget is exhausted
   *
   * @param {number} tokenBudget - Maximum tokens to keep
   * @returns {{ selected: import('./segmenter.js').Segment[], dropped: import('./segmenter.js').Segment[] }}
   */
  selectSegments(tokenBudget) {
    const { segments, config, graph } = this;

    // Sort by boosted rank
    const sorted = [...segments].sort((a, b) => {
      return (this.boostedRanks.get(b.id) || 0) - (this.boostedRanks.get(a.id) || 0);
    });

    const selected = [];
    const selectedIndices = new Set(); // indices into this.segments
    const selectedSet = new Set();     // segment IDs
    let usedTokens = 0;

    // ── Step 1: Force-include anchors ────────────────────────────
    if (config.alwaysKeepFirstUserMessage) {
      const firstUser = segments.find(s => s.role === 'user');
      if (firstUser) {
        selected.push(firstUser);
        selectedSet.add(firstUser.id);
        selectedIndices.add(segments.indexOf(firstUser));
        usedTokens += firstUser.tokenEstimate;
      }
    }

    if (config.alwaysKeepLastAssistantMessage) {
      // Find all segments from the last assistant message
      const lastAssistantMsgIndex = Math.max(
        ...segments.filter(s => s.role === 'assistant').map(s => s.messageIndex)
      );
      const lastAssistantSegs = segments.filter(
        s => s.messageIndex === lastAssistantMsgIndex && s.role === 'assistant'
      );
      for (const seg of lastAssistantSegs) {
        if (!selectedSet.has(seg.id)) {
          selected.push(seg);
          selectedSet.add(seg.id);
          selectedIndices.add(segments.indexOf(seg));
          usedTokens += seg.tokenEstimate;
        }
      }
    }

    // ── Step 2: Greedy selection with diversity ──────────────────
    for (const candidate of sorted) {
      if (selectedSet.has(candidate.id)) continue;
      if (usedTokens + candidate.tokenEstimate > tokenBudget) continue;

      // Diversity check: max similarity with already-selected
      const candidateIdx = segments.indexOf(candidate);
      const candidateVec = graph.getVector(candidateIdx);
      let tooSimilar = false;

      for (const selIdx of selectedIndices) {
        const selVec = graph.getVector(selIdx);
        const sim = graph.vectorizer.cosineSimilarity(candidateVec, selVec);
        if (sim > config.diversityThreshold) {
          tooSimilar = true;
          break;
        }
      }

      if (tooSimilar) continue;

      selected.push(candidate);
      selectedSet.add(candidate.id);
      selectedIndices.add(candidateIdx);
      usedTokens += candidate.tokenEstimate;
    }

    // Dropped = everything not selected
    const dropped = segments.filter(s => !selectedSet.has(s.id));

    return { selected, dropped, usedTokens };
  }
}
