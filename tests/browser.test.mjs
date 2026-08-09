/* Drives the real app in a real browser.
 *
 * The unit tests check the arithmetic. This checks the thing a driver actually
 * touches: does it open, does it show stops ahead and not behind, can a note be
 * written and read back, does it survive the network being switched off, and
 * does a shared file merge without eating anything.
 *
 * Needs a browser. Run with:
 *   NODE_PATH=/opt/node22/lib/node_modules node --test tests/browser.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

/* A made-up stretch of I-80 running due east. The truck starts at HERE and
 * drives east, so the stops laid out to the east must show up and the one to
 * the west must not. */
const HERE = { lat: 40.9250, lon: -98.3420 };

function offset(northM, eastM) {
  return {
    lat: +(HERE.lat + northM / 111320).toFixed(6),
    lon: +(HERE.lon + eastM / (111320 * Math.cos(HERE.lat * Math.PI / 180))).toFixed(6)
  };
}

const MI = 1609.344;

const DATASET = {
  format: 'parity.dataset',
  version: 1,
  name: 'browser-test',
  generated_at: '2026-08-01T00:00:00Z',
  sample: true,
  warning: 'Invented coordinates for testing. Not real places.',
  attribution: ['test fixture'],
  counts: { places: 5 },
  places: [
    place('osm:node/1', 'Platte River Rest Area', offset(-80, 130 * MI), 'E'),
    place('osm:node/2', 'Cornhusker Travel Plaza', offset(-90, 150 * MI), 'E', 'truck_stop'),
    place('osm:node/3', 'Elm Creek Rest Area', offset(-70, 12 * MI), 'E'),
    place('osm:node/4', 'Westbound Rest Area', offset(-60, -40 * MI), 'W'),
    place('osm:node/5', 'Across The Median Rest Area', offset(400, 140 * MI), 'W')
  ]
};

function place(id, name, at, direction, kind = 'rest_area') {
  return {
    id, name, kind, lat: at.lat, lon: at.lon,
    route: 'I-80', direction, milepost: null, state: 'NE',
    base: {
      restroom: true, family_restroom: null, ada: null, showers: null,
      food: null, fuel: null, truck_parking_spots: 40, hours: '24/7', staffed: null
    },
    sources: [{ source: 'test', native_id: id, fetched_at: '2026-08-01T00:00:00Z' }]
  };
}

const TMP = join(tmpdir(), 'parity-browser-test');
let server, browser, context, page;

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'dataset.json'), JSON.stringify(DATASET));

  server = spawn('npx', ['--yes', 'http-server', ROOT, '-p', String(PORT), '-c-1', '--silent'],
    { stdio: 'ignore', env: { ...process.env, PATH: process.env.PATH + ':/opt/node22/lib/node_modules/.bin' } });

  // Wait for the server to answer rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/index.html');
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }

  browser = await chromium.launch();
  context = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: HERE.lat, longitude: HERE.lon },
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  page = await context.newPage();
  page.on('pageerror', e => { throw new Error('page error: ' + e.message); });
});

after(async () => {
  await context?.close();
  await browser?.close();
  server?.kill();
  rmSync(TMP, { recursive: true, force: true });
});

async function loadDataset() {
  await page.goto(BASE + '/#/data', { waitUntil: 'load' });
  await page.waitForSelector('.card');
  await page.setInputFiles('[data-file="dataset"]', join(TMP, 'dataset.json'));
  await page.waitForSelector('.toast');
}

/**
 * Drive the truck east past a run of fixes, the way a real receiver feeds the
 * app: a steady trickle of positions rather than one jump. The app works its
 * heading out from where the truck has actually been, and it deliberately
 * redraws at most every few seconds to keep the processor idle, so the drive
 * has to run long enough for a redraw to fall due.
 */
const STEP_M = 20;          // 20 m every 700 ms is about 64 mph
const STEP_MS = 700;

async function driveEast() {
  await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lon });
  await page.goto(BASE + '/#/', { waitUntil: 'load' });
  await page.waitForSelector('.due .num');

  for (let i = 1; i <= 30; i++) {
    const at = offset(0, i * STEP_M);
    await context.setGeolocation({ latitude: at.lat, longitude: at.lon });
    await page.waitForTimeout(STEP_MS);
    const heading = await page.textContent('.bar .where b').catch(() => '');
    if (heading && !/no heading/.test(heading)) return;
  }
  throw new Error('the app never worked out a heading from the drive');
}

