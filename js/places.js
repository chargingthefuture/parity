/* Parity — the base map data.
 *
 * Places come from public sources (OpenStreetMap, federal and state transport
 * departments) through the offline import pipeline in /pipeline. The app never
 * calls those services itself. The only file it ever reads over the wire is one
 * that is already sitting on this phone: the bundled dataset, saved by the
 * service worker when the app was installed, so it opens in airplane mode.
 */

import * as db from './db.js';
import { buildIndex, near } from './geo.js';

/* The app ships with whichever of these is present, in this order.
 *
 * data/dataset.json is real data built from the public sources by
 * pipeline/make-dataset.mjs. The sample is 33 invented places, kept only so the
 * app has something to run against before a real dataset has been built. Real
 * data wins whenever it is there, and the sample carries a flag that puts a
 * standing warning on screen whenever it is the one loaded. */
const BUNDLED = ['data/dataset.json', 'data/sample-dataset.json'];

let index = null;         // grid lookup, rebuilt when the dataset changes
let cache = null;         // every place, in memory — a few thousand small rows

export const KIND_LABELS = {
  rest_area: 'Rest area',
  services: 'Services',
  truck_stop: 'Truck stop',
  welcome_center: 'Welcome center',
  toilets: 'Restroom',
  fuel: 'Fuel',
  weigh_station: 'Weigh station',
  other: 'Stop'
};

export const KIND_ICONS = {
  rest_area: '🅿️',
  services: '🛣',
  truck_stop: '🛻',
  welcome_center: 'ℹ️',
  toilets: '🚻',
  fuel: '⛽',
  weigh_station: '⚖️',
  other: '📍'
};

/** Check a file really is a dataset before letting it near the database. */
export function validateDataset(data) {
  if (!data || typeof data !== 'object') return 'That file is not readable as data.';
  if (data.format !== 'parity.dataset') return 'That is not a Parity dataset file.';
  if (!Array.isArray(data.places)) return 'That dataset has no places in it.';
  const bad = data.places.find(p => !p || !p.id || typeof p.lat !== 'number' || typeof p.lon !== 'number');
  if (bad) return 'That dataset has a row with no id or no position.';
  return null;
}

/**
 * Replace the base data. Observations are deliberately untouched — a dataset
 * refresh must never cost a driver a note they wrote.
 */
export async function loadDataset(data) {
  const problem = validateDataset(data);
  if (problem) throw new Error(problem);
  await db.clear(db.STORE_PLACES);
  await db.putAll(db.STORE_PLACES, data.places);
  db.saveMeta({
    datasetName: data.name || 'unnamed',
    datasetGeneratedAt: data.generated_at || null,
    datasetSample: data.sample === true,
    datasetCount: data.places.length
  });
  cache = null;
  index = null;
  return data.places.length;
}

/** Load the dataset that shipped with the app, the first time the app is opened. */
export async function loadBundledIfEmpty() {
  const n = await db.count(db.STORE_PLACES);
  if (n > 0) return n;
  for (const file of BUNDLED) {
    try {
      /* force-cache, because this file was copied onto the phone by the service
       * worker at install. Reading it is not a network round trip and works in
       * airplane mode on the very first launch. */
      const res = await fetch(file, { cache: 'force-cache' });
      if (!res.ok) continue;
      return await loadDataset(await res.json());
    } catch {
      // Try the next one. A missing real dataset is normal before one is built.
    }
  }
  // Nothing bundled and nothing stored. The app still runs; the data screen
  // explains how to load a dataset file.
  return 0;
}

/** Every place, plus any stub that arrived attached to someone else's notes. */
export async function all() {
  if (cache) return cache;
  const [places, stubs] = await Promise.all([
    db.getAll(db.STORE_PLACES),
    db.getAll(db.STORE_STUBS)
  ]);
  const byId = new Map(places.map(p => [p.id, p]));
  for (const s of stubs) {
    // A stub only ever fills a gap. It never replaces real dataset data.
    if (!byId.has(s.id)) byId.set(s.id, { ...s, stub: true });
  }
  cache = Array.from(byId.values());
  return cache;
}

export async function getIndex() {
  if (index) return index;
  index = buildIndex(await all());
  return index;
}

export async function byId(id) {
  const list = await all();
  return list.find(p => p.id === id) || null;
}

/** Everything within a radius of a point. */
export async function within(from, radiusM) {
  return near(await getIndex(), from, radiusM);
}

export function invalidate() {
  cache = null;
  index = null;
}

/** Save a place that arrived with an imported observation. */
export async function addStubs(stubs) {
  const existing = new Set((await db.getAll(db.STORE_PLACES)).map(p => p.id));
  const fresh = stubs.filter(s => s && s.id && !existing.has(s.id));
  if (fresh.length) await db.putAll(db.STORE_STUBS, fresh);
  cache = null;
  index = null;
  return fresh.length;
}

/** The small version of a place that rides along inside an export file. */
export function trim(p) {
  return {
    id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon,
    route: p.route ?? null, direction: p.direction ?? null, state: p.state ?? null
  };
}

export function label(p) {
  return p.name || (KIND_LABELS[p.kind] || 'Stop');
}

/** A one-line description of where a place is: route, direction, mile post. */
export function whereLine(p) {
  const bits = [];
  if (p.route) bits.push(p.route + (p.direction && p.direction !== 'both' ? ' ' + p.direction : ''));
  if (p.milepost != null) bits.push('MP ' + p.milepost);
  if (p.state) bits.push(p.state);
  return bits.join(' · ');
}

/**
 * What the source claims is here.
 *
 * Three states, and the difference matters: true, false, and "the source never
 * said". A blank is shown as unknown, never as a missing amenity — a driver
 * planning a night stop should not read silence as "no showers".
 */
export function baseFlags(p) {
  const b = p.base || {};
  const out = [];
  const add = (key, yes, no) => {
    if (b[key] === true) out.push({ label: yes, state: 'yes' });
    else if (b[key] === false) out.push({ label: no, state: 'no' });
  };
  add('restroom', 'Restroom', 'No restroom');
  add('family_restroom', 'Family restroom', null);
  add('ada', 'Step-free access', null);
  add('showers', 'Showers', 'No showers');
  add('food', 'Food', null);
  add('fuel', 'Fuel', null);
  if (b.staffed === true) out.push({ label: 'Staffed', state: 'yes' });
  if (b.truck_parking_spots != null) out.push({ label: b.truck_parking_spots + ' truck spots', state: 'info' });
  if (b.hours) out.push({ label: b.hours, state: 'info' });
  return out.filter(f => f.label);
}
