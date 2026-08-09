#!/usr/bin/env node
//
// pipeline/fetch-arcgis.mjs
//
// Download raw records from any ArcGIS feature layer listed in sources.json and write the answers
// to disk untouched.
//
// This is the second and last script in the pipeline that needs the internet. Run it once over
// Wi-Fi. The app never calls these services.
//
// An ArcGIS feature layer is a map layer a transport department publishes with a web address you
// can ask questions of. Every one of them answers the same query, so one fetcher covers the federal
// truck parking layer and every state's rest area layer. What differs is only the field names, and
// those live in each source's fieldMap in sources.json.
//
// Usage:
//   node pipeline/fetch-arcgis.mjs --all
//   node pipeline/fetch-arcgis.mjs --source ia-dot-rest-areas --source oh-dot-rest-areas
//   node pipeline/fetch-arcgis.mjs --all --include-unverified
//
// Options:
//   --source <id>          One source id from sources.json. Repeat for several.
//   --all                  Every source in sources.json with kind "arcgis".
//   --include-unverified   Also fetch sources marked verified:false. Without this they are listed
//                          and skipped, because a guessed address is not worth a request.
//   --out <dir>            Where to write. Default pipeline/cache/arcgis.
//   --page-size <n>        Records per request. Capped by what the layer allows.
//   --gap <ms>             Wait between requests. Default 1000.
//   --retries <n>          Attempts per request before giving up. Default 5.
//   --force                Re-fetch a source that already has cached pages.
//   --dry-run              Print the addresses that would be called and stop.

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** The address that asks a layer to describe itself: its record limit and its field names. */
export function describeUrl(endpoint) {
  return `${endpoint.replace(/\/+$/, '')}?f=json`;
}

/** The address for one page of records. */
export function queryUrl(endpoint, { offset = 0, pageSize = 1000, where = '1=1', objectIds = null } = {}) {
  const params = new URLSearchParams({
    where,
    outFields: '*',
    f: 'json',
    outSR: '4326',
    returnGeometry: 'true',
    // Ask for plain longitude and latitude rather than the layer's own grid.
    geometryPrecision: '6',
  });
  if (objectIds) {
    params.set('objectIds', objectIds.join(','));
  } else {
    params.set('resultOffset', String(offset));
    params.set('resultRecordCount', String(pageSize));
  }
  return `${endpoint.replace(/\/+$/, '')}/query?${params.toString()}`;
}

