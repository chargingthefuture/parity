/* Tests for the parts of the app that decide what a driver is shown.
 *
 * These are the calculations that are wrong-answer dangerous rather than
 * merely annoying: which stops are ahead, which side of the median they are on,
 * how far ahead the planning window sits, and how several drivers' notes get
 * rolled into one line without hiding a disagreement.
 *
 * Run with:  node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../js/geo.js';
import { plan, choose, bandFor, fmtDuration } from '../js/planner.js';
import * as obs from '../js/observations.js';
import * as places from '../js/places.js';

/* A stretch of I-80 running due east, near Grand Island, Nebraska. Positions
 * are made up but the geometry is real enough to test against. */
const HERE = { lat: 40.9250, lon: -98.3420 };
const EAST = 90;

function offset(from, northM, eastM) {
  return {
    lat: from.lat + northM / 111320,
    lon: from.lon + eastM / (111320 * Math.cos(from.lat * Math.PI / 180))
  };
}

test('distance and bearing agree with a known offset', () => {
  const p = offset(HERE, 0, 10000);           // 10 km due east
  assert.ok(Math.abs(geo.distance(HERE, p) - 10000) < 20);
  assert.ok(Math.abs(geo.bearing(HERE, p) - 90) < 0.5);
});

test('turn is signed: left is negative, right is positive', () => {
  assert.equal(geo.turn(0, 90), 90);
  assert.equal(geo.turn(0, 270), -90);
  assert.equal(geo.turn(350, 10), 20);
  assert.equal(geo.turn(10, 350), -20);
});

test('alongCross splits an offset into down-the-road and to-the-side', () => {
  // 5 km ahead and 100 m to the right of an eastbound truck.
  const p = offset(HERE, -100, 5000);
  const { along, cross } = geo.alongCross(HERE, EAST, p);
  assert.ok(Math.abs(along - 5000) < 30, `along was ${along}`);
  assert.ok(Math.abs(cross - 100) < 10, `cross was ${cross}`);
});

test('a stop behind you has a negative along-track distance', () => {
  const behind = offset(HERE, 0, -3000);
  assert.ok(geo.alongCross(HERE, EAST, behind).along < 0);
});

test('side of travel: right is yours, left is across the median', () => {
  const right = offset(HERE, -120, 1200);     // south of an eastbound road
  const left = offset(HERE, 120, 1200);       // north of it
  assert.equal(geo.sideOfTravel(HERE, EAST, right, 60), 'right');
  assert.equal(geo.sideOfTravel(HERE, EAST, left, 60), 'left');
});

test('side of travel says "unclear" inside the tolerance band rather than guessing', () => {
  const almostOnTheLine = offset(HERE, -20, 1200);
  assert.equal(geo.sideOfTravel(HERE, EAST, almostOnTheLine, 60), 'unclear');
});

test('a westbound truck sees the mirror image of the same two stops', () => {
  const northOfRoad = offset(HERE, 120, -1200);
  // Heading west, a stop to the north is now on your right.
  assert.equal(geo.sideOfTravel(HERE, 270, northOfRoad, 60), 'right');
});

test('far ahead, the geometry is refused rather than trusted', () => {
  // 130 miles due east, 80 m south of the road. Read flat, the bearing makes
  // this look 2.8 km to the LEFT, purely from the curve of the earth.
  const farAhead = offset(HERE, -80, 130 * geo.M_PER_MILE);
  const { cross } = geo.alongCross(HERE, EAST, farAhead);
  assert.ok(cross < -1000, `the trap this guards against: cross read as ${Math.round(cross)} m`);
  assert.equal(geo.sideOfTravel(HERE, EAST, farAhead, 60), 'unknown');
});

test('close up, the side is measured', () => {
  assert.deepEqual(geo.assessSide(HERE, EAST, offset(HERE, -120, 900)), { side: 'yours', basis: 'measured' });
  assert.deepEqual(geo.assessSide(HERE, EAST, offset(HERE, 120, 900)), { side: 'other', basis: 'measured' });
});

test('far off, the published direction is used instead', () => {
  const far = { ...offset(HERE, -80, 130 * geo.M_PER_MILE), direction: 'E' };
  assert.deepEqual(geo.assessSide(HERE, EAST, far), { side: 'yours', basis: 'signed' });

  const farOpposite = { ...offset(HERE, 400, 130 * geo.M_PER_MILE), direction: 'W' };
  assert.deepEqual(geo.assessSide(HERE, EAST, farOpposite), { side: 'other', basis: 'signed' });
});

