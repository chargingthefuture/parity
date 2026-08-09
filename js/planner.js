/* Parity — planning the next stop.
 *
 * The problem this solves: a stop taken under pressure is taken wherever you
 * happen to be, which at night is how a driver ends up at an unlit lot with a
 * blind walk to a detached restroom. A stop that was picked an hour earlier is
 * a stop that got chosen. So the app works backwards from a target interval and
 * shows what is coming up around it, early enough that there is still a choice.
 *
 * The window is expressed in time and converted to distance using the speed you
 * are actually doing, because "in about 40 minutes" is the useful unit and
 * "in 38 miles" is the one the road is marked in.
 */

import { M_PER_MILE } from './geo.js';

export const BANDS = ['morning', 'day', 'evening', 'night'];

/** Which time band a moment falls in. Used to show the parking answer that
 *  matches when you will actually arrive, not the one for right now. */
export function bandFor(date = new Date()) {
  const h = date.getHours();
  if (h < 10) return 'morning';
  if (h < 16) return 'day';
  if (h < 21) return 'evening';
  return 'night';
}

/**
 * Work out where the planning window sits on the road ahead.
 *
 * lastStopAt  ISO timestamp of the last break, or null if none recorded
 * speedMps    current speed from the position fix, or null
 * settings    intervalMinutes, windowMinutes, assumedSpeedMph
 */
export function plan(lastStopAt, speedMps, settings, now = Date.now()) {
  const interval = settings.intervalMinutes;
  const half = settings.windowMinutes;

  const started = lastStopAt ? Date.parse(lastStopAt) : null;
  const elapsedMin = started ? (now - started) / 60000 : null;
  const dueInMin = elapsedMin == null ? interval : interval - elapsedMin;

  /* A speed reading below walking pace means stopped or parked, and using it
   * would collapse the window to nothing. Fall back to a cruising figure. */
  const usable = speedMps != null && speedMps > 4;
  const speedMph = usable ? speedMps * 2.23694 : settings.assumedSpeedMph;
  const metresPerMin = speedMph * M_PER_MILE / 60;

  const fromMin = Math.max(0, dueInMin - half);
  const toMin = Math.max(half, dueInMin + half);

  let status = 'ok';
  if (dueInMin <= 0) status = 'overdue';
  else if (dueInMin <= half) status = 'due';
  else if (dueInMin <= half * 2) status = 'due-soon';

  return {
    intervalMin: interval,
    elapsedMin,
    dueInMin,
    status,
    speedMph,
    speedIsMeasured: usable,
    windowFromM: fromMin * metresPerMin,
    windowToM: toMin * metresPerMin,
    windowFromMin: fromMin,
    windowToMin: toMin,
    metresPerMin,
    arrivingBand: bandFor(new Date(now + Math.max(0, dueInMin) * 60000))
  };
}

/** Turn a distance ahead into "about 25 min" at the speed being used. */
export function minutesAway(metres, metresPerMin) {
  if (!metresPerMin) return null;
  return metres / metresPerMin;
}

export function fmtDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const m = Math.round(Math.abs(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const s = h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
  return minutes < 0 ? s + ' over' : s;
}

/**
 * Choose what to put on the stop screen.
 *
 * candidates are already filtered to "ahead of you, on your side" by geo.js.
 * They come back in three groups, and all three are shown, because the honest
 * answer to "where do I stop next" sometimes is "nothing good is coming up".
 *
 *   planned   rated at or above the driver's bar, inside the timing window
 *   window    inside the window but unrated or below the bar
 *   nearest   the closest options ahead whatever their rating, so there is
 *             always an answer — clearly marked as unrated where they are
 */
export function choose(candidates, summaries, settings, planned) {
  const bar = settings.minComfort;
  const inWindow = c => c.along >= planned.windowFromM && c.along <= planned.windowToM;

  const withSummary = candidates.map(c => ({ ...c, summary: summaries.get(c.place.id) || null }));

  const good = [];
  const other = [];
  for (const c of withSummary) {
    if (!inWindow(c)) continue;
    if (c.summary && c.summary.comfort != null && c.summary.comfort >= bar) good.push(c);
    else other.push(c);
  }

  good.sort((a, b) => (b.summary.rank - a.summary.rank) || (a.along - b.along));

  /* The fallback. Not filtered by rating and not filtered by the window —
   * if nothing good is within range, the nearest stops ahead are still the
   * answer, and they are labelled so nobody mistakes an unrated stop for a
   * checked one. */
  const nearest = withSummary
    .slice()
    .sort((a, b) => a.along - b.along)
    .slice(0, 6);

  return { planned: good, window: other, nearest, usedFallback: good.length === 0 };
}
