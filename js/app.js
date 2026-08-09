/* Parity — screens and routing.
 *
 * Five screens, and the one that opens first answers the only question that
 * matters while the wheels are turning: where do I stop next. Everything else
 * is one tap away from it.
 *
 * No network code lives in this file or any file it imports, other than reading
 * the dataset that was saved onto this phone when the app was installed.
 */

import * as db from './db.js';
import * as places from './places.js';
import * as obs from './observations.js';
import * as exchange from './exchange.js';
import * as loc from './location.js';
import * as geo from './geo.js';
import { plan, choose, fmtDuration, minutesAway, bandFor } from './planner.js';
import {
  esc, toast, scale5, options, triState, stepper, field, grade, pill,
  card, banner, fmtDate, fmtDay, getPath, setPath
} from './ui.js';

const view = document.getElementById('view');

let settings = db.getSettings();
let meta = db.getMeta();
let summaries = new Map();     // place id -> rolled-up observations
let draft = null;              // the log form in progress, kept across redraws
let lastPaint = 0;
let renderTicket = 0;          // only the newest redraw may write to the screen

const MI = geo.M_PER_MILE;

/* ---------- routing ---------- */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'now', arg: rest.map(decodeURIComponent).join('/') };
}

const SCREENS = {
  now: renderNow,
  nearby: renderNearby,
  place: renderPlace,
  log: renderLog,
  data: renderData,
  settings: renderSettings,
  privacy: renderPrivacy
};

/* Only these screens need a live position, so only these turn the receiver on. */
const NEEDS_POSITION = new Set(['now', 'nearby', 'place']);

