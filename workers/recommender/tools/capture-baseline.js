#!/usr/bin/env node
/**
 * Capture baseline rendered prompts from the *current* JS-based prompt
 * builders. Run BEFORE refactoring src/recommender-prompt.js. The new
 * YAML-rendered output must match these byte-for-byte (or with tracked
 * whitespace deltas).
 *
 * Usage: node tools/capture-baseline.js
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../src/recommender-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../tests/fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '../tests/snapshots/__snapshots__');

async function main() {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const name = file.replace(/\.json$/, '');

    const system = buildRecommenderSystemPrompt();
    const user = buildRecommenderUserMessage(
      fx.query,
      fx.behavior,
      fx.previousQueries || [],
      fx.followUp,
      fx.shownContent || {},
      fx.intent,
      fx.contextData || {},
    );

    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`),
      system,
    );
    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`),
      user,
    );
    console.log(`captured ${name} (system: ${system.length} chars, user: ${user.length} chars)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
