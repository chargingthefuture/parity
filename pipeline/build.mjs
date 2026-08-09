#!/usr/bin/env node
//
// pipeline/build.mjs
//
// Read everything already downloaded into the cache folder, turn it into Place records, join the
// records that describe the same physical place, and write one dataset file.
//
// No network. This step runs entirely off files on disk, which is the whole reason the fetch step
// writes raw answers: the rules below can be improved and everything rebuilt without asking a
// public service for the same data again.
//
// Usage:
//   node pipeline/build.mjs --out data/parity-dataset-us-northeast.json --name us-northeast
//   node pipeline/build.mjs --cache pipeline/cache --out /tmp/test.json

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distanceMetres,
  emptyBase,
  FLAG_FIELDS,
  generateName,
  isGeneratedName,
  normalizeArcgis,
  normalizeOsm,
} from './normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** Two records this close together, on the same road, are one place. */
export const MERGE_RADIUS_M = 150;

// ---------------------------------------------------------------------------
// Reading the cache
// ---------------------------------------------------------------------------

async function listFiles(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Read the sidecar file the fetch step writes next to a raw answer, if it is there. */
async function readMeta(rawFile) {
  try {
    return JSON.parse(await readFile(rawFile.replace(/\.json$/, '.meta.json'), 'utf8'));
  } catch {
    // No sidecar: fall back to when the file itself was last written.
    try {
      const info = await stat(rawFile);
      return { fetched_at: new Date(info.mtime).toISOString().replace(/\.\d+Z$/, 'Z') };
    } catch {
      return {};
    }
  }
}

function isRawFile(name) {
  return name.endsWith('.json') && !name.endsWith('.meta.json') && name !== 'layer.json';
}

/**
 * Walk the cache folder and turn every raw answer into Place records.
 *
 * Returns the records that have usable coordinates, plus a count of what was thrown away and why.
 */
export async function readCache(cacheDir, sourcesById) {
  const places = [];
  const dropped = { no_coordinates: 0, unreadable_record: 0, unknown_source: 0 };
  const perSource = {};
  const files = [];

  const countFor = (id) => {
    if (!perSource[id]) perSource[id] = { records: 0, places: 0 };
    return perSource[id];
  };

  const keep = (place, sourceId) => {
    if (!place) {
      dropped.unreadable_record += 1;
      return;
    }
    countFor(sourceId).records += 1;
    if (typeof place.lat !== 'number' || typeof place.lon !== 'number'
      || place.lat < -90 || place.lat > 90 || place.lon < -180 || place.lon > 180
      || (place.lat === 0 && place.lon === 0)) {
      // A record with no point on the map cannot be shown, cannot be navigated to, and cannot be
      // matched against another source. There is nothing useful left to do with it.
      dropped.no_coordinates += 1;
      return;
    }
    places.push(place);
  };

  // OpenStreetMap: one file per square of the map.
  const osmDir = path.join(cacheDir, 'osm');
  for (const name of await listFiles(osmDir)) {
    if (!isRawFile(name)) continue;
    const file = path.join(osmDir, name);
    files.push(file);
    const meta = await readMeta(file);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      dropped.unreadable_record += 1;
      continue;
    }
    for (const element of parsed.elements || []) {
      keep(normalizeOsm(element, meta), 'osm');
    }
  }

  // ArcGIS: one folder per source, one file per page of records.
  const arcgisDir = path.join(cacheDir, 'arcgis');
  for (const sourceId of await listFiles(arcgisDir)) {
    const source = sourcesById.get(sourceId);
    if (!source) {
      dropped.unknown_source += 1;
      continue;
    }
    const sourceDir = path.join(arcgisDir, sourceId);
    for (const name of await listFiles(sourceDir)) {
      if (!isRawFile(name)) continue;
      const file = path.join(sourceDir, name);
      files.push(file);
      const meta = await readMeta(file);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        dropped.unreadable_record += 1;
        continue;
      }
      for (const feature of parsed.features || []) {
        keep(normalizeArcgis(feature, source, meta), sourceId);
      }
    }
  }

  return { places, dropped, perSource, files };
}

