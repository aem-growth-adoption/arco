/**
 * LLM Fill Blocks Step — call-2 JSON generation in the template-driven pipeline.
 *
 * Calls the active LLM provider with the pre-built template prompt (ctx.prompt)
 * and expects a single JSON response: { blocks: [...], suggestions: [...] }.
 *
 * Unlike llm-generate.js this step does NOT stream sections incrementally.
 * It accumulates the full response, then parses the JSON, renders each block
 * via renderBlock(), post-processes it, and emits one `section` event per block.
 *
 * This is intentional: template-fill LLM output is a compact structured JSON
 * blob (no === section delimiters), so a streaming parser would add complexity
 * without benefit. The heartbeat interval keeps the connection alive while
 * accumulating.
 */

import { getProvider, findCatalogEntry, catalogAvailability } from '../../providers/index.js';
import { getActiveLlmConfig, resolveLlmConfig } from '../../llm-config.js';
import { renderBlock } from '../../block-renderers.js';
import {
  resolveTokens, normalizeProductUrls,
} from '../../images.js';
import sanitizeHTML from '../../sanitize.js';
import { processSuggestions, extractTitle } from './llm-generate.js';
import { unescapeHtml } from '../../da-persist.js'; // eslint-disable-line no-unused-vars

// ---------------------------------------------------------------------------
// Post-processing helpers
// ---------------------------------------------------------------------------

function processBlockHtml(html) {
  if (!html) return '';
  let out = resolveTokens(html);
  out = normalizeProductUrls(out);
  out = sanitizeHTML(out);
  return out;
}

