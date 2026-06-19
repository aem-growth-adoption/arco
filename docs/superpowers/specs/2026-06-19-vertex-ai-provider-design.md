# Vertex AI Provider Design

**Date:** 2026-06-19  
**Branch:** vertex-ai-support  
**Status:** Approved

## Goal

Add Google Vertex AI as a first-class LLM provider in the recommender worker so that `gemma-4-26b-a4b-it` and `gemma-4-26b-diffusion` (DiffusionGemma) can be selected in Model Settings and used in evals.

## Scope

- New provider file `workers/recommender/src/providers/vertex.js`
- Registration in `workers/recommender/src/providers/index.js` (catalog + availability)
- `.dev.vars.example` documentation
- Comment update in `wrangler.jsonc`

No changes to the pipeline, storage, admin UI, or eval runner — all existing machinery already consumes the normalized `{type:'delta'}` / `{type:'usage'}` contract.

## Environment Variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `VERTEX_AI_API_KEY` | ✓ | — | GCP API key (set via `wrangler secret put VERTEX_AI_API_KEY`) |
| `VERTEX_AI_PROJECT` | ✓ | — | GCP project ID (set via `wrangler secret put VERTEX_AI_PROJECT`) |
| `VERTEX_AI_LOCATION` | optional | `us-central1` | Vertex AI region (var, not secret) |

API key is sent as `X-goog-api-key` header (not as a query parameter, to avoid it appearing in logs).

## API Endpoint

```
POST https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models/{MODEL}:streamGenerateContent
```

## Request Body Format

Vertex AI uses `contents`/`parts` rather than OpenAI `messages`. The provider converts:

| OpenAI format | Vertex AI format |
|---------------|-----------------|
| `{ role: 'system', content }` | Top-level `system_instruction: { parts: [{ text: content }] }` |
| `{ role: 'user', content }` | `{ role: 'user', parts: [{ text: content }] }` |
| `{ role: 'assistant', content }` | `{ role: 'model', parts: [{ text: content }] }` |

Full request body:
```json
{
  "system_instruction": { "parts": [{ "text": "..." }] },
  "contents": [
    { "role": "user", "parts": [{ "text": "..." }] }
  ],
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 8192
  }
}
```

## SSE Response Parsing

Vertex AI streams Server-Sent Events where each `data:` frame is a complete JSON object:

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":null}]}
data: {"candidates":[{"content":{"role":"model","parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12},"modelVersion":"gemma-4-26b-a4b-it"}
```

Content is extracted from `candidates[0].content.parts[0].text`.  
Usage is extracted from `usageMetadata` on the final frame.  
Finish reason is from `candidates[0].finishReason` when non-null.

**No `[DONE]` sentinel** — the stream ends when the SSE connection closes.

## Normalized Usage Frame

The `{type: 'usage'}` frame yielded by the provider:

```js
{
  prompt_tokens:      usageMetadata.promptTokenCount,
  completion_tokens:  usageMetadata.candidatesTokenCount,
  total_tokens:       usageMetadata.totalTokenCount,
  cache_read_tokens:  usageMetadata.cachedContentTokenCount ?? 0,
  cache_write_tokens: 0,   // Vertex does not report write cost separately
  done_reason:        candidates[0].finishReason ?? null,
  model_version:      response.modelVersion ?? null,  // surfaced in debug snapshot
}
```

All fields map to existing downstream consumers in `llm-generate.js` and `storage.js` without changes.

## TTFT and Throughput

TTFT and tokens/s are computed wall-clock by `llm-generate.js` from the timing of first/last delta arrivals — no provider-side work needed.

**DiffusionGemma behaviour:** `gemma-4-26b-diffusion` generates all tokens simultaneously (diffusion, not autoregressive) and emits a single large delta chunk. As a result:
- TTFT ≈ total LLM wall-clock time
- `llmStreaming` interval ≈ 0 ms
- Tokens/s is still meaningful as total_tokens / total_llm_ms

This is a useful differentiator in the eval matrix vs the autoregressive `gemma-4-26b-a4b-it`.

## Catalog Entries

Added to `MODEL_CATALOG` in `providers/index.js`:

```js
{
  provider: 'vertex',
  model: 'gemma-4-26b-a4b-it',
  label: 'Vertex AI · Gemma 4 26B IT',
  requires: ['VERTEX_AI_API_KEY', 'VERTEX_AI_PROJECT'],
},
{
  provider: 'vertex',
  model: 'gemma-4-26b-diffusion',
  label: 'Vertex AI · Gemma 4 26B Diffusion',
  requires: ['VERTEX_AI_API_KEY', 'VERTEX_AI_PROJECT'],
},
```

`PROVIDER_BASE_REQUIREMENTS` gets a `vertex` entry checking for both required vars.

## Error Handling

- Missing `VERTEX_AI_API_KEY` or `VERTEX_AI_PROJECT` → `err.status = 401`
- Non-2xx HTTP response → `err.status = response.status`, message includes first 200 chars of body
- Malformed SSE frames are silently skipped (same pattern as sambanova/vllm)

## Files Changed

| File | Change |
|------|--------|
| `workers/recommender/src/providers/vertex.js` | New file (~100 lines) |
| `workers/recommender/src/providers/index.js` | Import vertex, add to PROVIDERS, add 2 catalog entries, add base requirements check |
| `workers/recommender/.dev.vars.example` | Document `VERTEX_AI_API_KEY`, `VERTEX_AI_PROJECT`, `VERTEX_AI_LOCATION` |
| `workers/recommender/wrangler.jsonc` | Add comment noting `VERTEX_AI_API_KEY` and `VERTEX_AI_PROJECT` secrets |
