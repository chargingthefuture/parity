/* Parity — sharing without a server.
 *
 * A group of drivers pooling what they know needs no backend, no hosting bill,
 * and no account. It needs a file. One driver exports, hands the file over
 * however she likes — text message, email, a memory stick, an app that shares
 * files directly between two phones — and the other imports it.
 *
 * This is a deliberate safety decision, not a shortcut. A central service that
 * held these records would be a single database of where women stopped, when
 * they stopped, and how often. It would be requestable, buyable, leakable, and
 * a standing target. The file-passing design means that database does not exist
 * anywhere, so it cannot be handed to anyone. Every driver holds only what she
 * wrote and what she was given directly.
 *
 * Merge rules, in one line: add what is new, keep what is already here, keep
 * both sides of a disagreement, and never silently overwrite anything.
 */

import * as db from './db.js';
import * as places from './places.js';
import * as obs from './observations.js';

export const OBS_FORMAT = 'parity.observations';

/** Build the file that gets handed to another driver. */
export async function exportObservations() {
  const observations = await obs.all();
  const ids = new Set(observations.map(o => o.place_id));
  const all = await places.all();
  const stubs = all.filter(p => ids.has(p.id)).map(places.trim);

  return {
    format: OBS_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    device: db.deviceId(),
    counts: { observations: observations.length, places: stubs.length },
    /* The places ride along trimmed to name and position so a note stays
     * readable on a phone whose dataset does not cover that stretch of road. */
    places: stubs,
    observations
  };
}

/** Everything on this phone, for moving to a new one after a wipe. */
export async function exportBackup() {
  const file = await exportObservations();
  return {
    ...file,
    format: 'parity.backup',
    settings: db.getSettings(),
    meta: db.getMeta()
  };
}

export function download(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Merge someone else's file into this phone.
 *
 * Returns a plain-language report so the driver can see what actually changed
 * rather than having to trust it.
 */
export async function importObservations(data) {
  if (!data || (data.format !== OBS_FORMAT && data.format !== 'parity.backup')) {
    throw new Error('That is not a Parity observations file.');
  }
  if (!Array.isArray(data.observations)) {
    throw new Error('That file has no observations in it.');
  }

  const mine = new Map((await obs.all()).map(o => [o.obs_id, o]));
  const added = [];
  const kept = [];
  const rejected = [];

  for (const incoming of data.observations) {
    const problem = obs.validate(incoming);
    if (problem) { rejected.push({ id: incoming?.obs_id ?? '(no id)', problem }); continue; }
    if (mine.has(incoming.obs_id)) {
      /* Already here. The copy on this phone wins, always. Nothing a driver
       * wrote is replaced by a file somebody handed her. */
      kept.push(incoming.obs_id);
      continue;
    }
    added.push(incoming);
  }

  if (added.length) await db.putAll(db.STORE_OBSERVATIONS, added);

  let stubsAdded = 0;
  if (Array.isArray(data.places) && data.places.length) {
    stubsAdded = await places.addStubs(data.places.map(p => ({
      id: p.id, name: p.name, kind: p.kind || 'other',
      lat: p.lat, lon: p.lon, route: p.route ?? null,
      direction: p.direction ?? null, state: p.state ?? null,
      base: {}, sources: [{ source: 'shared', native_id: p.id }]
    })));
  }

  const authors = new Set(added.map(o => o.author).filter(Boolean));
  const placeIds = new Set(added.map(o => o.place_id));

  return {
    added: added.length,
    alreadyHad: kept.length,
    rejected,
    stubsAdded,
    authors: authors.size,
    places: placeIds.size,
    from: data.device || 'unknown device'
  };
}

/** Restore settings from a full backup file. Observations come in through the
 *  same merge rules as anyone else's file — a restore never wipes. */
export async function importBackup(data) {
  const report = await importObservations(data);
  if (data.settings) db.saveSettings(data.settings);
  if (data.meta) {
    /* The device id is deliberately NOT restored from a backup unless this
     * phone has none, so two phones restored from one file do not both claim
     * to be the same author. */
    const current = db.getMeta();
    db.saveMeta({
      lastStopAt: data.meta.lastStopAt ?? current.lastStopAt,
      device: current.device || data.meta.device || null
    });
  }
  return report;
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try { resolve(JSON.parse(r.result)); }
      catch { reject(new Error('That file is not readable as data.')); }
    };
    r.onerror = () => reject(new Error('That file could not be read.'));
    r.readAsText(file);
  });
}
