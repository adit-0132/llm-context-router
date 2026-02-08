/**
 * Structural Analyzer — Layer 1
 *
 * Performs deterministic cleanup on segments before any scoring:
 *
 *   1. Code Supersession Detection
 *      If two code blocks share >30% tokens (Jaccard similarity) and
 *      are in the same language, the older one is marked as superseded.
 *      Only the latest version survives.
 *
 *   2. Meta Elimination
 *      Segments classified as 'meta' (greetings, thanks, pleasantries)
 *      are removed entirely from the candidate pool.
 *
 * The output is a reduced set of "live" segments — candidates for
 * Layer 2 scoring. Eliminated segments are tracked for the manifest.
 */

import { DEFAULT_CONFIG } from './config.js';

// ── Jaccard Similarity ──────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two token sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @returns {number} Similarity in [0, 1]
 */
function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 && tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract the language identifier from a code segment.
 * Falls back to null if not detected.
 *
 * @param {import('./segmenter.js').Segment} seg
 * @returns {string|null}
 */
function getCodeLanguage(seg) {
  return seg.codeLanguage || null;
}

// ── Code Supersession Detection ─────────────────────────────────────

/**
 * Detect superseded code blocks.
 *
 * For each pair of code segments:
 *   - If they share the same language (or both have no language)
 *   - AND their Jaccard token similarity exceeds the threshold
 *   - AND one appears later in the conversation
 *   → the earlier one is superseded
 *
 * Returns the set of segment IDs that are superseded (stale).
 *
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {number} [jaccardThreshold]
 * @returns {{ supersededIds: Set<string>, supersessionPairs: Array<{stale: string, replacement: string, similarity: number}> }}
 */
export function detectSupersession(segments, jaccardThreshold = DEFAULT_CONFIG.supersessionJaccardThreshold) {
  const codeSegments = segments.filter(s => s.type === 'code');
  const supersededIds = new Set();
  const supersessionPairs = [];

  // Compare each pair of code segments
  for (let i = 0; i < codeSegments.length; i++) {
    // Skip if already superseded
    if (supersededIds.has(codeSegments[i].id)) continue;

    for (let j = i + 1; j < codeSegments.length; j++) {
      if (supersededIds.has(codeSegments[j].id)) continue;

      const older = codeSegments[i];
      const newer = codeSegments[j];

      // Same language check (null == null is OK — both unspecified)
      const langOlder = getCodeLanguage(older);
      const langNewer = getCodeLanguage(newer);
      if (langOlder !== langNewer) continue;

      // Jaccard similarity on token sets
      const similarity = jaccardSimilarity(older.tokens, newer.tokens);

      if (similarity >= jaccardThreshold) {
        // The older one is superseded by the newer one
        supersededIds.add(older.id);
        supersessionPairs.push({
          stale: older.id,
          replacement: newer.id,
          similarity: parseFloat(similarity.toFixed(3)),
        });
        break; // This older block is already superseded, move on
      }
    }
  }

  return { supersededIds, supersessionPairs };
}

// ── Meta Elimination ────────────────────────────────────────────────

/**
 * Find segments that should be eliminated (meta/pleasantry segments
 * and very short acknowledgments).
 *
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {Object} [config]
 * @returns {Set<string>} IDs of segments to eliminate
 */
export function detectMeta(segments, config = DEFAULT_CONFIG) {
  const metaIds = new Set();

  if (!config.eliminateMeta) return metaIds;

  for (const seg of segments) {
    // Explicit meta classification from segmenter
    if (seg.type === 'meta') {
      metaIds.add(seg.id);
      continue;
    }

    // Short user acknowledgments: "great", "works", "nice", "ok cool", etc.
    if (
      seg.role === 'user' &&
      seg.content.length <= config.shortAcknowledgmentMaxChars &&
      !seg.content.includes('?') &&
      seg.type === 'reasoning' &&
      !seg.isArtifact
    ) {
      // Check if it's actually just a short affirmation
      const words = seg.content.trim().split(/\s+/);
      if (words.length <= 6) {
        metaIds.add(seg.id);
      }
    }
  }

  return metaIds;
}

// ── Main Analyzer ───────────────────────────────────────────────────

/**
 * @typedef {Object} AnalysisResult
 * @property {import('./segmenter.js').Segment[]} liveSegments   - Segments surviving analysis
 * @property {import('./segmenter.js').Segment[]} eliminatedSegments - Removed segments
 * @property {Set<string>} supersededIds  - IDs eliminated by supersession
 * @property {Set<string>} metaIds        - IDs eliminated as meta
 * @property {Array} supersessionPairs    - Supersession details for manifest
 */

/**
 * Run Layer 1 structural analysis on all segments.
 *
 * @param {import('./segmenter.js').Segment[]} segments - All segments from segmenter
 * @param {Object} [config]
 * @returns {AnalysisResult}
 */
export function analyze(segments, config = DEFAULT_CONFIG) {
  // Step 1: Detect superseded code blocks
  const { supersededIds, supersessionPairs } = detectSupersession(
    segments,
    config.supersessionJaccardThreshold
  );

  // Step 2: Detect meta/acknowledgment segments
  const metaIds = detectMeta(segments, config);

  // Step 3: Partition into live vs eliminated
  const eliminatedIds = new Set([...supersededIds, ...metaIds]);
  const liveSegments = [];
  const eliminatedSegments = [];

  for (const seg of segments) {
    if (eliminatedIds.has(seg.id)) {
      eliminatedSegments.push(seg);
    } else {
      liveSegments.push(seg);
    }
  }

  return {
    liveSegments,
    eliminatedSegments,
    supersededIds,
    metaIds,
    supersessionPairs,
  };
}
