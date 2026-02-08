/**
 * Weighted Semantic Graph
 *
 * Builds a graph where each segment is a node and edges encode a composite
 * similarity signal from four sources:
 *
 *   1. Content similarity  (TF-IDF cosine)
 *   2. Temporal proximity  (closeness in conversation timeline)
 *   3. Cross-role bonus    (user ↔ assistant interaction)
 *   4. Reference detection (explicit "as I mentioned", "above", etc.)
 *
 * Uses a sparse adjacency representation (Map of Maps) and prunes
 * low-weight edges to keep the graph tractable for PageRank.
 */

import { DEFAULT_CONFIG } from './config.js';
import { TFIDFVectorizer } from './tfidf.js';

// ── Reference detection patterns ────────────────────────────────────

const REFERENCE_PHRASES = [
  /\b(?:as\s+(?:i|we|you)\s+(?:mentioned|said|noted|discussed|described))\b/i,
  /\b(?:(?:earlier|previously|above|before)\s+(?:i|we|you)\s+(?:mentioned|said|noted))\b/i,
  /\b(?:going\s+back\s+to)\b/i,
  /\b(?:regarding|about|re:)\b/i,
  /\b(?:the\s+(?:previous|earlier|above)\s+(?:code|example|approach|solution|version))\b/i,
  /\b(?:as\s+shown\s+(?:above|earlier|before))\b/i,
  /\b(?:building\s+on|based\s+on\s+(?:the|your|my))\b/i,
];

/**
 * Check whether segment B references content from segment A.
 * A lightweight heuristic — looks for backward-referencing language in B
 * when A precedes B in the conversation.
 *
 * @param {import('./segmenter.js').Segment} segA
 * @param {import('./segmenter.js').Segment} segB
 * @returns {boolean}
 */
function detectsReference(segA, segB) {
  // Only check if B comes after A
  if (segB.positionNormalized <= segA.positionNormalized) return false;

  for (const re of REFERENCE_PHRASES) {
    if (re.test(segB.content)) return true;
  }
  return false;
}

// ── SemanticGraph ───────────────────────────────────────────────────

export class SemanticGraph {
  /**
   * @param {import('./segmenter.js').Segment[]} segments
   * @param {Object} [config] - Override DEFAULT_CONFIG
   */
  constructor(segments, config = {}) {
    this.segments = segments;
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Map<string, Map<string, number>>} adjacency: nodeId → { neighborId → weight } */
    this.adjacency = new Map();

    /** @type {TFIDFVectorizer} */
    this.vectorizer = new TFIDFVectorizer();

    /** @type {Array<{ vector: Map<string, number>, norm: number }>} */
    this.vectors = [];
  }

  /**
   * Build the complete weighted graph.
   *
   * @param {function} [onProgress] - Callback (fraction: 0–1) for progress reporting
   * @returns {Map<string, Map<string, number>>} The adjacency map
   */
  build(onProgress) {
    const { segments, config } = this;
    const n = segments.length;

    // Step 1: Vectorize
    this.vectors = this.vectorizer.fitTransform(segments);

    // Step 2: Initialize adjacency
    for (const seg of segments) {
      this.adjacency.set(seg.id, new Map());
    }

    // Step 3: Compute pairwise edge weights
    // O(n²) but n is typically 200–400 segments — very fast
    const totalPairs = (n * (n - 1)) / 2;
    let pairsDone = 0;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const segA = segments[i];
        const segB = segments[j];

        // ── Content similarity (TF-IDF cosine) ───────────────────
        const contentSim = this.vectorizer.cosineSimilarity(
          this.vectors[i],
          this.vectors[j]
        );

        // ── Temporal proximity ───────────────────────────────────
        // 1.0 when adjacent, decays toward 0.0 for distant segments
        const temporalSim = 1 - Math.abs(
          segA.positionNormalized - segB.positionNormalized
        );

        // ── Cross-role bonus ─────────────────────────────────────
        const crossRole = (segA.role !== segB.role) ? 1.0 : 0.0;

        // ── Reference detection ──────────────────────────────────
        const reference = (detectsReference(segA, segB) || detectsReference(segB, segA))
          ? 1.0
          : 0.0;

        // ── Composite weight ─────────────────────────────────────
        const weight =
          config.alpha * contentSim +
          config.beta  * temporalSim +
          config.gamma * crossRole +
          config.delta * reference;

        // Prune negligible edges
        if (weight > config.edgePruneThreshold) {
          this.adjacency.get(segA.id).set(segB.id, weight);
          this.adjacency.get(segB.id).set(segA.id, weight);
        }

        pairsDone++;
        if (onProgress && pairsDone % 500 === 0) {
          onProgress(pairsDone / totalPairs);
        }
      }
    }

    if (onProgress) onProgress(1);
    return this.adjacency;
  }

  /**
   * Get the TF-IDF vector for a segment by index.
   * Useful for the ranker's diversity check.
   *
   * @param {number} segmentIndex
   * @returns {{ vector: Map<string, number>, norm: number }}
   */
  getVector(segmentIndex) {
    return this.vectors[segmentIndex];
  }

  /**
   * Get adjacency neighbors and weights for a node.
   *
   * @param {string} nodeId
   * @returns {Map<string, number>}
   */
  getNeighbors(nodeId) {
    return this.adjacency.get(nodeId) || new Map();
  }

  /**
   * Total number of edges (after pruning).
   * @returns {number}
   */
  get edgeCount() {
    let count = 0;
    for (const neighbors of this.adjacency.values()) {
      count += neighbors.size;
    }
    return count / 2; // undirected graph → each edge counted twice
  }
}
