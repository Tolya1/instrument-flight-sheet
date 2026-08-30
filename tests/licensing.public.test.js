'use strict';
// Licensing guard: a hosted (PUBLIC_MODE) instance must never serve
// Navigraph-derived navdata, even when data/navdata-ils.json is on disk.
// A Navigraph subscription covers the subscriber, not an audience.
//
// Proven functionally: load the airport module in each mode and ask it for a
// non-US airport's ILS — EDDF exists only in the Navigraph extract, never in
// FAA NASR, so it is the perfect probe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HAVE_NAVDATA = fs.existsSync(path.join(ROOT, 'data', 'navdata-ils.json'));
const HAVE_DATA = fs.existsSync(path.join(ROOT, 'data', 'airports.csv'));
const skip = (!HAVE_NAVDATA || !HAVE_DATA) && 'needs a populated data/ incl. navdata-ils.json';

// Load a *fresh* copy of lib/airports.js with PUBLIC_MODE set as given
// (the module reads the env var at load time).
async function loadAirports(publicMode) {
  const prev = process.env.PUBLIC_MODE;
  process.env.PUBLIC_MODE = publicMode ? '1' : '0';
  const modPath = require.resolve('../lib/airports.js');
  delete require.cache[modPath];
  const mod = require(modPath);
  await mod.init();
  process.env.PUBLIC_MODE = prev;
  delete require.cache[modPath]; // don't leak this instance to other tests
  return mod;
}

const ilsEnds = info => (info ? info.runways.flatMap(r => r.ends).filter(e => e.ils) : []);

test('PUBLIC_MODE serves no Navigraph ILS, even with the file present', { skip }, async () => {
  const a = await loadAirports(true);
  assert.equal(ilsEnds(a.airportInfo('EDDF')).length, 0, 'Frankfurt ILS comes only from Navigraph — must be absent');
  assert.equal(ilsEnds(a.airportInfo('YSSY')).length, 0, 'same for Sydney');
  const s = a.status();
  assert.equal(s.navIlsCount, 0);
  assert.match(s.ilsSource, /not served in public mode/);
  // US coverage still works: FAA NASR is public domain
  assert.ok(ilsEnds(a.airportInfo('KSAN')).length >= 1, 'NASR ILS still served publicly');
});

test('personal mode does serve Navigraph ILS worldwide', { skip }, async () => {
  const a = await loadAirports(false);
  assert.ok(ilsEnds(a.airportInfo('EDDF')).length >= 2, 'Frankfurt ILS present for the subscriber');
  const s = a.status();
  assert.ok(s.navIlsCount > 3000);
  assert.match(s.ilsSource, /^Navigraph \d{4}/);
});
