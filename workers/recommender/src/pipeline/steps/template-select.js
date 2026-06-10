/**
 * Template Select Step — call-1 LLM routing that picks a page template for the query.
 *
 * Calls the LLM with the `template-select` prompt (small output: ~50 tokens),
 * parses the returned JSON to extract the template name, validates it against
 * the catalog, and writes ctx.template + ctx.intent.
 *
 * Falls back to `arco-discovery-guide` on any error or invalid name so the
 * main pipeline always has a valid template to work with.
 */

/* eslint-disable-next-line import/extensions */
import catalog from '../../../templates/catalog.json';
import { renderPrompt } from '../../prompt-loader.js';
import { getProvider, findCatalogEntry, catalogAvailability } from '../../providers/index.js';

const FALLBACK_TEMPLATE_NAME = 'arco-discovery-guide';

// Fast/cheap model for this routing call — ~50 token output.
const STEP_PROVIDER = 'cerebras';
const STEP_MODEL = 'llama3.1-8b';
const STEP_MAX_TOKENS = 100;
const STEP_TEMPERATURE = 0;

/**
 * Return the fallback template object from the catalog.
 * @returns {object}
 */
function getFallbackTemplate() {
  return catalog.templates.find((t) => t.name === FALLBACK_TEMPLATE_NAME);
}

/**
 * Accumulate all delta chunks from a streaming provider call into a single string.
 * The output is tiny (~50 tokens) so we always collect the full response.
 *
 * @param {AsyncIterable} stream — provider async iterable
 * @returns {Promise<string>}
 */
async function accumulateStream(stream) {
  let text = '';
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of stream) {
    if (chunk.type === 'delta' && chunk.text) {
      text += chunk.text;
    }
    // 'usage' and other frame types are ignored — output is tiny.
  }
  return text;
}

/**
 * Parse the template name from the LLM response text.
 * Tries JSON.parse first, then falls back to regex extraction.
 *
 * @param {string} text
 * @returns {string|null} template name, or null if not parseable
 */
function parseTemplateName(text) {
  const trimmed = text.trim();

  // 1. Try strict JSON parse on the full response.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.template === 'string') {
      return parsed.template;
    }
  } catch {
    // fall through to regex
  }

  // 2. Regex extraction handles cases where the LLM wraps the JSON in prose or markdown.
  const match = trimmed.match(/"template"\s*:\s*"([^"]+)"/);
  if (match) return match[1];

  return null;
}

// eslint-disable-next-line import/prefer-default-export
export async function templateSelect(ctx, config = {}, env = {}) {
  const start = Date.now();
  const fallback = getFallbackTemplate();

  try {
    // Render the prompt. normalizeContext in prompt-loader maps top-level keys
    // (query, followUp, previousQueries), so we flatten from ctx.request.
    const prompt = renderPrompt('template-select', {
      query: ctx.request.query,
      followUp: ctx.request.followUp,
      previousQueries: ctx.request.previousQueries,
    });

    // Flow config can override provider/model/params, but defaults are fast + cheap.
    const providerId = config.templateSelectProvider || STEP_PROVIDER;
    const model = config.templateSelectModel || STEP_MODEL;
    const temperature = typeof config.templateSelectTemperature === 'number'
      ? config.templateSelectTemperature : STEP_TEMPERATURE;
    const maxTokens = config.templateSelectMaxTokens || STEP_MAX_TOKENS;

    // Availability check — fall back gracefully if credentials are missing.
    const entry = findCatalogEntry(providerId, model) || { provider: providerId, model };
    const { available, missing } = catalogAvailability(entry, env);
    if (!available) {
      console.warn(`[template-select] Provider ${providerId}/${model} unavailable (missing: ${missing.join(', ')}), using fallback template`);
      ctx.template = fallback;
      ctx.intent = { type: fallback.intent, confidence: 1 };
      ctx.timings.templateSelect = Date.now() - start;
      return;
    }

    const provider = getProvider(providerId);

    const stream = provider.stream({
      env,
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      maxTokens,
      temperature,
      signal: null,
    });

    const rawText = await accumulateStream(stream);
    const templateName = parseTemplateName(rawText);

    if (!templateName) {
      console.warn(`[template-select] Could not parse template name from LLM response: "${rawText.substring(0, 200)}", using fallback`);
      ctx.template = fallback;
      ctx.intent = { type: fallback.intent, confidence: 1 };
      ctx.timings.templateSelect = Date.now() - start;
      return;
    }

    // Validate the returned name against the catalog.
    const found = catalog.templates.find((t) => t.name === templateName);
    if (!found) {
      console.warn(`[template-select] LLM returned unknown template name "${templateName}", using fallback`);
      ctx.template = fallback;
      ctx.intent = { type: fallback.intent, confidence: 1 };
      ctx.timings.templateSelect = Date.now() - start;
      return;
    }

    ctx.template = found;
    ctx.intent = { type: found.intent, confidence: 1 };
  } catch (err) {
    console.warn(`[template-select] Error during template selection: ${err.message}, using fallback`);
    ctx.template = fallback;
    ctx.intent = { type: fallback.intent, confidence: 1 };
  }

  ctx.timings.templateSelect = Date.now() - start;
}
