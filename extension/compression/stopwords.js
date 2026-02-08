/**
 * English Stopwords
 *
 * A curated set of ~175 high-frequency English words that carry little
 * semantic weight. Used by the TF-IDF vectorizer to filter noise.
 *
 * Intentionally conservative — we don't strip domain-specific terms
 * like "function", "class", "error" because those are meaningful in
 * programming conversations.
 */

export const STOPWORDS = new Set([
  // Articles & determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those',

  // Pronouns
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',

  // Be / Have / Do
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'done',

  // Modal verbs
  'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must',

  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'up', 'about', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under',
  'over', 'out', 'off', 'down', 'against', 'along',

  // Conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either',
  'neither', 'not', 'only',

  // Common adverbs
  'also', 'just', 'very', 'really', 'quite', 'already',
  'still', 'even', 'too', 'here', 'there', 'then', 'now',
  'when', 'where', 'how', 'why', 'what', 'which', 'who',
  'whom', 'whose',

  // Common verbs (non-domain)
  'get', 'got', 'getting', 'make', 'made', 'making',
  'go', 'going', 'went', 'gone',
  'know', 'known', 'see', 'seen', 'take', 'taken',
  'come', 'came', 'say', 'said',

  // Quantifiers & misc
  'all', 'each', 'every', 'any', 'some', 'no', 'many',
  'much', 'more', 'most', 'few', 'less', 'least',
  'other', 'another', 'such', 'like',

  // Filler
  'if', 'than', 'because', 'as', 'until', 'while',
  'although', 'though', 'since', 'unless',
  'well', 'let', 'sure', 'okay', 'ok', 'yes', 'no',
  'oh', 'ah', 'um', 'uh', 'hmm',

  // LLM-conversation filler
  'hello', 'hey', 'hi',
  'please', 'thanks', 'thank', 'sorry', 'help',
  'need', 'want', 'think', 'try', 'use', 'using', 'used',
  'way', 'thing', 'things', 'something', 'anything',
  'everything', 'nothing',
]);
