/**
 * Ranker v2 — Information-Theoretic Scoring + Dependency-Aware Selection
 *
 * Replaces TextRank (PageRank centrality) with a fundamentally different
 * approach:
 *
 * Layer 2 — Scoring:
 *   score = novelty × density × recency × role_weight
 *
 *   - novelty:    average IDF of the segment's terms (unique info)
 *   - density:    novelty / tokenEstimate (information per token)
 *   - recency:    e^(-λ × (1 - position)) (exponential decay from end)
 *   - role_weight: user requirements and assistant code score highest
 *
 * Layer 3 — Selection:
 *   1. Seed anchors:  first user msg + last assistant msg
 *                     + non-superseded code from the last 30%
 *   2. Resolve deps:  for each anchor, find earlier segments where
 *                     rare terms first appeared → pull them in
 *   3. Density fill:  fill remaining budget with highest-density segments
 *   4. Diversity:     skip candidates too similar to already-selected
 */

import { DEFAULT_CONFIG } from './config.js';
import { TFIDFVectorizer } from './tfidf.js';

// ── Layer 2: Information-Theoretic Scoring ──────────────────────────

export class Scorer {
  /**
   * @param {import('./segmenter.js').Segment[]} segments - Live segments (post-analysis)
   * @param {Object} [config]
   */
  constructor(segments, config = {}) {
    this.segments = segments;
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {TFIDFVectorizer} */
    this.vectorizer = new TFIDFVectorizer();

    /** @type {Array<{ vector: Map<string, number>, norm: number }>} */
    this.vectors = [];

    /** @type {Map<string, number>} segmentId → composite score */
    this.scores = new Map();

    /** @type {Map<string, number>} term → index of first segment containing it */
    this.termOrigins = new Map();
  }

  /**
   * Compute all scores. Must be called before selection.
   * @returns {Map<string, number>} segmentId → score
   */
  computeScores() {
    const { segments, config } = this;
    if (segments.length === 0) return new Map();

    // Step 1: Build TF-IDF vectors (used for novelty + diversity later)
    this.vectors = this.vectorizer.fitTransform(segments);

    // Step 2: Build term origins index (for dependency resolution in Layer 3)
    this._buildTermOrigins();

    // Step 3: Compute composite score for each segment
    //
    // Formula:
    //   score = (novelty × recency × roleWeight) + (artifactBoost × recency)
    //
    // The additive artifactBoost prevents code blocks from being drowned
    // out by short novel text segments. Code blocks are long (low density)
    // but are the primary deliverables — they should score high regardless
    // of their information density.
    //
    // artifactBoost is a flat bonus for segments flagged as artifacts
    // (code blocks, decisions, structured lists).
    //
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const vec = this.vectors[i];

      const novelty      = this._computeNovelty(seg, vec);
      const recency      = this._computeRecency(seg);
      const roleWeight   = this._computeRoleWeight(seg);
      const artifactBoost = seg.isArtifact ? 3.0 : 0;

      const score = (novelty * recency * roleWeight) + (artifactBoost * recency);

      this.scores.set(seg.id, score);
    }

