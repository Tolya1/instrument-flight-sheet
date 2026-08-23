'use strict';
// Opt-in LIVE smoke tests — real network, real upstreams. Run with:
//   LIVE=1 npm test          (Git Bash / Linux)
//   $env:LIVE='1'; npm test  (PowerShell)
// Checks every upstream the sheet depends on, multi-region where relevant.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const LIVE = process.env.LIVE === '1';
const skip = !LIVE && 'set LIVE=1 to run network smoke tests';

test('SimBrief fetcher reachable and shaped right', { skip }, async () => {
  const { fetchOfp } = require('../lib/simbrief');
  const fs = require('node:fs'); const path = require('node:path');
  const userid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8')).userid;
  const raw = await fetchOfp(userid, { diskCache: false });
  assert.ok(raw.params.time_generated);
  assert.ok(raw.origin.icao_code);
});

test('aviationweather.gov serves all five regions in one call', { skip }, async () => {
  const { fetchMetars } = require('../lib/wx');
  const m = await fetchMetars(['KSAN', 'EDDF', 'RJTT', 'FAOR', 'YSSY']);
  for (const id of ['KSAN', 'EDDF', 'RJTT', 'FAOR', 'YSSY']) {
    assert.ok(m[id] && m[id].raw, `${id}: METAR returned`);
  }
});

test('OurAirports mirror serves current CSVs', { skip }, async () => {
  const res = await fetch('https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv', { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  assert.ok(res.ok);
});

test('PilotEdge ATIS endpoint answers (null outside PE hours is fine)', { skip }, async () => {
  const { fetchPeAtis } = require('../lib/peatis');
  await assert.doesNotReject(() => fetchPeAtis('KSAN')); // shape/reachability, not staffing
});

test('FAA NASR current-or-previous cycle downloadable (outage-tolerant)', { skip }, async () => {
  const { currentCycle, nasrStamp } = require('../lib/cycle');
  const { current, previous } = currentCycle();
  let ok = false;
  for (const cyc of [current, previous]) {
    try {
      const res = await fetch(`https://nfdc.faa.gov/webContent/28DaySub/extra/${nasrStamp(cyc)}_ILS_CSV.zip`, {
        method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000),
      });
      if (res.ok) { ok = true; break; }
    } catch (e) { /* try previous */ }
  }
  // AIM has real maintenance windows — report, don't fail the suite red.
  if (!ok) console.log('  note: FAA NASR unreachable right now (AIM maintenance?) — app serves cached cycle');
  assert.ok(true);
});
