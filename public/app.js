'use strict';

// A week is 168 hour slots, indexed day * 24 + hour, with day 0 = Monday.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOTS = 168;

const $ = (id) => document.getElementById(id);

/* ---------- slot encoding: 168 bits -> 21 bytes -> 28 base64url chars ---------- */

function encodeSlots(slots) {
  const bytes = new Uint8Array(21);
  for (let i = 0; i < SLOTS; i++) {
    if (slots[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSlots(str) {
  const out = new Uint8Array(SLOTS);
  let bin;
  try {
    bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return out;
  }
  for (let i = 0; i < SLOTS; i++) {
    const byte = bin.charCodeAt(i >> 3) || 0;
    out[i] = (byte >> (i & 7)) & 1;
  }
  return out;
}

/* ---------- timezones ----------
 * A recurring weekday-hour has no date, so there is no single right UTC offset
 * for it. Rather than freeze one at save time, each person's grid is stored in
 * their own zone and converted only here, against today's date.
 */

function offsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Whole hours between two zones. Half-hour zones (India, Nepal) round to the
// nearest hour, so a slot can sit up to 30 minutes off against a whole-hour zone.
function hourShift(fromTz, toTz, date = new Date()) {
  try {
    return Math.round((offsetMinutes(toTz, date) - offsetMinutes(fromTz, date)) / 60);
  } catch {
    return 0;
  }
}

// Shifting wraps the week: Sunday 23:00 in one zone is Monday morning in another.
function shiftSlots(slots, shift) {
  if (!shift) return slots;
  const out = new Uint8Array(SLOTS);
  for (let i = 0; i < SLOTS; i++) {
    if (slots[i]) out[(((i + shift) % SLOTS) + SLOTS) % SLOTS] = 1;
  }
  return out;
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ?tz=Asia/Tokyo overrides the detected zone, which is what makes the
// conversion testable from a single browser.
function viewerTz() {
  const override = new URLSearchParams(location.search).get('tz');
  if (override && validTz(override)) return override;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const TZ = viewerTz();

function tzLabel(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date);
    const name = parts.find((p) => p.type === 'timeZoneName');
    return name ? `${tz.replace(/_/g, ' ')} (${name.value})` : tz.replace(/_/g, ' ');
  } catch {
    return tz;
  }
}

/* ---------- time formatting ---------- */

const hh = (h) => String(h).padStart(2, '0') + ':00';

function formatRun(start, length) {
  const endIdx = start + length;
  const startDay = Math.floor(start / 24) % 7;
  const endDay = Math.floor(endIdx / 24) % 7;
  const from = `${DAYS[startDay]} ${hh(start % 24)}`;
  const to = endDay === startDay ? hh(endIdx % 24) : `${DAYS[endDay]} ${hh(endIdx % 24)}`;
  return `${from} – ${to}`;
}

function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/* ---------- api ---------- */

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // fall through to a generic message
  }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

/* ---------- local identity ----------
 * A random id in localStorage is the whole of "logging back in": it is what
 * lets someone edit their own row without an account. The cached copy of that
 * row also papers over KV's list lag, so you always see yourself immediately
 * after saving.
 */

const localKey = (code) => `ga:${code}`;

function loadLocal(code) {
  try {
    const raw = localStorage.getItem(localKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocal(code, record) {
  try {
    localStorage.setItem(localKey(code), JSON.stringify(record));
  } catch {
    // private browsing, storage disabled: everything still works for one sitting
  }
}

function clearLocal(code) {
  try {
    localStorage.removeItem(localKey(code));
  } catch {
    // ignore
  }
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- grid ---------- */

function buildGrid(container, { interactive }) {
  const grid = document.createElement('div');
  grid.className = 'grid';

  const corner = document.createElement('div');
  corner.className = 'head corner';
  grid.appendChild(corner);

  for (const day of DAYS) {
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = day;
    grid.appendChild(head);
  }

  const cells = new Array(SLOTS);
  for (let hour = 0; hour < 24; hour++) {
    const label = document.createElement('div');
    label.className = 'hour';
    label.textContent = hh(hour);
    grid.appendChild(label);

    for (let day = 0; day < 7; day++) {
      const idx = day * 24 + hour;
      const cell = document.createElement('div');
      cell.className = `cell day-${day}${hour === 0 ? ' hour-0' : ''}`;
      cell.dataset.idx = String(idx);
      cells[idx] = cell;
      grid.appendChild(cell);
    }
  }

  container.replaceChildren(grid);

  const state = new Uint8Array(SLOTS);
  let painting = false;
  let paintValue = 0;

  const paint = (target) => {
    const cell = target && target.closest ? target.closest('.cell') : null;
    if (!cell || !grid.contains(cell)) return;
    const idx = Number(cell.dataset.idx);
    if (state[idx] === paintValue) return;
    state[idx] = paintValue;
    cell.classList.toggle('on', Boolean(paintValue));
  };

  if (interactive) {
    grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      painting = true;
      paintValue = state[Number(cell.dataset.idx)] ? 0 : 1;
      grid.setPointerCapture(e.pointerId);
      paint(cell);
    });

    // With the pointer captured, moves keep coming to the grid rather than to
    // whichever cell is under the finger, so look the cell up by coordinate.
    grid.addEventListener('pointermove', (e) => {
      if (!painting) return;
      e.preventDefault();
      paint(document.elementFromPoint(e.clientX, e.clientY));
    });

    const stop = (e) => {
      if (!painting) return;
      painting = false;
      if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
    };
    grid.addEventListener('pointerup', stop);
    grid.addEventListener('pointercancel', stop);
  }

  return {
    get() {
      return state;
    },
    set(next) {
      for (let i = 0; i < SLOTS; i++) {
        state[i] = next[i] ? 1 : 0;
        cells[i].classList.toggle('on', Boolean(state[i]));
      }
    },
    heat(counts, total) {
      for (let i = 0; i < SLOTS; i++) {
        const count = counts[i];
        // Five steps between nothing and everyone, so the top step means
        // "all of us" no matter how many people there are.
        const level = count === 0 ? 0 : count >= total ? 5 : Math.max(1, Math.ceil((count / total) * 4));
        cells[i].dataset.level = String(level);
        cells[i].title = count ? `${formatRun(i, 1)} — ${count} of ${total}` : '';
      }
    },
  };
}

/* ---------- overlap ---------- */

// A run is a contiguous stretch where the exact same people are free, so the
// names attached to it are always accurate.
function bestRuns(people) {
  const total = people.length;
  if (!total) return { runs: [], counts: new Uint8Array(SLOTS), total };

  const counts = new Uint8Array(SLOTS);
  const sets = new Array(SLOTS);
  for (let i = 0; i < SLOTS; i++) sets[i] = [];

  people.forEach((person, personIdx) => {
    const local = shiftSlots(decodeSlots(person.s), hourShift(person.tz, TZ));
    for (let i = 0; i < SLOTS; i++) {
      if (local[i]) {
        counts[i]++;
        sets[i].push(personIdx);
      }
    }
  });

  const runs = [];
  let i = 0;
  while (i < SLOTS) {
    if (counts[i] < 2) {
      i++;
      continue;
    }
    const sig = sets[i].join(',');
    let end = i + 1;
    while (end < SLOTS && sets[end].join(',') === sig) end++;
    runs.push({ start: i, length: end - i, count: counts[i], who: sets[i] });
    i = end;
  }

  runs.sort((a, b) => b.count - a.count || b.length - a.length || a.start - b.start);
  return { runs, counts, total };
}

/* ---------- views ---------- */

const state = {
  code: null,
  people: [],
  me: null, // { id, n, tz, s }
  mineGrid: null,
  allGrid: null,
};

function show(view) {
  $('view-home').hidden = view !== 'home';
  $('view-group').hidden = view !== 'group';
}

function showError(el, message) {
  const node = $(el);
  node.textContent = message;
  node.hidden = !message;
}

function setTab(which) {
  const mine = which === 'mine';
  $('tab-mine').setAttribute('aria-selected', String(mine));
  $('tab-all').setAttribute('aria-selected', String(!mine));
  $('pane-mine').hidden = !mine;
  $('pane-all').hidden = mine;
  if (!mine) renderOverlap();
}

function renderOverlap() {
  const { runs, counts, total } = bestRuns(state.people);
  state.allGrid.heat(counts, Math.max(total, 1));

  const names = state.people.map((p) => p.n);
  $('people-summary').textContent = total === 0
    ? 'No one has filled this in yet.'
    : total === 1
      ? `Only ${names[0]} has filled this in so far.`
      : `${total} people so far: ${listNames(names)}.`;

  const best = $('best');
  if (!runs.length) {
    best.innerHTML = '';
    if (total >= 2) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No hour works for two or more of you yet.';
      best.appendChild(p);
    }
    return;
  }

  // Show the top two tiers of overlap: the best answer, and the near miss.
  const tiers = [...new Set(runs.map((r) => r.count))].slice(0, 2);
  const shown = runs.filter((r) => tiers.includes(r.count)).slice(0, 8);

  const heading = document.createElement('h2');
  heading.textContent = 'Best times';
  best.replaceChildren(heading);

  for (const run of shown) {
    const row = document.createElement('div');
    row.className = `best-row${run.count === total ? ' full' : ''}`;

    const when = document.createElement('span');
    when.className = 'best-when';
    when.textContent = formatRun(run.start, run.length);

    const who = document.createElement('span');
    who.className = 'best-who';
    if (run.count === total) {
      who.textContent = total === 2 ? 'both of you' : `everyone (${total})`;
    } else {
      const missing = state.people.filter((_, i) => !run.who.includes(i)).map((p) => p.n);
      who.textContent = `${run.count} of ${total} — without ${listNames(missing)}`;
    }

    row.append(when, who);
    best.appendChild(row);
  }
}

// Your own cached row wins over the server's copy, which covers KV's list lag:
// you always see yourself immediately after saving. Sorted so the summary and
// the "without X" lists read the same way every time.
function mergeLocal(people, me) {
  const rest = me ? people.filter((p) => p.id !== me.id) : people;
  const all = me ? [...rest, me] : [...rest];
  return all.sort((a, b) => a.n.localeCompare(b.n));
}

async function openGroup(code) {
  showError('group-error', '');
  let group;
  try {
    group = await api(`/group/${code}`);
  } catch (e) {
    show('home');
    location.hash = '';
    showError('home-error', e.message === 'group not found'
      ? `No group with the code ${code}.`
      : e.message);
    return;
  }

  state.code = code;
  state.me = loadLocal(code);
  state.people = mergeLocal(group.people, state.me);

  $('group-name').textContent = group.name || 'Your group';
  document.title = group.name ? `${group.name} — When Are We Free` : 'When Are We Free';
  $('group-code').textContent = code;
  $('tz-mine').textContent = tzLabel(TZ);
  $('tz-all').textContent = tzLabel(TZ);

  show('group');

  state.mineGrid = buildGrid($('grid-mine'), { interactive: true });
  state.allGrid = buildGrid($('grid-all'), { interactive: false });

  if (state.me) {
    $('me-name').value = state.me.n;
    // Stored in whatever zone they used last; show it in the zone they're in now.
    state.mineGrid.set(shiftSlots(decodeSlots(state.me.s), hourShift(state.me.tz, TZ)));
    $('remove').hidden = false;
  } else {
    $('me-name').value = '';
    $('remove').hidden = true;
  }

  setTab(state.me ? 'all' : 'mine');
}

async function save() {
  const name = $('me-name').value.trim();
  if (!name) {
    $('me-name').focus();
    showError('group-error', 'Add your name so the others know whose hours these are.');
    return;
  }
  showError('group-error', '');

  const id = (state.me && state.me.id) || newId();
  const record = { id, n: name, tz: TZ, s: encodeSlots(state.mineGrid.get()) };

  const button = $('save');
  button.disabled = true;
  $('save-status').textContent = 'Saving…';

  try {
    await api(`/group/${state.code}/p/${id}`, { method: 'PUT', body: JSON.stringify(record) });
  } catch (e) {
    $('save-status').textContent = '';
    showError('group-error', e.message);
    button.disabled = false;
    return;
  }

  state.me = record;
  saveLocal(state.code, record);
  state.people = mergeLocal(state.people, record);
  $('remove').hidden = false;
  $('save-status').textContent = 'Saved.';
  button.disabled = false;
  setTab('all');
}

async function removeMe() {
  if (!state.me) return;
  const button = $('remove');
  button.disabled = true;
  $('save-status').textContent = 'Removing…';
  try {
    await api(`/group/${state.code}/p/${state.me.id}`, { method: 'DELETE' });
  } catch (e) {
    showError('group-error', e.message);
    $('save-status').textContent = '';
    button.disabled = false;
    return;
  }
  button.disabled = false;
  state.people = state.people.filter((p) => p.id !== state.me.id);
  clearLocal(state.code);
  state.me = null;
  state.mineGrid.set(new Uint8Array(SLOTS));
  $('me-name').value = '';
  $('remove').hidden = true;
  $('save-status').textContent = 'Removed.';
  setTab('mine');
}

/* ---------- routing and wiring ---------- */

function route() {
  const match = location.hash.match(/^#\/([^/?]+)/);
  if (match) {
    openGroup(match[1].toUpperCase());
  } else {
    show('home');
    document.title = 'When Are We Free';
  }
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('home-error', '');
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const group = await api('/group', {
      method: 'POST',
      body: JSON.stringify({ name: $('create-name').value.trim() }),
    });
    location.hash = `#/${group.code}`;
  } catch (err) {
    showError('home-error', err.message);
  } finally {
    button.disabled = false;
  }
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 6) {
    showError('home-error', 'A group code is 6 characters.');
    return;
  }
  showError('home-error', '');
  location.hash = `#/${code}`;
});

$('save').addEventListener('click', save);
$('clear').addEventListener('click', () => state.mineGrid.set(new Uint8Array(SLOTS)));
$('remove').addEventListener('click', removeMe);
$('tab-mine').addEventListener('click', () => setTab('mine'));
$('tab-all').addEventListener('click', () => setTab('all'));

$('leave').addEventListener('click', () => {
  location.hash = '';
});

$('code-copy').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#/${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $('code-copy').title = 'Link copied';
    $('save-status').textContent = 'Share link copied.';
  } catch {
    $('save-status').textContent = link;
  }
});

// Submitting the name field shouldn't reload the page.
$('me-form').addEventListener('submit', (e) => {
  e.preventDefault();
  save();
});

window.addEventListener('hashchange', route);
route();
