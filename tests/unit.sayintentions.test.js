'use strict';
// SI ATIS text parsing — format per SI's own WX API example (KSLC).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSiAtis } = require('../lib/sayintentions');

const KSLC = 'Salt Lake City International airport, information Juliet. 2354 Zulu. Wind 320 at 8. Visibility 10. Sky clear. Temperature 28, dew point 4. Altimeter 30.12. Arriving and departing runways 34R, 34L, 35. Visual approaches in use. Advise on initial contact you have information Juliet.';

test('SI ATIS: phonetic letter, combined runways, approaches', () => {
  const a = parseSiAtis(KSLC);
  assert.equal(a.letter, 'J');
  assert.equal(a.arrivingRunways, '34R, 34L, 35');
  assert.equal(a.departingRunways, '34R, 34L, 35');
  assert.match(a.approaches, /Visual approaches in use/i);
});

test('SI ATIS: split arriving/departing phrasing', () => {
  const a = parseSiAtis('Foo airport, information Xray. Arriving runway 25L. Departing runways 25R. ILS approaches in use.');
  assert.equal(a.letter, 'X');
  assert.equal(a.arrivingRunways, '25L');
  assert.equal(a.departingRunways, '25R');
});

test('SI ATIS: garbage and empty tolerated', () => {
  assert.equal(parseSiAtis(''), null);
  assert.equal(parseSiAtis(null), null);
  const a = parseSiAtis('no structured content here');
  assert.equal(a.letter, null);
  assert.equal(a.arrivingRunways, null);
});
