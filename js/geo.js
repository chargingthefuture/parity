/* Parity — geography math.
 *
 * All of it runs on the phone with no network. Distances are in metres
 * internally and converted for display at the edge, so there is exactly one
 * place where a unit can be got wrong.
 *
 * The important function here is alongCross(). Everything the app claims about
 * "ahead of you" and "your side of the road" comes out of it.
 */

const R = 6371008.8;               // mean earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const M_PER_MILE = 1609.344;
export const M_PER_FOOT = 0.3048;

/** Straight-line distance between two points, in metres. */
export function distance(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Compass bearing from a to b, degrees clockwise from north, 0-360. */
export function bearing(a, b) {
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/**
 * Smallest turn from bearing a to bearing b, in degrees, -180..180.
 * Negative is to the left, positive is to the right.
 */
export function turn(a, b) {
  let d = (b - a + 540) % 360 - 180;
  // -180 and 180 are the same turn; normalize so the sign is stable.
  if (d === -180) d = 180;
  return d;
}

/**
 * Split the offset from a moving position to a point into two parts:
 *   along — metres further down the road in the direction of travel
 *           (negative means it is already behind you)
 *   cross — metres to the side, positive to the RIGHT of travel
 *
 * This is a flat-earth approximation of the offset, which is correct to well
 * under a metre at the ranges that matter here (tens of miles), and it costs
 * two trig calls instead of a projection library.
 */
export function alongCross(from, heading, point) {
  const d = distance(from, point);
  const t = turn(heading, bearing(from, point)) * D2R;
  return { along: d * Math.cos(t), cross: d * Math.sin(t), distance: d };
}

/**
 * How far ahead the sideways offset still means anything.
 *
 * Past a couple of kilometres it does not. Two things swamp it. The road bends,
 * so a stop that is dead ahead on the map sits well off your current heading.
 * And the earth is curved, so a point 130 miles due east of you is not on a
 * bearing of exactly 90° — it is nearly a degree off, which at that range works
 * out as a sideways offset of about 2.8 km. A median is 20 metres wide. Reading
 * either of those as "she is on the far carriageway" would hide good stops for
 * no reason, so beyond this range the geometry is not consulted at all.
 */
export const SIDE_RANGE_M = 2000;

/**
 * Which side of the road a place sits on, from geometry alone.
 * Returns 'right' | 'left' | 'unclear' | 'unknown'.
 *
 * 'unclear' means it is inside the tolerance band — too close to the centre
 * line to call. 'unknown' means it is too far away for this method to say
 * anything at all. They are different answers and the caller treats them
 * differently.
 */
export function sideOfTravel(from, heading, point, toleranceM = 60, maxRangeM = SIDE_RANGE_M) {
  const { cross, distance: d } = alongCross(from, heading, point);
  if (d > maxRangeM) return 'unknown';
  if (Math.abs(cross) < toleranceM) return 'unclear';
  return cross > 0 ? 'right' : 'left';
}

/**
 * Can she actually get to it without crossing the median?
 *
 * This is the question the app has to get right. Getting it wrong in one
 * direction sends a driver past her exit to a stop she cannot reach; getting it
 * wrong in the other hides a stop she could have used. So it is answered from
 * whichever evidence is actually trustworthy, and when neither is, it says so
 * instead of guessing:
 *
 *   close up   — the measured sideways offset, which at short range is real.
 *                Assumes right-hand traffic (the United States): a stop on your
 *                right is on your carriageway.
 *   further on — the direction the source published for that stop. A transport
 *                department that records a rest area as northbound is telling
 *                you which carriageway it is on, and that stays true at any
 *                distance.
 *   otherwise  — unknown, and the app says "side unknown" rather than picking.
 *
 * Returns { side: 'yours' | 'other' | 'unclear' | 'unknown', basis }.
 */
export function assessSide(from, heading, place, opts = {}) {
  if (heading == null) return { side: 'unknown', basis: 'no-heading' };

  const geometric = sideOfTravel(
    from, heading, place,
    opts.toleranceM ?? 60,
    opts.maxRangeM ?? SIDE_RANGE_M
  );
  if (geometric === 'right') return { side: 'yours', basis: 'measured' };
  if (geometric === 'left') return { side: 'other', basis: 'measured' };
  if (geometric === 'unclear') return { side: 'unclear', basis: 'measured' };

  const agrees = directionAgrees(place.direction, heading);
  if (agrees === true) return { side: 'yours', basis: 'signed' };
  if (agrees === false) return { side: 'other', basis: 'signed' };
  return { side: 'unknown', basis: 'none' };
}

/**
 * Does a place's published direction tag agree with the way you are pointing?
 * Returns true (agrees), false (contradicts), or null (the data does not say).
 *
 * A published direction is a hint only. It is checked against a compass
 * heading, and a highway that runs northeast still gets tagged N or E, so the
 * test is generous — it only reports a contradiction when the tag points more
 * than a right angle away from travel.
 */
export function directionAgrees(direction, heading) {
  if (!direction || direction === 'both') return null;
  const compass = { N: 0, E: 90, S: 180, W: 270 };
  const want = compass[direction];
  if (want === undefined) return null;
  return Math.abs(turn(heading, want)) <= 90;
}

/**
 * Filter and rank places by where they are relative to a moving driver.
 *
 * opts:
 *   heading      degrees, or null when standing still / no fix yet
 *   coneDeg      how far off straight ahead still counts as ahead (default 60)
 *   minAlong     metres — skip anything nearer than this, it is too late to plan
 *   maxAlong     metres — the far edge of the planning window
 *   sideTolerance metres for the divided-highway check
 *
 * With no heading, direction cannot be judged, so everything within range is
 * returned with `ahead: null` and the caller shows it as unfiltered.
 */
export function relativeTo(from, heading, places, opts = {}) {
  const cone = opts.coneDeg ?? 60;
  const minAlong = opts.minAlong ?? 0;
  const maxAlong = opts.maxAlong ?? Infinity;
  const tol = opts.sideTolerance ?? 60;
  const out = [];

  for (const p of places) {
    const d = distance(from, p);
    if (heading == null) {
      if (d < minAlong || d > maxAlong) continue;
      out.push({ place: p, distance: d, along: d, cross: null, ahead: null, side: null, bearing: bearing(from, p) });
      continue;
    }
    const b = bearing(from, p);
    const off = Math.abs(turn(heading, b));
    const { along, cross } = alongCross(from, heading, p);
    const ahead = off <= cone && along > 0;
    if (!ahead) continue;
    if (along < minAlong || along > maxAlong) continue;
    const sideInfo = assessSide(from, heading, p, { toleranceM: tol, maxRangeM: opts.sideRangeM });
    out.push({
      place: p,
      distance: d,
      along,
      cross,
      ahead: true,
      side: sideInfo.side,
      sideBasis: sideInfo.basis,
      tagAgrees: directionAgrees(p.direction, heading),
      bearing: b
    });
  }
  out.sort((a, b2) => a.along - b2.along);
  return out;
}

/* ---- a coarse grid so a few thousand places can be searched fast ---- */

const CELL = 0.25;   // degrees; about 17 miles of latitude

function cellKey(lat, lon) {
  return Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL);
}

/** Build a lookup from a list of places. Rebuilt whenever the dataset changes. */
export function buildIndex(places) {
  const cells = new Map();
  for (const p of places) {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    const k = cellKey(p.lat, p.lon);
    let bucket = cells.get(k);
    if (!bucket) cells.set(k, bucket = []);
    bucket.push(p);
  }
  return { cells, count: places.length };
}

/**
 * Every place within radiusM of a point. Walks only the grid cells the circle
 * touches, so a 50-mile look-ahead reads a handful of cells instead of the
 * whole dataset — which is what keeps the screen responsive and the processor
 * asleep between position updates.
 */
export function near(index, from, radiusM) {
  if (!index) return [];
  const latSpan = radiusM / 111320;
  const lonSpan = radiusM / (111320 * Math.max(0.05, Math.cos(from.lat * D2R)));
  const lat0 = Math.floor((from.lat - latSpan) / CELL);
  const lat1 = Math.floor((from.lat + latSpan) / CELL);
  const lon0 = Math.floor((from.lon - lonSpan) / CELL);
  const lon1 = Math.floor((from.lon + lonSpan) / CELL);
  const out = [];
  for (let a = lat0; a <= lat1; a++) {
    for (let o = lon0; o <= lon1; o++) {
      const bucket = index.cells.get(a + ':' + o);
      if (!bucket) continue;
      for (const p of bucket) {
        if (distance(from, p) <= radiusM) out.push(p);
      }
    }
  }
  return out;
}

/* ---- display ---- */

export function fmtMiles(metres, digits) {
  const mi = metres / M_PER_MILE;
  const d = digits ?? (mi < 10 ? 1 : 0);
  return mi.toFixed(d) + ' mi';
}

export function fmtFeet(metres) {
  const ft = Math.round(metres / M_PER_FOOT);
  if (ft >= 1000) return fmtMiles(metres, 1);
  return Math.round(ft / 10) * 10 + ' ft';
}

/** Rough walking time, at a deliberately unhurried pace. */
export function walkMinutes(metres) {
  return Math.max(1, Math.round(metres / 75));
}

export function compassPoint(deg) {
  if (deg == null) return '—';
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
