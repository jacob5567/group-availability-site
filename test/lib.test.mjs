// Unit tests for public/lib.js — the pure slot encoding, timezone conversion,
// formatting, and overlap logic. No DOM, no network, no browser: `npm test`
// runs this on every change with nothing but Node itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../public/lib.js'), 'utf8');
const exportNames = [
  'encodeSlots', 'decodeSlots', 'offsetMinutes', 'hourShift', 'shiftSlots',
  'validTz', 'formatHourLabel', 'formatRun', 'listNames', 'bestRuns',
];
const mod = await import(
  'data:text/javascript;base64,' +
  Buffer.from(`${src}\nexport { ${exportNames.join(', ')} };`).toString('base64')
);

const idx = (day, hour) => day * 24 + hour;
const slotsFrom = (...indices) => {
  const s = new Uint8Array(168);
  for (const i of indices) s[i] = 1;
  return s;
};
const onIndices = (s) => [...s.keys()].filter((i) => s[i]);

test('slot encoding round-trips', () => {
  const sample = slotsFrom(0, 33, 34, 167, 91);
  const encoded = mod.encodeSlots(sample);
  assert.equal(encoded.length, 28);
  assert.match(encoded, /^[A-Za-z0-9_-]{28}$/);
  assert.deepEqual(onIndices(mod.decodeSlots(encoded)), [0, 33, 34, 91, 167]);
});

test('empty and full weeks round-trip', () => {
  assert.deepEqual(onIndices(mod.decodeSlots(mod.encodeSlots(new Uint8Array(168)))), []);
  assert.equal(onIndices(mod.decodeSlots(mod.encodeSlots(new Uint8Array(168).fill(1)))).length, 168);
});

test('garbage input decodes to empty instead of throwing', () => {
  assert.deepEqual(onIndices(mod.decodeSlots('!!!!')), []);
});

test('offsetMinutes tracks real UTC offsets, including half-hour zones', () => {
  const sept = new Date('2026-09-19T12:00:00Z');
  assert.equal(mod.offsetMinutes('America/Denver', sept), -360);
  assert.equal(mod.offsetMinutes('Asia/Tokyo', sept), 540);
  assert.equal(mod.offsetMinutes('UTC', sept), 0);
  assert.equal(mod.offsetMinutes('Asia/Kolkata', sept), 330);
});

test('offsetMinutes tracks DST rather than assuming a fixed offset', () => {
  const jan = new Date('2026-01-15T12:00:00Z');
  assert.equal(mod.offsetMinutes('America/Denver', jan), -420);
  const sept = new Date('2026-09-19T12:00:00Z');
  assert.equal(mod.hourShift('America/Denver', 'Asia/Tokyo', sept), 15);
  assert.equal(mod.hourShift('America/Denver', 'Asia/Tokyo', jan), 16);
});

test('hourShift falls back to 0 for an invalid zone rather than throwing', () => {
  assert.equal(mod.hourShift('Not/AZone', 'UTC'), 0);
});

test('the plan headline case: Denver Tue 09:00-11:00 -> Tokyo Wed 00:00-02:00', () => {
  const sept = new Date('2026-09-19T12:00:00Z');
  const denverTue = slotsFrom(idx(1, 9), idx(1, 10));
  const inTokyo = mod.shiftSlots(denverTue, mod.hourShift('America/Denver', 'Asia/Tokyo', sept));
  assert.deepEqual(onIndices(inTokyo), [idx(2, 0), idx(2, 1)]);
  assert.equal(mod.formatRun(idx(2, 0), 2), 'Wed 00:00 – 02:00');
});

test('week-edge wrap forwards: Sun 23:00 LA -> Mon 08:00 Berlin', () => {
  const sept = new Date('2026-09-19T12:00:00Z');
  const sunLate = slotsFrom(idx(6, 23));
  const inBerlin = mod.shiftSlots(sunLate, mod.hourShift('America/Los_Angeles', 'Europe/Berlin', sept));
  assert.deepEqual(onIndices(inBerlin), [idx(0, 8)]);
});

test('week-edge wrap backwards: Mon 02:00 Berlin -> Sun 17:00 LA', () => {
  const sept = new Date('2026-09-19T12:00:00Z');
  const monEarly = slotsFrom(idx(0, 2));
  const backwards = mod.shiftSlots(monEarly, mod.hourShift('Europe/Berlin', 'America/Los_Angeles', sept));
  assert.deepEqual(onIndices(backwards), [idx(6, 17)]);
});