test('the app opens straight into the stop screen with the bundled data already there', async () => {
  // No sign-in, no "connect to continue", no empty first run. The dataset that
  // ships with the app is loaded before the first screen is drawn.
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.due .num');
  const text = await page.textContent('#view');
  assert.match(text, /Next stop in/i);
  assert.doesNotMatch(text, /No stops loaded/i, 'the bundled dataset should already be in');
  assert.doesNotMatch(text, /sign in|log in|account|connect/i, 'there is no login wall anywhere');

  const loaded = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    return db.getMeta().datasetCount;
  });
  assert.ok(loaded > 0, `the bundled dataset should have loaded, got ${loaded} stops`);
});

test('a dataset file loads and is counted', async () => {
  await loadDataset();
  const toast = await page.textContent('.toast');
  assert.match(toast, /5 stops loaded/);
  await page.goto(BASE + '/#/data', { waitUntil: 'load' });
  await page.waitForSelector('.kv');
  const text = await page.textContent('#view');
  assert.match(text, /Stops in the dataset/);
  assert.match(text, /browser-test/);
});

test('demonstration data carries a standing warning', async () => {
  await page.goto(BASE + '/#/', { waitUntil: 'load' });
  await page.waitForSelector('.due .num');
  const text = await page.textContent('#view');
  assert.match(text, /Demonstration data/i);
  assert.match(text, /not real places/i);
});

test('driving east shows what is ahead and hides what is behind', async () => {
  await driveEast();
  const heading = await page.textContent('.bar .where b');
  assert.match(heading, /^E ·/, `expected an easterly heading, got "${heading}"`);

  const text = await page.textContent('#view');
  assert.match(text, /Platte River Rest Area/, 'a stop ahead should be listed');
  assert.doesNotMatch(text, /Westbound Rest Area/, 'a stop behind must not be listed');
});

test('the stop across the median is dropped', async () => {
  const text = await page.textContent('#view');
  assert.doesNotMatch(text, /Across The Median/, 'the far carriageway must not be offered');
});

test('nothing rated yet means the honest fallback, marked unrated', async () => {
  const text = await page.textContent('#view');
  assert.match(text, /Nothing rated well in range/i);
  assert.match(text, /Unrated/);
});

test('the stop clock restarts and the countdown follows it', async () => {
  await page.goto(BASE + '/#/', { waitUntil: 'load' });
  await page.waitForSelector('[data-act="stopped"]');
  await page.click('[data-act="stopped"]');
  await page.waitForSelector('.toast');
  const text = await page.textContent('#view');
  assert.match(text, /last stop/i);
  const due = await page.textContent('.due .num');
  assert.match(due, /2h 3[0-9]m|2h 30m/, `countdown should reset to about 2h30, got ${due}`);
});

test('a note can be written and read back', async () => {
  await page.goto(BASE + '/#/log/' + encodeURIComponent('osm:node/1'), { waitUntil: 'load' });
  await page.waitForSelector('[data-act="save-obs"]');

  await page.click('[data-set="access.door"][data-value="single_locking"]');
  await page.click('[data-set="safety.sightline"][data-value="clear"]');
  await page.click('[data-set="safety.comfort"][data-value="5"]');
  await page.click('[data-set="safety.light_lot"][data-value="4"]');
  await page.click('[data-set="safety.light_path"][data-value="2"]');
  await page.click('[data-set="practical.cleanliness"][data-value="4"]');
  await page.fill('[data-text="notes"]', 'Door faces the truck lot. North light out.');
  await page.click('[data-act="save-obs"]');

  await page.waitForSelector('.obs');
  const text = await page.textContent('#view');
  assert.match(text, /Door faces the truck lot/);
  assert.match(text, /Would stop again/);
  assert.match(text, /Single, locks/);
});

test('the worst lighting score is what gets reported, not the average', async () => {
  const text = await page.textContent('#view');
  // lot 4, path 2 -> the walk is the number that matters, so "Poor", not "Good".
  const block = text.slice(text.indexOf('Lighting, worst part'));
  assert.match(block.slice(0, 60), /Poor/, 'a dark path must not be averaged away by a bright lot');
});

test('a typed note survives tapping another button on the form', async () => {
  await page.goto(BASE + '/#/log/' + encodeURIComponent('osm:node/2'), { waitUntil: 'load' });
  await page.waitForSelector('[data-text="notes"]');
  await page.fill('[data-text="notes"]', 'half typed');
  await page.click('[data-set="safety.comfort"][data-value="3"]');
  await page.waitForTimeout(200);
  assert.equal(await page.inputValue('[data-text="notes"]'), 'half typed');
});

test('a rated stop is promoted out of the unrated fallback', async () => {
  await driveEast();
  const text = (await page.textContent('#view')).replace(/\s+/g, ' ');
  const heading = await page.textContent('.bar .where b');
  const shown = `heading=${heading} :: ${text.slice(0, 700)}`;
  assert.match(text, /Rated stops in your window/, shown);
  const planned = await page.textContent('.stop');
  assert.match(planned, /Platte River Rest Area/, shown);
});