// ---------------------------------------------------------------------------
// Deciding what counts as the same place
// ---------------------------------------------------------------------------

// Which kinds can describe the same site. A restroom point sitting inside a rest area is the same
// stop; a weigh station next to a truck stop is not. The check is applied both ways round, so the
// lists cannot disagree with each other.
const KIND_MATCHES = {
  rest_area: ['rest_area', 'services', 'welcome_center', 'toilets', 'other'],
  services: ['services', 'rest_area', 'truck_stop', 'fuel', 'toilets', 'other'],
  truck_stop: ['truck_stop', 'services', 'fuel', 'toilets', 'other'],
  toilets: ['toilets', 'rest_area', 'services', 'truck_stop', 'fuel', 'welcome_center', 'weigh_station', 'other'],
  fuel: ['fuel', 'truck_stop', 'services', 'toilets', 'other'],
  welcome_center: ['welcome_center', 'rest_area', 'toilets', 'other'],
  weigh_station: ['weigh_station', 'toilets', 'other'],
  other: ['rest_area', 'services', 'truck_stop', 'toilets', 'fuel', 'welcome_center', 'weigh_station', 'other'],
};

/** True when two kinds could describe one site. */
export function kindsMatch(a, b) {
  const left = KIND_MATCHES[a] || [];
  const right = KIND_MATCHES[b] || [];
  return left.includes(b) && right.includes(a);
}

/**
 * True when two records describe the same physical place.
 *
 * Close together, a kind that fits, and no disagreement on the road or the direction of travel.
 * A field only counts against a match when both records have an answer: one source being silent is
 * not evidence of anything. `both` sits either side of a divided road, so it never conflicts.
 */
export function isSamePlace(a, b, radius = MERGE_RADIUS_M) {
  if (!kindsMatch(a.kind, b.kind)) return false;
  if (a.route && b.route && a.route !== b.route) return false;
  if (a.direction && b.direction && a.direction !== b.direction
    && a.direction !== 'both' && b.direction !== 'both') return false;
  return distanceMetres(a.lat, a.lon, b.lat, b.lon) <= radius;
}

// How specific a kind is. When two sources disagree, the more specific label is the more useful one.
const KIND_SPECIFICITY = {
  other: 0,
  toilets: 1,
  fuel: 2,
  services: 3,
  weigh_station: 4,
  welcome_center: 5,
  truck_stop: 6,
  rest_area: 6,
};

/**
 * Fold a group of records about one place into a single Place.
 *
 * The order matters and it is deliberate. Records are sorted by how much the source is trusted for
 * amenity facts — a state transport department first, then the federal roll-up, then
 * OpenStreetMap — and the first one becomes the starting point. A state department runs the
 * buildings it publishes and updates its own inventory when a restroom is closed or rebuilt;
 * OpenStreetMap tags are entered by volunteers passing through and can be years behind. So where
 * both have an answer and the answers differ, the department's answer is kept.
 *
 * Where only one has an answer, that answer is used whoever it came from. A real value is never
 * replaced by a null, in either direction — a fact is always better than a silence.
 */
