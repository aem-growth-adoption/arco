/**
 * Block Renderers
 *
 * Converts typed block JSON (from the call-2 LLM in the template-fill pipeline)
 * into EDS block HTML strings.
 *
 * Strategy: convert each typed block into the {block, rows, data, variants}
 * intermediate format expected by sectionToHtml(), then delegate to it.
 * This reuses all existing escaping, sanitization, and rendering logic.
 *
 * Typed block schemas (call-2 LLM output):
 *   hero             { type, headline, subheadline?, image? }
 *   text             { type, heading?, paragraphs }
 *   cards            { type, items:[{title, body, image?, cta?:{label,href}}] }
 *   comparison-table { type, products:string[], recommended? }
 *   product-list     { type, products:[{slug, reason}] }
 *   testimonials     { type, items:[{quote, author, product?}] }
 *   recipe-steps     { type, title, steps, tips? }
 *   accordion        { type, items:[{question, answer}] }
 *   article-excerpt  { type, slug }
 */

import { sectionToHtml, sanitizeBlockContent } from './json-to-eds.js';

// ---------------------------------------------------------------------------
// Per-type converters — each returns a section object {block, rows, data?}
// ---------------------------------------------------------------------------

/**
 * hero → {block:'hero', rows:[...]}
 *
 * Row 1: [headline h1] + optional subheadline p
 * Row 2 (if image): token row
 */
function heroSection(block) {
  const headlineCell = [{ type: 'h1', text: block.headline }];
  if (block.subheadline) {
    headlineCell.push({ type: 'p', text: block.subheadline });
  }

  const rows = [[headlineCell]];

  if (block.image && block.image.startsWith('{{')) {
    rows.push([[{ type: 'token', value: block.image }]]);
  }

  return { block: 'hero', rows };
}

/**
 * text → {block:'text', rows:[...]}
 *
 * Optional heading row, then one row per paragraph.
 */
function textSection(block) {
  const rows = [];

  if (block.heading) {
    rows.push([[{ type: 'h2', text: block.heading }]]);
  }

  const paragraphs = Array.isArray(block.paragraphs) ? block.paragraphs : [];
  paragraphs.forEach((para) => {
    rows.push([[{ type: 'p', text: para }]]);
  });

  return { block: 'text', rows };
}

/**
 * cards → {block:'cards', rows:[...]}
 *
 * One row per item, two cells:
 *   cell 0: image token or empty-p placeholder
 *   cell 1: title h3 + body p + optional cta link
 */
function cardsSection(block) {
  const items = Array.isArray(block.items) ? block.items : [];

  const rows = items.map((item) => {
    const imageCell = item.image
      ? [{ type: 'token', value: item.image }]
      : [{ type: 'p', text: '' }];

    const contentCell = [
      { type: 'h3', text: item.title },
      { type: 'p', text: item.body },
    ];

    if (item.cta && item.cta.label && item.cta.href) {
      contentCell.push({
        type: 'link',
        text: item.cta.label,
        href: item.cta.href,
        style: 'primary',
      });
    }

    return [imageCell, contentCell];
  });

  return { block: 'cards', rows };
}

/**
 * comparison-table → {block:'comparison-table', rows:[...], data:{recommended}}
 *
 * Each product slug → one token row.
 * data.recommended drives the data-recommended attribute on the block div.
 */
function comparisonTableSection(block) {
  const products = (block.products || []).filter((s) => s && typeof s === 'string');

  const rows = products.map((slug) => [
    [{ type: 'token', value: `{{product:${slug}}}` }],
  ]);

  const data = { recommended: block.recommended || null };

  return { block: 'comparison-table', rows, data };
}

/**
 * product-list → {block:'product-list', rows:[...]}
 *
 * One row per product, two cells: token | reason paragraph.
 */
function productListSection(block) {
  const products = (block.products || []).filter((p) => p && typeof p === 'object' && p.slug);

  const rows = products.map(({ slug, reason }) => [
    [{ type: 'token', value: `{{product:${slug}}}` }],
    [{ type: 'p', text: reason }],
  ]);

  return { block: 'product-list', rows };
}

/**
 * testimonials → {block:'testimonials', rows:[...]}
 *
 * One row per testimonial, one cell: quote p + author strong + optional product link.
 * sanitizeBlockContent() strips malformed rows (empty quotes, rating-only rows, etc.).
 */
