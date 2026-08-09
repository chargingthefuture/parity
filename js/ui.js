/* Parity — small rendering helpers shared by the screens.
 *
 * Screens are built as strings and handed to the browser in one go, with clicks
 * caught by one listener on the page rather than one per button. On a phone
 * that is holding a position fix and a few thousand rows in memory, that is the
 * difference between a screen that redraws instantly and one that stutters.
 */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
export function toast(message, bad = false) {
  document.querySelectorAll('.toast').forEach(n => n.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), bad ? 6000 : 2600);
}

/** A 1-to-5 rating row. `name` is read back by the form reader. */
export function scale5(name, value, lowLabel, highLabel) {
  const buttons = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" data-set="${esc(name)}" data-value="${n}"
       aria-pressed="${value === n}" aria-label="${n} out of 5">${n}</button>`
  ).join('');
  return `<div class="scale5">${buttons}</div>
    <div class="scale-ends"><span>${esc(lowLabel)}</span><span>${esc(highLabel)}</span></div>`;
}

/** A row of choices, one selectable. Tapping the chosen one again clears it,
 *  because a wrong tap while driving must be undoable in one more tap. */
export function options(name, choices, value, extraClass = '') {
  return `<div class="opts ${extraClass}">` + choices.map(c =>
    `<button type="button" data-set="${esc(name)}" data-value="${esc(c.v)}"
       aria-pressed="${value === c.v}">${esc(c.l)}</button>`
  ).join('') + '</div>';
}

/** Yes / No / Not sure. "Not sure" is a real answer and is stored as unknown,
 *  never as "no" — the difference matters when reading someone else's note. */
export function triState(name, value) {
  const choices = [
    { v: 'true', l: 'Yes' },
    { v: 'false', l: 'No' },
    { v: 'null', l: 'Not sure' }
  ];
  const current = value === true ? 'true' : value === false ? 'false' : value === null ? 'null' : '';
  return options(name, choices, current, 'tri');
}

/** A plus/minus counter, sized for a thumb. */
export function stepper(name, value, unit, step = 1) {
  return `<div class="numrow">
    <button type="button" data-step="${esc(name)}" data-delta="${-step}" aria-label="less">−</button>
    <div class="val">${value == null ? '—' : esc(value)}<small>${esc(unit)}</small></div>
    <button type="button" data-step="${esc(name)}" data-delta="${step}" aria-label="more">+</button>
  </div>`;
}

export function field(question, why, body) {
  return `<div class="field">
    <span class="q">${esc(question)}</span>
    ${why ? `<p class="why">${esc(why)}</p>` : ''}
    ${body}
  </div>`;
}

export function gradeClass(n) {
  if (n == null) return 'gn';
  return 'g' + Math.max(1, Math.min(5, Math.round(n)));
}

export function grade(key, value, word) {
  return `<div class="grade">
    <div class="k">${esc(key)}</div>
    <div class="v ${gradeClass(value)}">${esc(word)}</div>
  </div>`;
}

export function pill(text, cls = '') {
  return `<span class="pill big ${cls}">${esc(text)}</span>`;
}

export function card(title, hint, body) {
  return `<div class="card">
    ${title ? `<div class="lbl">${esc(title)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>` : ''}
    ${body}
  </div>`;
}

export function banner(kind, title, text) {
  return `<div class="banner ${kind}"><b>${esc(title)}</b>${esc(text)}</div>`;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Read a nested value with a dotted path, for form fields named "safety.comfort". */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = obj;
  for (const k of keys) {
    if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
    target = target[k];
  }
  target[last] = value;
  return obj;
}