export function mergePlaces(group, priorityOf) {
  const ordered = [...group].sort((a, b) => {
    const byPriority = priorityOf(b) - priorityOf(a);
    if (byPriority !== 0) return byPriority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const winner = ordered[0];
  // The id comes from the most trusted source in the group. Observations point at this id, so it
  // has to be picked the same way every rebuild — which is why the sort above breaks ties on the id
  // itself rather than on the order files happened to be read in.
  const merged = {
    id: winner.id,
    name: winner.name,
    kind: winner.kind,
    lat: winner.lat,
    lon: winner.lon,
    route: winner.route,
    direction: winner.direction,
    milepost: winner.milepost,
    state: winner.state,
    base: { ...emptyBase(), ...winner.base },
    sources: [],
  };

  // The best name is a name a source published, taken from the most trusted source that has one.
  // A name this pipeline made up is only a fallback.
  let bestName = isGeneratedName(winner) ? null : winner.name;

  for (const place of ordered) {
    if (place !== winner) {
      if (!bestName && !isGeneratedName(place)) bestName = place.name;

      if ((KIND_SPECIFICITY[place.kind] ?? 0) > (KIND_SPECIFICITY[merged.kind] ?? 0)) merged.kind = place.kind;

      for (const field of ['route', 'direction', 'milepost', 'state']) {
        if (merged[field] === null && place[field] !== null) merged[field] = place[field];
      }
      // A record that names one carriageway is more use to a driver than one that says "both".
      if (merged.direction === 'both' && place.direction && place.direction !== 'both') {
        merged.direction = place.direction;
      }

      for (const field of FLAG_FIELDS) {
        if (merged.base[field] === null && place.base[field] !== null) merged.base[field] = place.base[field];
      }
      if (merged.base.truck_parking_spots === null && place.base.truck_parking_spots !== null) {
        merged.base.truck_parking_spots = place.base.truck_parking_spots;
      }
      if (merged.base.hours === null && place.base.hours !== null) merged.base.hours = place.base.hours;
    }

    for (const entry of place.sources) {
      const already = merged.sources.some((s) => s.source === entry.source && s.native_id === entry.native_id);
      if (!already) merged.sources.push(entry);
    }
  }

  merged.sources.sort((a, b) => (a.source + a.native_id < b.source + b.native_id ? -1 : 1));
  merged.name = bestName || generateName(merged);
  return merged;
}

/**
 * Group every record that describes the same place and fold each group into one Place.
 *
 * Records are bucketed into a grid first so that each one is only compared with its neighbours
 * rather than with all several thousand others. Groups are grown by joining any two records that
 * match, so three records of the same place from three sources end up as one.
 */
export function dedupe(places, priorityOf, radius = MERGE_RADIUS_M) {
  // A grid square a little wider than the match radius, so a matching pair is always either in the
  // same square or in one touching it.
  const CELL = 0.0025;
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const grid = new Map();
  places.forEach((place, index) => {
    const key = cellKey(place.lat, place.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });

  // Join records into groups (each record starts in a group of its own, and matching two records
  // joins their groups).
  const parent = places.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let comparisons = 0;
  places.forEach((place, index) => {
    const row = Math.floor(place.lat / CELL);
    const col = Math.floor(place.lon / CELL);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (const other of grid.get(`${row + dr}:${col + dc}`) || []) {
          if (other <= index) continue;
          comparisons += 1;
          if (isSamePlace(place, places[other], radius)) join(index, other);
        }
      }
    }
  });

  const groups = new Map();
  places.forEach((place, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(place);
  });

  const merged = [];
  let mergedAway = 0;
  for (const group of groups.values()) {
    if (group.length === 1) merged.push(group[0]);
    else {
      merged.push(mergePlaces(group, priorityOf));
      mergedAway += group.length - 1;
    }
  }

  merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { places: merged, mergedAway, groupsMerged: [...groups.values()].filter((g) => g.length > 1).length, comparisons };
}

// ---------------------------------------------------------------------------
// Building the file
// ---------------------------------------------------------------------------

export async function loadSources(file) {
  const registry = JSON.parse(await readFile(file, 'utf8'));
  const byId = new Map(registry.sources.map((s) => [s.id, s]));
  return { registry, byId };
}

function boundingBox(places) {
  if (!places.length) return [0, 0, 0, 0];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const place of places) {
    west = Math.min(west, place.lon);
    east = Math.max(east, place.lon);
    south = Math.min(south, place.lat);
    north = Math.max(north, place.lat);
  }
  const r = (n) => Math.round(n * 1e4) / 1e4;
  return [r(west), r(south), r(east), r(north)];
}

/**
 * Do the whole offline half of the pipeline: read the cache, normalize, join duplicates, and
 * return the dataset file's contents together with a summary of what happened.
 */
