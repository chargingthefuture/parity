// pipeline/normalize.mjs
//
// Turns one raw record from one source into one Place record, exactly as docs/SCHEMA.md defines it.
//
// Everything in this file is a pure function: the same input always gives the same output, nothing
// here touches the network and nothing here reads or writes a file. build.mjs feeds it records read
// from the cache folder; test.mjs feeds it records written by hand. Both get the same answers.
//
// The rule that matters most: every flag in `base` is true, false, or null, and **null means the
// source said nothing**. A silent source must never come out as false, because the app draws "we do
// not know" differently from "there is none". Guessing false here would tell a driver at 2am that a
// place has no restroom when nobody ever checked.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The eight place kinds the schema allows. */
export const KINDS = [
  'rest_area',
  'services',
  'truck_stop',
  'toilets',
  'fuel',
  'welcome_center',
  'weigh_station',
  'other',
];

/** The seven yes / no / unknown flags inside `base`. */
export const FLAG_FIELDS = ['restroom', 'family_restroom', 'ada', 'showers', 'food', 'fuel', 'staffed'];

/** A `base` object with every field set to null, in the key order the schema uses. */
export function emptyBase() {
  return {
    restroom: null,
    family_restroom: null,
    ada: null,
    showers: null,
    food: null,
    fuel: null,
    truck_parking_spots: null,
    hours: null,
    staffed: null,
  };
}

// ---------------------------------------------------------------------------
// Small value readers
// ---------------------------------------------------------------------------

// Words a source uses for yes, for no, and for "no answer". Anything not in these lists is treated
// as no answer, which is the safe direction to be wrong in.
const YES_WORDS = new Set([
  'y', 'yes', 'true', 't', '1', 'available', 'present', 'open', 'designated', 'x', 'yes ', 'have',
]);
const NO_WORDS = new Set([
  'n', 'no', 'false', 'f', '0', 'none', 'not available', 'unavailable', 'absent', 'closed', 'no ',
]);
const SILENT_WORDS = new Set([
  '', 'unknown', 'unk', 'na', 'n/a', 'null', 'nil', 'undefined', 'not reported', 'no data',
  'not applicable', 'not surveyed', '-', '--', '?', 'tbd', 'other',
]);

/**
 * Read a yes / no / unknown flag out of whatever the source wrote.
 * Returns true, false, or null. Null means the source was silent — never a stand-in for false.
 */
export function threeState(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null; // 2, -1, -9999 and friends are placeholder codes, not answers
  }
  const s = String(value).trim().toLowerCase();
  if (SILENT_WORDS.has(s)) return null;
  if (YES_WORDS.has(s)) return true;
  if (NO_WORDS.has(s)) return false;
  return null;
}

/** Read a count (truck parking spaces). Returns a whole number of 0 or more, or null. */
export function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null; // -1 and -9999 are the usual "not filled in" placeholders
  return Math.round(n);
}

/** Read a plain number (milepost). Returns a number of 0 or more, or null. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.round(n * 1000) / 1000;
}

/** Read a free-text field. Trims it, and turns blanks and placeholder words into null. */
export function toText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (SILENT_WORDS.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Round a coordinate to 6 decimal places, about 10 cm. Returns null if there is no number there.
 *
 * A missing value must come back as null rather than 0, or a record with no location would quietly
 * be placed in the Gulf of Guinea instead of being thrown away.
 */
export function roundCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Words that follow a route number but are not part of it. "US 30 BUS" is still US-30 for the
// purpose of "which road is this stop on", and the direction letters are handled separately.
const ROUTE_SUFFIX_NOISE = new Set([
  'BUS', 'BUSINESS', 'BYP', 'BYPASS', 'ALT', 'ALTERNATE', 'SPUR', 'TRK', 'TRUCK', 'LOOP', 'CONN',
  'N', 'S', 'E', 'W', 'NB', 'SB', 'EB', 'WB', 'NORTH', 'SOUTH', 'EAST', 'WEST',
  'HWY', 'HIGHWAY', 'RTE', 'ROUTE', 'RD', 'ROAD',
]);

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
]);

const STATE_NAMES = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}));

