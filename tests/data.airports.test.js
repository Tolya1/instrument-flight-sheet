'use strict';
// Regional data-presence tests against the REAL local databases (OurAirports
// CSVs + NASR + Navigraph extract in data/). Catches missing/vanished data
// per region: a failed row here means someone flying that region gets an
// empty frequency box or no ILS line.
//
// Skips (with a message) when data/ hasn't been populated yet — run the
// server once, or node -e "require('./lib/airports').init()".
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const airports = require('../lib/airports');

const HAVE_DATA = fs.existsSync(path.join(__dirname, '..', 'data', 'airports.csv'));
const HAVE_NAVDATA = fs.existsSync(path.join(__dirname, '..', 'data', 'navdata-ils.json'));

// Per-region roster: [icao, minFreqRows, expectIls, exactIls?]
// exactIls pins freq/course for one runway end — AIRAC-stable values; if an
// AIRAC actually changes one, the failure is informative, not noise.
const ROSTER = {
  US: [
    ['KSAN', 4, true, { rwy: '27', f: 110.9 }],
    ['KSBA', 4, true, { rwy: '07', f: 110.3 }],
  ],
  Europe: [
    ['EDDF', 6, true, { rwy: '25C', f: 111.55, c: 246 }],
    ['EGLL', 6, true, null],
    ['EPWA', 4, true, null],
  ],
  Asia: [
    ['RJTT', 6, true, { rwy: '34L', f: 111.7 }],
    ['ZBAA', 4, true, null],
  ],
  Africa: [
    ['FAOR', 3, true, { rwy: '03L', f: 110.3 }],
    ['GOBD', 2, false, null],
  ],
  Oceania: [
    ['YSSY', 4, true, { rwy: '16R', f: 109.5 }],
    ['NZAA', 3, true, null],
  ],
};

before(async () => { if (HAVE_DATA) await airports.init(); });

for (const [region, rows] of Object.entries(ROSTER)) {
  test(`${region}: airport data present and usable`, { skip: !HAVE_DATA && 'data/ not populated — start the server once first' }, () => {
    for (const [icao, minFreqs, expectIls, exact] of rows) {
      const info = airports.airportInfo(icao);
      assert.ok(info, `${icao}: resolves in airport DB`);
      assert.ok(info.elevation !== null, `${icao}: elevation`);
      assert.ok(info.freqs.length >= minFreqs, `${icao}: >=${minFreqs} freq rows (got ${info.freqs.length})`);
      assert.ok(info.freqs.some(f => ['TWR', 'CTAF', 'A/D', 'APP'].includes(f.type)), `${icao}: has a tower/approach-class freq`);
      assert.ok(info.runways.length >= 1 && info.runways[0].lengthFt > 0, `${icao}: runway dims`);
      const ilsEnds = info.runways.flatMap(r => r.ends).filter(e => e.ils);
      if (expectIls && (HAVE_NAVDATA || icao.startsWith('K'))) {
        assert.ok(ilsEnds.length >= 1, `${icao}: at least one ILS end`);
      }
      if (exact && (HAVE_NAVDATA || icao.startsWith('K'))) {
        const end = ilsEnds.find(e => e.ident === exact.rwy);
        assert.ok(end, `${icao}: ILS on rwy ${exact.rwy}`);
        assert.equal(end.ils.locFreq, exact.f, `${icao} ${exact.rwy}: ILS freq`);
        if (exact.c) assert.equal(end.ils.course, exact.c, `${icao} ${exact.rwy}: course`);
      }
    }
  });
}

test('non-US ILS comes from the Navigraph layer (NASR is US-only)', { skip: (!HAVE_DATA || !HAVE_NAVDATA) && 'needs data/ + navdata-ils.json' }, () => {
  const s = airports.status();
  assert.ok(s.navIlsCount > 3000, `worldwide ILS count sane (got ${s.navIlsCount})`);
  assert.match(s.ilsSource, /^Navigraph \d{4}/);
});

test('navdata cycle is not expired', { skip: !HAVE_NAVDATA && 'no navdata-ils.json' }, () => {
  const s = airports.status();
  assert.ok(!/EXPIRED/.test(s.ilsSource), `stale AIRAC: ${s.ilsSource} — run update-navdata.cmd`);
});

test('nav-band frequencies: VOR-ATIS kept and flagged, comm types never below 118', { skip: !HAVE_DATA && 'data/ not populated' }, () => {
  // Australia's AERIS: ATIS over VORs (YSSY 115.55, YBBN 113.2) — must be
  // present but flagged navBand so the sheet says "tune NAV radio".
  const yssy = airports.airportInfo('YSSY');
  const atis = yssy.freqs.find(f => f.type === 'ATIS');
  assert.ok(atis, 'YSSY has an ATIS row');
  assert.ok(atis.mhz < 118, 'YSSY ATIS is in the nav band (data as expected)');
  assert.equal(atis.navBand, true, 'nav-band ATIS carries the flag');
  // No airport in the roster may list a comm position below 118.0 MHz.
  for (const rows of Object.values(ROSTER)) {
    for (const [icao] of rows) {
      const info = airports.airportInfo(icao);
      if (!info) continue;
      for (const f of info.freqs) {
        if (!['ATIS', 'AWOS', 'ASOS'].includes(f.type)) {
          assert.ok(f.mhz >= 118, `${icao}: ${f.type} ${f.mhz} is below the comm band`);
        }
        if (f.navBand) assert.ok(f.mhz < 118, `${icao}: navBand flag only below 118`);
      }
    }
  }
});

test('US non-ICAO ident resolution (L35-style fields)', { skip: !HAVE_DATA && 'data/ not populated' }, () => {
  assert.ok(airports.resolveIdent('L35'), 'L35 (Big Bear) resolves');
  assert.ok(airports.airportInfo('L35').elevation > 6000, 'Big Bear elevation sane');
  assert.equal(airports.resolveIdent('KSAN'), 'KSAN');
});