test('with neither a measurement nor a published direction, it admits it does not know', () => {
  const far = { ...offset(HERE, -80, 130 * geo.M_PER_MILE), direction: null };
  assert.deepEqual(geo.assessSide(HERE, EAST, far), { side: 'unknown', basis: 'none' });
});

test('with no heading at all, the side is unknown rather than assumed', () => {
  assert.deepEqual(geo.assessSide(HERE, null, offset(HERE, -120, 900)), { side: 'unknown', basis: 'no-heading' });
});

test('a stop 130 miles straight ahead is not hidden as being across the median', () => {
  // The bug this guards: curvature made a stop dead ahead read as "other side",
  // so it never reached the driver at all.
  const ahead = { id: 'far', ...offset(HERE, -80, 130 * geo.M_PER_MILE), direction: 'E' };
  const [row] = geo.relativeTo(HERE, EAST, [ahead], { coneDeg: 60, maxAlong: 400000 });
  assert.ok(row, 'it must survive the ahead filter');
  assert.equal(row.side, 'yours');
  assert.equal(row.sideBasis, 'signed');
});

test('direction tags are a hint, and silence is not a contradiction', () => {
  assert.equal(geo.directionAgrees('E', 90), true);
  assert.equal(geo.directionAgrees('W', 90), false);
  assert.equal(geo.directionAgrees(null, 90), null);
  assert.equal(geo.directionAgrees('both', 90), null);
  // A road running northeast still gets tagged N; that must not read as wrong.
  assert.equal(geo.directionAgrees('N', 45), true);
});

test('relativeTo keeps what is ahead and drops what is behind or off to the side', () => {
  const ahead = { id: 'a', lat: offset(HERE, -50, 20000).lat, lon: offset(HERE, -50, 20000).lon };
  const behind = { id: 'b', lat: offset(HERE, -50, -20000).lat, lon: offset(HERE, -50, -20000).lon };
  const sideways = { id: 'c', lat: offset(HERE, 20000, 200).lat, lon: offset(HERE, 20000, 200).lon };

  const out = geo.relativeTo(HERE, EAST, [ahead, behind, sideways], { coneDeg: 60, maxAlong: 100000 });
  assert.deepEqual(out.map(r => r.place.id), ['a']);
});

test('with no heading, nothing is filtered by direction and the caller is told so', () => {
  const a = { id: 'a', ...offset(HERE, 0, 20000) };
  const b = { id: 'b', ...offset(HERE, 0, -20000) };
  const out = geo.relativeTo(HERE, null, [a, b], { maxAlong: 100000 });
  assert.equal(out.length, 2);
  assert.ok(out.every(r => r.ahead === null));
});

test('the grid index finds the same places a full scan would', () => {
  const list = [];
  for (let i = 0; i < 400; i++) {
    list.push({ id: 'p' + i, ...offset(HERE, (i % 20 - 10) * 3000, (Math.floor(i / 20) - 10) * 3000) });
  }
  const index = geo.buildIndex(list);
  const radius = 25000;
  const fast = new Set(geo.near(index, HERE, radius).map(p => p.id));
  const slow = new Set(list.filter(p => geo.distance(HERE, p) <= radius).map(p => p.id));
  assert.deepEqual([...fast].sort(), [...slow].sort());
  assert.ok(fast.size > 10, 'the test data should actually hit something');
});

/* ---- the planning window ---- */

const SETTINGS = {
  intervalMinutes: 150, windowMinutes: 30, assumedSpeedMph: 60,
  minComfort: 3, coneDeg: 60, sideToleranceM: 60
};

test('with no stop logged, the window opens a full interval ahead', () => {
  const p = plan(null, null, SETTINGS, Date.parse('2026-08-08T12:00:00Z'));
  assert.equal(Math.round(p.dueInMin), 150);
  assert.equal(p.status, 'ok');
  // 120 to 180 minutes at 60 mph is 120 to 180 miles.
  assert.ok(Math.abs(p.windowFromM / geo.M_PER_MILE - 120) < 1);
  assert.ok(Math.abs(p.windowToM / geo.M_PER_MILE - 180) < 1);
});

test('the window walks in as the drive goes on', () => {
  const now = Date.parse('2026-08-08T14:00:00Z');
  const twoHoursAgo = new Date(now - 120 * 60000).toISOString();
  const p = plan(twoHoursAgo, null, SETTINGS, now);
  assert.equal(Math.round(p.dueInMin), 30);
  assert.equal(p.status, 'due');
  assert.equal(Math.round(p.windowFromM / geo.M_PER_MILE), 0);
  assert.equal(Math.round(p.windowToM / geo.M_PER_MILE), 60);
});