    return this.scores;
  }

  /**
   * Novelty: average IDF of the segment's unique terms.
   * High IDF = rare in the conversation = novel information.
   */
  _computeNovelty(seg, vec) {
    if (vec.vector.size === 0) return 0.01; // avoid zero

    let totalIdf = 0;
    for (const term of vec.vector.keys()) {
      const idf = this.vectorizer.idf.get(term) || 0;
      totalIdf += idf;
    }

    return totalIdf / vec.vector.size;
  }

  /**
   * Recency: exponential decay from end of conversation.
   * e^(-λ × (1 - position))
   */
  _computeRecency(seg) {
    const lambda = this.config.recencyDecayLambda;
    return Math.exp(-lambda * (1 - seg.positionNormalized));
  }

  /**
   * Role-based weight.
   * Assistant messages with code/decisions score highest.
   * Short user acknowledgments score lowest.
   */
  _computeRoleWeight(seg) {
    const weights = this.config.roleWeights;

    if (seg.role === 'user') {
      if (seg.type === 'question' || seg.isArtifact) {
        return weights.user_requirement;
      }
      if (seg.content.length <= this.config.shortAcknowledgmentMaxChars &&
          seg.content.trim().split(/\s+/).length <= 6) {
        return weights.user_acknowledgment;
      }
      return weights.user_default;
    }

    // Assistant
    if (seg.type === 'code' || seg.isArtifact) {
      return weights.assistant_with_code;
    }
    if (seg.type === 'decision') {
      return weights.assistant_with_decision;
    }
    // Check if this message has a sibling code block
    // (assistant explanation next to code is more valuable)
    const hasSiblingCode = this.segments.some(
      s => s.messageIndex === seg.messageIndex && s.type === 'code'
    );
    if (hasSiblingCode) {
      return weights.assistant_default; // slightly below code, but not penalized
    }
    return weights.assistant_explanation;
  }

  /**
   * Build an index of term → first segment index where it appears.
   * Used by dependency resolution in Layer 3.
   */
  _buildTermOrigins() {
    this.termOrigins.clear();
    for (let i = 0; i < this.segments.length; i++) {
      for (const term of this.segments[i].tokens) {
        if (!this.termOrigins.has(term)) {
          this.termOrigins.set(term, i);
        }
      }
    }
  }

  /**
   * Get the TF-IDF vector for a segment by index.
   * @param {number} idx
   * @returns {{ vector: Map<string, number>, norm: number }}
   */
  getVector(idx) {
    return this.vectors[idx];
  }

  /**
   * Compute cosine similarity between two segment vectors.
   * @param {number} idxA
   * @param {number} idxB
   * @returns {number}
   */
  cosineSimilarity(idxA, idxB) {
    return this.vectorizer.cosineSimilarity(this.vectors[idxA], this.vectors[idxB]);
  }
}

// ── Layer 3: Dependency-Aware Selection ─────────────────────────────

