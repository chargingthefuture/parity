#!/usr/bin/env node
//
// pipeline/test.mjs
//
// Tests for the offline half of the pipeline. Uses only what Node itself ships with, so there is
// nothing to install.
//
//   node pipeline/test.mjs        (or)   node --test pipeline/
//
// Nothing here touches the network. The two fetch scripts are only checked for the addresses and
// queries they would build, never by calling anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distanceMetres,
  emptyBase,
  generateName,
  normalizeArcgis,
  normalizeDirection,
  normalizeOsm,
  normalizeRoute,
  normalizeState,
  threeState,
  toCount,
  validateDataset,
  validatePlace,
} from './normalize.mjs';

import { dedupe, isSamePlace, kindsMatch, mergePlaces } from './build.mjs';
import { buildSample, SAMPLE_WARNING } from './build-sample.mjs';
import { buildQuery, tileBbox, tileName } from './fetch-osm.mjs';
import { describeUrl, queryUrl } from './fetch-arcgis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

test('interstate numbers are written one way', () => {
  for (const written of ['I 95', 'i-95', 'I-95', 'I95', 'Interstate 95', 'IH-95', 'IR 95', 'i 95 ']) {
    assert.equal(normalizeRoute(written), 'I-95', `${written} should become I-95`);
  }
});

test('federal route numbers are written one way', () => {
  for (const written of ['US 30', 'U.S. 30', 'US-30', 'us 30', 'USH 30', 'US Route 30', 'US 30 BUS']) {
    assert.equal(normalizeRoute(written), 'US-30', `${written} should become US-30`);
  }
});

test('state route numbers are written one way', () => {
  assert.equal(normalizeRoute('SR 1'), 'SR-1');
  assert.equal(normalizeRoute('State Route 1'), 'SR-1');
  assert.equal(normalizeRoute('S.R. 1'), 'SR-1');
  assert.equal(normalizeRoute('SH-1'), 'SR-1');
  assert.equal(normalizeRoute('Highway 1'), 'SR-1');
  assert.equal(normalizeRoute('IA 141'), 'SR-141');
  assert.equal(normalizeRoute('MD 279'), 'SR-279');
});

test('a road nobody can identify comes back as nothing, never as a guess', () => {
  assert.equal(normalizeRoute(null), null);
  assert.equal(normalizeRoute(undefined), null);
  assert.equal(normalizeRoute(''), null);
  assert.equal(normalizeRoute('   '), null);
  assert.equal(normalizeRoute('N/A'), null);
  assert.equal(normalizeRoute('Unknown'), null);
  // A bare number could be an interstate or a state route. Picking one would send a driver to the
  // wrong road, so neither is picked.
  assert.equal(normalizeRoute('95'), null);
  assert.equal(normalizeRoute('Main Street'), null);
});

test('a field holding several roads keeps the first', () => {
  assert.equal(normalizeRoute('I-95;US-1'), 'I-95');
  assert.equal(normalizeRoute('US 30 / SR 4'), 'US-30');
});

// ---------------------------------------------------------------------------
// Direction of travel
// ---------------------------------------------------------------------------

test('direction of travel is read from every spelling sources use', () => {
  for (const written of ['NB', 'northbound', 'North', 'N', 'n/b', 'NORTH BOUND', 'I-95 NB']) {
    assert.equal(normalizeDirection(written), 'N', `${written} should become N`);
  }
  assert.equal(normalizeDirection('SB'), 'S');
  assert.equal(normalizeDirection('Southbound'), 'S');
  assert.equal(normalizeDirection('east'), 'E');
  assert.equal(normalizeDirection('WB'), 'W');
  assert.equal(normalizeDirection('Westbound'), 'W');
});

test('a road served in both directions is marked both', () => {
  assert.equal(normalizeDirection('Both'), 'both');
  assert.equal(normalizeDirection('N/S'), 'both');
  assert.equal(normalizeDirection('E/W'), 'both');
  assert.equal(normalizeDirection('bi-directional'), 'both');
});