/** The address that asks only for the record numbers, used when a layer cannot page. */
export function idsUrl(endpoint, where = '1=1') {
  const params = new URLSearchParams({ where, returnIdsOnly: 'true', f: 'json' });
  return `${endpoint.replace(/\/+$/, '')}/query?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

/**
 * Fetch one address and return both the raw text and the parsed answer.
 *
 * ArcGIS reports a problem two ways: an HTTP error, or a 200 response whose body is
 * `{ "error": { "code": 400, "message": "…" } }`. Both are treated as failures.
 */
async function getJson(url, retries) {
  let wait = 3000;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'parity-offline-restroom-pipeline/1 (offline dataset build)' },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) throw new Error(`server answered ${response.status}`);
      if (!response.ok) throw new Error(`server answered ${response.status}: ${text.slice(0, 300)}`);

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`answer was not JSON: ${text.slice(0, 300)}`);
      }
      if (parsed && parsed.error) {
        const message = parsed.error.message || JSON.stringify(parsed.error);
        // A wrong address or a wrong field name will not fix itself, so stop rather than retry.
        if ([400, 404, 498, 499].includes(parsed.error.code)) {
          throw Object.assign(new Error(`layer refused the request: ${message}`), { fatal: true });
        }
        throw new Error(`layer reported an error: ${message}`);
      }
      return { text, data: parsed };
    } catch (error) {
      if (error.fatal || attempt === retries) throw error;
      const pause = wait + Math.floor(Math.random() * 1000);
      console.error(`    attempt ${attempt} failed (${error.message}). Waiting ${Math.round(pause / 1000)}s.`);
      await sleep(pause);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------

async function fetchSource(source, options) {
  const { outRoot, gap, retries, pageSizeArg, force } = options;
  const dir = path.join(outRoot, source.id);
  await mkdir(dir, { recursive: true });

  if (force) {
    for (const file of await readdir(dir)) {
      if (/^page-\d+\.(meta\.)?json$/.test(file)) await rm(path.join(dir, file));
    }
  } else {
    const existing = (await readdir(dir)).filter((f) => /^page-\d+\.json$/.test(f));
    if (existing.length) {
      console.log(`  already cached: ${existing.length} page(s). Use --force to fetch again.`);
      return { pages: existing.length, records: null, skipped: true };
    }
  }

  // Ask the layer to describe itself first: how many records it will hand over at once, and
  // whether it can page at all. Older map services cannot, and need the record-number route below.
  let layerMax = 1000;
  let supportsPagination = true;
  try {
    const { data } = await getJson(describeUrl(source.endpoint), retries);
    if (Number.isFinite(data.maxRecordCount)) layerMax = data.maxRecordCount;
    const advanced = data.advancedQueryCapabilities;
    if (advanced && advanced.supportsPagination === false) supportsPagination = false;
    await writeFile(path.join(dir, 'layer.json'), `${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    console.error(`  could not read the layer description: ${error.message}`);
    if (error.fatal) throw error;
  }

  const pageSize = Math.max(
    1,
    Math.min(Number(pageSizeArg) || Number(source.maxRecordCount) || layerMax, layerMax, 2000),
  );
  const where = source.where || '1=1';
  const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const writePage = async (index, text, url, count) => {
    await writeFile(path.join(dir, `page-${index}.json`), text);
    await writeFile(
      path.join(dir, `page-${index}.meta.json`),
      `${JSON.stringify({ source: source.id, endpoint: source.endpoint, url, fetched_at: fetchedAt, records: count }, null, 2)}\n`,
    );
  };

  let pages = 0;
  let records = 0;

  if (supportsPagination) {
    for (let offset = 0; ; offset += pageSize) {
      const url = queryUrl(source.endpoint, { offset, pageSize, where });
      const { text, data } = await getJson(url, retries);
      const features = Array.isArray(data.features) ? data.features : [];
      await writePage(pages, text, url, features.length);
      pages += 1;
      records += features.length;
      console.log(`  page ${pages}: ${features.length} record(s), ${records} so far.`);
      // Stop when the layer says there is no more, or when a short page proves it.
      if (!data.exceededTransferLimit && features.length < pageSize) break;
      if (features.length === 0) break;
      await sleep(gap);
    }
  } else {
    // The layer cannot skip ahead, so ask for every record number and then request them in batches.
    console.log('  layer cannot page; asking for record numbers instead.');
    const { data } = await getJson(idsUrl(source.endpoint, where), retries);
    const ids = Array.isArray(data.objectIds) ? data.objectIds : [];
    console.log(`  ${ids.length} record number(s).`);
    for (let i = 0; i < ids.length; i += pageSize) {
      const batch = ids.slice(i, i + pageSize);
      const url = queryUrl(source.endpoint, { objectIds: batch, where });
      const { text, data: page } = await getJson(url, retries);
      const features = Array.isArray(page.features) ? page.features : [];
      await writePage(pages, text, url, features.length);
      pages += 1;
      records += features.length;
      console.log(`  page ${pages}: ${features.length} record(s), ${records} so far.`);
      if (i + pageSize < ids.length) await sleep(gap);
    }
  }

  return { pages, records, skipped: false };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { flags: new Set(), source: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else if (key === 'source') {
      args.source.push(next);
      i += 1;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = JSON.parse(await readFile(path.join(HERE, 'sources.json'), 'utf8'));
  const arcgisSources = registry.sources.filter((s) => s.kind === 'arcgis');

  let chosen;
  if (args.flags.has('all')) {
    chosen = arcgisSources;
  } else if (args.source.length) {
    chosen = args.source.map((id) => {
      const found = arcgisSources.find((s) => s.id === id);
      if (!found) {
        console.error(`No ArcGIS source called "${id}" in sources.json.`);
        console.error(`Known: ${arcgisSources.map((s) => s.id).join(', ')}`);
        process.exit(1);
      }
      return found;
    });
  } else {
    console.error('Choose sources with --source <id> (repeatable) or --all.');
    console.error(`Known: ${arcgisSources.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const includeUnverified = args.flags.has('include-unverified');
  const outRoot = path.resolve(REPO, args.out || 'pipeline/cache/arcgis');
  const gap = Number(args.gap ?? 1000);
  const retries = Number(args.retries ?? 5);
  const force = args.flags.has('force');
  const dryRun = args.flags.has('dry-run');

  const runnable = [];
  for (const source of chosen) {
    if (source.verified === false && !includeUnverified) {
      console.log(`SKIPPED ${source.id}: marked unchecked in sources.json.`);
      console.log(`  ${source.note || 'Check the address and the field names first.'}`);
      continue;
    }
    runnable.push(source);
  }

  if (!runnable.length) {
    console.log('');
    console.log('Nothing to fetch. Every chosen source is marked unchecked.');
    console.log('Open each address in a browser, correct sources.json, set verified to true,');
    console.log('or re-run with --include-unverified to try them as written.');
    return;
  }

  if (dryRun) {
    for (const source of runnable) {
      console.log(`${source.id}`);
      console.log(`  describe: ${describeUrl(source.endpoint)}`);
      console.log(`  first page: ${queryUrl(source.endpoint, { offset: 0, pageSize: source.maxRecordCount || 1000, where: source.where || '1=1' })}`);
    }
    return;
  }

  let failures = 0;
  for (const source of runnable) {
    console.log('');
    console.log(`${source.id} — ${source.endpoint}`);
    if (source.verified === false) console.log('  warning: this address has not been checked.');
    try {
      const result = await fetchSource(source, { outRoot, gap, retries, pageSizeArg: args['page-size'], force });
      if (!result.skipped) console.log(`  done: ${result.records} record(s) over ${result.pages} page(s).`);
    } catch (error) {
      console.error(`  failed: ${error.message}`);
      failures += 1;
    }
    await sleep(gap);
  }

  console.log('');
  console.log(`Finished. ${runnable.length - failures} source(s) cached, ${failures} failed.`);
  console.log(`Cache: ${outRoot}`);
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
