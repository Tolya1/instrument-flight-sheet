'use strict';
// METAR parser regressions. The COR case is the exact report that killed the
// original (pre-rewrite) tool; the rest cover regional format differences.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMetar, metarAgeMin } = require('../lib/metar-parse');

test('malformed COR METAR (the one that killed v1) still yields altimeter', () => {
  const p = parseMetar('METAR KSAN 171851Z COR 180KT 10 9SM BKN014 BKN100 26/21 A2998 RMK AO2 SLP153 $');
  assert.equal(p.altimInHg, 29.98);
  assert.equal(p.ceilingFt, 1400);
  assert.equal(p.tempC, 26);
  assert.equal(p.windDir, null); // garbage wind skipped, not crashed on
  assert.ok(p.cor);
});

test('US format: gusts, 10SM, A-group', () => {
  const p = parseMetar('KCRQ 201447Z 26012G22KT 10SM CLR 24/12 A2996');
  assert.equal(p.windDir, 260);
  assert.equal(p.windSpd, 12);
  assert.equal(p.windGust, 22);
  assert.equal(p.visSm, 10);
  assert.equal(p.altimInHg, 29.96);
  assert.ok(p.altimHpa > 1013 && p.altimHpa < 1016);
});

test('European format: Q-group hPa primary source, metric visibility', () => {
  const p = parseMetar('METAR EPWA 201430Z 29008KT 9999 SCT035 22/14 Q1018 NOSIG');
  assert.equal(p.altimHpa, 1018);
  assert.equal(p.altimInHg, 30.06);
  assert.equal(p.visM, 9999);
  assert.equal(p.visSm, null);
});

test('Chinese format: MPS winds convert to knots', () => {
  const p = parseMetar('ZBAA 231030Z 09002MPS 060V130 CAVOK 30/27 Q1007 NOSIG');
  assert.equal(p.windDir, 90);
  assert.equal(p.windSpd, 4); // 2 m/s = 3.9 kt
  assert.ok(p.clouds.some(c => c.cover === 'CAVOK'));
});

test('fractional and two-token visibility', () => {
  assert.equal(parseMetar('KSBA 201453Z VRB03KT 1 1/2SM BR OVC004 16/14 A2999').visSm, 1.5);
  assert.equal(parseMetar('KFHR 191803Z AUTO 10003KT M1/4SM FG VV002 11/11 A3000').visSm, 0.25);
  assert.equal(parseMetar('KFHR 191803Z AUTO 10003KT M1/4SM FG VV002 11/11 A3000').ceilingFt, 200);
});

test('VRB wind and negative temps', () => {
  const p = parseMetar('ENGM 231020Z VRB02KT 9999 FEW020 M03/M07 Q1021');
  assert.ok(p.windVrb);
  assert.equal(p.tempC, -3);
  assert.equal(p.dewC, -7);
});

test('garbage and empty input never throw', () => {
  assert.doesNotThrow(() => parseMetar('GARBAGE ### not a metar 12345'));
  assert.doesNotThrow(() => parseMetar(''));
  assert.doesNotThrow(() => parseMetar(null));
  assert.equal(parseMetar('').ok, false);
});

test('day-of-month rollover never produces a future obsTime (review fix #1)', () => {
  // On Mar 1, a "302355Z" METAR must not resolve to Feb 30 -> Mar 2.
  const p = parseMetar('KGEG 302355Z 25003KT 8SM CLR 15/05 A3000');
  const age = metarAgeMin(p);
  if (age !== null) assert.ok(age >= 0, `obsTime resolved into the future (age ${age} min)`);
});

test('an obs time later today resolves to last month, never the future', () => {
  // Dynamic: stamp a METAR ~2h ahead of "now" — whatever day the suite runs.
  const f = new Date(Date.now() + 2 * 3600 * 1000);
  const tok = `${String(f.getUTCDate()).padStart(2, '0')}${String(f.getUTCHours()).padStart(2, '0')}${String(f.getUTCMinutes()).padStart(2, '0')}Z`;
  const p = parseMetar(`KGEG ${tok} 25003KT 8SM CLR 15/05 A3000`);
  const age = metarAgeMin(p);
  if (age !== null) assert.ok(age >= -60, `future-stamped obs not rolled back (age ${age} min)`);
});
