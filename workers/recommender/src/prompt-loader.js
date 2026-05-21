/**
 * Prompt loader — parses YAML prompt templates and renders them with
 * Nunjucks. Used by:
 *  - production worker code: `renderPrompt(name, ctx)` → { system, user }
 *  - promptfoo tests:        `renderForPromptfoo({ vars })` → OpenAI messages
 *
 * Templates are bundled as text imports (see wrangler.jsonc `rules`) so the
 * worker needs no runtime filesystem. YAML is parsed and Nunjucks templates
 * compiled exactly once at module init.
 */

import nunjucks from 'nunjucks';
import yaml from 'yaml';

/* eslint-disable import/extensions */
import recommenderYaml from '../prompts/recommender.yaml';
import suggestionsYaml from '../prompts/suggestions.yaml';
import brandVoicePartial from '../prompts/partials/brand-voice.njk';
import blockGuidePartial from '../prompts/partials/block-guide.njk';
import productCatalogPartial from '../prompts/partials/product-catalog.njk';
import accessoriesPartial from '../prompts/partials/accessories.njk';
/* eslint-enable import/extensions */

// ── In-memory Nunjucks loader (no filesystem on Workers) ────────────────────
class InMemoryLoader {
  constructor(templates) {
    this.templates = templates;
  }

  getSource(name) {
    const src = this.templates[name];
    if (src === undefined) {
      throw new Error(`Template not found: ${name}`);
    }
    return { src, path: name, noCache: false };
  }
}

const PARTIALS = {
  'partials/brand-voice.njk': brandVoicePartial,
  'partials/block-guide.njk': blockGuidePartial,
  'partials/product-catalog.njk': productCatalogPartial,
  'partials/accessories.njk': accessoriesPartial,
};

const env = new nunjucks.Environment(new InMemoryLoader(PARTIALS), {
  autoescape: false,
  throwOnUndefined: false,
  trimBlocks: false,
  lstripBlocks: false,
});

// ── Parse YAML + compile templates once ─────────────────────────────────────
function parsePrompt(yamlText) {
  const parsed = yaml.parse(yamlText);
  if (!parsed?.system || !parsed?.user) {
    throw new Error('Prompt YAML missing `system` or `user` key');
  }
  return {
    system: nunjucks.compile(parsed.system, env),
    user: nunjucks.compile(parsed.user, env),
  };
}

const PROMPTS = {
  recommender: parsePrompt(recommenderYaml),
  suggestions: parsePrompt(suggestionsYaml),
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a named prompt with the given context object.
 *
 * @param {'recommender'|'suggestions'} name
 * @param {object} ctx — see prompts/README.md for the schema per prompt
 * @returns {{ system: string, user: string }}
 */
export function renderPrompt(name, ctx) {
  const prompt = PROMPTS[name];
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  const safe = normalizeContext(ctx);
  return {
    system: prompt.system.render(safe),
    user: prompt.user.render(safe),
  };
}

/**
 * Defensive defaults — let templates use `intent.type`, `behavior.foo`,
 * `rag.bar` without null checks. Missing optional sections render to empty.
 */
function normalizeContext(ctx) {
  return {
    query: ctx.query || '',
    scenario: ctx.scenario || 'default',
    catalog: ctx.catalog || [],
    accessories: ctx.accessories || [],
    intent: ctx.intent || { type: '', journeyStage: '' },
    followUp: ctx.followUp || null,
    behavior: ctx.behavior || { coldStart: true },
    featureMatch: ctx.featureMatch || null,
    history: ctx.history || '',
    shownProductsLine: ctx.shownProductsLine || '',
    rag: ctx.rag || {},
    previousQueries: ctx.previousQueries || null,
    shownBlockTypes: ctx.shownBlockTypes || null,
    // suggestions fields (used after Task 18)
    count: ctx.count,
    userProfile: ctx.userProfile,
    recentlyViewed: ctx.recentlyViewed,
    excludeQueries: ctx.excludeQueries,
    pageUrl: ctx.pageUrl,
    pageTitle: ctx.pageTitle,
  };
}

// ── Catalog enrichment helpers ──────────────────────────────────────────────
// These pre-compute underscore fields the catalog/accessories partials consume.
// IMPORTANT: the output of these helpers must produce strings that, when
// rendered through the partials, byte-equal the old buildProductCatalog() /
// buildAccessoriesList() output. Snapshot tests in Task 10 enforce this.

/**
 * Adds underscore fields to each product:
 *   _boiler, _group, _pump, _power, _specials, _bestFor, _warranty, _topUses, _heatUp
 *
 * Logic mirrors workers/recommender/src/recommender-prompt.js:68-103 exactly.
 *
 * @param {Array} products — raw products.json entries
 * @param {Array|object} profiles — product-profiles.json `.data` or `.profiles`
 * @returns {Array} enriched products
 */
export function enrichCatalogForPrompt(products, profiles) {
  const profileLookup = Array.isArray(profiles)
    ? new Map(profiles.map((p) => [(p.productId || p.id), p]))
    : new Map(Object.entries(profiles || {}));

  return products.map((p) => {
    const profile = profileLookup.get(p.id);
    const topUsesStr = profile?.scores
      ? Object.entries(profile.scores)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([uc, score]) => `${uc}(${score})`)
          .join(', ')
      : '';

    const specials = [];
    if (p.specs?.pidControl) specials.push('PID');
    if (p.specs?.flowControl) specials.push('Flow Control');
    if (p.specs?.pressureProfiling) specials.push('Pressure Profiling');
    if (p.specs?.plumbedIn) specials.push('Plumb-in');
    if (p.specs?.builtInGrinder) specials.push('Built-in Grinder');
    if (p.specs?.touchscreen) specials.push('Touchscreen');
    if (p.specs?.autoMilk) specials.push('Auto Milk');
    if (p.specs?.programmableDrinks) {
      specials.push(`${p.specs.programmableDrinks} programmable drinks`);
    }

    return {
      ...p,
      _boiler: p.specs?.boilers || '?',
      _group: p.specs?.groupHead || '?',
      _pump: p.specs?.pumpType || '?',
      _power: p.specs?.power || '?',
      _specials: specials.join(', '),
      _bestFor: p.bestFor?.join(', ') || 'general',
      _warranty: p.warranty || 'N/A',
      _topUses: topUsesStr,
      _heatUp: p.specs?.heatUpTime || '?',
    };
  });
}

