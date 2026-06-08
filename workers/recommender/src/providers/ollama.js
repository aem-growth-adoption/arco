/**
 * Ollama provider — OpenAI-compatible /v1/chat/completions over HTTP.
 * Points at a local Ollama server (typically an SSH-forwarded EC2 instance at
 * http://localhost:11434/v1). Parses Server-Sent Events and yields normalized
 * delta/usage chunks — same contract as the other providers.
 *
 * Configuration comes from env (no API key needed):
 *   OLLAMA_BASE_URL  e.g. http://localhost:11434/v1
 *   OLLAMA_MODEL     selected via llm-config; passed in as `model` here
 */

function resolveEndpoint(env) {
  const base = (env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
  // Accept both ".../v1" and a bare host; normalize to the chat completions path.
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  if (base.endsWith('/v1/chat/completions')) return base;
  return `${base}/v1/chat/completions`;
}

async function* iterateSse(response, signal) {
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
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      // eslint-disable-next-line no-restricted-syntax
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue; // eslint-disable-line no-continue
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue; // eslint-disable-line no-continue
        try {
          yield JSON.parse(data);
        } catch {
          // ignore malformed frame
        }
      }
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

  const response = await fetch(resolveEndpoint(env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ollama ignores auth, but the OpenAI shape expects a bearer.
      Authorization: `Bearer ${env.OLLAMA_API_KEY || 'ollama'}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Ollama request failed (${response.status}): ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let usage = null;
  const iter = iterateSse(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    const text = evt.choices?.[0]?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (evt.usage) usage = evt.usage;
  }
  if (usage) yield { type: 'usage', usage };
}

export default { id: 'ollama', stream };
