#!/usr/bin/env node
//
// pipeline/fetch-osm.mjs
//
// Download raw OpenStreetMap data through Overpass and write it to disk untouched.
//
// This is one of only two scripts in the pipeline that need the internet. Run it once over Wi-Fi.
// Nothing else in the pipeline, and nothing in the app itself, ever calls Overpass again.
//
// It writes the response exactly as it arrived. Turning that raw text into Place records is
// normalize.mjs's job, and keeping the raw text means the records can be rebuilt with better rules
// later without asking a public free service for the same data twice.
//
// Usage:
//   node pipeline/fetch-osm.mjs --bbox -80.5,36.5,-66.9,47.5
//   node pipeline/fetch-osm.mjs --bbox -95,41,-94,42 --tile 0.5 --out pipeline/cache/osm --force
//
// Options:
//   --bbox w,s,e,n   Area to cover, in degrees: west, south, east, north. Required.
//   --tile <deg>     Width and height of one query square. Default 1 degree.
//   --out <dir>      Where to write. Default pipeline/cache/osm.
//   --endpoint <url> Overpass server. Default comes from sources.json.
//   --gap <ms>       Wait between requests. Default 3000, from sources.json.
//   --timeout <s>    Overpass server-side time limit per query. Default 180.
//   --retries <n>    Attempts per square before giving up. Default 5.
//   --force          Fetch squares that are already cached instead of skipping them.
//   --dry-run        Print the squares and the query, ask for nothing.

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

// What counts as a place a driver might stop at. Each entry becomes one line of the Overpass query,
// asked for as both a point and an area, because a rest area is sometimes drawn as a single point
// and sometimes as the outline of the whole site.
const SELECTORS = [
  '["highway"="rest_area"]',
  '["highway"="services"]',
  '["amenity"="toilets"]',
  '["amenity"="fuel"]',
  '["amenity"="truck_stop"]',
  // Truck-specific: parking and fuel that say in their own tags that lorries are welcome. This is
  // what separates a stop a 70-foot vehicle can actually use from a car park.
  '["amenity"="parking"]["hgv"="yes"]',
  '["amenity"="parking"]["hgv"="designated"]',
  '["amenity"="parking"]["truck"="yes"]',
  '["amenity"="fuel"]["hgv"="yes"]',
  '["amenity"="fuel"]["hgv:lanes"]',
];

/** Build the Overpass query text for one square. Overpass wants south,west,north,east. */
export function buildQuery(square, timeoutSeconds = 180) {
  const { south, west, north, east } = square;
  const box = `${south},${west},${north},${east}`;
  const lines = [];
  for (const selector of SELECTORS) {
    lines.push(`  node${selector}(${box});`);
    lines.push(`  way${selector}(${box});`);
    lines.push(`  relation${selector}(${box});`);
  }
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    '(',
    ...lines,
    ');',
    // `center` gives one point for an area, so a rest area drawn as an outline still lands on the map.
    'out center tags;',
  ].join('\n');
}

/** Cut a bounding box into squares no larger than `tile` degrees on a side. */
export function tileBbox(bbox, tile = 1) {
  const [west, south, east, north] = bbox;
  const squares = [];
  const step = Math.max(0.05, Number(tile) || 1);
  for (let s = south; s < north; s += step) {
    for (let w = west; w < east; w += step) {
      squares.push({
        south: round4(s),
        west: round4(w),
        north: round4(Math.min(s + step, north)),
        east: round4(Math.min(w + step, east)),
      });
    }
  }
  return squares;
}

