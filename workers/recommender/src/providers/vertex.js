/**
 * Vertex AI provider — calls streamGenerateContent for Gemma and
 * DiffusionGemma models hosted on Google Cloud Vertex AI.
 *
 * Auth: X-goog-api-key header (VERTEX_AI_API_KEY secret).
 * Endpoint: https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/
 *           locations/{LOCATION}/publishers/google/models/{MODEL}:streamGenerateContent
 *
 * DiffusionGemma generates all tokens in one shot (non-autoregressive), so it
 * emits a single large delta chunk. TTFT will equal total LLM wall-clock time.
 */

const DEFAULT_LOCATION = 'us-central1';

function resolveEndpoint(env, model) {
  const project = env.VERTEX_AI_PROJECT;
  const location = env.VERTEX_AI_LOCATION || DEFAULT_LOCATION;
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
}

function convertMessages(messages) {
  let systemInstruction = null;
  const contents = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }
  return { systemInstruction, contents };
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
        if (!data) continue; // eslint-disable-line no-continue
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
  if (!env.VERTEX_AI_API_KEY) {
    const err = new Error('Vertex AI API key is not configured (set VERTEX_AI_API_KEY).');
    err.status = 401;
    throw err;
  }
  if (!env.VERTEX_AI_PROJECT) {
    const err = new Error('Vertex AI project ID is not configured (set VERTEX_AI_PROJECT).');
    err.status = 401;
    throw err;
  }

  const { systemInstruction, contents } = convertMessages(messages);
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemInstruction) body.system_instruction = systemInstruction;

  const response = await fetch(resolveEndpoint(env, model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-goog-api-key': env.VERTEX_AI_API_KEY,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`Vertex AI request failed (${response.status}): ${errBody.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let usageMetadata = null;
  let finishReason = null;
  let modelVersion = null;

  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iterateSse(response, signal)) {
    if (signal?.aborted) break;
    const text = evt.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) yield { type: 'delta', text };
    if (evt.candidates?.[0]?.finishReason) finishReason = evt.candidates[0].finishReason;
    if (evt.usageMetadata) usageMetadata = evt.usageMetadata;
    if (evt.modelVersion) modelVersion = evt.modelVersion;
  }

  if (usageMetadata) {
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: usageMetadata.promptTokenCount ?? null,
        completion_tokens: usageMetadata.candidatesTokenCount ?? null,
        total_tokens: usageMetadata.totalTokenCount ?? null,
        cache_read_tokens: usageMetadata.cachedContentTokenCount ?? 0,
        cache_write_tokens: 0,
        done_reason: finishReason ?? null,
        model_version: modelVersion ?? null,
      },
    };
  }
}

export default { id: 'vertex', stream };
