/**
 * Composer
 *
 * Reassembles selected segments back into a clean .llmchat v2.0 file:
 *
 *   1. Groups selected segments back into their parent messages
 *   2. Maintains chronological order
 *   3. Merges adjacent segments within the same message
 *   4. Generates the compression manifest with statistics
 *
 * The manifest makes the compression fully transparent — it records
 * what was kept, what was dropped, and categorizes the reasons.
 */

import { DEFAULT_CONFIG } from './config.js';

/**
 * Categorize why a segment was dropped.
 *
 * @param {import('./segmenter.js').Segment} seg
 * @param {Map<string, number>} ranks - Boosted ranks
 * @param {number} medianRank - Median rank score
 * @returns {'redundant' | 'meta' | 'superseded' | 'low_rank'}
 */
function categorizeDropReason(seg, ranks, medianRank) {
  if (seg.type === 'meta') return 'meta';

  const score = ranks.get(seg.id) || 0;

  // If it's a code block that's not in the final portion,
  // it was likely superseded by a later version
  if (seg.type === 'code' && seg.positionNormalized < 0.75) {
    return 'superseded';
  }

  if (score < medianRank * 0.5) return 'low_rank';

  // Default: dropped due to diversity constraint (redundant with a kept segment)
  return 'redundant';
}

/**
 * Extract top topic terms from the selected segments.
 * Uses term frequency across selected segments to find dominant topics.
 *
 * @param {import('./segmenter.js').Segment[]} selected
 * @param {number} [topN=5]
 * @returns {string[]}
 */
function extractTopTopics(selected, topN = 5) {
  const termFreq = new Map();

  for (const seg of selected) {
    // Count each term once per segment (document frequency style)
    const seen = new Set(seg.tokens);
    for (const term of seen) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }
  }

  // Sort by frequency, take top N
  return [...termFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term]) => term);
}

/**
 * Compose the final compressed .llmchat v2.0 output.
 *
 * @param {Object} originalData - The original .llmchat data
 * @param {import('./segmenter.js').Segment[]} allSegments - All segments
 * @param {import('./segmenter.js').Segment[]} selected - Selected segments
 * @param {import('./segmenter.js').Segment[]} dropped - Dropped segments
 * @param {number} usedTokens - Token budget used
 * @param {Map<string, number>} boostedRanks - From ranker
 * @param {Object} compressionConfig - The config used for this compression
 * @param {number} qualitySlider - The slider value (0–100)
 * @returns {Object} Compressed .llmchat v2.0 JSON
 */
export function compose(
  originalData,
  allSegments,
  selected,
  dropped,
  usedTokens,
  boostedRanks,
  compressionConfig,
  qualitySlider
) {
  // ── Step 1: Group selected segments by message index ──────────
  const messageGroups = new Map(); // messageIndex → [segments]

  // Sort selected by original position to maintain chronological order
  const sortedSelected = [...selected].sort((a, b) => {
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
    // Within same message, sort by segment ID to maintain order
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  for (const seg of sortedSelected) {
    if (!messageGroups.has(seg.messageIndex)) {
      messageGroups.set(seg.messageIndex, []);
    }
    messageGroups.get(seg.messageIndex).push(seg);
  }

  // ── Step 2: Reassemble messages ───────────────────────────────
  const compressedMessages = [];

  for (const [msgIdx, segs] of messageGroups) {
    const originalMsg = originalData.messages[msgIdx];
    if (!originalMsg) continue;

    // Merge segment contents with double newlines
    const mergedContent = segs.map(s => s.content).join('\n\n');

    compressedMessages.push({
      id: originalMsg.id,
      role: originalMsg.role,
      content: mergedContent,
      timestamp: originalMsg.timestamp,
      metadata: {
        ...originalMsg.metadata,
        _compression: {
          segments_kept: segs.length,
          segment_types: [...new Set(segs.map(s => s.type))],
        }
      }
    });

    // Preserve artifacts if present
    if (originalMsg.artifacts && originalMsg.artifacts.length > 0) {
      compressedMessages[compressedMessages.length - 1].artifacts = originalMsg.artifacts;
    }
  }

  // ── Step 3: Compute statistics ────────────────────────────────
  const originalTokens = allSegments.reduce((sum, s) => sum + s.tokenEstimate, 0);

  // Median rank for drop categorization
  const rankValues = [...boostedRanks.values()].sort((a, b) => a - b);
  const medianRank = rankValues[Math.floor(rankValues.length / 2)] || 0;

  // Categorize drops
  const dropCategories = { redundant: 0, meta: 0, superseded: 0, low_rank: 0 };
  for (const seg of dropped) {
    const reason = categorizeDropReason(seg, boostedRanks, medianRank);
    dropCategories[reason]++;
  }

  const topTopics = extractTopTopics(selected);

  // ── Step 4: Build v2.0 output ─────────────────────────────────
  return {
    version: '2.0',
    standard: 'llmchat',
    metadata: {
      title: originalData.metadata.title,
      created: originalData.metadata.created,
      updated: originalData.metadata.updated,
      source_platform: originalData.metadata.source_platform,
      source_model: originalData.metadata.source_model,
      conversation_id: originalData.metadata.conversation_id,
      original_messages: originalData.messages.length,
      original_tokens_estimate: originalTokens,
      compressed_messages: compressedMessages.length,
      compressed_tokens_estimate: usedTokens,
      compression_ratio: parseFloat((usedTokens / originalTokens).toFixed(3)),
      compression_method: 'semantic-graph-textrank-v1',
      quality_level: qualitySlider,
      compression_config: {
        alpha: compressionConfig.alpha,
        beta: compressionConfig.beta,
        gamma: compressionConfig.gamma,
        delta: compressionConfig.delta,
        diversity_threshold: compressionConfig.diversityThreshold,
      }
    },
    messages: compressedMessages,
    compression_manifest: {
      total_segments: allSegments.length,
      kept_segments: selected.length,
      dropped_segments: dropped.length,
      top_topics: topTopics,
      dropped_categories: dropCategories,
    }
  };
}
