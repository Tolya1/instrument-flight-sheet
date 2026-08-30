'use strict';
// SI ATIS text parsing — format per SI's own WX API example (KSLC).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSiAtis, collapseComms, keyFromFlightJson } = require('../lib/sayintentions');

// Real getWX comms payloads (fetched 2026-08-30), in the API's own array
// order — order is load-bearing for the client-mirroring filter.
const KOAK_COMMS = [
  { callsign: 'NORCAL', freq: '125.35', type: 'APP' },
  { callsign: 'NORCAL', freq: '128.325', type: 'APP' },
  { callsign: 'NORCAL', freq: '135.1', type: 'APP' },
  { callsign: null, freq: '133.775', type: 'ATIS' },
  { callsign: 'OAKLAND', freq: '121.1', type: 'CLR' },
  { callsign: 'OAKLAND', freq: '122.95', type: 'CTAF' },
  { callsign: 'NORCAL', freq: '120.9', type: 'DEP' },
  { callsign: 'NORCAL', freq: '127', type: 'DEP' },
  { callsign: 'NORCAL', freq: '135.1', type: 'DEP' },
  { callsign: 'OAKLAND', freq: '122.5', type: 'FSS' },
  { callsign: 'OAKLAND', freq: '121.75', type: 'GND' },
  { callsign: 'OAKLAND', freq: '121.9', type: 'GND' },
  { callsign: 'OAKLAND', freq: '118.3', type: 'TWR' },
  { callsign: 'OAKLAND', freq: '127.2', type: 'TWR' },
];
// EGLL ground: callsign:null in slot 1 -> SI's client shows all three.
const EGLL_COMMS = [
  { callsign: null, freq: '121.705', type: 'GND' },
  { callsign: null, freq: '121.855', type: 'GND' },
  { callsign: null, freq: '121.905', type: 'GND' },
  { callsign: 'HEATHROW', freq: '118.505', type: 'TWR' },
  { callsign: 'HEATHROW', freq: '118.705', type: 'TWR' },
  { callsign: 'HEATHROW', freq: '124.48', type: 'TWR' },
];
// YSSY tower: slot 1 is callsign:null -> all four shown.
const YSSY_COMMS = [
  { callsign: 'SYDNEY', freq: '121.7', type: 'GND' },
  { callsign: 'SYDNEY', freq: '126.5', type: 'GND' },
  { callsign: 'SYDNEY', freq: '133.95', type: 'TWR' },
  { callsign: null, freq: '120.5', type: 'TWR' },
  { callsign: null, freq: '124.7', type: 'TWR' },
  { callsign: null, freq: '119.45', type: 'TWR' },
  { callsign: 'SYDNEY COORDINATOR', freq: '127.6', type: 'AIR' },
];

test('KOAK: the frequency SI hides (TWR 127.2) is never printed', () => {
  const rows = collapseComms(KOAK_COMMS);
  const twr = rows.find(r => r.type === 'TWR');
  assert.equal(twr.mhz, 118.3);
  assert.equal(twr.altCount, 0, '127.2 is hidden by SI itself — printing it sends the pilot into the void');
  assert.deepEqual(twr.all, [118.3]);
  const gnd = rows.find(r => r.type === 'GND');
  assert.deepEqual(gnd.all, [121.75], 'GND 121.9 hidden too');
  // callsigned slot-1 entries hidden for every type
  assert.deepEqual(rows.find(r => r.type === 'APP').all, [125.35, 135.1]);
  assert.deepEqual(rows.find(r => r.type === 'DEP').all, [120.9, 135.1]);
});

test('null-callsign slot 1 is NOT hidden (EGLL ground, YSSY tower)', () => {
  const gnd = collapseComms(EGLL_COMMS).find(r => r.type === 'GND');
  assert.deepEqual(gnd.all, [121.705, 121.855, 121.905], 'all three EGLL grounds survive');
  const etwr = collapseComms(EGLL_COMMS).find(r => r.type === 'TWR');
  assert.deepEqual(etwr.all, [118.505, 124.48], 'callsigned 118.705 hidden');
  const ytwr = collapseComms(YSSY_COMMS).find(r => r.type === 'TWR');
  assert.deepEqual(ytwr.all, [133.95, 120.5, 124.7, 119.45], 'YSSY keeps all four (slot 1 has no callsign)');
  assert.deepEqual(collapseComms(YSSY_COMMS).find(r => r.type === 'GND').all, [121.7]);
});

