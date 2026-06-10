/**
 * Build Template Prompt Step — assembles system and user prompts for
 * template-fill-based page generation.
 * Reads ctx.template, ctx.rag, ctx.request.*. Writes ctx.templateBlocks,
 * ctx.prompt.system, ctx.prompt.user.
 */

import { renderPrompt } from '../../prompt-loader.js';

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function buildTemplatePrompt(ctx, config = {}, env = {}) {
  const start = Date.now();

  // Filter blocks: remove skipOnFollowUp blocks when this is a follow-up request
  const allBlocks = ctx.template?.blocks || [];
  const isFollowUp = Boolean(ctx.request?.followUp);
  ctx.templateBlocks = isFollowUp
    ? allBlocks.filter((b) => !b.skipOnFollowUp)
    : allBlocks;

  // Also handle skipIfNoRag: "recipes" — skip recipe-steps if no RAG recipes available
  ctx.templateBlocks = ctx.templateBlocks.filter((b) => {
    if (b.skipIfNoRag === 'recipes' && (!ctx.rag?.recipes || ctx.rag.recipes.length === 0)) {
      return false;
    }
    return true;
  });

  if (!ctx.template) {
    console.warn('[build-template-prompt] ctx.template is null — was template-select skipped?');
  }

  try {
    const { system, user } = renderPrompt('template-fill', ctx);
    ctx.prompt.system = system;
    ctx.prompt.user = user;
  } finally {
    ctx.timings.templatePrompt = Date.now() - start;
  }
}
