#!/usr/bin/env node
//
// pipeline/build-sample.mjs
//
// Build data/sample-dataset.json from the hand-written extracts in pipeline/cache-samples/.
//
// No network, no downloaded data. This runs the same reading, normalizing and joining code as a
// real build, on records written by hand, so the app has something to open before anybody has
// fetched anything.
//
// **Every coordinate in the sample is invented.** None of these stops exist. The file it writes
// carries `"sample": true` and a warning saying so, and the app shows a standing warning the whole
// time a sample dataset is loaded.
//
// Usage: node pipeline/build-sample.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDataset, formatSummary } from './build.mjs';
import { validateDataset } from './normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const CACHE = path.join(HERE, 'cache-samples');
const OUT = path.join(REPO, 'data', 'sample-dataset.json');

export const SAMPLE_WARNING = 'Made-up data. Every place, coordinate and amenity in this file was'
  + ' written by hand to give the app something to run against. None of these stops exist. Do not'
  + ' plan a stop, a break or a night around anything in this file.';

// The sample is checked into the repository, so its build time is fixed. Rebuilding it then changes
// nothing unless the records themselves changed, which keeps the difference between two versions
// readable.
export const SAMPLE_GENERATED_AT = '2026-08-01T00:00:00Z';

export async function buildSample() {
  return buildDataset({
    cacheDir: CACHE,
    name: 'sample',
    sample: true,
    warning: SAMPLE_WARNING,
    generatedAt: SAMPLE_GENERATED_AT,
  });
}

async function main() {
  const { dataset, summary } = await buildSample();

  const problems = validateDataset(dataset);
  if (problems.length) {
    console.error('The sample dataset does not match docs/SCHEMA.md:');
    for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
    process.exit(1);
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(dataset, null, 2)}\n`);

  console.log(formatSummary(summary, { cacheDir: CACHE, outFile: OUT }));
  console.log('');
  console.log('Checked against docs/SCHEMA.md: no problems.');
  console.log(`sample: ${dataset.sample} — ${SAMPLE_WARNING}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
