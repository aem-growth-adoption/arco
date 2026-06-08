/**
 * Ollama provider — native /api/chat streaming.
 *
 * Uses Ollama's native API (not the OpenAI-compatible /v1 shim) because the
 * native final message includes real timing counters — prompt_eval_count /
 * prompt_eval_duration (prefill) and eval_count / eval_duration (decode) — which
 * give an accurate, GPU-level tokens/sec. The OpenAI shim buffers deltas and
 * omits these counters, so application-level timing through it is unreliable.
 *
 * Points at a local Ollama server (typically http://localhost:11434), which may
 * be the Mac itself or an SSH-forwarded remote box.
 *
 * Configuration (no API key needed):
 *   OLLAMA_BASE_URL  e.g. http://localhost:11434  (a trailing /v1 is tolerated)
 *   OLLAMA_MODEL     selected via llm-config; passed in as `model` here
 *   OLLAMA_THINK     optional "false" to disable the thinking phase on
 *                    reasoning-capable models (faster, fewer tokens)
 *
 * The normalized stream contract is unchanged: yields { type:'delta', text }
 * chunks and a terminal { type:'usage', usage } frame. The usage frame carries
 * the OpenAI-style token fields plus the native nanosecond timing counters.
 */

function resolveEndpoint(env) {
  let base = (env.OLLAMA_BASE_URL || '').replace(/\/+$/, '');
  // Tolerate a base configured for the OpenAI shim (".../v1").
  base = base.replace(/\/v1$/, '');
  return `${base}/api/chat`;
}

async function* iterateNdjson(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      // eslint-disable-next-line no-restricted-syntax
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // eslint-disable-line no-continue
        try {
          yield JSON.parse(trimmed);
        } catch {
          // ignore malformed line
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try { yield JSON.parse(tail); } catch { /* ignore */ }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function* stream({
  env, model, messages, temperature, maxTokens, signal,
}) {
  if (!env.OLLAMA_BASE_URL) {
    const err = new Error('Ollama base URL is not configured (set OLLAMA_BASE_URL).');
    err.status = 401;
    throw err;
  }

  const reqBody = {
    model,
    messages,
    stream: true,
    options: {
      temperature,
      ...(maxTokens ? { num_predict: maxTokens } : {}),
    },
  };
  // Allow disabling the thinking phase on reasoning-capable models.
  if (String(env.OLLAMA_THINK).toLowerCase() === 'false') reqBody.think = false;

  const response = await fetch(resolveEndpoint(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Ollama request failed (${response.status}): ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let final = null;
  const iter = iterateNdjson(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    if (evt.error) {
      const err = new Error(`Ollama error: ${evt.error}`);
      err.status = 500;
      throw err;
    }
    const text = evt.message?.content;
    if (text) yield { type: 'delta', text };
    // The terminal frame carries done:true plus the timing counters.
    if (evt.done) final = evt;
  }

  if (final) {
    const promptTokens = final.prompt_eval_count || 0;
    const completionTokens = final.eval_count || 0;
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        // Native Ollama timing counters (nanoseconds) — used for accurate
        // prefill/decode tokens-per-second in the debug stats.
        eval_count: final.eval_count || 0,
        eval_duration: final.eval_duration || 0,
        prompt_eval_count: final.prompt_eval_count || 0,
        prompt_eval_duration: final.prompt_eval_duration || 0,
        load_duration: final.load_duration || 0,
        total_duration: final.total_duration || 0,
      },
    };
  }
}

export default { id: 'ollama', stream };
