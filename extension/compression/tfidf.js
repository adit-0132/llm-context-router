/**
 * TF-IDF Vectorizer
 *
 * Pure-JavaScript implementation of Term Frequency–Inverse Document Frequency.
 * Produces sparse vectors (Map<string, number>) for memory efficiency — a
 * conversation's vocabulary can easily exceed 5000 terms, and most segments
 * use only a small subset.
 *
 * Includes cosine similarity computation with precomputed norms.
 *
 * No external dependencies.
 */

// ── TFIDFVectorizer ─────────────────────────────────────────────────

export class TFIDFVectorizer {
  constructor() {
    /** @type {Map<string, number>} term → document frequency count */
    this.df = new Map();

    /** @type {number} total number of documents (segments) */
    this.docCount = 0;

    /** @type {Map<string, number>} term → IDF weight (cached after fit) */
    this.idf = new Map();

    /** @type {boolean} */
    this.fitted = false;
  }

  /**
   * Learn vocabulary and IDF weights from a collection of segments.
   *
   * @param {Array<{tokens: string[]}>} segments - Pre-tokenized segments
   */
  fit(segments) {
    this.df.clear();
    this.idf.clear();
    this.docCount = segments.length;

    // Count document frequency for each term
    for (const seg of segments) {
      // Use a Set to count each term at most once per document
      const seen = new Set(seg.tokens);
      for (const term of seen) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
      }
    }

    // Precompute IDF: log(N / df) with smoothing to avoid division by zero
    // Using log(1 + N / (1 + df)) — sublinear TF-IDF variant
    for (const [term, freq] of this.df) {
      this.idf.set(term, Math.log(1 + this.docCount / (1 + freq)));
    }

    this.fitted = true;
  }

  /**
   * Transform a single segment into a sparse TF-IDF vector.
   *
   * @param {Array<string>} tokens - Pre-tokenized words
   * @returns {{ vector: Map<string, number>, norm: number }}
   */
  transform(tokens) {
    if (!this.fitted) {
      throw new Error('TFIDFVectorizer: call fit() before transform()');
    }

    // Compute term frequency (normalized by document length)
    const tf = new Map();
    for (const term of tokens) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    const docLength = tokens.length || 1;
    const vector = new Map();
    let normSq = 0;

    for (const [term, count] of tf) {
      const idfWeight = this.idf.get(term);
      if (idfWeight === undefined) continue; // term not in learned vocabulary

      // Sublinear TF: 1 + log(tf) to dampen high-frequency terms
      const tfWeight = 1 + Math.log(count / docLength + 1);
      const tfidf = tfWeight * idfWeight;

      vector.set(term, tfidf);
      normSq += tfidf * tfidf;
    }

    return { vector, norm: Math.sqrt(normSq) };
  }

  /**
   * Convenience: fit on all segments, then transform each.
   *
   * @param {Array<{tokens: string[]}>} segments
   * @returns {Array<{ vector: Map<string, number>, norm: number }>}
   */
  fitTransform(segments) {
    this.fit(segments);
    return segments.map(seg => this.transform(seg.tokens));
  }

  /**
   * Compute cosine similarity between two sparse TF-IDF vectors.
   *
   * cosine(A, B) = (A · B) / (‖A‖ × ‖B‖)
   *
   * Iterates over the smaller vector for efficiency.
   *
   * @param {{ vector: Map<string, number>, norm: number }} a
   * @param {{ vector: Map<string, number>, norm: number }} b
   * @returns {number} Similarity in [0, 1]
   */
  cosineSimilarity(a, b) {
    if (a.norm === 0 || b.norm === 0) return 0;

    // Iterate over the smaller vector for performance
    const [smaller, larger] = a.vector.size <= b.vector.size
      ? [a.vector, b.vector]
      : [b.vector, a.vector];

    let dotProduct = 0;
    for (const [term, weight] of smaller) {
      const otherWeight = larger.get(term);
      if (otherWeight !== undefined) {
        dotProduct += weight * otherWeight;
      }
    }

    return dotProduct / (a.norm * b.norm);
  }
}
