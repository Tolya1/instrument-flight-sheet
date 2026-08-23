'use strict';
// Pure-logic regressions: cycle arithmetic, wind components, runway parsing,
// CSV parsing, timezone math.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { currentCycle, nasrStamp } = require('../lib/cycle');
const { windComponents, parseRunwayList, localTime } = require('../lib/sheetmodel');
const { parseCsv } = require('../lib/csv');

test('NASR cycle arithmetic: anchor, boundaries, pre-anchor', () => {
  const at = d => currentCycle(new Date(d));
  assert.equal(nasrStamp(at('2026-08-06T12:00:00Z').current), '06_Aug_2026');
  assert.equal(nasrStamp(at('2026-09-02T23:59:00Z').current), '06_Aug_2026'); // last day of cycle
  assert.equal(nasrStamp(at('2026-09-03T00:01:00Z').current), '03_Sep_2026'); // first day of next
  assert.equal(nasrStamp(at('2026-08-23T00:00:00Z').previous), '09_Jul_2026');
  assert.equal(nasrStamp(at('2026-07-20T00:00:00Z').current), '09_Jul_2026'); // before anchor
});

test('wind components: true-vs-true math with L/R sense', () => {
  // rwy 27 (270T), wind 300@10 -> mostly headwind, crosswind from the right
  const w = windComponents(270, 300, 10);
  assert.equal(w.head, 9);
  assert.equal(w.cross, 5);
  assert.equal(w.side, 'R');
  // direct tailwind
  assert.equal(windComponents(270, 90, 10).head, -10);
  // VRB and calm produce no components
  assert.equal(windComponents(270, 'VRB', 8), null);
  assert.equal(windComponents(270, 300, 0), null);
  assert.equal(windComponents(null, 300, 10), null);
});

test('PE/ATIS runway list parsing', () => {
  assert.deepEqual(parseRunwayList('27'), ['27']);
  assert.deepEqual(parseRunwayList('24R, 25L'), ['24R', '25L']);
  assert.deepEqual(parseRunwayList('21 26'), ['21', '26']);
  assert.deepEqual(parseRunwayList('16L AND 16R'), ['16L', '16R']);
  assert.deepEqual(parseRunwayList(null), []);
});

test('localTime handles negative and fractional offsets', () => {
  assert.equal(localTime('2026-08-19T20:11:39Z', -7), '13:11');
  assert.equal(localTime('2026-08-19T20:11:39Z', 5.5), '01:41'); // India-style +5:30
  assert.equal(localTime('2026-08-19T20:11:39Z', null), null);
});

test('CSV parser: quotes, embedded commas, CRLF', () => {
  const rows = parseCsv('"id","name","desc"\r\n1,"San Diego, Intl","says ""hi"""\r\n2,Plain,\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'San Diego, Intl');
  assert.equal(rows[0].desc, 'says "hi"');
  assert.equal(rows[1].desc, '');
});