export async function buildDataset({
  cacheDir,
  sourcesFile = path.join(HERE, 'sources.json'),
  name = 'dataset',
  sample = false,
  warning = null,
  generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  radius = MERGE_RADIUS_M,
} = {}) {
  const { byId } = await loadSources(sourcesFile);
  const priorityOf = (place) => {
    const first = place.sources[0];
    const source = first ? byId.get(first.source) : null;
    return source && Number.isFinite(source.priority) ? source.priority : 0;
  };

  const { places: normalized, dropped, perSource, files } = await readCache(cacheDir, byId);
  const { places, mergedAway, groupsMerged } = dedupe(normalized, priorityOf, radius);

  for (const place of places) {
    for (const entry of place.sources) {
      if (!perSource[entry.source]) perSource[entry.source] = { records: 0, places: 0 };
      perSource[entry.source].places += 1;
    }
  }

  const attribution = [...new Set(
    places
      .flatMap((place) => place.sources.map((s) => byId.get(s.source)?.attribution))
      .filter(Boolean),
  )].sort();

  const dataset = {
    format: 'parity.dataset',
    version: 1,
    name,
    generated_at: generatedAt,
    sample: Boolean(sample),
    bbox: boundingBox(places),
    attribution,
    counts: { places: places.length },
    places,
  };
  if (warning) {
    // Sits directly after `sample` in the written file so it cannot be missed by anyone reading it.
    const { places: placeList, ...rest } = dataset;
    return {
      dataset: { ...rest, warning, places: placeList },
      summary: { perSource, dropped, mergedAway, groupsMerged, normalized: normalized.length, final: places.length, files: files.length },
    };
  }

  return {
    dataset,
    summary: { perSource, dropped, mergedAway, groupsMerged, normalized: normalized.length, final: places.length, files: files.length },
  };
}

/** Turn the summary into the lines printed at the end of a build. */
export function formatSummary(summary, { cacheDir, outFile } = {}) {
  const lines = [];
  lines.push(`Read ${summary.files} cached file(s) from ${cacheDir}`);
  lines.push('');
  lines.push('Records per source (records read, then places they ended up in):');
  const ids = Object.keys(summary.perSource).sort();
  if (!ids.length) lines.push('  none — the cache folder is empty');
  for (const id of ids) {
    const counts = summary.perSource[id];
    lines.push(`  ${id.padEnd(28)} ${String(counts.records).padStart(6)} read  ${String(counts.places).padStart(6)} in the file`);
  }
  lines.push('');
  lines.push(`Normalized ${summary.normalized} record(s) with usable coordinates.`);
  lines.push(`Joined ${summary.mergedAway} duplicate record(s) into ${summary.groupsMerged} place(s) shared by more than one source.`);
  const dropped = Object.entries(summary.dropped).filter(([, n]) => n > 0);
  if (dropped.length) {
    lines.push('Dropped:');
    for (const [reason, n] of dropped) {
      const why = {
        no_coordinates: 'no point on the map, so nothing could be shown or matched',
        unreadable_record: 'the record could not be read at all',
        unknown_source: 'a cache folder with no matching entry in sources.json',
      }[reason] || '';
      lines.push(`  ${String(n).padStart(6)} ${reason} — ${why}`);
    }
  } else {
    lines.push('Dropped: nothing.');
  }
  lines.push('');
  lines.push(`${summary.final} place(s) written${outFile ? ` to ${outFile}` : ''}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('Missing --out <file>. Example:');
    console.error('  node pipeline/build.mjs --out data/parity-dataset-us-northeast.json --name us-northeast');
    process.exit(1);
  }
  const cacheDir = path.resolve(REPO, args.cache || 'pipeline/cache');
  const outFile = path.resolve(REPO, args.out);
  const name = args.name || path.basename(outFile).replace(/^parity-dataset-/, '').replace(/\.json$/, '');

  const { dataset, summary } = await buildDataset({
    cacheDir,
    name,
    sample: args.flags.has('sample'),
    warning: args.warning || null,
    radius: Number(args.radius ?? MERGE_RADIUS_M),
  });

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(dataset, null, 2)}\n`);

  console.log(formatSummary(summary, { cacheDir, outFile }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
