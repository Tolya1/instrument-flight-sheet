'use strict';
// Extract a compact global ILS/LOC dataset from X-Plane's Navigraph-updated
// Custom Data folder (delivered AIRAC-current by Navigraph Hub, open format).
//
//   node tools/extract-navdata.js [xplane-root] [out.json]
//
// xplane-root defaults to `xplanePath` in data/settings.json.
// Output feeds lib/airports.js, which prefers it over FAA NASR per lookup.
//
// earth_nav.dat rows (NAV1100+): type 4 = ILS localizer, 5 = standalone
// LOC/LDA/SDF. Columns: type lat lon elev freq(x100) range bearing ident
// airport region runway name... Bearing packs magnetic course when >= 360:
// mag = floor(b/360), true = b - mag*360 (verified against FAOR/ZBAA).

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');

function xpRootFromSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')).xplanePath || null;
  } catch (e) { return null; }
}

function readCycle(customData) {
  const out = { cycle: null, validFrom: null, validTo: null };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(customData, 'cycle.json'), 'utf8'));
    out.cycle = String(j.cycle || j.AIRAC || '') || null;
    out.validFrom = j.validFrom || j.valid_from || null;
    out.validTo = j.validTo || j.valid_to || null;
  } catch (e) { /* fall through */ }
  if (!out.cycle || !out.validFrom) {
    try {
      const t = fs.readFileSync(path.join(customData, 'cycle_info.txt'), 'utf8');
      out.cycle = out.cycle || (t.match(/AIRAC cycle\s*:\s*(\d{4})/) || [])[1] || null;
      const valid = t.match(/Valid \(from\/to\):\s*(\S+)\s*-\s*(\S+)/);
      if (valid) { out.validFrom = out.validFrom || valid[1]; out.validTo = out.validTo || valid[2]; }
    } catch (e) { /* keep what we have */ }
  }
  return out;
}

async function main() {
  const xpRoot = process.argv[2] || xpRootFromSettings();
  if (!xpRoot) {
    console.error('Usage: node tools/extract-navdata.js <xplane-root> [out.json]\n(or set "xplanePath" in data/settings.json)');
    process.exit(1);
  }
  const customData = path.join(xpRoot, 'Custom Data');
  const navDat = path.join(customData, 'earth_nav.dat');
  if (!fs.existsSync(navDat)) {
    console.error(`not found: ${navDat} — is Navigraph Hub installed for X-Plane?`);
    process.exit(1);
  }
  const out = process.argv[3] || path.join(ROOT, 'data', 'navdata-ils.json');

  const meta = readCycle(customData);
  const ils = {};
  let rows = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(navDat) });
  for await (const line of rl) {
    const p = line.trim().split(/\s+/);
    if (p[0] !== '4' && p[0] !== '5') continue;
    const freq = parseInt(p[4], 10) / 100;
    if (!Number.isFinite(freq) || freq < 108 || freq > 118) continue;
    const airport = p[8], rwy = p[10], ident = p[7];
    if (!airport || !rwy) continue;
    const b = parseFloat(p[6]);
    const course = Number.isFinite(b) ? (b >= 360 ? Math.floor(b / 360) % 360 : Math.round(b)) : null;
    const name = p.slice(11).join(' ');
    // keep the best row per runway end (ILS beats bare LOC)
    const key = `${airport}|${rwy}`;
    if (ils[key] && /ILS/i.test(ils[key].cat || '') && !/ILS/i.test(name)) continue;
    ils[key] = { f: freq, c: course, cat: name || (p[0] === '4' ? 'ILS' : 'LOC'), id: ident };
    rows++;
  }

  const doc = {
    meta: {
      cycle: meta.cycle, validFrom: meta.validFrom, validTo: meta.validTo,
      source: 'Navigraph (X-Plane Custom Data)',
      extractedAt: new Date().toISOString(),
      count: Object.keys(ils).length,
    },
    ils,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc));
  console.log(`AIRAC ${meta.cycle} (valid ${meta.validFrom} - ${meta.validTo}): ${Object.keys(ils).length} runway ends with ILS/LOC (${rows} rows) -> ${out}`);
}

main();
