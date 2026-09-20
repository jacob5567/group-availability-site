'use strict';

// Pure logic shared by the app and its tests: no DOM, no globals besides
// what's passed in. Loaded as a classic script before app.js.

// A week is 168 hour slots, indexed day * 24 + hour, with day 0 = Monday.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOTS = 168;

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
 * their own zone and converted only at render time, against today's date.
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

/* ---------- time formatting ---------- */

const hh = (h) => String(h).padStart(2, '0') + ':00';

function formatHourLabel(hour, use12) {
  if (!use12) return hh(hour);
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

function formatRun(start, length, use12 = false) {
  const endIdx = start + length;
  const startDay = Math.floor(start / 24) % 7;
  const endDay = Math.floor(endIdx / 24) % 7;
  const from = `${DAYS[startDay]} ${formatHourLabel(start % 24, use12)}`;
  const to = endDay === startDay
    ? formatHourLabel(endIdx % 24, use12)
    : `${DAYS[endDay]} ${formatHourLabel(endIdx % 24, use12)}`;
  return `${from} – ${to}`;
}

function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/* ---------- overlap ----------
 * A run is a contiguous stretch where the exact same people are free, so the
 * names attached to it are always accurate.
 */

function bestRuns(people, viewerTz) {
  const total = people.length;
  if (!total) return { runs: [], counts: new Uint8Array(SLOTS), total };

  const counts = new Uint8Array(SLOTS);
  const sets = new Array(SLOTS);
  for (let i = 0; i < SLOTS; i++) sets[i] = [];

  people.forEach((person, personIdx) => {
    const local = shiftSlots(decodeSlots(person.s), hourShift(person.tz, viewerTz));
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
