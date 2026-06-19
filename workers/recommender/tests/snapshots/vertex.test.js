import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vertex from '../../src/providers/vertex.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const BASE_ENV = { VERTEX_AI_API_KEY: 'test-key', VERTEX_AI_PROJECT: 'test-proj' };
const BASE_ARGS = { model: 'gemma-4-26b-a4b-it', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, maxTokens: 512 };

async function collect(gen) {
  const items = [];
  for await (const item of gen) items.push(item);
  return items;
}

function makeSse(chunks, status = 200) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const CHUNK_HELLO = { candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: null }] };
const CHUNK_DONE = {
  candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  modelVersion: 'gemma-4-26b-a4b-it',
};

test('vertex — throws 401 when VERTEX_AI_API_KEY missing', async () => {
  await assert.rejects(
    collect(vertex.stream({ env: { VERTEX_AI_PROJECT: 'p' }, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 401); return true; },
  );
});

test('vertex — throws 401 when VERTEX_AI_PROJECT missing', async () => {
  await assert.rejects(
    collect(vertex.stream({ env: { VERTEX_AI_API_KEY: 'k' }, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 401); return true; },
  );
});

test('vertex — throws on non-2xx response', async () => {
  globalThis.fetch = async () => new Response('{"error":"not found"}', { status: 404 });
  await assert.rejects(
    collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 404); return true; },
  );
});

test('vertex — converts system message to system_instruction', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  const messages = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hi' }];
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, messages }));
  assert.deepEqual(body.system_instruction, { parts: [{ text: 'Be helpful.' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Hi' }] }]);
});

test('vertex — maps assistant role to model', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Next' },
  ];
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, messages }));
  assert.equal(body.contents[1].role, 'model');
  assert.equal(body.contents[2].role, 'user');
});

test('vertex — passes temperature and maxOutputTokens in generationConfig', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, temperature: 0.3, maxTokens: 2048 }));
  assert.equal(body.generationConfig.temperature, 0.3);
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
});

test('vertex — sends X-goog-api-key header', async () => {
  let hdrs;
  globalThis.fetch = async (_, opts) => { hdrs = opts.headers; return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: { ...BASE_ENV, VERTEX_AI_API_KEY: 'secret-123' }, ...BASE_ARGS }));
  assert.equal(hdrs['X-goog-api-key'], 'secret-123');
});

test('vertex — builds correct endpoint URL with default location', async () => {
  let url;
  globalThis.fetch = async (u) => { url = String(u); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, model: 'gemma-4-26b-diffusion' }));
  assert.equal(url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-central1/publishers/google/models/gemma-4-26b-diffusion:streamGenerateContent?alt=sse');
});

test('vertex — respects VERTEX_AI_LOCATION override', async () => {
  let url;
  globalThis.fetch = async (u) => { url = String(u); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: { ...BASE_ENV, VERTEX_AI_LOCATION: 'europe-west4' }, ...BASE_ARGS }));
  assert.match(url, /europe-west4-aiplatform\.googleapis\.com/);
  assert.match(url, /locations\/europe-west4\//);
  assert.match(url, /\?alt=sse$/);
});

test('vertex — yields delta chunks then usage frame', async () => {
  globalThis.fetch = async () => makeSse([CHUNK_HELLO, CHUNK_DONE]);
  const items = await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.deepEqual(items[0], { type: 'delta', text: 'Hello' });
  assert.deepEqual(items[1], { type: 'delta', text: ' world' });
  assert.deepEqual(items[2], {
    type: 'usage',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      done_reason: 'STOP',
      model_version: 'gemma-4-26b-a4b-it',
    },
  });
});

test('vertex — maps cachedContentTokenCount to cache_read_tokens', async () => {
  const chunk = {
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25, cachedContentTokenCount: 8 },
    modelVersion: 'gemma-4-26b-a4b-it',
  };
  globalThis.fetch = async () => makeSse([chunk]);
  const items = await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  const usage = items.find((i) => i.type === 'usage');
  assert.equal(usage.usage.cache_read_tokens, 8);
});

test('vertex — DiffusionGemma: single large chunk still yields delta + usage', async () => {
  const bigChunk = {
    candidates: [{ content: { parts: [{ text: 'entire response in one shot' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500, totalTokenCount: 600 },
    modelVersion: 'gemma-4-26b-diffusion',
  };
  globalThis.fetch = async () => makeSse([bigChunk]);
  const items = await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, model: 'gemma-4-26b-diffusion' }));
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'delta');
  assert.equal(items[0].text, 'entire response in one shot');
  assert.equal(items[1].type, 'usage');
  assert.equal(items[1].usage.completion_tokens, 500);
});