test('running late is reported as overdue, not as a negative countdown', () => {
  const now = Date.parse('2026-08-08T16:00:00Z');
  const p = plan(new Date(now - 200 * 60000).toISOString(), null, SETTINGS, now);
  assert.equal(p.status, 'overdue');
  assert.ok(p.dueInMin < 0);
  assert.equal(fmtDuration(p.dueInMin), '50m over');
});

test('a parked truck does not collapse the window to nothing', () => {
  const p = plan(null, 0.2, SETTINGS, Date.now());   // 0.2 m/s, effectively still
  assert.equal(p.speedIsMeasured, false);
  assert.equal(p.speedMph, SETTINGS.assumedSpeedMph);
  assert.ok(p.windowToM > 0);
});

test('a real speed reading is used once the truck is moving', () => {
  const p = plan(null, 31.3, SETTINGS, Date.now());  // about 70 mph
  assert.equal(p.speedIsMeasured, true);
  assert.ok(Math.abs(p.speedMph - 70) < 1);
});

test('the arrival time band is the one you will actually get there in', () => {
  const at9pm = new Date('2026-08-08T21:30:00');
  assert.equal(bandFor(at9pm), 'night');
  assert.equal(bandFor(new Date('2026-08-08T08:00:00')), 'morning');
});

/* ---- choosing what to show ---- */

function candidate(id, alongMiles, comfort) {
  return { place: { id, name: id, lat: 0, lon: 0 }, along: alongMiles * geo.M_PER_MILE, distance: alongMiles * geo.M_PER_MILE, side: 'right', ahead: true };
}

function summaryWith(comfort) {
  return obs.summarize([{
    obs_id: 'o', place_id: 'p', observed_at: new Date().toISOString(),
    safety: { comfort }, practical: {}, access: {}
  }]);
}

test('a well-rated stop inside the window is the headline answer', () => {
  const planned = plan(null, null, SETTINGS, Date.now());
  const cands = [candidate('good', 150, 5), candidate('meh', 150, 2)];
  const sums = new Map([['good', summaryWith(5)], ['meh', summaryWith(2)]]);
  const out = choose(cands, sums, SETTINGS, planned);
  assert.deepEqual(out.planned.map(c => c.place.id), ['good']);
  assert.deepEqual(out.window.map(c => c.place.id), ['meh']);
  assert.equal(out.usedFallback, false);
});

test('when nothing is rated well, the nearest stops ahead are still offered', () => {
  const planned = plan(null, null, SETTINGS, Date.now());
  const cands = [candidate('unrated-close', 12), candidate('unrated-far', 150)];
  const out = choose(cands, new Map(), SETTINGS, planned);
  assert.equal(out.planned.length, 0);
  assert.equal(out.usedFallback, true);
  assert.equal(out.nearest[0].place.id, 'unrated-close');
  assert.ok(out.nearest.every(c => c.summary === null), 'fallback stops must stay marked unrated');
});

/* ---- rolling up observations ---- */

function note(daysAgo, patch = {}) {
  const when = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return {
    obs_id: 'o' + Math.random(), place_id: 'p', observed_at: when, created_at: when,
    author: patch.author || 'dev-aaa',
    access: patch.access || {},
    safety: patch.safety || {},
    practical: patch.practical || {},
    notes: patch.notes || ''
  };
}

test('a place nobody logged stays unrated instead of getting a middling score', () => {
  assert.equal(obs.summarize([]), null);
  assert.equal(obs.summarize(null), null);
});

test('lighting reports the worst of the three, not the average', () => {
  const s = obs.summarize([note(1, { safety: { light_lot: 5, light_path: 1, light_interior: 5 } })]);
  assert.equal(Math.round(s.lighting), 1, 'a dark walk is the number that matters');
});

test('a recent note outweighs an old one without erasing it', () => {
  const s = obs.summarize([
    note(3, { safety: { comfort: 5 } }),
    note(1200, { safety: { comfort: 1 } })
  ]);
  assert.ok(s.comfort > 4, `recent should dominate, got ${s.comfort}`);
  assert.equal(s.count, 2, 'both notes are still there');
});