test('SI comms: ramp/air dropped, duplicates deduped, kneeboard order', () => {
  const rows = collapseComms([...KOAK_COMMS, { callsign: 'LAX', freq: '129.325', type: 'RMP' }]);
  assert.ok(!rows.some(r => r.type === 'RMP'), 'ramp control is noise on a kneeboard');
  assert.ok(!collapseComms(YSSY_COMMS).some(r => r.type === 'AIR'), 'AIR is not rendered by SI either');
  assert.deepEqual(rows.map(r => r.type).slice(0, 4), ['ATIS', 'CLR', 'GND', 'TWR']);
  // KSNA really does list CLR 118.0 twice (slots 0 and 1)
  const clr = collapseComms([
    { callsign: null, freq: '118.0', type: 'CLR' },
    { callsign: null, freq: '118.0', type: 'CLR' },
  ]).find(r => r.type === 'CLR');
  assert.deepEqual(clr.all, [118], 'duplicate 118.0 deduped to one row');
});

test('SI api key is found in the real nested flight.json shape', () => {
  assert.equal(keyFromFlightJson({ flight_details: { api_key: 'abcdefgh1234' } }), 'abcdefgh1234');
  assert.equal(keyFromFlightJson({ api_key: 'abcdefgh1234' }), 'abcdefgh1234'); // documented flat shape
  assert.equal(keyFromFlightJson({ flight_details: {} }), null);
  assert.equal(keyFromFlightJson(null), null);
});

const KSLC = 'Salt Lake City International airport, information Juliet. 2354 Zulu. Wind 320 at 8. Visibility 10. Sky clear. Temperature 28, dew point 4. Altimeter 30.12. Arriving and departing runways 34R, 34L, 35. Visual approaches in use. Advise on initial contact you have information Juliet.';

// Real SI `atis` strings (abbreviated shape), fetched 2026-08-30.
const REAL = {
  KOAK: 'METROPOLITAN OAKLAND INTL ARPT, INFO X-RAY. 0753Z. ARVG RWYS 30, 28L, 28R, 33. DPTG RWYS 30, 28R, 33. WIND CALM. VIS 10. ALTIM 29.94. RDBK ALL RWY AND HOLD SHORT INSTR.',
  KSNA: 'JOHN WAYNE, INFO NOVEMBER. 0753Z. ARVG AND DPTG RWYS 20R, 20L. WIND 190 AT 5. VIS 9. SKC. ALTIM 29.86.',
  KSFO: 'SAN FRANCISCO INTL ARPT, INFO MIKE. 0756Z. ARVG AND DPTG RWYS 28R, 28L. RWYS 1L, 1R, 19L AND 19R CLSD. WIND 270 AT 17. ALTIM 29.95.',
  EGLL: 'LONDON HEATHROW ARPT, INFO JULIET. 0850Z. ARVG RWY 27L. DPTG RWY 27R. WIND 230 AT 9 GUSTING 20. QNH 1010. TRL 80. BUR NDB OTS.',
};

test('SI abbreviated ATIS: letter + split arriving/departing runways (KOAK)', () => {
  const a = parseSiAtis(REAL.KOAK);
  assert.equal(a.letter, 'X', 'X-RAY -> X');
  assert.equal(a.arrivingRunways, '30, 28L, 28R, 33');
  assert.equal(a.departingRunways, '30, 28R, 33');
});

test('SI abbreviated ATIS: combined form (KSNA)', () => {
  const a = parseSiAtis(REAL.KSNA);
  assert.equal(a.letter, 'N');
  assert.equal(a.arrivingRunways, '20R, 20L');
  assert.equal(a.departingRunways, '20R, 20L');
});

test('closed runways are never read as active (KSFO)', () => {
  const a = parseSiAtis(REAL.KSFO);
  assert.equal(a.arrivingRunways, '28R, 28L');
  assert.ok(!/1L|19R/.test(a.arrivingRunways), 'CLSD runways excluded');
});

test('European ATIS: singular RWY and transition level (EGLL)', () => {
  const a = parseSiAtis(REAL.EGLL);
  assert.equal(a.letter, 'J');
  assert.equal(a.arrivingRunways, '27L');
  assert.equal(a.departingRunways, '27R');
  assert.equal(a.transLevel, 'FL80');
});

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