/** The file name for one square. Built from its edges, so re-running overwrites the same file. */
export function tileName(square) {
  return `tile_${square.west.toFixed(3)}_${square.south.toFixed(3)}_${square.east.toFixed(3)}_${square.north.toFixed(3)}`;
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask Overpass for one square, retrying on a busy or slow server.
 *
 * Overpass answers a query it could not finish inside its time limit with a normal 200 response
 * that carries a `remark` explaining the timeout, so the body is checked as well as the status.
 */
async function fetchSquare({ endpoint, query, retries, onAttempt }) {
  let wait = 5000;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (onAttempt) onAttempt(attempt);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // A real contact string is expected of anyone using the free servers.
          'User-Agent': 'parity-offline-restroom-pipeline/1 (offline dataset build)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(300_000),
      });

      const text = await response.text();

      if (response.status === 429 || response.status === 504 || response.status >= 500) {
        throw new Error(`server answered ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`server answered ${response.status}: ${text.slice(0, 300)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`answer was not JSON: ${text.slice(0, 300)}`);
      }
      if (!Array.isArray(parsed.elements)) {
        throw new Error(`answer had no elements list: ${text.slice(0, 300)}`);
      }
      if (typeof parsed.remark === 'string' && /timed out|out of memory/i.test(parsed.remark)) {
        throw new Error(`query too big for the server: ${parsed.remark} — try a smaller --tile`);
      }

      return { text, count: parsed.elements.length };
    } catch (error) {
      if (attempt === retries) throw error;
      // Wait longer each time, plus a random extra so several runs do not line up on the same second.
      const pause = wait + Math.floor(Math.random() * 2000);
      console.error(`  attempt ${attempt} failed (${error.message}). Waiting ${Math.round(pause / 1000)}s.`);
      await sleep(pause);
      wait = Math.min(wait * 2, 120_000);
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.bbox) {
    console.error('Missing --bbox w,s,e,n (west, south, east, north in degrees).');
    console.error('Example: node pipeline/fetch-osm.mjs --bbox -80.5,36.5,-66.9,47.5');
    process.exit(1);
  }

  const bbox = String(args.bbox).split(',').map((n) => Number(n.trim()));
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    console.error('--bbox needs four numbers: west,south,east,north');
    process.exit(1);
  }
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    console.error('--bbox must be west < east and south < north');
    process.exit(1);
  }

  const registry = JSON.parse(await readFile(path.join(HERE, 'sources.json'), 'utf8'));
  const osmSource = registry.sources.find((s) => s.id === 'osm') || {};

  const endpoint = args.endpoint || osmSource.endpoint || 'https://overpass-api.de/api/interpreter';
  const tile = Number(args.tile ?? osmSource.tileDegrees ?? 1);
  const gap = Number(args.gap ?? osmSource.rateLimitMs ?? 3000);
  const timeoutSeconds = Number(args.timeout ?? osmSource.timeoutSeconds ?? 180);
  const retries = Number(args.retries ?? 5);
  const outDir = path.resolve(REPO, args.out || 'pipeline/cache/osm');
  const force = args.flags.has('force');
  const dryRun = args.flags.has('dry-run');

  const squares = tileBbox(bbox, tile);
  console.log(`Area ${bbox.join(', ')} split into ${squares.length} square(s) of ${tile}°.`);
  console.log(`Server ${endpoint}, ${gap}ms between requests, ${retries} attempts per square.`);
  console.log(`Writing to ${outDir}`);

  if (dryRun) {
    console.log('\nQuery for the first square:\n');
    console.log(buildQuery(squares[0], timeoutSeconds));
    console.log(`\nWould write ${squares.map(tileName).slice(0, 5).join(', ')}${squares.length > 5 ? ', …' : ''}`);
    return;
  }

  await mkdir(outDir, { recursive: true });

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let elements = 0;

  for (const [index, square] of squares.entries()) {
    const name = tileName(square);
    const file = path.join(outDir, `${name}.json`);
    const label = `[${index + 1}/${squares.length}] ${name}`;

    if (!force && (await exists(file))) {
      console.log(`${label} already cached, skipping.`);
      skipped += 1;
      continue;
    }

    const query = buildQuery(square, timeoutSeconds);
    console.log(`${label} asking…`);
    try {
      const { text, count } = await fetchSquare({ endpoint, query, retries });
      // The response file holds the server's answer byte for byte. Everything this pipeline knows
      // about where it came from lives beside it in a .meta.json file, so the raw file stays raw.
      await writeFile(file, text);
      await writeFile(
        path.join(outDir, `${name}.meta.json`),
        `${JSON.stringify({
          source: 'osm',
          endpoint,
          bbox: [square.west, square.south, square.east, square.north],
          fetched_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          query,
        }, null, 2)}\n`,
      );
      console.log(`${label} ${count} element(s) saved.`);
      written += 1;
      elements += count;
    } catch (error) {
      console.error(`${label} gave up: ${error.message}`);
      failed += 1;
    }

    if (index < squares.length - 1) await sleep(gap);
  }

  console.log('');
  console.log(`Saved ${written} square(s), ${elements} element(s) in total.`);
  console.log(`Skipped ${skipped} already cached. Failed ${failed}.`);
  if (failed) {
    console.log('Run the same command again to retry only the squares that failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