/** Read a two-letter state code out of a code or a full state name. Returns null if unclear. */
export function normalizeState(value) {
  const s = toText(value);
  if (!s) return null;
  const upper = s.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  const byName = STATE_NAMES.get(s.toLowerCase());
  return byName || null;
}

/**
 * Turn whatever a source calls a road into the schema's form: `I-95`, `US-30`, `SR-1`.
 *
 * Handles `I 95`, `i-95`, `Interstate 95`, `IH-95`, `US 30`, `U.S. 30`, `State Route 1`, `SH 1`,
 * and a two-letter state prefix such as `TX-6` (which is that state's own route, so it becomes
 * `SR-6`; the state itself is carried in the Place's `state` field).
 *
 * A bare number with no prefix returns null on purpose. "95" could be I-95 or state route 95, and
 * inventing the wrong one would send a driver to the wrong road.
 */
export function normalizeRoute(value) {
  const raw = toText(value);
  if (!raw) return null;

  // Some sources pack several roads into one field ("I-95;US-1"). Take the first one.
  const first = raw.split(/[;,]|\s+\/\s+|\//)[0];
  const cleaned = first
    .replace(/[._]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!cleaned) return null;

  const parts = cleaned.split(' ');
  // Drop trailing words that describe a variant or a direction rather than the road number.
  while (parts.length > 1 && ROUTE_SUFFIX_NOISE.has(parts[parts.length - 1])) parts.pop();
  const text = parts.join(' ');

  // `IH` is how Texas writes it, `IR` is how Ohio writes it, `IS` turns up in older federal files.
  const interstate = text.match(/^(?:I|IH|IR|IS|INTERSTATE(?: HIGHWAY)?)\s*(\d{1,3})[A-Z]?$/);
  if (interstate) return `I-${Number(interstate[1])}`;

  const us = text.match(/^(?:US|U S|USH|USHWY|US HWY|US HIGHWAY|U S HIGHWAY|US ROUTE|US RTE|US RT)\s*(\d{1,3})[A-Z]?$/);
  if (us) return `US-${Number(us[1])}`;

  const stateRoute = text.match(
    /^(?:SR|S R|SH|ST HWY|STATE|STATE ROUTE|STATE ROAD|STATE HWY|STATE HIGHWAY|HWY|HIGHWAY|ROUTE|RTE|RT)\s*(\d{1,4})[A-Z]?$/,
  );
  if (stateRoute) return `SR-${Number(stateRoute[1])}`;

  // "TX 6", "IA 141" — a state's own numbered route, written with the state's letters in front.
  const statePrefixed = text.match(/^([A-Z]{2})\s*(\d{1,4})[A-Z]?$/);
  if (statePrefixed && STATE_CODES.has(statePrefixed[1])) return `SR-${Number(statePrefixed[2])}`;

  return null;
}

// ---------------------------------------------------------------------------
// Direction of travel
// ---------------------------------------------------------------------------

const DIRECTION_EXACT = new Map(Object.entries({
  N: 'N', NB: 'N', 'N B': 'N', NORTH: 'N', NORTHBOUND: 'N', 'NORTH BOUND': 'N',
  S: 'S', SB: 'S', 'S B': 'S', SOUTH: 'S', SOUTHBOUND: 'S', 'SOUTH BOUND': 'S',
  E: 'E', EB: 'E', 'E B': 'E', EAST: 'E', EASTBOUND: 'E', 'EAST BOUND': 'E',
  W: 'W', WB: 'W', 'W B': 'W', WEST: 'W', WESTBOUND: 'W', 'WEST BOUND': 'W',
  BOTH: 'both', 'BOTH DIRECTIONS': 'both', 'N S': 'both', 'S N': 'both', 'E W': 'both',
  'W E': 'both', BIDIRECTIONAL: 'both', 'BI DIRECTIONAL': 'both', 'TWO WAY': 'both',
  'BOTH WAYS': 'both',
}));

/**
 * Read a direction of travel. Returns `N`, `S`, `E`, `W`, `both`, or null.
 *
 * Null is returned whenever the value is not clearly one of those — a compass bearing in degrees,
 * a numeric lane code, a blank. The app treats direction only as a hint and checks the phone's real
 * heading, so a null here costs a driver nothing while a wrong guess sends them the wrong way.
 */
export function normalizeDirection(value) {
  const raw = toText(value);
  if (!raw) return null;
  const cleaned = raw
    .replace(/[./_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!cleaned) return null;

  const exact = DIRECTION_EXACT.get(cleaned);
  if (exact) return exact;

  // Fall back to looking inside a longer string, but only for forms that can mean nothing else:
  // "I-95 NB", "Rest Area Northbound". A word such as "North" on its own inside a place name is
  // ignored, because "North Platte Rest Area" is a name, not a direction.
  const found = new Set();
  for (const m of cleaned.matchAll(/\b(NORTH|SOUTH|EAST|WEST)\s?BOUND\b/g)) found.add(m[1][0]);
  for (const m of cleaned.matchAll(/\b(NB|SB|EB|WB)\b/g)) found.add(m[1][0]);
  if (found.size === 1) return [...found][0];
  if (found.size === 2 && found.has('N') && found.has('S')) return 'both';
  if (found.size === 2 && found.has('E') && found.has('W')) return 'both';
  return null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  rest_area: 'Rest area',
  services: 'Service area',
  truck_stop: 'Truck stop',
  toilets: 'Restroom',
  fuel: 'Fuel stop',
  welcome_center: 'Welcome center',
  weigh_station: 'Weigh station',
  other: 'Stop',
};

/**
 * Build a name for a place whose source did not give one, in the schema's form:
 * `Rest area — I-95 N, MP 12.4`. Parts that are unknown are left out rather than filled with
 * placeholder text.
 */
export function generateName(place) {
  const label = KIND_LABEL[place.kind] || KIND_LABEL.other;
  const bits = [];
  if (place.route) {
    bits.push(place.direction && place.direction !== 'both' ? `${place.route} ${place.direction}` : place.route);
  }
  if (place.milepost !== null && place.milepost !== undefined) bits.push(`MP ${Number(place.milepost)}`);
  if (!bits.length && place.state) bits.push(place.state);
  return bits.length ? `${label} — ${bits.join(', ')}` : label;
}

/** True when this name is one this pipeline made up rather than one a source published. */
export function isGeneratedName(place) {
  return place.name === generateName(place);
}

// ---------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------

function osmKind(tags) {
  if (tags.highway === 'rest_area') {
    // OpenStreetMap marks a welcome centre as a rest area carrying tourist information.
    if (tags.tourism === 'information' || tags.information === 'visitor_centre') return 'welcome_center';
    return 'rest_area';
  }
  if (tags.highway === 'services') return 'services';
  if (tags.amenity === 'truck_stop') return 'truck_stop';
  if (tags.amenity === 'weighbridge' || tags.highway === 'weigh_station') return 'weigh_station';
  if (tags.tourism === 'information' && tags.information === 'visitor_centre') return 'welcome_center';
  if (tags.amenity === 'toilets') return 'toilets';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'parking' && (tags.hgv === 'yes' || tags.hgv === 'designated' || tags.truck === 'yes')) {
    return 'rest_area';
  }
  return 'other';
}

function osmFlags(tags, kind) {
  const base = emptyBase();

  // Restroom. The node being a toilets node is itself the answer.
  if (kind === 'toilets') base.restroom = true;
  else base.restroom = threeState(tags.toilets ?? tags['toilets:access'] ?? null);
  if (base.restroom === null && tags['toilets:disposal']) base.restroom = true;

  // OpenStreetMap has no widely used tag for a family restroom, so this is almost always null.
  base.family_restroom = threeState(tags['toilets:family'] ?? tags.family_toilets ?? null);
  if (base.family_restroom === null && tags.changing_table === 'yes') base.family_restroom = true;

  // `wheelchair=limited` means partly usable. Reporting that as accessible would be the harmful
  // direction to be wrong in, so it is recorded as false rather than true.
  const wheelchair = toText(tags.wheelchair ?? tags['toilets:wheelchair']);
  if (wheelchair) {
    const w = wheelchair.toLowerCase();
    if (w === 'yes' || w === 'designated') base.ada = true;
    else if (w === 'no' || w === 'limited') base.ada = false;
  }

  base.showers = threeState(tags.shower ?? tags.showers ?? null);

  if (['fast_food', 'restaurant', 'cafe'].includes(tags.amenity)) base.food = true;
  else base.food = threeState(tags.food ?? null);
  if (base.food === null && (tags.vending === 'food' || tags['vending_machine'] === 'food')) base.food = true;

  if (kind === 'fuel' || tags.amenity === 'fuel') base.fuel = true;
  else base.fuel = threeState(tags.fuel ?? tags['fuel:diesel'] ?? null);

  base.truck_parking_spots = toCount(tags['capacity:hgv'] ?? tags['capacity:truck'] ?? tags['parking:hgv'] ?? null);
  base.hours = toText(tags.opening_hours);

  if (tags.unattended === 'yes') base.staffed = false;
  else if (tags.attended === 'yes' || tags.staffed === 'yes') base.staffed = true;
  else base.staffed = threeState(tags.staffed ?? null);

  return base;
}

/**
 * Turn one Overpass element into a Place.
 *
 * `element` is exactly what Overpass returns inside `elements`: a node with `lat`/`lon`, or a way
 * or relation with a `center`. `meta.fetched_at` is when the file it came from was downloaded.
 */
export function normalizeOsm(element, meta = {}) {
  if (!element || !element.type || element.id === undefined || element.id === null) return null;
  const tags = element.tags || {};
  const nativeId = `${element.type}/${element.id}`;
  const kind = osmKind(tags);

  const lat = roundCoord(element.lat ?? element.center?.lat ?? null);
  const lon = roundCoord(element.lon ?? element.center?.lon ?? null);

  const route = normalizeRoute(tags.ref ?? tags['ref:road'] ?? tags.official_ref ?? null);
  const direction = normalizeDirection(tags.direction ?? null) ?? normalizeDirection(tags.name ?? null);
  const milepost = toNumber(tags.milepost ?? tags.mile_marker ?? tags['ref:milepost'] ?? tags.distance ?? null);
  const state = normalizeState(tags['is_in:state_code'] ?? tags['addr:state'] ?? tags['is_in:state'] ?? null);

  const place = {
    id: `osm:${nativeId}`,
    name: toText(tags.name ?? tags['name:en'] ?? tags.official_name ?? null),
    kind,
    lat,
    lon,
    route,
    direction,
    milepost,
    state,
    base: osmFlags(tags, kind),
    sources: [{ source: 'osm', native_id: nativeId, fetched_at: meta.fetched_at ?? null }],
  };
  if (!place.name) place.name = generateName(place);
  return place;
}

// ---------------------------------------------------------------------------
// ArcGIS feature layers
// ---------------------------------------------------------------------------

/**
 * Read a field out of an ArcGIS attributes object.
 *
 * `spec` is a field name, a list of field names to try in order, or null for "this source does not
 * publish it". The lookup falls back to ignoring upper and lower case, because field names in a
 * hand-written map are easy to get slightly wrong and a near miss should still work.
 */
export function readField(attributes, spec) {
  if (!attributes || spec === null || spec === undefined) return null;
  const names = Array.isArray(spec) ? spec : [spec];
  const lowerIndex = new Map(Object.keys(attributes).map((k) => [k.toLowerCase(), k]));
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      const v = attributes[name];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    const alt = lowerIndex.get(name.toLowerCase());
    if (alt !== undefined) {
      const v = attributes[alt];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return null;
}

function arcgisKind(attributes, source) {
  const fieldMap = source.fieldMap || {};
  const raw = toText(readField(attributes, fieldMap.kind));
  if (raw) {
    const map = source.kindMap || {};
    const lower = raw.toLowerCase();
    for (const [from, to] of Object.entries(map)) {
      if (from.toLowerCase() === lower && KINDS.includes(to)) return to;
    }
    if (KINDS.includes(lower)) return lower;
  }
  if (source.defaultKind && KINDS.includes(source.defaultKind)) return source.defaultKind;
  return 'other';
}

/**
 * Turn one ArcGIS feature into a Place, using that source's field map.
 *
 * `feature` is exactly what an ArcGIS query returns: `{ attributes: {...}, geometry: { x, y } }`
 * with x as longitude and y as latitude, because the fetcher always asks for outSR=4326.
 */
export function normalizeArcgis(feature, source, meta = {}) {
  if (!feature || !source || !source.id) return null;
  const attributes = feature.attributes || {};
  const fieldMap = source.fieldMap || {};

  const nativeIdRaw = readField(attributes, fieldMap.native_id)
    ?? readField(attributes, ['OBJECTID', 'ObjectId', 'FID', 'OID']);
  if (nativeIdRaw === null || nativeIdRaw === undefined) return null;
  const nativeId = String(nativeIdRaw);

  const geometry = feature.geometry || {};
  const lat = roundCoord(geometry.y ?? geometry.lat ?? null);
  const lon = roundCoord(geometry.x ?? geometry.lon ?? geometry.long ?? null);

  const kind = arcgisKind(attributes, source);
  const nameField = toText(readField(attributes, fieldMap.name));
  const route = normalizeRoute(readField(attributes, fieldMap.route));
  const direction = normalizeDirection(readField(attributes, fieldMap.direction))
    ?? normalizeDirection(readField(attributes, fieldMap.route))
    ?? normalizeDirection(nameField);
  const milepost = toNumber(readField(attributes, fieldMap.milepost));
  const state = normalizeState(readField(attributes, fieldMap.state)) ?? normalizeState(source.state);

  const flags = fieldMap.base || {};
  const base = emptyBase();
  for (const field of FLAG_FIELDS) base[field] = threeState(readField(attributes, flags[field]));
  base.truck_parking_spots = toCount(readField(attributes, flags.truck_parking_spots));
  base.hours = toText(readField(attributes, flags.hours));

  // A source whose whole layer is restrooms is answering the restroom question by existing.
  if (base.restroom === null && (kind === 'toilets' || source.impliesRestroom === true)) base.restroom = true;
  if (base.fuel === null && kind === 'fuel') base.fuel = true;

  const place = {
    id: `${source.id}:${nativeId}`,
    name: nameField,
    kind,
    lat,
    lon,
    route,
    direction,
    milepost,
    state,
    base,
    sources: [{ source: source.id, native_id: nativeId, fetched_at: meta.fetched_at ?? null }],
  };
  if (!place.name) place.name = generateName(place);
  return place;
}

// ---------------------------------------------------------------------------
// Checking a record against the schema
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Check one Place against docs/SCHEMA.md. Returns a list of problems; empty means it is fine. */
export function validatePlace(place, index = 0) {
  const at = `place[${index}]`;
  const problems = [];
  if (!place || typeof place !== 'object') return [`${at} is not an object`];

  const expectedKeys = ['id', 'name', 'kind', 'lat', 'lon', 'route', 'direction', 'milepost', 'state', 'base', 'sources'];
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(place, key)) problems.push(`${at} is missing ${key}`);
  }
  for (const key of Object.keys(place)) {
    if (!expectedKeys.includes(key)) problems.push(`${at} has an unexpected field ${key}`);
  }

  if (typeof place.id !== 'string' || !place.id.includes(':')) problems.push(`${at}.id must be "<source>:<native id>"`);
  if (typeof place.name !== 'string' || !place.name.trim()) problems.push(`${at}.name must be a non-empty string`);
  if (!KINDS.includes(place.kind)) problems.push(`${at}.kind ${JSON.stringify(place.kind)} is not one of the eight kinds`);

  for (const key of ['lat', 'lon']) {
    const v = place[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at}.${key} must be a number`);
    else if (Math.round(v * 1e6) !== v * 1e6) problems.push(`${at}.${key} must be rounded to 6 decimal places`);
  }
  if (typeof place.lat === 'number' && (place.lat < -90 || place.lat > 90)) problems.push(`${at}.lat is out of range`);
  if (typeof place.lon === 'number' && (place.lon < -180 || place.lon > 180)) problems.push(`${at}.lon is out of range`);

  if (place.route !== null && typeof place.route !== 'string') problems.push(`${at}.route must be a string or null`);
  if (place.route && !/^(I|US|SR)-\d+$/.test(place.route)) problems.push(`${at}.route ${place.route} is not normalized`);
  if (place.direction !== null && !['N', 'S', 'E', 'W', 'both'].includes(place.direction)) {
    problems.push(`${at}.direction ${JSON.stringify(place.direction)} is not allowed`);
  }
  if (place.milepost !== null && typeof place.milepost !== 'number') problems.push(`${at}.milepost must be a number or null`);
  if (place.state !== null && !(typeof place.state === 'string' && /^[A-Z]{2}$/.test(place.state))) {
    problems.push(`${at}.state must be a two-letter code or null`);
  }

  const base = place.base;
  if (!base || typeof base !== 'object') {
    problems.push(`${at}.base must be an object`);
  } else {
    const baseKeys = Object.keys(emptyBase());
    for (const key of baseKeys) {
      if (!Object.prototype.hasOwnProperty.call(base, key)) problems.push(`${at}.base is missing ${key}`);
    }
    for (const key of Object.keys(base)) {
      if (!baseKeys.includes(key)) problems.push(`${at}.base has an unexpected field ${key}`);
    }
    for (const key of FLAG_FIELDS) {
      const v = base[key];
      if (v !== true && v !== false && v !== null) problems.push(`${at}.base.${key} must be true, false, or null`);
    }
    if (base.truck_parking_spots !== null && !Number.isInteger(base.truck_parking_spots)) {
      problems.push(`${at}.base.truck_parking_spots must be a whole number or null`);
    }
    if (base.hours !== null && typeof base.hours !== 'string') problems.push(`${at}.base.hours must be a string or null`);
  }

  if (!Array.isArray(place.sources) || place.sources.length === 0) {
    problems.push(`${at}.sources must list at least one source`);
  } else {
    place.sources.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        problems.push(`${at}.sources[${i}] is not an object`);
        return;
      }
      if (typeof entry.source !== 'string' || !entry.source) problems.push(`${at}.sources[${i}].source must be a string`);
      if (typeof entry.native_id !== 'string' || !entry.native_id) problems.push(`${at}.sources[${i}].native_id must be a string`);
      if (entry.fetched_at !== null && !(typeof entry.fetched_at === 'string' && ISO_DATE.test(entry.fetched_at))) {
        problems.push(`${at}.sources[${i}].fetched_at must be an ISO timestamp or null`);
      }
    });
  }

  return problems;
}

/** Check a whole dataset file against docs/SCHEMA.md. Returns a list of problems. */
export function validateDataset(dataset) {
  const problems = [];
  if (!dataset || typeof dataset !== 'object') return ['dataset is not an object'];
  if (dataset.format !== 'parity.dataset') problems.push('format must be "parity.dataset"');
  if (dataset.version !== 1) problems.push('version must be 1');
  if (typeof dataset.name !== 'string' || !dataset.name) problems.push('name must be a non-empty string');
  if (typeof dataset.generated_at !== 'string' || !ISO_DATE.test(dataset.generated_at)) {
    problems.push('generated_at must be an ISO timestamp');
  }
  if (typeof dataset.sample !== 'boolean') problems.push('sample must be true or false');
  if (!Array.isArray(dataset.bbox) || dataset.bbox.length !== 4 || dataset.bbox.some((n) => typeof n !== 'number')) {
    problems.push('bbox must be four numbers: west, south, east, north');
  }
  if (!Array.isArray(dataset.attribution) || dataset.attribution.some((s) => typeof s !== 'string')) {
    problems.push('attribution must be a list of strings');
  }
  if (!dataset.counts || typeof dataset.counts !== 'object' || typeof dataset.counts.places !== 'number') {
    problems.push('counts.places must be a number');
  }
  if (!Array.isArray(dataset.places)) {
    problems.push('places must be a list');
    return problems;
  }
  if (dataset.counts && dataset.counts.places !== dataset.places.length) {
    problems.push('counts.places does not match how many places are in the file');
  }
  if (dataset.sample === true && (typeof dataset.warning !== 'string' || !dataset.warning.trim())) {
    problems.push('a sample dataset must carry a warning string saying the coordinates are invented');
  }

  const seen = new Set();
  dataset.places.forEach((place, i) => {
    problems.push(...validatePlace(place, i));
    if (place && typeof place.id === 'string') {
      if (seen.has(place.id)) problems.push(`place[${i}].id ${place.id} appears more than once`);
      seen.add(place.id);
    }
  });

  for (let i = 1; i < dataset.places.length; i += 1) {
    if (String(dataset.places[i - 1]?.id) > String(dataset.places[i]?.id)) {
      problems.push('places are not sorted by id');
      break;
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;

/** Straight-line distance between two points on the earth, in metres. */
export function distanceMetres(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