/**
 * Adds `_description` (original `description` truncated to 80 chars) to each
 * accessory. Mirrors workers/recommender/src/recommender-prompt.js:108-113.
 *
 * @param {Array} accessories — raw accessories.json entries
 * @returns {Array} enriched accessories
 */
export function enrichAccessoriesForPrompt(accessories) {
  return (accessories || []).map((a) => ({
    ...a,
    _description: (a.description || '').substring(0, 80),
  }));
}

/**
 * Truncate fields on RAG entries that templates consume as `_snippet` /
 * `_verdictSnippet`. Mirrors the substring truncations in
 * workers/recommender/src/recommender-prompt.js:551 (reviews → 80),
 * :555 (faqs → 100), :564 (comparisons → 120).
 *
 * @param {object} rag
 * @returns {object} enriched rag (shallow clone)
 */
export function enrichRagForPrompt(rag) {
  if (!rag) return {};
  return {
    ...rag,
    reviews: rag.reviews?.map((r) => ({
      ...r,
      _snippet: (r.content || r.body || '').substring(0, 80),
    })),
    faqs: rag.faqs?.map((f) => ({
      ...f,
      _snippet: (f.answer || '').substring(0, 100),
    })),
    comparisons: rag.comparisons?.map((c) => ({
      ...c,
      _verdictSnippet: typeof c.verdict === 'string'
        ? c.verdict.substring(0, 120) : '',
    })),
  };
}

// ── promptfoo adapter ───────────────────────────────────────────────────────

/**
 * promptfoo prompt function — called as
 *   file://workers/recommender/src/prompt-loader.js:renderForPromptfoo
 * promptfoo passes the test's `vars` here. We expect `vars` to be a complete
 * RecommenderContext (or SuggestionsContext if `vars.prompt === 'suggestions'`).
 *
 * If `vars.catalog` / `vars.accessories` are absent, we lazy-load the JSON
 * from the content/ directory so fixtures don't need to inline the catalog.
 */
export async function renderForPromptfoo({ vars = {} } = {}) {
  const promptName = vars.prompt === 'suggestions' ? 'suggestions' : 'recommender';

  const ctx = { ...vars };

  if (promptName === 'recommender' && (!ctx.catalog || !ctx.accessories)) {
    const [products, profiles, accessories] = await Promise.all([
      loadJson('../../../content/products/products.json'),
      loadJson('../../../content/metadata/product-profiles.json'),
      loadJson('../../../content/accessories/accessories.json'),
    ]);
    ctx.catalog = ctx.catalog || enrichCatalogForPrompt(
      products.data || products,
      profiles.data || profiles.profiles || profiles,
    );
    ctx.accessories = ctx.accessories || enrichAccessoriesForPrompt(
      accessories.data || accessories,
    );
  }

  if (promptName === 'recommender' && ctx.rag) {
    ctx.rag = enrichRagForPrompt(ctx.rag);
  }

  const { system, user } = renderPrompt(promptName, ctx);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function loadJson(relPath) {
  // Node-only dynamic load, used by promptfoo tests (never reached on worker).
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const pathMod = await import('node:path');
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const txt = await readFile(pathMod.resolve(here, relPath), 'utf8');
  return JSON.parse(txt);
}
