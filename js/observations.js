/* Parity — the observation record. This is the point of the app.
 *
 * The government datasets say a restroom exists. They do not say whether the
 * door locks, whether the walk from truck parking is lit, or whether you can
 * see that door from your cab. Only a driver who stopped there knows that, and
 * only another driver needs it. So the observation record is the layer the app
 * is actually built around; the base data is scaffolding under it.
 *
 * Two rules run through everything below:
 *
 * 1. Records are added, never edited. Stopping at the same place in daylight
 *    and again at 2am produces two records, not one overwritten one. Conditions
 *    change — a burnt-out light, a lot that fills after 8pm — and a record that
 *    is rewritten each visit destroys exactly the history that shows it.
 *
 * 2. Disagreement is never averaged away. Where two drivers rated the same
 *    place very differently, the app says so and shows both, rather than
 *    quietly reporting the mean. A 5 and a 1 is not a 3; it is a question the
 *    driver reading it needs to answer for herself.
 */

import * as db from './db.js';

/* Every choice the log form offers, kept here so the form, the summary and the
 * import checker cannot drift apart. */
export const FIELDS = {
  interior: [
    { v: 'inside', l: 'Inside a building' },
    { v: 'detached', l: 'Standalone block' }
  ],
  hours: [
    { v: '24h', l: '24 hours' },
    { v: 'daytime', l: 'Daylight only' },
    { v: 'business_hours', l: 'Business hours' },
    { v: 'unknown', l: 'Not sure' }
  ],
  door: [
    { v: 'single_locking', l: 'Single, locks' },
    { v: 'multi_stall_locking', l: 'Stalls, outer door locks' },
    { v: 'multi_stall', l: 'Open multi-stall' }
  ],
  requires: [
    { v: 'none', l: 'Open to all' },
    { v: 'key', l: 'Ask for key' },
    { v: 'code', l: 'Door code' },
    { v: 'purchase', l: 'Must buy something' }
  ],
  sightline: [
    { v: 'clear', l: 'Clear' },
    { v: 'partial', l: 'Partial' },
    { v: 'blind', l: 'Blind' }
  ],
  availability: [
    { v: 'plenty', l: 'Plenty' },
    { v: 'some', l: 'Some' },
    { v: 'full', l: 'Full' }
  ],
  bands: [
    { v: 'morning', l: 'Morning' },
    { v: 'day', l: 'Midday' },
    { v: 'evening', l: 'Evening' },
    { v: 'night', l: 'Overnight' }
  ]
};

export function blank(placeId) {
  const now = new Date().toISOString();
  return {
    obs_id: db.newId(),
    place_id: placeId,
    observed_at: now,
    created_at: now,
    author: db.deviceId(),
    access: { interior: null, hours: null, hours_note: '', door: null, stalls: null, requires: null },
    safety: {
      light_lot: null, light_path: null, light_interior: null,
      sightline: null, walk_m: null,
      staffed: null, security: null, cameras: null, comfort: null
    },
    practical: {
      cleanliness: null, parking_spots: null, parking_availability: {},
      showers: null, laundry: null, food: null
    },
    notes: ''
  };
}

export async function save(obs) {
  await db.put(db.STORE_OBSERVATIONS, obs);
  return obs;
}

export async function forPlace(placeId) {
  const list = await db.byIndex(db.STORE_OBSERVATIONS, 'place_id', placeId);
  return list.sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
}

export async function all() {
  return db.getAll(db.STORE_OBSERVATIONS);
}

export async function remove(obsId) {
  return db.remove(db.STORE_OBSERVATIONS, obsId);
}

/** Group every stored observation by the place it is about. */
export async function byPlace() {
  const map = new Map();
  for (const o of await all()) {
    let list = map.get(o.place_id);
    if (!list) map.set(o.place_id, list = []);
    list.push(o);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
  }
  return map;
}

const DAY = 86400000;

export function ageDays(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / DAY);
}

/* A note from last week describes the place better than a note from three years
 * ago. Weight halves every year, so old notes still count but do not outvote
 * fresh ones. */
function recencyWeight(iso) {
  const d = ageDays(iso);
  if (d == null) return 0.25;
  return Math.pow(0.5, d / 365);
}

function weightedMean(pairs) {
  let num = 0, den = 0;
  for (const [value, weight] of pairs) {
    if (value == null) continue;
    num += value * weight;
    den += weight;
  }
  return den ? num / den : null;
}

/**
 * Roll a place's observations into the few numbers the list screen shows.
 * Returns null when nobody has logged the place — an unrated place stays
 * visibly unrated rather than being given a made-up middling score.
 */