test('an unclear direction comes back as nothing rather than a guess', () => {
  assert.equal(normalizeDirection(null), null);
  assert.equal(normalizeDirection(''), null);
  assert.equal(normalizeDirection('N/A'), null);
  assert.equal(normalizeDirection('Unknown'), null);
  assert.equal(normalizeDirection('180'), null); // a compass bearing, not a carriageway
  assert.equal(normalizeDirection('2'), null); // a lane code
  assert.equal(normalizeDirection('North Platte Rest Area'), null); // a name, not a direction
});

test('two-letter state codes are read from codes and from full names', () => {
  assert.equal(normalizeState('IA'), 'IA');
  assert.equal(normalizeState('iowa'), 'IA');
  assert.equal(normalizeState('New Hampshire'), 'NH');
  assert.equal(normalizeState('Republic of Texas'), null);
  assert.equal(normalizeState(null), null);
});

// ---------------------------------------------------------------------------
// Silence is not a no
// ---------------------------------------------------------------------------

test('a source saying nothing gives null, and a source saying no gives false', () => {
  // This is the rule the whole record shape exists for. The app draws "nobody checked" and
  // "there is none" differently, and turning silence into a no would tell a driver at 2am that a
  // place has no restroom when in truth nobody ever wrote it down.
  assert.equal(threeState(undefined), null);
  assert.equal(threeState(null), null);
  assert.equal(threeState(''), null);
  assert.equal(threeState('   '), null);
  assert.equal(threeState('Unknown'), null);
  assert.equal(threeState('N/A'), null);
  assert.equal(threeState('not reported'), null);
  assert.equal(threeState(-9999), null);

  assert.equal(threeState('N'), false);
  assert.equal(threeState('no'), false);
  assert.equal(threeState(0), false);
  assert.equal(threeState(false), false);

  assert.equal(threeState('Y'), true);
  assert.equal(threeState('yes'), true);
  assert.equal(threeState(1), true);
  assert.equal(threeState(true), true);
});

test('a place tagged with nothing about its amenities has every flag null, not false', () => {
  const place = normalizeOsm({
    type: 'node',
    id: 42,
    lat: 41.5,
    lon: -94.5,
    tags: { highway: 'rest_area', name: 'Quiet Rest Area' },
  });
  for (const field of ['restroom', 'family_restroom', 'ada', 'showers', 'food', 'fuel', 'staffed']) {
    assert.equal(place.base[field], null, `${field} should be null when nothing was tagged`);
    assert.notEqual(place.base[field], false, `${field} must not be turned into a no`);
  }
  assert.equal(place.base.truck_parking_spots, null);
  assert.equal(place.base.hours, null);
});

test('an ArcGIS record with blank amenity fields keeps them null, and a no stays a no', () => {
  const source = {
    id: 'test-dot',
    priority: 3,
    defaultKind: 'rest_area',
    state: 'IA',
    fieldMap: {
      native_id: 'OBJECTID',
      name: 'NAME',
      base: { restroom: 'RESTROOMS', showers: 'SHOWERS', ada: 'ADA', food: 'VENDING' },
    },
  };
  const place = normalizeArcgis(
    {
      attributes: { OBJECTID: 9, NAME: 'Blank Rest Area', RESTROOMS: '', SHOWERS: 'N', ADA: 'UNKNOWN' },
      geometry: { x: -94.5, y: 41.5 },
    },
    source,
  );
  assert.equal(place.base.restroom, null); // blank
  assert.equal(place.base.ada, null); // the word unknown
  assert.equal(place.base.food, null); // the field is not in the layer at all
  assert.equal(place.base.showers, false); // an actual no
});

test('a count of -1 is a placeholder, not zero spaces', () => {
  assert.equal(toCount(-1), null);
  assert.equal(toCount(null), null);
  assert.equal(toCount(''), null);
  assert.equal(toCount(0), 0);
  assert.equal(toCount('34'), 34);
  assert.equal(toCount('1,200'), 1200);
});

// ---------------------------------------------------------------------------
// OpenStreetMap records
// ---------------------------------------------------------------------------