test('a sharp disagreement is flagged rather than averaged away', () => {
  const s = obs.summarize([
    note(10, { safety: { comfort: 5 }, author: 'dev-aaa' }),
    note(20, { safety: { comfort: 1 }, author: 'dev-bbb' })
  ]);
  assert.equal(s.disagreement, true);
  assert.equal(s.authors, 2);
});

test('close ratings are not called a disagreement', () => {
  const s = obs.summarize([note(10, { safety: { comfort: 4 } }), note(20, { safety: { comfort: 3 } })]);
  assert.equal(s.disagreement, false);
});

test('notes older than a year are marked as old', () => {
  assert.equal(obs.summarize([note(400, { safety: { comfort: 4 } })]).stale, true);
  assert.equal(obs.summarize([note(30, { safety: { comfort: 4 } })]).stale, false);
});

test('parking answers stay in their own time band', () => {
  const s = obs.summarize([
    note(2, { practical: { parking_availability: { night: 'full' } } }),
    note(9, { practical: { parking_availability: { morning: 'plenty', night: 'some' } } })
  ]);
  assert.equal(s.parking.night, 'full', 'the newer answer wins within a band');
  assert.equal(s.parking.morning, 'plenty', 'and other bands are untouched');
});

test('facts that rarely change carry forward from the last note that stated one', () => {
  const s = obs.summarize([
    note(1, { access: {} }),
    note(60, { access: { door: 'single_locking', requires: 'key' } })
  ]);
  assert.equal(s.access.door, 'single_locking');
  assert.equal(s.access.requires, 'key');
});

test('the rated-well bar is applied honestly at the edges', () => {
  assert.equal(obs.meetsBar(summaryWith(3), 3), true);
  assert.equal(obs.meetsBar(summaryWith(2), 3), false);
  assert.equal(obs.meetsBar(null, 3), false);
  assert.equal(obs.meetsBar(obs.summarize([note(1, { notes: 'only a note' })]), 3), false);
});

/* ---- files coming in from another driver ---- */

test('an observation with a rating out of range is refused', () => {
  assert.equal(obs.validate({ obs_id: 'a', place_id: 'p', safety: { comfort: 3 } }), null);
  assert.ok(obs.validate({ obs_id: 'a', place_id: 'p', safety: { comfort: 9 } }));
  assert.ok(obs.validate({ place_id: 'p' }));
  assert.ok(obs.validate({ obs_id: 'a' }));
  assert.ok(obs.validate({ obs_id: 'a', place_id: 'p', observed_at: 'last tuesday' }));
});

test('a dataset file is checked before it is allowed near the database', () => {
  assert.equal(places.validateDataset({ format: 'parity.dataset', places: [{ id: 'a', lat: 1, lon: 2 }] }), null);
  assert.ok(places.validateDataset({ format: 'something.else', places: [] }));
  assert.ok(places.validateDataset({ format: 'parity.dataset' }));
  assert.ok(places.validateDataset({ format: 'parity.dataset', places: [{ id: 'a' }] }));
});

test('a source that says nothing is shown as unknown, never as absent', () => {
  const flags = places.baseFlags({ base: { restroom: true, showers: null, food: false } });
  const labels = flags.map(f => f.label);
  assert.ok(labels.includes('Restroom'));
  assert.ok(!labels.some(l => /shower/i.test(l)), 'silence about showers must not become "no showers"');
  assert.ok(labels.includes('No showers') === false);
});

test('a source that explicitly says no is shown as no', () => {
  const labels = places.baseFlags({ base: { showers: false } }).map(f => f.label);
  assert.deepEqual(labels, ['No showers']);
});

test('the trimmed place that rides along in an export keeps what a driver needs', () => {
  const t = places.trim({
    id: 'osm:node/1', name: 'Rest area', kind: 'rest_area', lat: 40.1, lon: -98.2,
    route: 'I-80', direction: 'E', state: 'NE', base: { restroom: true }, sources: [{}]
  });
  assert.deepEqual(Object.keys(t).sort(), ['direction', 'id', 'kind', 'lat', 'lon', 'name', 'route', 'state']);
  assert.equal(t.route, 'I-80');
});

test('distances read the way a driver would say them', () => {
  assert.equal(geo.fmtMiles(1609.344 * 42), '42 mi');
  assert.equal(geo.fmtMiles(1609.344 * 4.25), '4.3 mi');
  assert.equal(geo.fmtFeet(30.48), '100 ft');
  assert.equal(geo.compassPoint(0), 'N');
  assert.equal(geo.compassPoint(315), 'NW');
});
