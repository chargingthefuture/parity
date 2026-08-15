#!/usr/bin/env node
//
// pipeline/make-dataset.mjs
//
// One command that turns real public map data into the file the app ships with.
//
//   node pipeline/make-dataset.mjs --region us-northeast
//   node pipeline/make-dataset.mjs --bbox -80.5,36.5,-66.9,47.5
//
// It downloads OpenStreetMap through Overpass, optionally pulls in any transport
// department layers you have checked, joins records about the same physical place, and writes
// data/dataset.json — the file the app loads on first launch.
//
// THIS IS THE ONLY SCRIPT IN THE REPO THAT NEEDS THE INTERNET, and it is run by hand, once, over
// Wi-Fi, on a computer. The app never calls Overpass or any transport department. By the time a
// phone sees this data it is a single file that works with the radio switched off.
//
// It writes real data. To keep that honest it refuses to mark the result as a sample, and it
// refuses to write a file with no places in it — an empty dataset that looked real would leave a
// driver with a working app and no stops, which is worse than an obvious failure.
//
// Options:
//   --region <name>  A ready-made area. Run with --list-regions to see them.
//   --bbox w,s,e,n   An area of your own, in degrees: west, south, east, north.
//   --out <file>     Where to write. Default data/dataset.json.
//   --name <name>    What to call this dataset. Default is the region name.
//   --with-arcgis    Also pull the transport department layers in sources.json.
//                    Unchecked ones are skipped by fetch-arcgis.mjs unless you tell it otherwise.
//   --skip-fetch     Do not download anything; build from what is already in pipeline/cache.
//   --dry-run        Say what would be downloaded and stop.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDataset, formatSummary, MERGE_RADIUS_M } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * Ready-made areas, so nobody has to work out a bounding box to get started.
 *
 * These are rough rectangles that cover the area named, given as west, south, east, north in
 * degrees. They are deliberately generous — a rectangle that spills into the sea or over a border
 * costs a little download time and nothing else, whereas one that is too tight quietly leaves out
 * the stops at the edge.
 */
export const REGIONS = {
  'us-northeast': { bbox: [-80.6, 36.5, -66.9, 47.5], about: 'Mid-Atlantic and New England' },
  'us-southeast': { bbox: [-91.7, 24.4, -75.2, 39.2], about: 'Florida up to Virginia, west to the Mississippi' },
  'us-midwest': { bbox: [-104.1, 35.9, -80.5, 49.4], about: 'The Plains and the Great Lakes' },
  'us-southwest': { bbox: [-124.5, 31.3, -102.0, 42.1], about: 'California, the desert states and Texas west' },
  'us-northwest': { bbox: [-125.0, 41.9, -104.0, 49.1], about: 'The Pacific Northwest and the northern Rockies' },
  'us-lower-48': { bbox: [-125.0, 24.4, -66.9, 49.4], about: 'The whole lower 48. A long download — hours, not minutes.' },
  'i-80': { bbox: [-122.5, 39.5, -74.0, 42.5], about: 'A band along Interstate 80, coast to coast' },
  'i-95': { bbox: [-81.5, 25.4, -66.9, 45.4], about: 'A band along Interstate 95' },
  'i-40': { bbox: [-119.0, 33.5, -76.5, 37.0], about: 'A band along Interstate 40' }
};

export function resolveArea({ region, bbox }) {
  if (bbox) {
    const parts = String(bbox).split(',').map((n) => Number(n.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error('--bbox needs four numbers: west,south,east,north');
    }
    if (parts[0] >= parts[2] || parts[1] >= parts[3]) {
      throw new Error('--bbox must be west < east and south < north');
    }
    return { bbox: parts, name: 'custom' };
  }
  if (region) {
    const found = REGIONS[region];
    if (!found) {
      throw new Error(`Unknown region "${region}". Known: ${Object.keys(REGIONS).join(', ')}`);
    }
    return { bbox: found.bbox, name: region };
  }
  throw new Error('Give an area: --region <name> or --bbox w,s,e,n. --list-regions shows the ready-made ones.');
}

/**
 * The guard that keeps invented or empty data out of the app.
 *
 * The dataset that ships with the app is the one a driver plans a night stop around. Two things
 * must never reach it: a file with nothing in it, and a file still wearing the sample flag.
 */
export function checkBeforeWriting(dataset) {
  if (!dataset || !Array.isArray(dataset.places)) return 'The build produced no dataset.';
  if (dataset.places.length === 0) {
    return 'The build found no places. Nothing was written — an empty dataset would leave the app ' +
      'looking like it works with no stops in it. Check that the download actually saved ' +
      'something into pipeline/cache/osm, then run again.';
  }
  if (dataset.sample === true || dataset.warning) {
    return 'The build marked this as sample data. Real data must not carry the sample flag.';
  }
  return null;
}

function run(script, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...argv], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} stopped with code ${code}`));
    });
  });
}

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else { args[key] = next; i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('list-regions')) {
    console.log('Ready-made areas:\n');
    for (const [name, r] of Object.entries(REGIONS)) {
      console.log(`  ${name.padEnd(14)} ${r.about}`);
      console.log(`  ${' '.repeat(14)} ${r.bbox.join(', ')}\n`);
    }
    console.log('Or give your own with --bbox west,south,east,north');
    return;
  }

  const area = resolveArea({ region: args.region, bbox: args.bbox });
  const outFile = path.resolve(REPO, args.out || 'data/dataset.json');
  const name = args.name || area.name;
  const dryRun = args.flags.has('dry-run');

  if (!args.flags.has('skip-fetch')) {
    console.log(`Downloading OpenStreetMap for ${area.name}: ${area.bbox.join(', ')}`);
    console.log('This is the only step that needs the internet. Overpass is a free shared service,');
    console.log('so it asks for one square at a time with a pause between. A large area takes a while.\n');
    await run('fetch-osm.mjs', ['--bbox', area.bbox.join(','), ...(dryRun ? ['--dry-run'] : [])]);

    if (args.flags.has('with-arcgis')) {
      console.log('\nDownloading transport department layers.');
      console.log('Addresses still marked unchecked in sources.json are skipped on purpose.\n');
      await run('fetch-arcgis.mjs', ['--all', ...(dryRun ? ['--dry-run'] : [])]);
    }
  }

  if (dryRun) {
    console.log('\nDry run — nothing was downloaded and nothing was written.');
    return;
  }

  console.log('\nBuilding the dataset from what was downloaded. No internet needed from here on.\n');
  const { dataset, summary } = await buildDataset({
    cacheDir: path.resolve(REPO, 'pipeline/cache'),
    name,
    sample: false,
    warning: null,
    radius: MERGE_RADIUS_M
  });

  const problem = checkBeforeWriting(dataset);
  if (problem) {
    console.error(`\n${problem}`);
    process.exit(1);
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(dataset, null, 2)}\n`);

  console.log(formatSummary(summary, { cacheDir: path.resolve(REPO, 'pipeline/cache'), outFile }));
  console.log(`\nReal data: ${dataset.places.length} place(s) in ${path.relative(REPO, outFile)}.`);
  console.log('The app loads this file in place of the sample as soon as it is committed.');
  console.log('Bump VERSION in sw.js so phones fetch the new copy rather than serving the old one.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
}