test('a point becomes a Place', () => {
  const place = normalizeOsm(
    {
      type: 'node',
      id: 1234567890,
      lat: 39.41021234,
      lon: -75.62314321,
      tags: {
        highway: 'rest_area',
        name: 'I-95 Northbound Rest Area',
        ref: 'I 95',
        direction: 'northbound',
        toilets: 'yes',
        wheelchair: 'yes',
        'capacity:hgv': '47',
        opening_hours: '24/7',
        'is_in:state_code': 'DE',
      },
    },
    { fetched_at: '2026-08-01T00:00:00Z' },
  );

  assert.equal(place.id, 'osm:node/1234567890');
  assert.equal(place.name, 'I-95 Northbound Rest Area');
  assert.equal(place.kind, 'rest_area');
  assert.equal(place.lat, 39.410212); // rounded to 6 places
  assert.equal(place.lon, -75.623143);
  assert.equal(place.route, 'I-95');
  assert.equal(place.direction, 'N');
  assert.equal(place.state, 'DE');
  assert.equal(place.base.restroom, true);
  assert.equal(place.base.ada, true);
  assert.equal(place.base.truck_parking_spots, 47);
  assert.equal(place.base.hours, '24/7');
  assert.deepEqual(place.sources, [
    { source: 'osm', native_id: 'node/1234567890', fetched_at: '2026-08-01T00:00:00Z' },
  ]);
  assert.deepEqual(validatePlace(place), []);
});

test('an area drawn as an outline uses the centre point Overpass returns', () => {
  const place = normalizeOsm({
    type: 'way',
    id: 2001,
    center: { lat: 41.621, lon: -94.88 },
    tags: { highway: 'services', name: 'Dexter Service Plaza', ref: 'I80' },
  });
  assert.equal(place.id, 'osm:way/2001');
  assert.equal(place.kind, 'services');
  assert.equal(place.lat, 41.621);
  assert.equal(place.lon, -94.88);
  assert.equal(place.route, 'I-80');
});

test('an area with no centre has no coordinates, so the build can drop it', () => {
  const place = normalizeOsm({
    type: 'way',
    id: 2002,
    tags: { highway: 'rest_area', name: 'Adair Rest Area' },
  });
  assert.equal(place.lat, null);
  assert.equal(place.lon, null);
});

test('partly accessible is recorded as not accessible, because the other way round is the harmful one', () => {
  const limited = normalizeOsm({ type: 'node', id: 3, lat: 41, lon: -94, tags: { amenity: 'toilets', wheelchair: 'limited' } });
  assert.equal(limited.base.ada, false);
  const yes = normalizeOsm({ type: 'node', id: 4, lat: 41, lon: -94, tags: { amenity: 'toilets', wheelchair: 'yes' } });
  assert.equal(yes.base.ada, true);
});

// ---------------------------------------------------------------------------
// ArcGIS records
// ---------------------------------------------------------------------------

test('an ArcGIS record is read through its source field map', () => {
  const source = {
    id: 'oh-dot-rest-areas',
    priority: 3,
    state: 'OH',
    defaultKind: 'rest_area',
    kindMap: { 'Travel Information Center': 'welcome_center' },
    fieldMap: {
      native_id: 'OBJECTID',
      name: 'REST_AREA',
      kind: 'SITE_TYPE',
      route: 'ROUTE_ID',
      direction: 'DIRECTION',
      milepost: 'LOG_POINT',
      base: {
        restroom: 'RESTROOM',
        family_restroom: 'FAMILY_RESTROOM',
        ada: 'ADA',
        food: 'VENDING',
        truck_parking_spots: 'TRUCK_SPACES',
        hours: 'HOURS',
        staffed: 'STAFFED',
      },
    },
  };
  const place = normalizeArcgis(
    {
      attributes: {
        OBJECTID: 12,
        REST_AREA: 'Ohio Welcome Center',
        SITE_TYPE: 'Travel Information Center',
        ROUTE_ID: 'IR 70',
        DIRECTION: 'EB',
        LOG_POINT: 2.1,
        RESTROOM: 1,
        FAMILY_RESTROOM: 1,
        ADA: 1,
        VENDING: 1,
        TRUCK_SPACES: 18,
        HOURS: '8am-8pm',
        STAFFED: 'Y',
      },
      geometry: { x: -83.3802, y: 39.9202 },
    },
    source,
    { fetched_at: '2026-08-01T00:00:00Z' },
  );

  assert.equal(place.id, 'oh-dot-rest-areas:12');
  assert.equal(place.kind, 'welcome_center');
  assert.equal(place.route, 'I-70');
  assert.equal(place.direction, 'E');
  assert.equal(place.milepost, 2.1);
  assert.equal(place.state, 'OH'); // from the source, which covers one state only
  assert.equal(place.lat, 39.9202);
  assert.equal(place.lon, -83.3802);
  assert.equal(place.base.staffed, true);
  assert.equal(place.base.truck_parking_spots, 18);
  assert.deepEqual(validatePlace(place), []);
});

