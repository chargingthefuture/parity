/* Parity — where you are and which way you are pointing.
 *
 * The position never leaves the phone. It is not sent anywhere, not written to
 * a log, and not kept once the app is closed — it lives in a variable in memory
 * and that is all. The only thing that gets stored is what the driver chooses
 * to store: a note attached to a place she picked.
 *
 * Battery: the satellite receiver is the most expensive thing this app can
 * touch, and it runs on a phone clamped to a windscreen in the sun, so it is
 * only on when a screen is actually using it. It stops when the app goes to the
 * background, stops when the screen is closed, and can be dialled down to a
 * coarse fix from the settings screen.
 */

const listeners = new Set();

let watchId = null;
let wanted = false;          // does a visible screen need position right now
let last = null;             // most recent fix
let history = [];            // recent fixes, used to work out a heading
let manualHeading = null;    // set by hand when the receiver will not give one

export function subscribe(fn) {
  listeners.add(fn);
  if (last) fn(state());
  return () => listeners.delete(fn);
}

function emit() {
  const s = state();
  for (const fn of listeners) fn(s);
}

export function state() {
  return {
    fix: last,
    heading: heading(),
    headingIsManual: manualHeading != null && (last?.heading == null),
    speedMps: last?.speed ?? null,
    accuracyM: last?.accuracy ?? null,
    ageMs: last ? Date.now() - last.at : null,
    running: watchId != null
  };
}

/**
 * The direction of travel.
 *
 * The receiver reports one while moving, but on some phones it is missing or
 * unreliable below about 10 mph, so the fallback works it out from where the
 * truck has actually been over the last few fixes. Manual is the last resort:
 * the driver taps the compass direction herself and the filter uses that.
 */
export function heading() {
  if (last && last.heading != null && (last.speed == null || last.speed > 2)) return last.heading;
  const derived = derivedHeading();
  if (derived != null) return derived;
  return manualHeading;
}

function derivedHeading() {
  if (history.length < 2) return null;
  const to = history[history.length - 1];
  /* Look back far enough to have really moved. Two fixes taken metres apart
   * produce a heading dominated by position error, which would swing the
   * "ahead of you" filter around at random. */
  for (let i = history.length - 2; i >= 0; i--) {
    const from = history[i];
    const d = roughMetres(from, to);
    if (d >= 120) return bearingBetween(from, to);
  }
  return null;
}

function roughMetres(a, b) {
  const dLat = (b.lat - a.lat) * 111320;
  const dLon = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

function bearingBetween(a, b) {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function setManualHeading(deg) {
  manualHeading = deg;
  emit();
}

export function clearManualHeading() {
  manualHeading = null;
  emit();
}

export function manual() {
  return manualHeading;
}

/** Called by a screen that needs position. Safe to call repeatedly. */
export function start(highAccuracy = true) {
  wanted = true;
  if (watchId != null || document.hidden) return;
  if (!navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: highAccuracy,
    maximumAge: 5000,
    timeout: 30000
  });
  emit();
}

/** Called when leaving a screen that needs position. Turns the receiver off. */
export function stop() {
  wanted = false;
  hardStop();
}

function hardStop() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    emit();
  }
}

function onFix(pos) {
  const c = pos.coords;
  last = {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: c.accuracy,
    heading: Number.isFinite(c.heading) ? c.heading : null,
    speed: Number.isFinite(c.speed) ? c.speed : null,
    at: pos.timestamp || Date.now()
  };
  const prev = history[history.length - 1];

  /* Throw the trail away when the receiver has jumped rather than the truck
   * having moved. Two signs of it: a fix that implies a speed no truck can do,
   * and a fix arriving after a long silence — coming out of a tunnel, a dead
   * zone, or the app having been shut for an hour. Keeping the old trail across
   * a jump like that produces a heading pointing back the way she came, which
   * would put every stop she can actually reach on the "behind you" side and
   * hide the lot. Better to have no heading for a few seconds than a wrong one. */
  if (prev) {
    const gapMs = last.at - prev.at;
    const jumpM = roughMetres(prev, last);
    const impliedMps = gapMs > 0 ? jumpM / (gapMs / 1000) : Infinity;
    if (gapMs > 180000 || impliedMps > 67) history = [];   // 67 m/s is about 150 mph
  }

  const tail = history[history.length - 1];
  if (!tail || roughMetres(tail, last) > 25) {
    history.push({ lat: last.lat, lon: last.lon, at: last.at });
    if (history.length > 12) history.shift();
  }
  lastError = null;
  emit();
}

let lastError = null;

function onError(err) {
  lastError = err;
  emit();
}

export function error() {
  return lastError;
}

export function errorText() {
  if (!lastError) return null;
  if (lastError.code === 1) return 'Location is switched off for this app. Turn it on in your phone settings, or set your heading by hand below.';
  if (lastError.code === 2) return 'No position yet. Under a bridge or inside a building this can take a minute.';
  if (lastError.code === 3) return 'The position is taking a while. Still trying.';
  return 'No position available.';
}

/* Stop the receiver the moment the app is not on screen, and pick it back up
 * where it left off. This is most of the battery saving. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hardStop();
  else if (wanted) start();
});