export function summarize(list) {
  if (!list || !list.length) return null;
  const sorted = [...list].sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
  const latest = sorted[0];
  const w = sorted.map(o => [o, recencyWeight(o.observed_at)]);

  const comfort = weightedMean(w.map(([o, k]) => [o.safety?.comfort ?? null, k]));
  const cleanliness = weightedMean(w.map(([o, k]) => [o.practical?.cleanliness ?? null, k]));

  /* Lighting is scored as the WORST of the three, not the average. A bright
   * parking lot does not make up for an unlit path to the door — the dark part
   * is the part that matters, so it is the part that is reported. */
  const lighting = weightedMean(w.map(([o, k]) => {
    const parts = [o.safety?.light_lot, o.safety?.light_path, o.safety?.light_interior]
      .filter(v => v != null);
    return [parts.length ? Math.min(...parts) : null, k];
  }));

  const sightlineRank = { clear: 3, partial: 2, blind: 1 };
  const sightlineSeen = sorted.map(o => o.safety?.sightline).filter(Boolean);
  const sightline = sightlineSeen.length
    ? Object.keys(sightlineRank).find(k => sightlineRank[k] === Math.min(...sightlineSeen.map(s => sightlineRank[s])))
    : null;

  const walks = sorted.map(o => o.safety?.walk_m).filter(v => v != null);
  const walk_m = walks.length ? walks.reduce((a, b) => a + b, 0) / walks.length : null;

  /* Where drivers disagree sharply on comfort, say so instead of hiding it in
   * an average. Only recent-ish notes count toward a disagreement, otherwise a
   * fixed problem looks like an argument forever. */
  const recentComfort = sorted
    .filter(o => (ageDays(o.observed_at) ?? 9999) < 550 && o.safety?.comfort != null)
    .map(o => o.safety.comfort);
  const disagreement = recentComfort.length > 1 &&
    (Math.max(...recentComfort) - Math.min(...recentComfort)) >= 3;

  const lastAge = ageDays(latest.observed_at);
  const authors = new Set(sorted.map(o => o.author).filter(Boolean));

  return {
    count: sorted.length,
    authors: authors.size,
    latest,
    lastObservedAt: latest.observed_at,
    lastAgeDays: lastAge,
    stale: lastAge != null && lastAge > 365,
    comfort, cleanliness, lighting, sightline, walk_m,
    disagreement,
    /* One number for sorting: comfort leads, lighting and cleanliness pull it
     * around a little. Only ever used for ordering a list, never shown as a
     * score, because a single number is not what anyone should decide on. */
    rank: comfort == null ? null :
      comfort * 0.6 + (lighting ?? comfort) * 0.25 + (cleanliness ?? comfort) * 0.15,
    /* Access facts carry forward from the most recent note that stated them —
     * whether a door locks changes far less often than whether a lot is full.
     * A fact nobody has recorded stays null and is shown as "not recorded". */
    access: {
      door: latestNonNull(sorted, o => o.access?.door),
      interior: latestNonNull(sorted, o => o.access?.interior),
      hours: latestNonNull(sorted, o => o.access?.hours),
      requires: latestNonNull(sorted, o => o.access?.requires),
      stalls: latestNonNull(sorted, o => o.access?.stalls)
    },
    parking: mergeAvailability(sorted)
  };
}

function latestNonNull(sorted, pick) {
  for (const o of sorted) {
    const v = pick(o);
    if (v != null && v !== '') return v;
  }
  return null;
}

/** Most recent answer per time band. Whether a lot is full at 9pm says nothing
 *  about whether it is full at 9am, so the bands never blend into each other. */
function mergeAvailability(sorted) {
  const out = {};
  for (const band of ['morning', 'day', 'evening', 'night']) {
    for (const o of sorted) {
      const v = o.practical?.parking_availability?.[band];
      if (v) { out[band] = v; break; }
    }
  }
  return out;
}

/** Whether a place clears the driver's "rated well enough" bar. */
export function meetsBar(summary, minComfort) {
  if (!summary || summary.comfort == null) return false;
  return summary.comfort >= minComfort;
}

export function ratingWord(n) {
  if (n == null) return 'Unrated';
  if (n >= 4.5) return 'Very good';
  if (n >= 3.5) return 'Good';
  if (n >= 2.5) return 'Mixed';
  if (n >= 1.5) return 'Poor';
  return 'Bad';
}

export function ageWord(days) {
  if (days == null) return '';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 45) return Math.round(days) + ' days ago';
  if (days < 400) return Math.round(days / 30) + ' months ago';
  return Math.round(days / 365) + ' years ago';
}

/** Cheap sanity check on an observation arriving from someone else's file. */
export function validate(o) {
  if (!o || typeof o !== 'object') return 'not an object';
  if (!o.obs_id || typeof o.obs_id !== 'string') return 'missing obs_id';
  if (!o.place_id || typeof o.place_id !== 'string') return 'missing place_id';
  if (o.observed_at && Number.isNaN(Date.parse(o.observed_at))) return 'unreadable date';
  const r = v => v == null || (typeof v === 'number' && v >= 1 && v <= 5);
  const s = o.safety || {};
  if (![s.comfort, s.light_lot, s.light_path, s.light_interior].every(r)) return 'rating out of range';
  if (!r(o.practical?.cleanliness)) return 'rating out of range';
  return null;
}