async function render() {
  const route = parseRoute();
  const screen = SCREENS[route.name] || renderNow;

  if (NEEDS_POSITION.has(route.name)) loc.start(settings.highAccuracy);
  else loc.stop();

  if (route.name !== 'log') draft = null;

  document.querySelectorAll('.nav a').forEach(a => {
    const target = a.getAttribute('href').replace(/^#\/?/, '') || 'now';
    if (target === route.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  /* Drawing a screen means reading the database, so two redraws started close
   * together can finish in either order. Without this, a slow one that started
   * earlier could land last and put a stale list back on screen — the driver
   * would be looking at stops worked out from a position she has already passed.
   * Each redraw takes a ticket; only the newest one is allowed to write. */
  const ticket = ++renderTicket;
  let html;
  try {
    html = await screen(route.arg);
  } catch (err) {
    html = banner('warn', 'Something went wrong', String(err && err.message || err));
  }
  if (ticket !== renderTicket) return;
  view.innerHTML = html;
  lastPaint = Date.now();
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* A new fix arrives every second or so while moving. Redrawing that often would
 * keep the processor busy for no benefit — the numbers on screen barely change.
 * So redraws are held to one every four seconds, and never happen while a form
 * is open.
 *
 * A fix that arrives inside that gap is not thrown away: one redraw is booked
 * for when the gap runs out. Dropping them outright would leave the screen
 * stuck on an old position whenever fixes stopped arriving. */
const REDRAW_GAP_MS = 4000;
let pendingRedraw = null;

loc.subscribe(() => {
  const route = parseRoute();
  if (!NEEDS_POSITION.has(route.name)) return;
  const since = Date.now() - lastPaint;
  if (since >= REDRAW_GAP_MS) { render(); return; }
  if (pendingRedraw) return;
  pendingRedraw = setTimeout(() => {
    pendingRedraw = null;
    if (NEEDS_POSITION.has(parseRoute().name)) render();
  }, REDRAW_GAP_MS - since);
});

/* ---------- shared bits ---------- */

async function refreshSummaries() {
  const grouped = await obs.byPlace();
  summaries = new Map();
  for (const [placeId, list] of grouped) summaries.set(placeId, obs.summarize(list));
}

function headerBar() {
  const s = loc.state();
  const heading = s.heading;
  const line = heading == null
    ? 'no heading yet'
    : `${geo.compassPoint(heading)} · ${Math.round(heading)}°`;
  const speed = s.speedMps != null && s.speedMps > 1
    ? Math.round(s.speedMps * 2.23694) + ' mph'
    : (s.fix ? 'stopped' : '—');
  return `<div class="bar">
    <div><h1>Parity</h1><p class="sub">Restrooms you can use, on your side</p></div>
    <div class="where"><b>${esc(line)}</b>${esc(speed)}${s.headingIsManual ? ' · set by hand' : ''}</div>
  </div>`;
}

function sampleWarning() {
  if (!meta.datasetSample) return '';
  return banner('warn', 'Demonstration data — do not drive to these',
    'The stops loaded right now are made up, so the app has something to run against. ' +
    'They are not real places. Load a real dataset from the Data screen before you rely on this.');
}

function noDataWarning() {
  if (meta.datasetCount) return '';
  return banner('warn', 'No stops loaded',
    'There is no map data on this phone yet. Open the Data screen and load a dataset file.');
}

/* The side pill always says how it knows. "Signed" means the transport
 * department published a direction for that stop; "measured" means the app can
 * see which side of you it is on, which it can only do close up. */
function sideOf(candidate) {
  const basis = candidate.sideBasis;
  if (candidate.side === 'yours') {
    return pill(basis === 'signed' ? 'Your side (signed)' : 'Your side', 'side-yours');
  }
  if (candidate.side === 'other') {
    return pill(basis === 'signed' ? 'Other side (signed)' : 'Other side', 'side-other');
  }
  if (candidate.side === 'unclear') return pill('Side unclear', 'side-unclear');
  if (candidate.side === 'unknown') return pill('Side unknown', 'side-unclear');
  return '';
}

/** One row in a list of stops. */
function stopRow(c, opts = {}) {
  const p = c.place;
  const s = c.summary !== undefined ? c.summary : summaries.get(p.id);
  const dist = opts.useDistance ? c.distance : (c.along ?? c.distance);
  const mins = opts.metresPerMin ? minutesAway(dist, opts.metresPerMin) : null;

  const chips = [];
  chips.push(sideOf(c));
  if (s) {
    /* A place with notes but no rating is unrated, and is coloured as unrated
     * rather than as bad — nobody scored it low, nobody scored it at all. */
    const tone = s.comfort == null ? '' : s.comfort >= 4 ? 'green' : s.comfort >= 3 ? 'amber' : 'red';
    chips.push(pill(obs.ratingWord(s.comfort) + (s.count > 1 ? ` · ${s.count} notes` : ''), tone));
    if (s.access?.door === 'single_locking') chips.push(pill('Locking door', 'green'));
    if (s.sightline === 'blind') chips.push(pill('Blind walk', 'red'));
    if (s.lighting != null && s.lighting <= 2) chips.push(pill('Poorly lit', 'red'));
    if (s.access?.hours === '24h') chips.push(pill('24 hours'));
    if (s.stale) chips.push(pill('Old note', 'amber'));
    if (s.disagreement) chips.push(pill('Drivers disagree', 'amber'));
  } else {
    chips.push(pill('Unrated', ''));
    const b = p.base || {};
    if (b.restroom === true) chips.push(pill('Restroom listed'));
    if (b.truck_parking_spots != null) chips.push(pill(b.truck_parking_spots + ' spots'));
    if (b.hours) chips.push(pill(b.hours));
  }

  const cls = s && s.comfort != null
    ? (s.comfort >= settings.minComfort ? 'good' : 'warn')
    : '';

  return `<a class="stop ${cls}" href="#/place/${encodeURIComponent(p.id)}">
    <div class="top">
      <div>
        <div class="name">${esc(places.label(p))}</div>
        <p class="where">${esc(places.whereLine(p) || places.KIND_LABELS[p.kind] || '')}</p>
      </div>
      <div class="dist">${esc(geo.fmtMiles(dist))}<small>${mins != null ? esc(fmtDuration(mins)) : (c.ahead === false ? 'behind' : 'away')}</small></div>
    </div>
    <div class="pills">${chips.filter(Boolean).join('')}</div>
  </a>`;
}

function manualHeadingPicker() {
  const current = loc.manual();
  const dirs = [
    { v: 0, l: 'North' }, { v: 90, l: 'East' },
    { v: 180, l: 'South' }, { v: 270, l: 'West' }
  ];
  return card('Set your heading by hand', 'when the phone will not give one',
    `<p class="small muted" style="margin:0 0 10px">
      Which way are you pointing? Without this, the app cannot tell what is ahead of you
      from what is behind you, and it will not guess.</p>
     <div class="opts">${dirs.map(d =>
      `<button type="button" data-heading="${d.v}" aria-pressed="${current === d.v}">${d.l}</button>`
    ).join('')}</div>
     ${current != null ? '<div class="spacer"></div><button class="btn ghost" data-act="clear-heading">Clear it</button>' : ''}`);
}

/* ---------- the stop screen ---------- */

async function renderNow() {
  await refreshSummaries();
  meta = db.getMeta();
  const s = loc.state();
  const p = plan(meta.lastStopAt, s.speedMps, settings);

  const dueLabel = p.dueInMin <= 0 ? 'Overdue by' : 'Next stop in';
  const pct = p.elapsedMin == null ? 0
    : Math.max(0, Math.min(100, (p.elapsedMin / p.intervalMin) * 100));

  const timerCard = card(null, null, `
    <div class="due ${p.status}">
      <div class="cap">${esc(dueLabel)}</div>
      <div class="num">${esc(fmtDuration(Math.abs(p.dueInMin)))}</div>
      <div class="cap">${meta.lastStopAt
        ? 'last stop ' + esc(fmtDate(meta.lastStopAt))
        : 'no stop logged yet — the clock starts when you tap below'}</div>
    </div>
    <div class="meter ${p.status === 'overdue' ? 'overdue' : ''}"><i style="width:${pct}%"></i></div>
    <div class="spacer"></div>
    <button class="btn" data-act="stopped">I stopped — restart the clock</button>
    <div class="spacer"></div>
    <p class="small muted" style="margin:0">
      Looking ${esc(geo.fmtMiles(p.windowFromM, 0))} to ${esc(geo.fmtMiles(p.windowToM, 0))} ahead,
      at ${Math.round(p.speedMph)} mph${p.speedIsMeasured ? '' : ' (assumed — no speed reading yet)'}.
      You would get there around ${esc(bandLabel(p.arrivingBand))}.
    </p>`);

  if (!s.fix) {
    return headerBar() + sampleWarning() + noDataWarning() + timerCard +
      card('Waiting for a position', null,
        `<p class="small muted" style="margin:0 0 10px">${esc(loc.errorText() || 'Getting a fix from the satellites. In a canyon or under cover this takes a minute.')}</p>
         <a class="btn ghost" href="#/data" style="display:block;text-align:center;text-decoration:none;line-height:1.2">Open the data screen</a>`) +
      manualHeadingPicker();
  }

  const heading = s.heading;
  const radius = Math.max(p.windowToM * 1.25, 40 * MI);
  const nearby = await places.within(s.fix, radius);

  let candidates = geo.relativeTo(s.fix, heading, nearby, {
    coneDeg: settings.coneDeg,
    minAlong: 0.4 * MI,
    maxAlong: radius,
    sideTolerance: settings.sideToleranceM
  });

  if (heading != null && settings.hideOppositeSide) {
    /* Drop only what is known to be across the median. 'unclear' and 'unknown'
     * are both kept: showing a stop with a warning on it costs a driver a
     * glance, and hiding one she could have used costs her the stop. */
    candidates = candidates.filter(c => c.side !== 'other');
  }

  const picked = choose(candidates, summaries, settings, p);
  const rowOpts = { metresPerMin: p.metresPerMin };

  let body = '';

  if (heading == null) {
    body += banner('info', 'Direction unknown',
      'Nothing is being filtered by direction of travel yet, so some of these may be behind you or across the median. Set your heading below, or start moving.');
  }

  if (picked.planned.length) {
    body += `<div class="section-title">Rated stops in your window</div>`;
    body += picked.planned.slice(0, 6).map(c => stopRow(c, rowOpts)).join('');
  } else {
    body += banner('info', 'Nothing rated well in range',
      'No stop in your planning window has been rated ' + settings.minComfort +
      ' or better. The nearest options ahead are below — they have not been checked by anyone, so treat them as unknown.');
  }

  if (picked.window.length) {
    body += `<div class="section-title">Also in the window — not rated</div>`;
    body += picked.window.slice(0, 5).map(c => stopRow(c, rowOpts)).join('');
  }

  const shownIds = new Set([...picked.planned, ...picked.window].map(c => c.place.id));
  const fallback = picked.nearest.filter(c => !shownIds.has(c.place.id));
  if (fallback.length) {
    body += `<div class="section-title">Nearest ahead, whatever the rating</div>`;
    body += fallback.slice(0, 5).map(c => stopRow(c, rowOpts)).join('');
  }

  if (!picked.planned.length && !picked.window.length && !fallback.length) {
    body += `<div class="empty">Nothing ahead within ${esc(geo.fmtMiles(radius, 0))}.
      Either the dataset does not cover this road or you are between stops.
      <br><br><a class="back" href="#/nearby">Look in every direction instead</a></div>`;
  }

  return headerBar() + sampleWarning() + noDataWarning() + timerCard + body +
    (heading == null ? manualHeadingPicker() : '');
}

function bandLabel(band) {
  return { morning: 'morning', day: 'the middle of the day', evening: 'the evening', night: 'overnight' }[band] || band;
}

/* ---------- nearby ---------- */

let nearbyRadiusMi = 25;
let nearbyAheadOnly = false;

async function renderNearby() {
  await refreshSummaries();
  const s = loc.state();
  if (!s.fix) {
    return headerBar() + card('No position yet', null,
      `<p class="small muted" style="margin:0">${esc(loc.errorText() || 'Waiting for a fix.')}</p>`) +
      manualHeadingPicker();
  }

  const radius = nearbyRadiusMi * MI;
  const found = await places.within(s.fix, radius);

  let rows;
  if (nearbyAheadOnly && s.heading != null) {
    rows = geo.relativeTo(s.fix, s.heading, found, {
      coneDeg: settings.coneDeg, minAlong: 0, maxAlong: radius,
      sideTolerance: settings.sideToleranceM
    });
  } else {
    rows = found.map(pl => {
      const info = geo.assessSide(s.fix, s.heading, pl, { toleranceM: settings.sideToleranceM });
      return {
        place: pl,
        distance: geo.distance(s.fix, pl),
        along: geo.distance(s.fix, pl),
        ahead: s.heading == null ? null : Math.abs(geo.turn(s.heading, geo.bearing(s.fix, pl))) <= 90,
        side: info.side,
        sideBasis: info.basis
      };
    }).sort((a, b) => a.distance - b.distance);
  }

  const controls = card('Everything around you', rows.length + ' found', `
    <div class="opts">
      ${[5, 25, 60, 150].map(mi =>
        `<button type="button" data-radius="${mi}" aria-pressed="${nearbyRadiusMi === mi}">${mi} mi</button>`
      ).join('')}
    </div>
    <div class="spacer"></div>
    <div class="opts">
      <button type="button" data-aheadonly="0" aria-pressed="${!nearbyAheadOnly}">Every direction</button>
      <button type="button" data-aheadonly="1" aria-pressed="${nearbyAheadOnly}">Ahead of me only</button>
    </div>`);

  const list = rows.length
    ? rows.slice(0, 60).map(c => stopRow(c, { useDistance: true })).join('')
    : `<div class="empty">Nothing within ${nearbyRadiusMi} miles in the loaded data.</div>`;

  return headerBar() + sampleWarning() + controls + list;
}

/* ---------- one place ---------- */

async function renderPlace(id) {
  await refreshSummaries();
  const p = await places.byId(id);
  if (!p) return `<a class="back" href="#/">‹ Back</a>` + banner('warn', 'Not found', 'That stop is not in the data on this phone.');

  const list = await obs.forPlace(id);
  const sum = summaries.get(id);
  const s = loc.state();

  let position = '';
  if (s.fix) {
    const d = geo.distance(s.fix, p);
    const info = geo.assessSide(s.fix, s.heading, p, { toleranceM: settings.sideToleranceM });
    const ahead = s.heading != null ? Math.abs(geo.turn(s.heading, geo.bearing(s.fix, p))) <= 90 : null;
    position = `<div class="pills" style="margin-bottom:14px">
      ${pill(geo.fmtMiles(d) + ' away')}
      ${ahead === true ? pill('Ahead', 'green') : ahead === false ? pill('Behind you', 'red') : ''}
      ${sideOf({ side: info.side, sideBasis: info.basis })}
    </div>`;
  }

  const flags = places.baseFlags(p);
  const baseCard = card('What the public data says',
    p.stub ? 'shared with a note' : (p.sources?.[0]?.source || ''),
    (flags.length
      ? `<div class="pills">${flags.map(f => pill(f.label, f.state === 'no' ? 'red' : f.state === 'yes' ? 'green' : '')).join('')}</div>`
      : '<p class="small muted" style="margin:0">The source lists this stop but says nothing about what is at it.</p>') +
    `<p class="small muted" style="margin:12px 0 0">
      This is what a transport department or a map database recorded. It says a restroom exists.
      It does not say whether it is open, clean, lit, or safe to walk to.</p>`);

  let summaryCard;
  if (!sum) {
    summaryCard = card('Nobody has logged this one', null,
      `<p class="small muted" style="margin:0 0 12px">
        No driver has written anything about this stop on this phone. If you stop here, what you write
        is what you or anyone you share with will see next time.</p>
       <a class="btn" href="#/log/${encodeURIComponent(id)}" style="display:block;text-align:center;text-decoration:none;line-height:1.2">Log a visit</a>`);
  } else {
    const a = sum.access || {};
    const doorWord = {
      single_locking: 'Single, locks', multi_stall_locking: 'Stalls, outer door locks', multi_stall: 'Open multi-stall'
    }[a.door] || 'Not recorded';
    const hoursWord = {
      '24h': '24 hours', daytime: 'Daylight only', business_hours: 'Business hours', unknown: 'Not sure'
    }[a.hours] || 'Not recorded';
    const sightWord = { clear: 'Clear', partial: 'Partial', blind: 'Blind' }[sum.sightline] || 'Not recorded';
    const sightNum = { clear: 5, partial: 3, blind: 1 }[sum.sightline] ?? null;

    summaryCard = card('What drivers found',
      `${sum.count} note${sum.count === 1 ? '' : 's'} · ${sum.authors} ${sum.authors === 1 ? 'person' : 'people'}`,
      `<div class="grades">
        ${grade('Would stop again', sum.comfort, obs.ratingWord(sum.comfort))}
        ${grade('Lighting, worst part', sum.lighting, obs.ratingWord(sum.lighting))}
        ${grade('Cleanliness', sum.cleanliness, obs.ratingWord(sum.cleanliness))}
        ${grade('View of the door', sightNum, sightWord)}
      </div>
      <div class="spacer"></div>
      <div class="kv"><span class="k">Door</span><span class="v">${esc(doorWord)}</span></div>
      <div class="kv"><span class="k">Hours</span><span class="v">${esc(hoursWord)}</span></div>
      <div class="kv"><span class="k">Walk from truck parking</span><span class="v">${sum.walk_m != null
        ? esc(geo.fmtFeet(sum.walk_m)) + ' · about ' + geo.walkMinutes(sum.walk_m) + ' min' : 'Not recorded'}</span></div>
      <div class="kv"><span class="k">Getting in</span><span class="v">${esc({
        none: 'Open to all', key: 'Ask for a key', code: 'Door code', purchase: 'Must buy something'
      }[a.requires] || 'Not recorded')}</span></div>
      <div class="kv"><span class="k">Last logged</span><span class="v">${esc(obs.ageWord(sum.lastAgeDays))}</span></div>
      ${parkingRows(sum.parking)}
      ${sum.disagreement ? `<div class="spacer"></div>` + banner('warn', 'Drivers disagree here',
        'The ratings for this stop are a long way apart. Both are below, with their dates. Read them rather than the average.') : ''}
      ${sum.stale ? `<div class="spacer"></div>` + banner('warn', 'These notes are over a year old',
        'Lighting gets fixed and lights burn out. Treat this as a starting point, not the current state.') : ''}
      <div class="spacer"></div>
      <a class="btn" href="#/log/${encodeURIComponent(id)}" style="display:block;text-align:center;text-decoration:none;line-height:1.2">Log a visit</a>`);
  }

  const history = list.length ? card('Every note, newest first', null,
    list.map(o => observationBlock(o)).join('')) : '';

  return `<a class="back" href="#/">‹ Back to stops</a>
    <div class="bar"><div>
      <h1>${esc(places.label(p))}</h1>
      <p class="sub">${esc(places.whereLine(p) || places.KIND_LABELS[p.kind] || '')}</p>
    </div></div>
    ${position}${summaryCard}${baseCard}${history}`;
}

function parkingRows(parking) {
  const bands = [['morning', 'Morning'], ['day', 'Midday'], ['evening', 'Evening'], ['night', 'Overnight']];
  const known = bands.filter(([k]) => parking && parking[k]);
  if (!known.length) return '';
  const word = { plenty: 'Plenty of room', some: 'Some room', full: 'Full' };
  return known.map(([k, l]) =>
    `<div class="kv"><span class="k">Truck parking, ${esc(l.toLowerCase())}</span><span class="v">${esc(word[parking[k]])}</span></div>`
  ).join('');
}

function observationBlock(o) {
  const facts = [];
  const a = o.access || {}, s = o.safety || {}, pr = o.practical || {};
  const push = (label, value) => { if (value != null && value !== '') facts.push(`<b>${esc(label)}:</b> ${esc(value)}`); };

  push('Would stop again', s.comfort != null ? s.comfort + '/5' : null);
  push('Cleanliness', pr.cleanliness != null ? pr.cleanliness + '/5' : null);
  const lights = [
    s.light_lot != null ? 'lot ' + s.light_lot : null,
    s.light_path != null ? 'path ' + s.light_path : null,
    s.light_interior != null ? 'inside ' + s.light_interior : null
  ].filter(Boolean).join(', ');
  push('Lighting', lights || null);
  push('View of the door', { clear: 'clear', partial: 'partial', blind: 'blind' }[s.sightline]);
  push('Walk', s.walk_m != null ? geo.fmtFeet(s.walk_m) : null);
  push('Door', { single_locking: 'single, locks', multi_stall_locking: 'stalls, outer door locks', multi_stall: 'open multi-stall' }[a.door]);
  push('Stalls', a.stalls);
  push('Building', { inside: 'inside a building', detached: 'standalone block' }[a.interior]);
  push('Hours', { '24h': '24 hours', daytime: 'daylight only', business_hours: 'business hours', unknown: 'not sure' }[a.hours] + (a.hours_note ? ' — ' + a.hours_note : ''));
  push('Getting in', { none: 'open to all', key: 'ask for key', code: 'door code', purchase: 'must buy something' }[a.requires]);
  const people = [
    s.staffed === true ? 'staffed' : s.staffed === false ? 'nobody on site' : null,
    s.security === true ? 'security present' : null,
    s.cameras === true ? 'cameras' : s.cameras === false ? 'no cameras' : null
  ].filter(Boolean).join(', ');
  push('On site', people || null);
  push('Truck spots', pr.parking_spots);
  const amen = [
    pr.showers === true ? 'showers' : null,
    pr.laundry === true ? 'laundry' : null,
    pr.food === true ? 'food' : null
  ].filter(Boolean).join(', ');
  push('Also here', amen || null);

  const mine = o.author === db.deviceId();
  return `<div class="obs">
    <div class="head">
      <span class="when">${esc(fmtDay(o.observed_at))}</span>
      <span class="who">${mine ? 'you' : esc(o.author || 'shared')}</span>
    </div>
    ${facts.length ? `<p class="facts">${facts.join(' · ')}</p>` : ''}
    ${o.notes ? `<p class="note">${esc(o.notes)}</p>` : ''}
    ${mine ? `<div class="spacer"></div><button class="btn ghost" data-act="delete-obs" data-id="${esc(o.obs_id)}" style="padding:10px;font-size:14px">Delete this note</button>` : ''}
  </div>`;
}

/* ---------- the log form ---------- */

async function renderLog(id) {
  const p = await places.byId(id);
  if (!p) return banner('warn', 'Not found', 'That stop is not in the data on this phone.');
  if (!draft || draft.place_id !== id) draft = obs.blank(id);

  const F = obs.FIELDS;
  const a = draft.access, s = draft.safety, pr = draft.practical;

  return `<a class="back" href="#/place/${encodeURIComponent(id)}">‹ Back</a>
    <div class="bar"><div>
      <h1>Log a visit</h1>
      <p class="sub">${esc(places.label(p))}</p>
    </div></div>
    ${banner('info', 'Answer only what you noticed',
      'Every question can be left blank. A note that says one useful thing is worth saving, and it saves it. Nothing here is sent anywhere.')}

    ${card('Getting in', null,
      field('Is the restroom inside a building, or its own block?',
        'A standalone block usually means no one is watching the door.',
        options('access.interior', F.interior, a.interior)) +
      field('When is it open?', '', options('access.hours', F.hours, a.hours)) +
      field('The door', 'A door that locks behind you is the single thing most drivers ask about.',
        options('access.door', F.door, a.door)) +
      field('How many stalls?', '', stepper('access.stalls', a.stalls, 'stalls')) +
      field('Do you need anything to get in?', '', options('access.requires', F.requires, a.requires)))}

    ${card('Safety', null,
      field('Lighting — the parking lot', '', scale5('safety.light_lot', s.light_lot, 'Dark', 'Bright')) +
      field('Lighting — the walk to the door',
        'Rated on its own, because a bright lot with a dark path is the common case and the dangerous one.',
        scale5('safety.light_path', s.light_path, 'Dark', 'Bright')) +
      field('Lighting — inside', '', scale5('safety.light_interior', s.light_interior, 'Dark', 'Bright')) +
      field('Can you see the restroom door from truck parking?',
        'Whether anyone in the lot would see something happen at that door.',
        options('safety.sightline', F.sightline, s.sightline)) +
      field('How far is the walk?', '', stepper('safety.walk_m', s.walk_m, 'metres', 10)) +
      field('Anyone on site?', '', triState('safety.staffed', s.staffed)) +
      field('Security guard?', '', triState('safety.security', s.security)) +
      field('Cameras?', '', triState('safety.cameras', s.cameras)) +
      field('Would you stop here again?', 'The one that decides whether this shows up in your list next time.',
        scale5('safety.comfort', s.comfort, 'Never', 'Any time')))}

    ${card('Practical', null,
      field('How clean?', '', scale5('practical.cleanliness', pr.cleanliness, 'Filthy', 'Spotless')) +
      field('Truck spots, roughly', '', stepper('practical.parking_spots', pr.parking_spots, 'spots', 5)) +
      field('Room to park, at this time of day', 'Whether a lot is full at 9pm says nothing about 9am, so it is asked per time of day.',
        F.bands.map(b => `<div class="small muted" style="margin:8px 0 5px">${esc(b.l)}</div>` +
          options('practical.parking_availability.' + b.v, F.availability, pr.parking_availability?.[b.v])
        ).join('')) +
      field('Showers?', '', triState('practical.showers', pr.showers)) +
      field('Laundry?', '', triState('practical.laundry', pr.laundry)) +
      field('Food?', '', triState('practical.food', pr.food)))}

    ${card('Anything else', 'the part other drivers read first',
      `<textarea data-text="notes" placeholder="Which door, where to park, what was off. For example: door faces away from the truck lot, lot light out at the north end.">${esc(draft.notes)}</textarea>`)}

    ${card('When were you there?', null,
      `<input type="datetime-local" data-when="observed_at" value="${esc(toLocalInput(draft.observed_at))}">
       <p class="small muted" style="margin:8px 0 0">Defaults to now. Change it if you are writing this up the next morning.</p>`)}

    <button class="btn" data-act="save-obs">Save this note</button>
    <div class="spacer"></div>
    <button class="btn ghost" data-act="save-obs-and-stop">Save and restart my stop clock</button>`;
}

function toLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- data ---------- */

async function renderData() {
  meta = db.getMeta();
  const obsCount = await db.count(db.STORE_OBSERVATIONS);
  const placeCount = await db.count(db.STORE_PLACES);
  const stubCount = await db.count(db.STORE_STUBS);
  const est = await db.storageEstimate();
  const usedMb = est && est.usage != null ? (est.usage / 1048576).toFixed(1) + ' MB' : 'unknown';

  return `<div class="bar"><div><h1>Data</h1>
    <p class="sub">All of it is on this phone</p></div></div>

    ${sampleWarning()}

    ${card('What is on here', null,
      `<div class="kv"><span class="k">Your notes</span><span class="v">${obsCount}</span></div>
       <div class="kv"><span class="k">Stops in the dataset</span><span class="v">${placeCount}</span></div>
       ${stubCount ? `<div class="kv"><span class="k">Stops that came with shared notes</span><span class="v">${stubCount}</span></div>` : ''}
       <div class="kv"><span class="k">Dataset</span><span class="v">${esc(meta.datasetName || 'none')}${meta.datasetSample ? ' (demo)' : ''}</span></div>
       <div class="kv"><span class="k">Dataset built</span><span class="v">${meta.datasetGeneratedAt ? esc(fmtDay(meta.datasetGeneratedAt)) : '—'}</span></div>
       <div class="kv"><span class="k">Space used</span><span class="v">${esc(usedMb)}</span></div>
       <div class="kv"><span class="k">Your author mark</span><span class="v">${esc(db.deviceId())}</span></div>`)}

    ${card('Share your notes', 'no server, no account', `
      <p class="small muted" style="margin:0 0 12px">
        Export writes one file with every note you have taken. Send it to another driver however you
        like. Import reads a file someone sent you and adds their notes to yours — it never overwrites
        anything you wrote, and running the same file twice is harmless.</p>
      <div class="row2">
        <button class="btn" data-act="export-obs">Export notes</button>
        <button class="btn ghost" data-act="import-obs">Import a file</button>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="export-backup">Export everything (backup)</button>
      <p class="small muted" style="margin:10px 0 0">
        ${meta.lastExportAt ? 'Last export ' + esc(fmtDate(meta.lastExportAt)) + '.' : 'Never exported.'}
        A phone that is lost or wiped takes its notes with it. Save a backup somewhere off the phone now and then.</p>
      <input type="file" data-file="obs" accept="application/json,.json" hidden>`)}

    ${card('Map data', null, `
      <p class="small muted" style="margin:0 0 12px">
        The stops themselves come from public sources, built into a file by the import pipeline and
        loaded once. Do it over Wi-Fi. After that the app never needs a signal again.</p>
      <button class="btn ghost" data-act="import-dataset">Load a dataset file</button>
      <input type="file" data-file="dataset" accept="application/json,.json" hidden>`)}

    ${card('Housekeeping', null, `
      <button class="btn ghost" data-act="new-device-id">Get a new author mark</button>
      <p class="small muted" style="margin:10px 0 16px">
        Your author mark is four random characters. It is not your name and it is not linked to you or
        this phone — it only lets someone reading pooled notes tell one person's six notes apart from
        six people agreeing. Replace it whenever you want; nothing breaks.</p>
      <button class="btn ghost" data-act="wipe" style="border-color:#5a312b;color:#d96a5a">Delete everything on this phone</button>`)}

    <a class="btn ghost" href="#/privacy" style="display:block;text-align:center;text-decoration:none;line-height:1.2">What this app stores, in plain words</a>
    <div class="spacer"></div>
    <a class="btn ghost" href="#/settings" style="display:block;text-align:center;text-decoration:none;line-height:1.2">Settings</a>`;
}

/* ---------- settings ---------- */

async function renderSettings() {
  settings = db.getSettings();
  return `<a class="back" href="#/data">‹ Back</a>
    <div class="bar"><div><h1>Settings</h1><p class="sub">How the app plans your stops</p></div></div>

    ${card('Stop interval', 'how long between breaks',
      stepper('set.intervalMinutes', settings.intervalMinutes, 'minutes', 15) +
      `<p class="small muted" style="margin:10px 0 0">Default is 150 minutes — two and a half hours.</p>`)}

    ${card('Planning window', 'how far either side of that counts',
      stepper('set.windowMinutes', settings.windowMinutes, 'minutes', 5) +
      `<p class="small muted" style="margin:10px 0 0">
        Stops within this much of your target time are shown as planned options, early enough to choose between.</p>`)}

    ${card('Rated well enough', 'the bar for the main list',
      scale5('set.minComfort', settings.minComfort, 'Anything', 'Only the best') +
      `<p class="small muted" style="margin:10px 0 0">
        Stops rated below this are still shown, in their own section, marked. Nothing is hidden from you.</p>`)}

    ${card('Direction of travel', null,
      `<span class="q">How wide is "ahead of me"?</span>
       ${stepper('set.coneDeg', settings.coneDeg, 'degrees either side', 5)}
       <div class="spacer"></div>
       <span class="q">Hide stops across the median</span>
       <p class="why">On a divided highway the far side costs you an exit, a turnaround, and the time back. Stops the app is unsure about are always kept.</p>
       ${options('set.hideOppositeSide', [{ v: 'true', l: 'Hide them' }, { v: 'false', l: 'Show them' }], String(settings.hideOppositeSide))}
       <div class="spacer"></div>
       <span class="q">How close counts as the same side</span>
       ${stepper('set.sideToleranceM', settings.sideToleranceM, 'metres', 10)}`)}

    ${card('Speed used before a reading arrives', null,
      stepper('set.assumedSpeedMph', settings.assumedSpeedMph, 'mph', 1))}

    ${card('Battery', null,
      `<span class="q">Position accuracy</span>
       <p class="why">Precise positioning uses noticeably more battery. Coarse is usually enough to tell which stop is next, but is worse at working out your heading.</p>
       ${options('set.highAccuracy', [{ v: 'true', l: 'Precise' }, { v: 'false', l: 'Coarse, save battery' }], String(settings.highAccuracy))}
       <p class="small muted" style="margin:10px 0 0">
         Either way the receiver switches off the moment this app is not on screen.</p>`)}`;
}

/* ---------- the plain-words data note ---------- */

async function renderPrivacy() {
  return `<a class="back" href="#/data">‹ Back</a>
    <div class="bar"><div><h1>Your data</h1><p class="sub">In plain words</p></div></div>

    ${card('The short version', null, `<p class="small" style="margin:0;line-height:1.6">
      Everything this app knows is on this phone. Nothing is sent anywhere. There is no account, no
      sign-in, and no company holding a copy. If you turn the phone off, that is the end of it.</p>`)}

    ${card('Where you are', null, `<p class="small" style="margin:0;line-height:1.6">
      The app asks your phone for your position so it can tell which stops are ahead of you and which
      are across the median. That position is used on the spot and then forgotten. It is never saved,
      never written to a history, and never sent off the phone. Close the app and it is gone.
      <br><br>
      The satellite receiver only runs while a screen that needs it is open. Switch to another app and
      it stops, which is also why it does not flatten your battery.</p>`)}

    ${card('What is saved', null, `<p class="small" style="margin:0;line-height:1.6">
      Two things. The stop list, which is public map data you loaded once. And your notes — what you
      wrote about a place you stopped at, with the date. That is it.
      <br><br>
      Your notes carry a four-character mark like <b>dev-7c1a9e</b> so that when notes get pooled, one
      driver's six notes can be told apart from six drivers agreeing. It is random. It is not your
      name, it is not your phone number, and it is not built from anything about you or your phone.
      Change it any time on the Data screen.</p>`)}

    ${card('Sharing', null, `<p class="small" style="margin:0;line-height:1.6">
      Sharing is a file you export and hand over. You choose who gets it, and you can read it first —
      it is plain text.
      <br><br>
      This is on purpose. A shared service holding all of this would be a list of where women stopped,
      when, and how often. That list could be subpoenaed, sold, hacked, or handed over. Because the
      app has no server, that list does not exist anywhere and cannot be handed to anyone.</p>`)}

    ${card('What is not here', null, `<p class="small" style="margin:0;line-height:1.6">
      No account. No advertising. No tracking of any kind — no analytics, no usage measurement, no
      crash reporting. Nothing that shares your live location with anyone. No comments, no followers,
      no feed. None of that is switched off in a setting; it was never built.</p>`)}

    ${card('The one thing to watch', null, `<p class="small" style="margin:0;line-height:1.6">
      Because nothing is in the cloud, a lost, broken, or wiped phone loses your notes. Export a backup
      now and then and save it somewhere else — your own cloud drive, a laptop, an email to yourself.
      That copy is yours and it goes wherever you put it.</p>`)}`;
}

/* ---------- one click handler for the whole app ---------- */

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act],[data-set],[data-step],[data-radius],[data-aheadonly],[data-heading]');
  if (!t) return;

  /* form widgets */
  if (t.dataset.set) {
    ev.preventDefault();
    const path = t.dataset.set;
    const raw = t.dataset.value;
    if (path.startsWith('set.')) {
      const key = path.slice(4);
      const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
      settings = db.saveSettings({ [key]: value });
      render();
      return;
    }
    if (!draft) return;
    const value = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null
      : /^-?\d+$/.test(raw) ? Number(raw) : raw;
    const current = getPath(draft, path);
    setPath(draft, path, current === value ? null : value);
    repaintForm();
    return;
  }

  if (t.dataset.step) {
    ev.preventDefault();
    const path = t.dataset.step;
    const delta = Number(t.dataset.delta);
    if (path.startsWith('set.')) {
      const key = path.slice(4);
      const limits = {
        intervalMinutes: [30, 480], windowMinutes: [5, 120], coneDeg: [15, 90],
        sideToleranceM: [10, 300], assumedSpeedMph: [25, 80]
      }[key] || [0, 10000];
      const next = Math.max(limits[0], Math.min(limits[1], (settings[key] || 0) + delta));
      settings = db.saveSettings({ [key]: next });
      render();
      return;
    }
    if (!draft) return;
    const current = getPath(draft, path);
    const next = Math.max(0, (current == null ? 0 : current) + delta);
    setPath(draft, path, next === 0 && delta < 0 ? null : next);
    repaintForm();
    return;
  }

  if (t.dataset.radius) { nearbyRadiusMi = Number(t.dataset.radius); render(); return; }
  if (t.dataset.aheadonly) { nearbyAheadOnly = t.dataset.aheadonly === '1'; render(); return; }
  if (t.dataset.heading) { loc.setManualHeading(Number(t.dataset.heading)); render(); return; }

  const act = t.dataset.act;
  if (!act) return;
  ev.preventDefault();

  if (act === 'clear-heading') { loc.clearManualHeading(); render(); return; }

  if (act === 'stopped') {
    meta = db.saveMeta({ lastStopAt: new Date().toISOString() });
    toast('Clock restarted');
    render();
    return;
  }

  if (act === 'save-obs' || act === 'save-obs-and-stop') {
    if (!draft) return;
    readFreeText();
    const placeId = draft.place_id;
    draft.created_at = new Date().toISOString();
    await obs.save(draft);
    if (act === 'save-obs-and-stop') db.saveMeta({ lastStopAt: new Date().toISOString() });
    draft = null;
    toast('Saved on this phone');
    location.hash = '#/place/' + encodeURIComponent(placeId);
    return;
  }

  if (act === 'delete-obs') {
    if (!confirm('Delete this note? It cannot be got back unless it is in a backup file.')) return;
    await obs.remove(t.dataset.id);
    toast('Deleted');
    render();
    return;
  }

  if (act === 'export-obs') {
    const file = await exchange.exportObservations();
    if (!file.observations.length) { toast('No notes to export yet', true); return; }
    exchange.download(file, `parity-observations-${exchange.stamp()}.json`);
    meta = db.saveMeta({ lastExportAt: new Date().toISOString() });
    toast(`${file.observations.length} notes exported`);
    return;
  }

  if (act === 'export-backup') {
    const file = await exchange.exportBackup();
    exchange.download(file, `parity-backup-${exchange.stamp()}.json`);
    meta = db.saveMeta({ lastExportAt: new Date().toISOString() });
    toast('Backup saved');
    return;
  }

  if (act === 'import-obs') { document.querySelector('[data-file="obs"]').click(); return; }
  if (act === 'import-dataset') { document.querySelector('[data-file="dataset"]').click(); return; }

  if (act === 'new-device-id') {
    if (!confirm('Get a new author mark? Notes you already wrote keep the old one.')) return;
    db.newDeviceId();
    toast('New mark: ' + db.deviceId());
    render();
    return;
  }

  if (act === 'wipe') {
    if (!confirm('Delete every note and all map data on this phone? Export a backup first if you have not.')) return;
    if (!confirm('Last check — this cannot be undone.')) return;
    await db.clear(db.STORE_OBSERVATIONS);
    await db.clear(db.STORE_PLACES);
    await db.clear(db.STORE_STUBS);
    places.invalidate();
    db.saveMeta({ datasetName: null, datasetCount: 0, datasetSample: null, lastStopAt: null });
    meta = db.getMeta();
    toast('Everything deleted');
    render();
    return;
  }
});

/* The free-text and date inputs are read back at save time rather than on every
 * keystroke, so typing never triggers a redraw. */
function readFreeText() {
  const notes = document.querySelector('[data-text="notes"]');
  if (notes && draft) draft.notes = notes.value;
  const when = document.querySelector('[data-when="observed_at"]');
  if (when && when.value && draft) {
    const d = new Date(when.value);
    if (!Number.isNaN(d.getTime())) draft.observed_at = d.toISOString();
  }
}

/* Redraw the form without losing what is typed in the text box. */
async function repaintForm() {
  readFreeText();
  const scroll = window.scrollY;
  view.innerHTML = await renderLog(draft.place_id);
  window.scrollTo(0, scroll);
  lastPaint = Date.now();
}

document.addEventListener('change', async (ev) => {
  const input = ev.target.closest('[data-file]');
  if (!input || !input.files || !input.files[0]) return;
  const kind = input.dataset.file;
  const file = input.files[0];
  input.value = '';
  try {
    const data = await exchange.readFile(file);
    if (kind === 'dataset') {
      const n = await places.loadDataset(data);
      meta = db.getMeta();
      toast(`${n} stops loaded`);
      render();
    } else {
      const report = await exchange.importObservations(data);
      let msg = `${report.added} added`;
      if (report.alreadyHad) msg += `, ${report.alreadyHad} already here`;
      if (report.rejected.length) msg += `, ${report.rejected.length} unreadable`;
      toast(msg);
      render();
    }
  } catch (err) {
    toast(err.message || 'That file could not be read', true);
  }
});

/* ---------- start ---------- */

(async function start() {
  try {
    await places.loadBundledIfEmpty();
  } catch { /* the data screen explains what to do */ }
  meta = db.getMeta();
  db.deviceId();
  await render();
  /* Ask the browser to keep this data rather than throwing it out when space
   * runs short. A driver's notes are not a cache. */
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then(has => { if (!has) navigator.storage.persist(); });
  }
})();