function hasContent(html) {
  return html.replace(/<[^>]*>/g, '').trim().length > 0;
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

/**
 * llmFillBlocks — pipeline step: call-2 LLM generation for template-driven flow.
 *
 * @param {object} ctx   Pipeline context (ctx.prompt, ctx.llm, ctx.timings, etc.)
 * @param {object} config Flow step config ({model?, temperature?, maxTokens?, llmTimeout?})
 * @param {object} env   Worker bindings + secrets
 */
export async function llmFillBlocks(ctx, config = {}, env = {}) {
  // Ensure llm state bag exists (defensive — executor normally initialises ctx.llm).
  ctx.llm = ctx.llm || {};
  ctx.llm.sections = ctx.llm.sections || [];
  ctx.llm.suggestions = ctx.llm.suggestions || [];
  ctx.llm.fullText = ctx.llm.fullText || '';
  ctx.llm.usage = ctx.llm.usage || null;
  ctx.timings = ctx.timings || {};

  const writeLine = async (obj) => {
    const line = JSON.stringify(obj);
    ctx.ndjsonLines = ctx.ndjsonLines || [];
    ctx.ndjsonLines.push(line);
    await ctx.writer.write(ctx.encoder.encode(`${line}\n`));
  };

  // Announce which template was selected so the client can show progress.
  await writeLine({ type: 'template-selected', template: ctx.template?.name || 'unknown' });

  // Resolve provider + model from KV active config, falling through to flow defaults.
  const active = await getActiveLlmConfig(env);
  const resolved = resolveLlmConfig(active, config);
  const {
    provider: providerId, model, temperature, maxTokens, thinking = null,
  } = resolved;

  // Preflight — surface a helpful error instead of letting the vendor call fail.
  const entry = findCatalogEntry(providerId, model) || { provider: providerId, model };
  const { available, missing } = catalogAvailability(entry, env);
  if (!available) {
    const err = new Error(
      `Missing configuration for ${providerId}/${model}: ${missing.join(', ')}. `
      + 'Set the required secrets or pick a different model in Admin → Model Settings.',
    );
    err.status = 400;
    throw err;
  }

  const provider = getProvider(providerId);
  ctx.llm.model = model;
  ctx.llm.provider = providerId;
  ctx.llm.temperature = temperature;
  ctx.llm.maxTokens = maxTokens;

  // Heartbeat keeps the connection alive while we wait for the full JSON response.
  const heartbeatInterval = setInterval(async () => {
    try {
      await ctx.writer.write(
        ctx.encoder.encode(`${JSON.stringify({ type: 'heartbeat' })}\n`),
      );
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 3000);

  // Timeout — mirrors llm-generate.js logic.
  const explicitTimeout = parseInt(env.LLM_TIMEOUT_MS, 10);
  const ollamaTimeout = parseInt(env.OLLAMA_TIMEOUT_MS, 10) || 300_000;
  const providerDefault = providerId === 'ollama' ? ollamaTimeout : 60_000;
  const envTimeout = Number.isFinite(explicitTimeout) && explicitTimeout > 0
    ? explicitTimeout : providerDefault;
  const timeoutMs = config.llmTimeout || envTimeout;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  ctx.timings.llmStart = Date.now();

  let completion;
  try {
    completion = provider.stream({
      env,
      model,
      messages: [
        { role: 'system', content: ctx.prompt.system },
        { role: 'user', content: ctx.prompt.user },
      ],
      maxTokens,
      temperature,
      thinking,
      signal: abortController.signal,
    });
  } catch (llmErr) {
    clearTimeout(timeoutId);
    clearInterval(heartbeatInterval);
    if (llmErr.name === 'AbortError' || abortController.signal.aborted) {
      throw new Error('AI request timed out. Try a simpler query.');
    }
    const status = llmErr.status || llmErr.statusCode;
    if (status === 401) throw new Error('AI authentication failed. Check API key.');
    if (status === 429) throw new Error('AI rate limit reached. Please wait a moment.');
    if (status === 503 || status === 502) throw new Error('AI service is temporarily overloaded. Try again shortly.');
    if (llmErr.message?.includes('timeout')) throw new Error('AI request timed out. Try a simpler query.');
    throw new Error('AI service unavailable. Please try again.');
  }

  // Accumulate the full response.
  let rawText = '';
  let tokenCount = 0;
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of completion) {
      if (chunk.type === 'usage') {
        ctx.llm.usage = chunk.usage;
        continue; // eslint-disable-line no-continue
      }
      if (chunk.type === 'delta' && chunk.text) {
        if (!ctx.timings.llmFirstToken) ctx.timings.llmFirstToken = Date.now();
        ctx.timings.llmLastToken = Date.now();
        rawText += chunk.text;
        tokenCount += 1;
      }
    }
  } catch (streamErr) {
    if (streamErr.name === 'AbortError' || abortController.signal.aborted) {
      throw new Error('AI request timed out. Try a simpler query.');
    }
    throw streamErr;
  } finally {
    clearTimeout(timeoutId);
    clearInterval(heartbeatInterval);
  }

  ctx.timings.llmEnd = Date.now();
  ctx.llm.fullText = rawText;

  // Parse the accumulated JSON response.
  let parsed;
  try {
    // Strip markdown fences if the model wrapped the JSON in a code block.
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn('[llm-fill-blocks] JSON parse failed:', e.message, 'raw:', rawText.slice(0, 200));
    const errLine = JSON.stringify({ type: 'error', message: 'AI response was not valid JSON. Please try again.' });
    ctx.ndjsonLines = ctx.ndjsonLines || [];
    ctx.ndjsonLines.push(errLine);
    await ctx.writer.write(ctx.encoder.encode(`${errLine}\n`));
    return;
  }

  // Render and emit each block.
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let sectionIndex = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const block of blocks) {
    const rawHtml = renderBlock(block);
    const html = processBlockHtml(rawHtml);
    if (!hasContent(html)) continue; // eslint-disable-line no-continue
    ctx.llm.sections.push(html);
    // eslint-disable-next-line no-await-in-loop
    await writeLine({ type: 'section', index: sectionIndex, html });
    sectionIndex += 1;
  }

  // Process and emit suggestions.
  if (Array.isArray(parsed?.suggestions)) {
    ctx.llm.suggestions = processSuggestions(parsed.suggestions);
  }
  if (ctx.llm.suggestions.length) {
    await writeLine({ type: 'suggestions', items: ctx.llm.suggestions });
  }

  // Debug event — leaner than llm-generate.js (no sectionDetails, no parser stats).
  await writeLine({
    type: 'debug',
    timings: {
      total: Date.now() - ctx.timings.start,
      llm: ctx.timings.llmEnd - ctx.timings.llmStart,
      llmFirstToken: ctx.timings.llmFirstToken
        ? ctx.timings.llmFirstToken - ctx.timings.llmStart : null,
      steps: ctx.timings.steps || [],
    },
    pipeline: { flow: ctx.flowId || 'template-routing', flowName: 'Template Routing' },
    template: { name: ctx.template?.name, intent: ctx.template?.intent },
    intent: ctx.intent,
    prompt: {
      systemLength: ctx.prompt?.system?.length || 0,
      userLength: ctx.prompt?.user?.length || 0,
      systemPrompt: ctx.prompt?.system || '',
      userMessage: ctx.prompt?.user || '',
    },
    llm: {
      provider: ctx.llm.provider,
      model: ctx.llm.model,
      inputTokens: ctx.llm.usage?.prompt_tokens || null,
      outputTokens: ctx.llm.usage?.completion_tokens || null,
      chunks: tokenCount,
      timeToFirstTokenMs: (ctx.timings.llmFirstToken && ctx.timings.llmStart)
        ? ctx.timings.llmFirstToken - ctx.timings.llmStart : null,
      rawOutput: rawText,
      sections: ctx.llm.sections.length,
    },
    rag: {
      products: { count: ctx.rag?.products?.length || 0 },
      guides: { count: ctx.rag?.guides?.length || 0 },
      experiences: { count: ctx.rag?.experiences?.length || 0 },
      recipes: { count: ctx.rag?.recipes?.length || 0 },
      faqs: { count: ctx.rag?.faqs?.length || 0 },
    },
  });

  // Done event.
  const title = extractTitle(ctx.llm.sections[0] || '');
  await writeLine({ type: 'done', title, usedProducts: [] });
}