test('an ArcGIS record with no geometry has no coordinates', () => {
  const place = normalizeArcgis(
    { attributes: { OBJECTID: 503, NAME: 'Unlocated' }, geometry: null },
    { id: 'bts-truck-stop-parking', defaultKind: 'truck_stop', fieldMap: { native_id: 'OBJECTID', name: 'NAME' } },
  );
  assert.equal(place.lat, null);
  assert.equal(place.lon, null);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('a place with no name gets one built from the road and the milepost', () => {
  const place = normalizeOsm({
    type: 'node',
    id: 7,
    lat: 39.41,
    lon: -75.62,
    tags: { highway: 'rest_area', ref: 'I 95', direction: 'NB', milepost: '12.4' },
  });
  assert.equal(place.name, 'Rest area — I-95 N, MP 12.4');
});

test('a built name leaves out what is unknown instead of filling it in', () => {
  assert.equal(
    generateName({ kind: 'truck_stop', route: 'US-30', direction: null, milepost: null, state: 'IA' }),
    'Truck stop — US-30',
  );
  assert.equal(
    generateName({ kind: 'toilets', route: null, direction: null, milepost: null, state: 'DE' }),
    'Restroom — DE',
  );
  assert.equal(
    generateName({ kind: 'rest_area', route: null, direction: null, milepost: null, state: null }),
    'Rest area',
  );
});

// ---------------------------------------------------------------------------
// Deciding what is the same place
// ---------------------------------------------------------------------------

function place(overrides = {}) {
  return {
    id: 'osm:node/1',
    name: 'Somewhere',
    kind: 'rest_area',
    lat: 41.59,
    lon: -94.93,
    route: 'I-80',
    direction: 'W',
    milepost: null,
    state: 'IA',
    base: emptyBase(),
    sources: [{ source: 'osm', native_id: 'node/1', fetched_at: '2026-08-01T00:00:00Z' }],
    ...overrides,
  };
}

test('distance between two points is measured in metres', () => {
  assert.ok(Math.abs(distanceMetres(41.59, -94.93, 41.5903, -94.9315) - 137) < 20);
  assert.ok(distanceMetres(41.59, -94.93, 41.59, -94.93) < 0.001);
});

test('two records of one site close together are the same place', () => {
  const a = place();
  const b = place({ id: 'ia-dot-rest-areas:1', lat: 41.5903, lon: -94.9302 });
  assert.equal(isSamePlace(a, b), true);
});

test('two records far apart are not the same place', () => {
  const a = place();
  const b = place({ id: 'ia-dot-rest-areas:1', lat: 41.6, lon: -94.93 });
  assert.equal(isSamePlace(a, b), false);
});

test('the two sides of a divided road are not joined', () => {
  const a = place({ direction: 'W' });
  const b = place({ id: 'osm:node/2', direction: 'E', lat: 41.5906, lon: -94.9299 });
  assert.equal(isSamePlace(a, b), false);
});

test('two roads are not joined even when the points nearly touch', () => {
  const a = place({ route: 'I-80' });
  const b = place({ id: 'osm:node/2', route: 'US-6', lat: 41.5901, lon: -94.9301 });
  assert.equal(isSamePlace(a, b), false);
});

test('a source that is silent about the road blocks nothing', () => {
  const a = place({ route: 'I-80', direction: 'W' });
  const b = place({ id: 'osm:node/2', route: null, direction: null, kind: 'toilets', lat: 41.5901, lon: -94.9301 });
  assert.equal(isSamePlace(a, b), true);
});

test('a weigh station is never folded into a rest area', () => {
  assert.equal(kindsMatch('weigh_station', 'rest_area'), false);
  assert.equal(kindsMatch('rest_area', 'toilets'), true);
  assert.equal(kindsMatch('truck_stop', 'fuel'), true);
});

// ---------------------------------------------------------------------------
// Joining records
// ---------------------------------------------------------------------------

const priorityOf = (p) => (p.sources[0].source === 'osm' ? 1 : 3);

test('joining two records fills the gaps and never writes a null over a fact', () => {
  const fromOsm = place({
    id: 'osm:node/1001',
    name: 'Wilton Rest Area',
    base: { ...emptyBase(), restroom: true, ada: true, truck_parking_spots: 32, hours: '24/7' },
  });
  const fromState = place({
    id: 'ia-dot-rest-areas:1',
    name: 'Wilton Rest Area',
    milepost: 271.4,
    base: { ...emptyBase(), restroom: true, family_restroom: true, showers: false, staffed: false, truck_parking_spots: 34 },
    sources: [{ source: 'ia-dot-rest-areas', native_id: '1', fetched_at: '2026-08-01T00:00:00Z' }],
  });

  const merged = mergePlaces([fromOsm, fromState], priorityOf);

  // Facts only one source had survive, whichever source that was.
  assert.equal(merged.base.ada, true, 'a fact only OpenStreetMap had is kept');
  assert.equal(merged.base.family_restroom, true, 'a fact only the state had is kept');
  assert.equal(merged.base.hours, '24/7', 'the hours only OpenStreetMap had are kept');
  assert.equal(merged.milepost, 271.4);
  // The state department runs the building, so its count wins the disagreement.
  assert.equal(merged.base.truck_parking_spots, 34);
  // The id comes from the source that is trusted more, and every source is listed.
  assert.equal(merged.id, 'ia-dot-rest-areas:1');
  assert.equal(merged.sources.length, 2);
  assert.deepEqual(merged.sources.map((s) => s.source).sort(), ['ia-dot-rest-areas', 'osm']);
  assert.deepEqual(validatePlace(merged), []);
});

test('a flag the state department says no to beats OpenStreetMap saying yes', () => {
  const fromOsm = place({ id: 'osm:node/1010', base: { ...emptyBase(), family_restroom: true } });
  const fromState = place({
    id: 'oh-dot-rest-areas:11',
    base: { ...emptyBase(), family_restroom: false },
    sources: [{ source: 'oh-dot-rest-areas', native_id: '11', fetched_at: '2026-08-01T00:00:00Z' }],
  });
  assert.equal(mergePlaces([fromOsm, fromState], priorityOf).base.family_restroom, false);
  // The order the records were read in must not change the answer.
  assert.equal(mergePlaces([fromState, fromOsm], priorityOf).base.family_restroom, false);
});

test('a name a source published beats a name this pipeline made up', () => {
  const generated = place({
    id: 'ia-dot-rest-areas:1',
    name: 'Rest area — I-80 W',
    sources: [{ source: 'ia-dot-rest-areas', native_id: '1', fetched_at: '2026-08-01T00:00:00Z' }],
  });
  const named = place({ id: 'osm:node/1001', name: 'Wilton Rest Area' });
  assert.equal(mergePlaces([generated, named], priorityOf).name, 'Wilton Rest Area');
});

test('three records of one place from three sources become one', () => {
  const records = [
    place({ id: 'osm:node/1', lat: 41.59, lon: -94.93 }),
    place({
      id: 'ia-dot-rest-areas:1',
      lat: 41.5902,
      lon: -94.9302,
      sources: [{ source: 'ia-dot-rest-areas', native_id: '1', fetched_at: '2026-08-01T00:00:00Z' }],
    }),
    place({
      id: 'bts-truck-stop-parking:9',
      lat: 41.5904,
      lon: -94.9304,
      sources: [{ source: 'bts-truck-stop-parking', native_id: '9', fetched_at: '2026-08-01T00:00:00Z' }],
    }),
  ];
  const result = dedupe(records, priorityOf);
  assert.equal(result.places.length, 1);
  assert.equal(result.mergedAway, 2);
  assert.equal(result.places[0].sources.length, 3);
});

test('places come out sorted by id, so two builds can be compared line by line', () => {
  const records = [
    place({ id: 'osm:node/9', lat: 40, lon: -90 }),
    place({ id: 'ia-dot-rest-areas:2', lat: 41, lon: -91, sources: [{ source: 'ia-dot-rest-areas', native_id: '2', fetched_at: null }] }),
    place({ id: 'bts-truck-stop-parking:3', lat: 42, lon: -92, sources: [{ source: 'bts-truck-stop-parking', native_id: '3', fetched_at: null }] }),
  ];
  const ids = dedupe(records, priorityOf).places.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort());
});

// ---------------------------------------------------------------------------
// Checking a record against the schema
// ---------------------------------------------------------------------------

test('the schema check catches a record that breaks the rules', () => {
  const bad = place({ direction: 'NE', route: 'Interstate 80', kind: 'gas station', lat: '41.59' });
  const problems = validatePlace(bad);
  assert.ok(problems.some((p) => p.includes('direction')));
  assert.ok(problems.some((p) => p.includes('route')));
  assert.ok(problems.some((p) => p.includes('kind')));
  assert.ok(problems.some((p) => p.includes('lat')));
});

test('the schema check catches a flag that is neither yes, no, nor unknown', () => {
  const bad = place({ base: { ...emptyBase(), restroom: 'Y' } });
  assert.ok(validatePlace(bad).some((p) => p.includes('base.restroom')));
});

// ---------------------------------------------------------------------------
// The sample dataset
// ---------------------------------------------------------------------------

test('the sample dataset builds, matches the schema, and says plainly that it is made up', async () => {
  const { dataset, summary } = await buildSample();

  assert.deepEqual(validateDataset(dataset), []);
  assert.equal(dataset.format, 'parity.dataset');
  assert.equal(dataset.sample, true);
  assert.equal(dataset.name, 'sample');
  assert.equal(dataset.warning, SAMPLE_WARNING);
  assert.match(dataset.warning, /Made-up data/);
  assert.ok(dataset.attribution.length > 1, 'the sample comes from more than one source');

  assert.ok(dataset.places.length >= 25 && dataset.places.length <= 40,
    `expected 25 to 40 places, got ${dataset.places.length}`);

  // Every path through the code is exercised: a record was thrown away for having no point on the
  // map, and records from two different sources were joined into one place.
  assert.ok(summary.dropped.no_coordinates >= 1, 'a record with no coordinates should be dropped');
  assert.ok(summary.mergedAway >= 1, 'at least one pair should be joined');

  const shared = dataset.places.filter((p) => p.sources.length > 1);
  assert.ok(shared.length >= 1, 'at least one place should be built from two sources');
  for (const p of shared) {
    const names = new Set(p.sources.map((s) => s.source));
    assert.ok(names.size > 1, 'a joined place should list more than one source');
  }

  // The roads really were normalized on the way in.
  const routes = new Set(dataset.places.map((p) => p.route).filter(Boolean));
  assert.ok([...routes].every((r) => /^(I|US|SR)-\d+$/.test(r)), `unexpected road name in ${[...routes]}`);
  assert.ok(routes.has('I-80') && routes.has('I-70') && routes.has('I-95'));

  // Somewhere in the sample a source is silent about a flag, and it stayed silent.
  assert.ok(dataset.places.some((p) => p.base.restroom === null), 'a null flag should survive the build');
  assert.ok(dataset.places.some((p) => p.base.restroom === false), 'an explicit no should survive the build');
});

test('the sample dataset written to data/ is the one this code builds', async () => {
  const onDisk = JSON.parse(await readFile(path.join(REPO, 'data', 'sample-dataset.json'), 'utf8'));
  const { dataset } = await buildSample();
  assert.deepEqual(onDisk, dataset, 'run: node pipeline/build-sample.mjs');
});

// ---------------------------------------------------------------------------
// The two fetch scripts — addresses and queries only, nothing is called
// ---------------------------------------------------------------------------

test('a big area is cut into squares small enough for the server to answer', () => {
  const squares = tileBbox([-80.5, 36.5, -78.5, 38.5], 1);
  assert.equal(squares.length, 4);
  assert.equal(tileName(squares[0]), 'tile_-80.500_36.500_-79.500_37.500');
  for (const square of squares) {
    assert.ok(square.east - square.west <= 1.0001);
    assert.ok(square.north - square.south <= 1.0001);
  }
});

test('the OpenStreetMap query asks for rest areas, restrooms, fuel and truck parking', () => {
  const query = buildQuery({ south: 41, west: -95, north: 42, east: -94 }, 180);
  assert.match(query, /\[out:json\]\[timeout:180\];/);
  assert.match(query, /"highway"="rest_area"/);
  assert.match(query, /"highway"="services"/);
  assert.match(query, /"amenity"="toilets"/);
  assert.match(query, /"amenity"="fuel"/);
  assert.match(query, /"amenity"="truck_stop"/);
  assert.match(query, /"hgv"="yes"/);
  assert.match(query, /"truck"="yes"/);
  // Overpass takes the box as south, west, north, east.
  assert.match(query, /\(41,-95,42,-94\)/);
  // `center` is what makes an area drawn as an outline land on a single point.
  assert.match(query, /out center tags;/);
  // Points and areas both, or a rest area drawn as an outline would be missed.
  assert.ok(query.includes('node["highway"="rest_area"]'));
  assert.ok(query.includes('way["highway"="rest_area"]'));
});

test('the ArcGIS addresses ask for every field in plain longitude and latitude', () => {
  const url = queryUrl('https://example.org/rest/services/Layer/MapServer/0', { offset: 2000, pageSize: 1000 });
  assert.ok(url.startsWith('https://example.org/rest/services/Layer/MapServer/0/query?'));
  assert.match(url, /where=1%3D1/);
  assert.match(url, /outFields=\*/);
  assert.match(url, /f=json/);
  assert.match(url, /outSR=4326/);
  assert.match(url, /resultOffset=2000/);
  assert.match(url, /resultRecordCount=1000/);
  assert.equal(describeUrl('https://example.org/rest/services/Layer/MapServer/0/'), 'https://example.org/rest/services/Layer/MapServer/0?f=json');
});

// ---------------------------------------------------------------------------
// The source registry
// ---------------------------------------------------------------------------

test('every source is described well enough to be fetched, and guesses are marked as guesses', async () => {
  const registry = JSON.parse(await readFile(path.join(HERE, 'sources.json'), 'utf8'));
  assert.ok(Array.isArray(registry.sources) && registry.sources.length >= 6);

  const ids = new Set();
  for (const source of registry.sources) {
    assert.ok(source.id, 'every source needs an id');
    assert.ok(!ids.has(source.id), `two sources share the id ${source.id}`);
    ids.add(source.id);
    assert.ok(['osm', 'arcgis'].includes(source.kind), `${source.id} has an unknown kind`);
    assert.ok(source.description && source.description.length > 20, `${source.id} needs a description`);
    assert.match(source.endpoint, /^https:\/\//, `${source.id} needs a web address`);
    assert.equal(typeof source.verified, 'boolean', `${source.id} must say whether its address was checked`);
    if (source.verified === false) {
      assert.ok(source.note && source.note.length > 20, `${source.id} is unchecked and must say what to check`);
    }
    if (source.kind === 'arcgis') {
      assert.ok(source.fieldMap, `${source.id} needs a field map`);
      assert.ok(source.fieldMap.base, `${source.id} needs a field map for the amenity flags`);
      assert.ok(Number.isFinite(source.priority), `${source.id} needs a priority`);
    }
  }

  // At least four state transport departments, so the field map really is doing work across
  // differently named layers.
  const stateSources = registry.sources.filter((s) => s.kind === 'arcgis' && s.state);
  assert.ok(stateSources.length >= 4, `expected at least 4 state sources, found ${stateSources.length}`);
});
