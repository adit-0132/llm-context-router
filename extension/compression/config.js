/**
 * Compression Engine Configuration
 *
 * All tunable parameters for the semantic graph compression pipeline.
 * Weights, thresholds, and boost multipliers are exposed here so they
 * can be adjusted without touching algorithm code.
 */

export const DEFAULT_CONFIG = Object.freeze({
  // ── Edge Weight Coefficients ──────────────────────────────────────
  // Composite edge weight = α·content + β·temporal + γ·crossRole + δ·reference
  alpha: 0.40,   // Content similarity (TF-IDF cosine)
  beta:  0.20,   // Temporal proximity in conversation
  gamma: 0.25,   // Cross-role bonus (user ↔ assistant)
  delta: 0.15,   // Explicit reference detection

  // ── TextRank (PageRank) Parameters ────────────────────────────────
  dampingFactor: 0.85,       // PageRank damping (standard value)
  convergenceThreshold: 0.0001,
  maxIterations: 100,

  // ── Segment Type Boost Multipliers ────────────────────────────────
  boosts: Object.freeze({
    code_final:  2.0,   // Code blocks in the last 25% of conversation
    code:        1.2,   // Code blocks elsewhere
    decision:    1.5,   // "Let's go with X", "I'll use Y"
    question:    1.0,   // Neutral
    reasoning:   1.0,   // Neutral
    list:        0.9,   // Slightly lower — often verbose
    meta:        0.1,   // "Thanks!", "Sure!", greetings
  }),

  // ── Recency Boost ─────────────────────────────────────────────────
  // Segments in the last `recencyWindow` fraction get `recencyMultiplier`
  recencyWindow: 0.25,       // Last 25% of conversation
  recencyMultiplier: 1.3,

  // ── Diversity Constraint (MMR-style) ──────────────────────────────
  // A candidate is only added if its max cosine similarity with
  // already-selected segments is below this threshold.
  diversityThreshold: 0.70,

  // ── Graph Construction ────────────────────────────────────────────
  edgePruneThreshold: 0.05,  // Drop edges with weight below this

  // ── Token Estimation ──────────────────────────────────────────────
  // Rough chars-per-token ratio for budget estimation.
  // English text averages ~4 chars/token; code is denser (~3.5).
  charsPerToken: 4,

  // ── Always-Preserve Rules ─────────────────────────────────────────
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
 *
 * `tokenBudgetFraction` is the fraction of original tokens to retain.
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
  // Map [0, 100] → [0.05, 1.0]
  return 0.05 + (clamped / 100) * 0.95;
}
