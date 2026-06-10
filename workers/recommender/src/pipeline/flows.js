/**
 * Flow Definitions — Arco recommender pipeline configuration.
 */

const LEGACY_FLOW = {
  id: 'legacy',
  name: 'Coffee Equipment Recommender',
  description: 'Espresso machine and grinder recommendation with behavior analysis and comparison tables.',
  steps: [
    { step: 'rate-limit', gate: true },
    { step: 'safety-gate', gate: true },
    { step: 'analyze-behavior' },
    { step: 'intent-classify' },
    { parallel: [{ step: 'persona-match' }, { step: 'use-case-match' }] },
    { step: 'rag-products', config: { maxResults: 8 } },
    {
      parallel: [
        {
          step: 'rag-content',
          config: {
            maxGuides: 5, maxExperiences: 3, maxComparisons: 2, maxRecipes: 3, maxTools: 3,
          },
        },
        { step: 'rag-features', config: { maxResults: 6 } },
        { step: 'rag-reviews', config: { maxResults: 6 } },
        { step: 'rag-faqs', config: { maxResults: 4 } },
      ],
    },
    { step: 'build-recommender-prompt' },
    {
      step: 'llm-generate',
      config: { model: 'gpt-oss-120b', maxTokens: 5120, temperature: 0.6 },
    },
  ],
};

const TEMPLATE_ROUTING_FLOW = {
  id: 'template-routing',
  name: 'Template-Driven Coffee Recommender',
  description: 'Two-call pipeline: fast template selection + typed JSON block filling.',
  steps: [
    { step: 'rate-limit', gate: true },
    { step: 'safety-gate', gate: true },
    { step: 'analyze-behavior' },
    { step: 'template-select' },
    { parallel: [{ step: 'persona-match' }, { step: 'use-case-match' }] },
    { step: 'rag-products', config: { maxResults: 8 } },
    {
      parallel: [
        {
          step: 'rag-content',
          config: {
            maxGuides: 5, maxExperiences: 3, maxComparisons: 2, maxRecipes: 3, maxTools: 3,
          },
        },
        { step: 'rag-features', config: { maxResults: 6 } },
        { step: 'rag-reviews', config: { maxResults: 6 } },
        { step: 'rag-faqs', config: { maxResults: 4 } },
      ],
    },
    { step: 'build-template-prompt' },
    {
      step: 'llm-fill-blocks',
      config: { model: 'gpt-oss-120b', maxTokens: 4096, temperature: 0.6 },
    },
  ],
};

export const STATIC_FLOWS = {
  default: TEMPLATE_ROUTING_FLOW,
  'template-routing': TEMPLATE_ROUTING_FLOW,
  legacy: LEGACY_FLOW,
  recommender: LEGACY_FLOW, // backward-compat alias
};

/**
 * Resolve a flow by ID.
 */
export function resolveFlow(flowId) {
  return STATIC_FLOWS[flowId || 'default'] || STATIC_FLOWS.default;
}
