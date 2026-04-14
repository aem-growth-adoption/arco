/**
 * Hero Image Selection — Hybrid keyword + vector scoring.
 *
 * Uses the unified hero image catalog (content/hero-image-catalog.json) which
 * contains ~88 entries from lifestyle, curated, and product sources.
 *
 * Selection combines:
 *   1. Keyword scoring (product match +10, topic overlap +2, partial +1)
 *   2. Vector similarity from pre-computed RAG results (score * 8)
 *
 * Vector matches arrive pre-computed from the RAG step — no async needed here.
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import catalogData from '../../../content/hero-image-catalog.json';
/* eslint-enable import/extensions, import/no-relative-packages */

export const HERO_IMAGE_CATALOG = catalogData.images;

// ---------------------------------------------------------------------------
// Intent fallback topics
// ---------------------------------------------------------------------------

const INTENT_FALLBACK_TOPICS = {
  beginner: ['beginner', 'welcome', 'easy', 'first-machine', 'discovery'],
  discovery: ['discovery', 'general', 'espresso', 'welcome'],
  comparison: ['comparison', 'side-by-side', 'upgrade', 'choosing'],
  'product-detail': ['espresso', 'home-barista'],
  'use-case': ['espresso', 'home'],
  specs: ['technical', 'pressure', 'extraction', 'specs'],
  reviews: ['espresso', 'home-barista'],
  price: ['budget', 'entry-level', 'choosing'],
  recommendation: ['espresso', 'home-barista', 'discovery'],
  support: ['maintenance', 'cleaning', 'support', 'troubleshooting'],
  gift: ['espresso', 'home', 'beginner'],
  medical: ['general', 'espresso'],
  accessibility: ['easy', 'automatic', 'simple'],
  technique: ['technique', 'extraction', 'dialing-in', 'precision'],
  upgrade: ['upgrade', 'comparison', 'progression', 'advanced'],
};

// ---------------------------------------------------------------------------
// Tokenization & Keyword Scoring
// ---------------------------------------------------------------------------

/**
 * Tokenise a query string and use-case list into a normalised keyword set.
 */
function tokenize(query, useCases) {
  const tokens = new Set();
  if (query) {
    query.toLowerCase().split(/[\s,;.!?]+/).forEach((word) => {
      const trimmed = word.replace(/[^a-z0-9-]/g, '');
      if (trimmed.length > 2) tokens.add(trimmed);
    });
  }
  if (useCases) {
    useCases.forEach((uc) => {
      tokens.add(uc.toLowerCase().trim());
      uc.toLowerCase().split(/[\s-]+/).forEach((word) => {
        if (word.length > 2) tokens.add(word);
      });
    });
  }
  return tokens;
}

/**
 * Score a hero image against the given query context using keywords.
 * Higher score = better match.
 */
function scoreImage(image, queryTokens, productIds) {
  let score = 0;

  // Exact product match is the strongest signal
  if (image.productIds) {
    productIds.forEach((pid) => {
      if (image.productIds.includes(pid)) score += 10;
    });
  }

  // Topic overlap with query tokens
  (image.topics || []).forEach((topic) => {
    if (queryTokens.has(topic)) {
      score += 2;
    }
    // Partial match — topic inside a token or vice versa
    queryTokens.forEach((token) => {
      if (token !== topic && (token.includes(topic) || topic.includes(token))) {
        score += 1;
      }
    });
  });

  return score;
}

// ---------------------------------------------------------------------------
// Selection — Hybrid keyword + vector
// ---------------------------------------------------------------------------

/**
 * Select the best hero image for a given query context.
 *
 * Combines keyword scoring with pre-computed vector similarity from the RAG step.
 * Product matches (+10) dominate; for mood/lifestyle queries, vector similarity
 * provides the decisive signal.
 *
 * @param {Object} keywordCtx
 * @param {string} [keywordCtx.query] - The user's search query
 * @param {string[]} [keywordCtx.useCases] - Extracted use cases
 * @param {string} [keywordCtx.intentType] - Classified intent type
 * @param {string[]} [keywordCtx.productIds] - Relevant product IDs from RAG
 * @param {Array} [vectorMatches=[]] - Pre-computed vector matches from ctx.rag.heroImages
 * @returns {{ url: string, alt: string }} Image URL and alt text
 */
export function selectHeroImage({
  query, useCases, intentType, productIds = [],
} = {}, vectorMatches = []) {
  const queryTokens = tokenize(query, useCases);

  // Also add intent type as a query token for topic matching
  if (intentType) queryTokens.add(intentType);

  // Build vector score lookup: id → similarity score
  const vectorScoreMap = new Map();
  vectorMatches.forEach((vm) => {
    if (vm.id && vm.score != null) {
      vectorScoreMap.set(vm.id, vm.score);
    }
  });

  // Score every image: keyword + vector boost
  let scored = HERO_IMAGE_CATALOG.map((image) => {
    const keywordScore = scoreImage(image, queryTokens, productIds);
    const vectorScore = vectorScoreMap.get(image.id) || 0;
    return {
      image,
      keywordScore,
      vectorScore,
      score: keywordScore + (vectorScore * 8),
    };
  });

  // If no strong match (best score <= 1), inject intent fallback topics
  const bestScore = Math.max(...scored.map((s) => s.score));
  if (bestScore <= 1 && intentType) {
    const fallbackTopics = INTENT_FALLBACK_TOPICS[intentType] || ['general', 'espresso'];
    fallbackTopics.forEach((topic) => queryTokens.add(topic));
    scored = HERO_IMAGE_CATALOG.map((image) => {
      const keywordScore = scoreImage(image, queryTokens, productIds);
      const vectorScore = vectorScoreMap.get(image.id) || 0;
      return {
        image,
        keywordScore,
        vectorScore,
        score: keywordScore + (vectorScore * 8),
      };
    });
  }

  // Sort descending by score, random jitter to break ties
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return Math.random() - 0.5;
  });

  // Pick from the top tier (all images sharing the highest score)
  const topScore = scored[0].score;
  const topTier = scored.filter((s) => s.score === topScore);
  const selected = topTier[Math.floor(Math.random() * topTier.length)].image;

  // URL is pre-resolved in the catalog — no more DEFAULT_HERO fallback
  return {
    url: selected.url,
    alt: selected.alt,
  };
}