export class Selector {
  /**
   * @param {Scorer} scorer
   * @param {import('./segmenter.js').Segment[]} segments - Live segments
   * @param {Object} [config]
   */
  constructor(scorer, segments, config = {}) {
    this.scorer = scorer;
    this.segments = segments;
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Map<string, number>} segmentId → index in segments array */
    this.idToIndex = new Map();
    for (let i = 0; i < segments.length; i++) {
      this.idToIndex.set(segments[i].id, i);
    }
  }

  /**
   * Run the full selection pipeline.
   *
   * @param {number} tokenBudget - Maximum tokens to keep
   * @returns {{ selected: import('./segmenter.js').Segment[], dropped: import('./segmenter.js').Segment[], usedTokens: number }}
   */
  select(tokenBudget) {
    const { segments, config, scorer } = this;

    const selectedSet = new Set();    // segment IDs
    const selectedIndices = new Set(); // indices into segments array
    let usedTokens = 0;

    // Helper: add a segment if budget allows
    const addSegment = (seg) => {
      if (selectedSet.has(seg.id)) return false;
      if (usedTokens + seg.tokenEstimate > tokenBudget) return false;
      selectedSet.add(seg.id);
      selectedIndices.add(this.idToIndex.get(seg.id));
      usedTokens += seg.tokenEstimate;
      return true;
    };

    // ── Step 1: Seed anchors ─────────────────────────────────────
    // First user message
    if (config.alwaysKeepFirstUserMessage) {
      const firstUser = segments.find(s => s.role === 'user');
      if (firstUser) addSegment(firstUser);
    }

    // Last assistant message (all segments from it)
    if (config.alwaysKeepLastAssistantMessage) {
      const lastAssistantMsgIdx = Math.max(
        ...segments.filter(s => s.role === 'assistant').map(s => s.messageIndex),
        -1
      );
      if (lastAssistantMsgIdx >= 0) {
        const lastAssistantSegs = segments.filter(
          s => s.messageIndex === lastAssistantMsgIdx && s.role === 'assistant'
        );
        for (const seg of lastAssistantSegs) addSegment(seg);
      }
    }

    // Non-superseded code blocks from the anchor window (last 30%)
    const anchorThreshold = 1 - config.anchorWindowFraction;
    const anchorCodeBlocks = segments.filter(
      s => s.type === 'code' && s.positionNormalized >= anchorThreshold
    );
    for (const seg of anchorCodeBlocks) addSegment(seg);

    // ── Step 2: Resolve dependencies for anchors ─────────────────
    // For each anchor, find earlier segments where rare terms first appeared
    const anchorIds = new Set(selectedSet);
    const depSegments = this._resolveDependencies(anchorIds);
    for (const seg of depSegments) addSegment(seg);

    // ── Step 3: Density-sorted fill ──────────────────────────────
    // Sort remaining segments by information density (score / tokenEstimate)
    const remaining = segments
      .filter(s => !selectedSet.has(s.id))
      .map(s => ({
        segment: s,
        density: (scorer.scores.get(s.id) || 0) / (s.tokenEstimate || 1),
        score: scorer.scores.get(s.id) || 0,
      }))
      .sort((a, b) => b.density - a.density);

    for (const { segment: candidate } of remaining) {
      if (usedTokens + candidate.tokenEstimate > tokenBudget) continue;

      // Diversity check: max cosine similarity with already-selected
      const candidateIdx = this.idToIndex.get(candidate.id);
      let tooSimilar = false;

      for (const selIdx of selectedIndices) {
        const sim = scorer.cosineSimilarity(candidateIdx, selIdx);
        if (sim > config.diversityThreshold) {
          tooSimilar = true;
          break;
        }
      }

      if (tooSimilar) continue;

      addSegment(candidate);
    }

    // Build results
    const selected = segments.filter(s => selectedSet.has(s.id));
    const dropped = segments.filter(s => !selectedSet.has(s.id));

    return { selected, dropped, usedTokens };
  }

  /**
   * Resolve dependencies for a set of anchor segments.
   *
   * For each anchor, find its "rare" terms (IDF above median),
   * then find the earliest segment where each rare term first appeared.
   * Those origin segments are dependencies.
   *
   * @param {Set<string>} anchorIds
   * @returns {import('./segmenter.js').Segment[]}
   */
  _resolveDependencies(anchorIds) {
    const { segments, scorer, config } = this;

    // Compute median IDF for "rare" threshold
    const allIdfs = [...scorer.vectorizer.idf.values()].sort((a, b) => a - b);
    const medianIdf = allIdfs[Math.floor(allIdfs.length * config.dependencyIdfPercentile)] || 0;

    const depIds = new Set();

    for (const anchorId of anchorIds) {
      const anchorIdx = this.idToIndex.get(anchorId);
      if (anchorIdx === undefined) continue;

      const anchor = segments[anchorIdx];
      let depsFound = 0;

      // Find rare terms in the anchor
      const rareTerms = anchor.tokens.filter(t => {
        const idf = scorer.vectorizer.idf.get(t);
        return idf !== undefined && idf > medianIdf;
      });

      // Deduplicate
      const uniqueRareTerms = [...new Set(rareTerms)];

      // Sort by IDF descending (rarest first — most likely to be meaningful)
      uniqueRareTerms.sort((a, b) =>
        (scorer.vectorizer.idf.get(b) || 0) - (scorer.vectorizer.idf.get(a) || 0)
      );

      for (const term of uniqueRareTerms) {
        if (depsFound >= config.maxDependenciesPerAnchor) break;

        const originIdx = scorer.termOrigins.get(term);
        if (originIdx === undefined) continue;

        const originSeg = segments[originIdx];
        // Only pull in if it's a different, earlier segment
        if (originSeg.id === anchorId) continue;
        if (originSeg.positionNormalized >= anchor.positionNormalized) continue;
        if (anchorIds.has(originSeg.id) || depIds.has(originSeg.id)) continue;

        depIds.add(originSeg.id);
        depsFound++;
      }
    }

    return segments.filter(s => depIds.has(s.id));
  }
}