test('a full week of slots survives any shift with no loss', () => {
  assert.equal(onIndices(mod.shiftSlots(new Uint8Array(168).fill(1), 15)).length, 168);
});

test('formatRun crosses midnight and day boundaries correctly', () => {
  assert.equal(mod.formatRun(idx(1, 18), 3), 'Tue 18:00 – 21:00');
  assert.equal(mod.formatRun(idx(1, 23), 2), 'Tue 23:00 – Wed 01:00');
  assert.equal(mod.formatRun(idx(1, 22), 2), 'Tue 22:00 – Wed 00:00');
});

test('formatRun in 12-hour mode', () => {
  assert.equal(mod.formatRun(idx(1, 0), 1, true), 'Tue 12 AM – 1 AM');
  assert.equal(mod.formatRun(idx(1, 13), 2, true), 'Tue 1 PM – 3 PM');
  assert.equal(mod.formatRun(idx(1, 23), 1, true), 'Tue 11 PM – Wed 12 AM');
});

test('formatHourLabel covers midnight and noon in 12-hour mode', () => {
  assert.equal(mod.formatHourLabel(0, true), '12 AM');
  assert.equal(mod.formatHourLabel(12, true), '12 PM');
  assert.equal(mod.formatHourLabel(23, true), '11 PM');
  assert.equal(mod.formatHourLabel(9, false), '09:00');
});

test('bestRuns finds the top overlapping run among same-zone people', () => {
  const mk = (n, indices) => ({ n, tz: 'UTC', s: mod.encodeSlots(slotsFrom(...indices)) });
  const people = [
    mk('Jacob', [idx(1, 18), idx(1, 19), idx(1, 20), idx(3, 19)]),
    mk('Sam', [idx(1, 18), idx(1, 19), idx(1, 20), idx(3, 19)]),
    mk('Alex', [idx(1, 18), idx(1, 19), idx(1, 20)]),
  ];
  const result = mod.bestRuns(people, 'UTC');
  assert.deepEqual(
    [mod.formatRun(result.runs[0].start, result.runs[0].length), result.runs[0].count],
    ['Tue 18:00 – 21:00', 3],
  );
  assert.deepEqual(
    [mod.formatRun(result.runs[1].start, result.runs[1].length), result.runs[1].count],
    ['Thu 19:00 – 20:00', 2],
  );
  assert.deepEqual(
    [result.counts[idx(1, 18)], result.counts[idx(3, 19)], result.counts[idx(0, 0)]],
    [3, 2, 0],
  );
  assert.ok(result.runs.every((r) => r.count >= 2), 'solo hours are never offered as runs');
});

test('bestRuns returns nothing for an empty group', () => {
  assert.equal(mod.bestRuns([], 'UTC').runs.length, 0);
});

test('a run only holds while the exact same people are free', () => {
  const mk = (n, indices) => ({ n, tz: 'UTC', s: mod.encodeSlots(slotsFrom(...indices)) });
  const swapped = [
    mk('A', [idx(1, 18), idx(1, 19)]),
    mk('B', [idx(1, 18), idx(1, 19)]),
    mk('C', [idx(1, 19), idx(1, 20)]),
  ];
  const result = mod.bestRuns(swapped, 'UTC');
  // C is alone at 20:00, so that hour is correctly not offered as an overlap.
  assert.deepEqual(
    result.runs.map((r) => [mod.formatRun(r.start, r.length), r.count]),
    [['Tue 19:00 – 20:00', 3], ['Tue 18:00 – 19:00', 2]],
  );
});

test('bestRuns converts across timezones before comparing', () => {
  // Denver 09:00 Tue and Tokyo 00:00 Wed are the same real hour.
  const crossTz = [
    { n: 'Jacob', tz: 'America/Denver', s: mod.encodeSlots(slotsFrom(idx(1, 9))) },
    { n: 'Sam', tz: 'Asia/Tokyo', s: mod.encodeSlots(slotsFrom(idx(2, 0))) },
  ];
  const result = mod.bestRuns(crossTz, 'America/Denver');
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].count, 2);
});

test('validTz accepts IANA names and rejects garbage', () => {
  assert.equal(mod.validTz('America/Denver'), true);
  assert.equal(mod.validTz('Not/AZone'), false);
  assert.equal(mod.validTz(''), false);
  assert.equal(mod.validTz(null), false);
});

test('listNames reads naturally at every length', () => {
  assert.equal(mod.listNames(['A']), 'A');
  assert.equal(mod.listNames(['A', 'B']), 'A and B');
  assert.equal(mod.listNames(['A', 'B', 'C']), 'A, B, and C');
});
