/**
 * Compression Engine Configuration — v2
 *
 * All tunable parameters for the 3-layer compression pipeline.
 *
 * Layer 1: Structural Analysis (supersession, meta elimination)
 * Layer 2: Information-Theoretic Scoring (novelty × density × recency × role)
 * Layer 3: Dependency-Aware Selection (anchors → deps → density fill)
 */

export const DEFAULT_CONFIG = Object.freeze({
  // ── Layer 1: Structural Analysis ──────────────────────────────────

  // Code supersession: if two code blocks share > this fraction of tokens
  // (Jaccard similarity) and are in the same language, the older one is stale.
  supersessionJaccardThreshold: 0.30,

  // Meta elimination: segments classified as 'meta' are removed entirely
  eliminateMeta: true,

  // ── Layer 2: Information Scoring ──────────────────────────────────

  // Exponential recency decay: score = e^(-λ × (1 - position))
  // λ = 2.0 → half-life at ~35% from the end
  //   position 1.0 (latest):  recency = 1.0
  //   position 0.5 (middle):  recency = 0.37
  //   position 0.0 (oldest):  recency = 0.14
  recencyDecayLambda: 2.0,

  // Role-based weight multipliers
  roleWeights: Object.freeze({
    user_requirement:       1.5,   // User message with question or constraint
    user_acknowledgment:    0.2,   // User message that's short / affirmative
    user_default:           0.8,   // User message — general
    assistant_with_code:    2.0,   // Assistant message containing code blocks
    assistant_with_decision: 1.8,  // Assistant message containing decisions
    assistant_explanation:  0.6,   // Assistant message — explanation only
    assistant_default:      0.8,   // Assistant message — general
  }),

  // Short acknowledgment threshold: user messages with fewer chars than this
  // and no question marks are classified as "acknowledgment"
  shortAcknowledgmentMaxChars: 80,

  // ── Layer 3: Selection ────────────────────────────────────────────

  // Anchor window: non-superseded code blocks from the last N% of
  // the conversation are automatic anchors (always kept).
  anchorWindowFraction: 0.30,  // last 30%

  // Dependency detection: a term is "rare" if its IDF is above median IDF.
  // For each anchor, we find where rare terms first appeared → dependency.
  // This threshold controls the minimum IDF percentile for a term to
  // be considered when detecting dependencies.
  dependencyIdfPercentile: 0.50,  // above median

  // Max dependencies to pull per anchor (prevents explosion)
  maxDependenciesPerAnchor: 5,

  // Diversity constraint (MMR-style): skip candidate if max cosine
  // similarity with any already-selected segment exceeds this.
  diversityThreshold: 0.70,

  // ── Shared ────────────────────────────────────────────────────────

  // Token estimation: chars per token (English ≈ 4, code ≈ 3.5)
  charsPerToken: 4,

  // Always-preserve anchors
  alwaysKeepFirstUserMessage: true,
  alwaysKeepLastAssistantMessage: true,
});

/**
 * Compression presets mapped to the quality slider (0–100).
 *
 * The slider represents "quality" (how much to KEEP), not "compression".
 *   100 = keep everything (raw export)
 *    70 = conservative — keep ~70% of tokens
 *    40 = moderate (DEFAULT) — keep ~40% of tokens
 *    15 = aggressive — keep ~15% of tokens
 */
export const PRESETS = Object.freeze({
  RAW:          { quality: 100, tokenBudgetFraction: 1.00, label: 'Raw (no compression)' },
  CONSERVATIVE: { quality: 70,  tokenBudgetFraction: 0.70, label: 'Conservative' },
  MODERATE:     { quality: 40,  tokenBudgetFraction: 0.40, label: 'Moderate' },
  AGGRESSIVE:   { quality: 15,  tokenBudgetFraction: 0.15, label: 'Aggressive' },
});

/**
 * Interpolate a token budget fraction from the slider value (0–100).
 * Linear interpolation: slider=100 → keep 100%, slider=0 → keep 5%.
 *
 * @param {number} sliderValue - Quality slider value, 0–100
 * @returns {number} Fraction of tokens to keep (0.05–1.0)
 */
export function qualityToFraction(sliderValue) {
  const clamped = Math.max(0, Math.min(100, sliderValue));
  return 0.05 + (clamped / 100) * 0.95;
}
