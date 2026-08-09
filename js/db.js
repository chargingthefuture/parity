/* Parity — on-device storage.
 *
 * PRIVACY, stated plainly and enforced by the code below: there is no network
 * code anywhere in this app. Nothing here calls fetch() against a remote host,
 * there is no account, no analytics, no crash reporter, no advertising or
 * measurement library. Every position fix, every note, and every timestamp
 * stays in this browser's own storage on this phone until the person holding
 * it exports a file and hands it over deliberately.
 *
 * Two storage systems, for two different jobs:
 *   IndexedDB    the dataset and the observations. Thousands of rows, and it
 *                survives being large. Everything asynchronous.
 *   localStorage settings and a small amount of state that has to be readable
 *                the instant the app opens, before anything is rendered.
 */

const DB_NAME = 'parity';
const DB_VERSION = 1;

export const STORE_PLACES = 'places';
export const STORE_OBSERVATIONS = 'observations';
export const STORE_STUBS = 'place_stubs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PLACES)) {
        db.createObjectStore(STORE_PLACES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_OBSERVATIONS)) {
        const s = db.createObjectStore(STORE_OBSERVATIONS, { keyPath: 'obs_id' });
        s.createIndex('place_id', 'place_id', { unique: false });
        s.createIndex('observed_at', 'observed_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STUBS)) {
        db.createObjectStore(STORE_STUBS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDb().then(db => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(store) {
  return wrap((await tx(store, 'readonly')).getAll());
}

export async function get(store, key) {
  return wrap((await tx(store, 'readonly')).get(key));
}

export async function put(store, value) {
  return wrap((await tx(store, 'readwrite')).put(value));
}

export async function remove(store, key) {
  return wrap((await tx(store, 'readwrite')).delete(key));
}

export async function clear(store) {
  return wrap((await tx(store, 'readwrite')).clear());
}

export async function count(store) {
  return wrap((await tx(store, 'readonly')).count());
}

/** Write many rows in one transaction. A dataset load is 5000 rows; one row at
 *  a time would take long enough to be visible on a phone. */
export async function putAll(store, values) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve(values.length);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function byIndex(store, indexName, key) {
  const s = await tx(store, 'readonly');
  return wrap(s.index(indexName).getAll(key));
}

/* ---- settings and small state (localStorage) ---- */

const SETTINGS_KEY = 'parity:settings';
const META_KEY = 'parity:meta';

export const DEFAULT_SETTINGS = {
  intervalMinutes: 150,        // 2.5 hours, the spec's default
  windowMinutes: 30,           // how far either side of the target counts as "planned"
  coneDeg: 60,                 // how far off straight ahead still counts as ahead
  sideToleranceM: 60,          // the divided-highway caution band
  assumedSpeedMph: 58,         // used to turn time into distance before there is a speed reading
  minComfort: 3,               // what counts as "rated well" for the main list
  hideOppositeSide: true,      // drop stops on the far carriageway
  highAccuracy: true,          // precise position while the stop screen is open
  units: 'imperial'
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

export function getSettings() {
  return readJson(SETTINGS_KEY, DEFAULT_SETTINGS);
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function getMeta() {
  return readJson(META_KEY, {
    datasetName: null,
    datasetGeneratedAt: null,
    datasetSample: null,
    datasetCount: 0,
    device: null,
    lastStopAt: null,
    lastExportAt: null
  });
}

export function saveMeta(patch) {
  const next = { ...getMeta(), ...patch };
  localStorage.setItem(META_KEY, JSON.stringify(next));
  return next;
}

/**
 * A random id for this device, made up on first run.
 *
 * It is not a name, not an account, and not derived from anything about the
 * phone or the person — it is four random bytes. Its only job is that after
 * two drivers pool their notes, six notes from one person can be told apart
 * from six people agreeing. It can be thrown away and replaced at any time
 * from the data screen, and nothing breaks when it is.
 */
export function deviceId() {
  const meta = getMeta();
  if (meta.device) return meta.device;
  const id = 'dev-' + randomHex(3);
  saveMeta({ device: id });
  return id;
}

export function newDeviceId() {
  const id = 'dev-' + randomHex(3);
  saveMeta({ device: id });
  return id;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

/** A random id for one observation. Random, not sequential — a sequence would
 *  leak how many stops someone has made and in what order. */
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return randomHex(16);
}

/** How much room this phone has left, when the browser will say. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