function testimonialsSection(block) {
  const items = Array.isArray(block.items) ? block.items : [];

  const rows = items.map((item) => {
    const cell = [
      { type: 'p', text: item.quote },
      { type: 'strong', text: item.author },
    ];

    if (item.product) {
      cell.push({
        type: 'link',
        text: `See ${item.product}`,
        href: `/products/${item.product}`,
        style: 'text',
      });
    }

    return [cell];
  });

  return { block: 'testimonials', rows };
}

/**
 * recipe-steps → {block:'recipe-steps', rows:[...]}
 *
 * Row 1: title h2
 * Row 2: ordered list of steps
 * Row 3 (if tips): "Tips" h3 + unordered list of tips
 */
function recipeStepsSection(block) {
  const rows = [
    [[{ type: 'h2', text: block.title }]],
    [[{ type: 'ol', items: Array.isArray(block.steps) ? block.steps : [] }]],
  ];

  if (Array.isArray(block.tips) && block.tips.length > 0) {
    rows.push([[
      { type: 'h3', text: 'Tips' },
      { type: 'ul', items: block.tips },
    ]]);
  }

  return { block: 'recipe-steps', rows };
}

/**
 * accordion → {block:'accordion', rows:[...]}
 *
 * One row per item, two cells: question p | answer p.
 */
function accordionSection(block) {
  const items = Array.isArray(block.items) ? block.items : [];

  const rows = items.map(({ question, answer }) => [
    [{ type: 'p', text: question }],
    [{ type: 'p', text: answer }],
  ]);

  return { block: 'accordion', rows };
}

/**
 * article-excerpt → {block:'article-excerpt', rows:[...]}
 *
 * One row, one cell: story token.
 */
function articleExcerptSection(block) {
  const rows = [
    [[{ type: 'token', value: `{{story:${block.slug}}}` }]],
  ];

  return { block: 'article-excerpt', rows };
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const RENDERERS = {
  hero: heroSection,
  text: textSection,
  cards: cardsSection,
  'comparison-table': comparisonTableSection,
  'product-list': productListSection,
  testimonials: testimonialsSection,
  'recipe-steps': recipeStepsSection,
  accordion: accordionSection,
  'article-excerpt': articleExcerptSection,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a typed block (call-2 LLM output) to an EDS HTML string.
 *
 * @param {Object} typedBlock - Typed block from the template-fill LLM response.
 *   Must have a `type` field matching one of the 9 supported block types.
 * @returns {string} EDS block HTML string, or '' if the block type is unknown
 *   or results in no content after sanitization.
 *
 * Callers are responsible for running sanitizeContentCards, resolveTokens,
 * normalizeProductUrls, and sanitizeHTML on the returned HTML.
 */
export function renderBlock(typedBlock) {
  if (!typedBlock || !typedBlock.type) {
    console.warn('[block-renderers] renderBlock called with missing type:', typedBlock);
    return '';
  }

  const renderer = RENDERERS[typedBlock.type];
  if (!renderer) {
    console.warn(`[block-renderers] Unknown block type: "${typedBlock.type}"`);
    return '';
  }

  let section;
  try {
    section = renderer(typedBlock);
  } catch (err) {
    console.error(`[block-renderers] Error building section for type "${typedBlock.type}":`, err);
    return '';
  }

  // Sanitize (strips malformed testimonial rows, etc.)
  const sanitized = sanitizeBlockContent(section);
  if (!sanitized) {
    // sanitizeBlockContent returns null to signal "skip this section entirely"
    return '';
  }

  return sectionToHtml(sanitized);
}

/**
 * Build the section object for a typed block — applies sanitizeBlockContent
 * but does NOT call sectionToHtml(). Callers that need to run sanitizeContentCards
 * should use this instead of renderBlock().
 *
 * @param {Object} typedBlock - Typed block from the template-fill LLM response.
 * @returns {Object|null} Sanitized section object, or null if the block is unknown
 *   or results in no content after sanitization.
 */
export function buildSection(typedBlock) {
  if (!typedBlock || !typedBlock.type) return null;
  const renderer = RENDERERS[typedBlock.type];
  if (!renderer) return null;
  try {
    const section = renderer(typedBlock);
    return sanitizeBlockContent(section);
  } catch (err) {
    console.warn(`[block-renderers] Error building section for ${typedBlock.type}:`, err.message);
    return null;
  }
}