test('notes export to a file and merge back in without eating anything', async () => {
  await page.goto(BASE + '/#/data', { waitUntil: 'load' });
  await page.waitForSelector('[data-act="export-obs"]');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-act="export-obs"]')
  ]);
  const path = join(TMP, 'exported.json');
  await download.saveAs(path);
  const file = JSON.parse(readFileSync(path, 'utf8'));

  assert.equal(file.format, 'parity.observations');
  assert.ok(file.observations.length >= 1);
  assert.ok(file.places.length >= 1, 'places must ride along so the note stays usable');
  assert.ok(file.device.startsWith('dev-'));

  // Importing your own file back must add nothing and lose nothing.
  await page.setInputFiles('[data-file="obs"]', path);
  await page.waitForSelector('.toast');
  const toast = await page.textContent('.toast');
  assert.match(toast, /0 added/);
  assert.match(toast, /already here/);
});

test("another driver's notes merge in and both sides survive", async () => {
  const theirs = {
    format: 'parity.observations',
    version: 1,
    exported_at: '2026-08-07T00:00:00Z',
    device: 'dev-999999',
    counts: { observations: 1, places: 1 },
    places: [{ id: 'osm:node/1', name: 'Platte River Rest Area', kind: 'rest_area', lat: DATASET.places[0].lat, lon: DATASET.places[0].lon, route: 'I-80', direction: 'E', state: 'NE' }],
    observations: [{
      obs_id: 'from-another-driver-0001',
      place_id: 'osm:node/1',
      observed_at: '2026-08-06T23:00:00Z',
      created_at: '2026-08-06T23:05:00Z',
      author: 'dev-999999',
      access: { door: 'multi_stall' },
      safety: { comfort: 1, light_path: 1, sightline: 'blind' },
      practical: {},
      notes: 'Lot was dark when I came through.'
    }]
  };
  const path = join(TMP, 'theirs.json');
  writeFileSync(path, JSON.stringify(theirs));

  await page.goto(BASE + '/#/data', { waitUntil: 'load' });
  await page.waitForSelector('[data-file="obs"]', { state: 'attached' });
  await page.setInputFiles('[data-file="obs"]', path);
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /1 added/);

  await page.goto(BASE + '/#/place/' + encodeURIComponent('osm:node/1'), { waitUntil: 'load' });
  await page.waitForSelector('.obs');
  const text = await page.textContent('#view');
  assert.match(text, /Lot was dark when I came through/, "the other driver's note is there");
  assert.match(text, /Door faces the truck lot/, 'and mine is still there');
  assert.match(text, /Drivers disagree here/, 'a 5 against a 1 must be surfaced, not averaged');
  assert.match(text, /2 people/);
});

test('a stop that arrived with a shared note is still openable', async () => {
  const text = await page.textContent('#view');
  assert.match(text, /Platte River Rest Area/);
});

test('it works with the network switched off', async () => {
  await context.setOffline(true);
  await page.goto(BASE + '/#/', { waitUntil: 'load' }).catch(() => {});
  await page.waitForSelector('.due .num', { timeout: 15000 });
  const text = await page.textContent('#view');
  assert.match(text, /Next stop in|Overdue by/);

  await page.goto(BASE + '/#/place/' + encodeURIComponent('osm:node/1'), { waitUntil: 'load' }).catch(() => {});
  await page.waitForSelector('.obs', { timeout: 15000 });
  assert.match(await page.textContent('#view'), /Door faces the truck lot/,
    'notes must be readable with no signal');
  await context.setOffline(false);
});

test('a receiver jump does not produce a heading pointing back the way she came', async () => {
  // Coming out of a long dead zone or a tunnel, the next fix can land miles
  // from the last one. Read as movement, that trail points backwards, which
  // would put every stop she can actually reach on the "behind you" side and
  // hide the lot. No heading for a few seconds beats a wrong one.
  await driveEast();
  const before = await page.evaluate(async () => (await import('./js/location.js')).state().heading);
  assert.ok(before != null && Math.abs(before - 90) < 20, `should be driving east first, got ${before}`);

  const back = offset(0, -8000);
  await context.setGeolocation({ latitude: back.lat, longitude: back.lon });
  await page.waitForTimeout(1000);

  const after = await page.evaluate(async () => (await import('./js/location.js')).state().heading);
  assert.equal(after, null, `after a jump the stale heading must be dropped, got ${after}`);
});

test('the app makes no request to anywhere but its own folder', async () => {
  const foreign = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin !== BASE) foreign.push(r.url());
  });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.due .num');
  await page.goto(BASE + '/#/nearby', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  assert.deepEqual(foreign, [], 'no third-party request may ever be made');
});
