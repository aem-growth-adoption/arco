/**
 * bench-ollama.js — backend benchmark harness for the local Ollama runtime.
 *
 * POSTs each query in an eval suite to a locally-running worker
 * (`wrangler dev` on :8787) and measures, per query:
 *   - TTFT      time to the first streamed `section` frame (ms)
 *   - duration  total time until the `done` frame / stream end (ms)
 *   - sections  number of `section` frames received
 *   - tokens    input / output / total (from the `debug` frame)
 *   - tok/s     output tokens per second of generation (output / (duration - TTFT))
 *
 * Usage:
 *   node tools/bench-ollama.js [suiteId] [--url http://localhost:8787] [--out report.json] [--runs 1]
 *
 * Defaults: suite=coffee-dev, url=http://localhost:8787, out=stdout only, runs=1.
 * The model is whatever the worker resolves (set OLLAMA_MODEL in .dev.vars).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.resolve(HERE, '../../../eval/suites');

function parseArgs(argv) {
  const args = { suiteId: 'coffee-dev', url: 'http://localhost:8787', out: null, runs: 1 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') { args.url = argv[++i]; } // eslint-disable-line no-plusplus
    else if (a === '--out') { args.out = argv[++i]; } // eslint-disable-line no-plusplus
    else if (a === '--runs') { args.runs = Math.max(1, parseInt(argv[++i], 10) || 1); } // eslint-disable-line no-plusplus
    else if (!a.startsWith('--')) rest.push(a);
  }
  if (rest[0]) args.suiteId = rest[0];
  return args;
}

function loadSuite(suiteId) {
  const file = path.join(SUITES_DIR, `${suiteId}.json`);
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(suite.queries)) throw new Error(`Suite ${suiteId} has no queries`);
  return suite;
}

/**
 * Stream one /api/generate call and collect timing + token metrics.
 */
async function benchOne(baseUrl, query) {
  const t0 = performance.now();
  let ttft = null;
  let sections = 0;
  let model = null;
  let provider = null;
  let usage = { input: null, output: null, total: null };
  let errored = null;

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, sessionId: randomUUID() }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // eslint-disable-line no-continue
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; } // eslint-disable-line no-continue
      if (evt.type === 'section') {
        if (ttft === null) ttft = performance.now() - t0;
        sections += 1;
      } else if (evt.type === 'debug' && evt.llm) {
        model = evt.llm.model;
        provider = evt.llm.provider;
        usage = {
          input: evt.llm.inputTokens,
          output: evt.llm.outputTokens,
          total: evt.llm.totalTokens,
        };
      } else if (evt.type === 'error') {
        errored = evt.message || 'stream error';
      }
    }
  }

  const duration = performance.now() - t0;
  const genMs = ttft != null ? duration - ttft : duration;
  const tokPerSec = usage.output && genMs > 0 ? (usage.output / (genMs / 1000)) : null;

  return {
    query,
    provider,
    model,
    error: errored,
    ttftMs: ttft != null ? Math.round(ttft) : null,
    durationMs: Math.round(duration),
    sections,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.total,
    tokensPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
  };
}

function fmt(v, width) {
  return String(v ?? '—').padStart(width);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suite = loadSuite(args.suiteId);
  const queries = suite.queries.map((q) => q.query);

  process.stdout.write(
    `\nbench-ollama → ${args.url}  suite=${suite.id} (${queries.length} queries × ${args.runs} run(s))\n\n`,
  );

  const results = [];
  for (let run = 0; run < args.runs; run += 1) {
    for (const query of queries) {
      let r;
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await benchOne(args.url, query);
      } catch (err) {
        r = { query, error: err.message };
      }
      r.run = run;
      results.push(r);
      const label = query.length > 48 ? `${query.slice(0, 45)}...` : query;
      if (r.error) {
        process.stdout.write(`  ✗ ${label}\n      ERROR: ${r.error}\n`);
      } else {
        process.stdout.write(
          `  ✓ ${label}\n`
          + `      ttft=${fmt(r.ttftMs, 5)}ms  dur=${fmt(r.durationMs, 6)}ms  `
          + `sec=${fmt(r.sections, 2)}  out=${fmt(r.outputTokens, 5)}tok  ${fmt(r.tokensPerSec, 6)} tok/s\n`,
        );
      }
    }
  }

  const ok = results.filter((r) => !r.error && r.tokensPerSec != null);
  if (ok.length) {
    const avg = (sel) => Math.round(ok.reduce((s, r) => s + sel(r), 0) / ok.length);
    const avgF = (sel) => Math.round((ok.reduce((s, r) => s + sel(r), 0) / ok.length) * 10) / 10;
    process.stdout.write(
      `\n  averages (n=${ok.length}): ttft=${avg((r) => r.ttftMs)}ms  `
      + `dur=${avg((r) => r.durationMs)}ms  ${avgF((r) => r.tokensPerSec)} tok/s  `
      + `model=${ok[0].provider}/${ok[0].model}\n\n`,
    );
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ suite: suite.id, url: args.url, results }, null, 2));
    process.stdout.write(`  report written to ${args.out}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`bench-ollama failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
