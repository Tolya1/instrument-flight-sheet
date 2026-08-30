'use strict';
// VATSIM callsign->airport matching against a synthetic feed — the research
// pitfalls, frozen as regressions: K-dropped US prefixes, Australian 2-letter
// codes, double-underscore relief callsigns, observers, FIR-level centers,
// null atis_code, A/D-split ATIS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVatspy, matchAirport, atisLetter, firstToken } = require('../lib/vatsim');

const SPY = parseVatspy(`
[Airports]
KSAN|San Diego Intl|32.73|-117.18|SAN|KZLA|0
KSBA|Santa Barbara|34.42|-119.84|SBA|KZLA|0
YMML|Melbourne|-37.67|144.84|ML|YMMM|0
EPWA|Warsaw Chopin|52.16|20.96||EPWW|0
[FIRs]
KZLA|Los Angeles|LAX|KZLA
KZLA|Los Angeles|LA|KZLA
YMMM|Melbourne FIR|ML-MUN|YMMM
EPWW|Warsaw FIR|EPWW|EPWW
`);

const FEED = { general: { update_timestamp: 'x' }, controllers: [
  { callsign: 'SAN_TWR', frequency: '118.300', facility: 4, text_atis: null },
  { callsign: 'SAN_1_GND', frequency: '123.900', facility: 3, text_atis: null },
  { callsign: 'LAX_CTR', frequency: '125.800', facility: 6, text_atis: ['Los Angeles Center'] },
  { callsign: 'MZ_OBS', frequency: '199.998', facility: 0, text_atis: null },
  { callsign: 'EPWA__GND', frequency: '121.905', facility: 3, text_atis: null },
  { callsign: 'ML_APP', frequency: '132.000', facility: 5, text_atis: ['Extending MAV 133.55'] },
  { callsign: 'SBA_TWR', frequency: '119.700', facility: 4, text_atis: null },
], atis: [
  { callsign: 'KSAN_ATIS', frequency: '134.800', facility: 4, atis_code: 'K', text_atis: ['ATIS KSAN K', 'SAN INFO K'] },
  { callsign: 'EPWA_A_ATIS', frequency: '125.475', facility: 4, atis_code: null, text_atis: ['ATIS EPWA F 300830', 'EPWA ARR INFO F'] },
] };

test('US K-dropped prefix: KSAN matches SAN_TWR + relief SAN_1_GND, not SBA', () => {
  const m = matchAirport('KSAN', SPY, FEED);
  const calls = m.positions.map(p => p.callsign);
  assert.ok(calls.includes('SAN_TWR'));
  assert.ok(calls.includes('SAN_1_GND'));
  assert.ok(!calls.includes('SBA_TWR'));
});

test('overlying center matched via FIR prefix and flagged', () => {
  const m = matchAirport('KSAN', SPY, FEED);
  const ctr = m.positions.find(p => p.callsign === 'LAX_CTR');
  assert.ok(ctr, 'LAX_CTR attached to KSAN via KZLA');
  assert.equal(ctr.overlying, true);
  assert.equal(ctr.mhz, '125.800');
});

test('observers and 199.998 placeholders are never shown', () => {
  const m = matchAirport('KSAN', SPY, FEED);
  assert.ok(!m.positions.some(p => p.callsign === 'MZ_OBS'));
});

test('double-underscore relief callsign still matches (EPWA__GND)', () => {
  const m = matchAirport('EPWA', SPY, FEED);
  assert.ok(m.positions.some(p => p.callsign === 'EPWA__GND'));
});

test('Australian 2-letter prefix: YMML matches ML_APP', () => {
  const m = matchAirport('YMML', SPY, FEED);
  assert.ok(m.positions.some(p => p.callsign === 'ML_APP'));
});

test('ATIS: letter from atis_code, or parsed from text when null; A/D kinds', () => {
  const san = matchAirport('KSAN', SPY, FEED);
  assert.equal(san.atis[0].letter, 'K');
  assert.equal(san.atis[0].kind, 'ATIS');
  const wa = matchAirport('EPWA', SPY, FEED);
  assert.equal(wa.atis[0].letter, 'F', 'null atis_code parsed from text');
  assert.equal(wa.atis[0].kind, 'ARR');
});

test('firstToken handles hyphens and empty infixes', () => {
  assert.equal(firstToken('NZCH-S_CTR'), 'NZCH');
  assert.equal(firstToken('EPWA__GND'), 'EPWA');
  assert.equal(firstToken('EGLL_S_TWR'), 'EGLL');
});
