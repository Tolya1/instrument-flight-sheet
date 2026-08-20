'use strict';
// Airport static data: OurAirports CSVs (airports, frequencies, runways, navaids)
// + FAA NASR ILS_BASE.csv for localizer freq/course. All cached under data/,
// refreshed on demand or when stale. Everything is best-effort: a failed
// refresh keeps serving the previous cache.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseCsv } = require('./csv');
const { currentCycle, nasrStamp, isoDate } = require('./cycle');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OA_BASE = 'https://davidmegginson.github.io/ourairports-data';
const OA_FILES = ['airports.csv', 'airport-frequencies.csv', 'runways.csv', 'navaids.csv'];
const OA_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // re-download weekly

// Human labels for OurAirports frequency `type` codes, in display order.
const FREQ_ORDER = ['ATIS', 'AWOS', 'ASOS', 'CLD', 'GND', 'TWR', 'A/D', 'APP', 'DEP', 'CTR', 'CTAF', 'UNIC'];
const FREQ_LABEL = {
  ATIS: 'ATIS', AWOS: 'AWOS', ASOS: 'ASOS', CLD: 'Clearance', GND: 'Ground', TWR: 'Tower',
  'A/D': 'Apch/Dep', APP: 'Approach', DEP: 'Departure', CTR: 'Center', CTAF: 'CTAF', UNIC: 'UNICOM',
};

const state = {
  airports: null,        // ident -> {name, elevation, type, municipality, localCode, iata}
  byLocalCode: null,     // local_code -> ident
  freqs: null,           // ident -> [{type,label,desc,mhz}]
  runways: null,         // ident -> [{leIdent,heIdent,lengthFt,widthFt,surface,lighted,closed,leHeadingT,heHeadingT}]
  navaids: null,         // ident -> {name,type,freqKhz}
  ils: null,             // "APT|RWY" -> {locFreq, course, category, locId}  (APT = FAA id, no K)
  ilsCycle: null,        // ISO date of the NASR cycle in use
  loadedAt: null,
  refreshing: false,
  lastError: null,
};

function fileAge(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch (e) { return Infinity; }
}

async function download(url, dest, headers = {}, validate = null) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (validate && !validate(buf)) throw new Error(`${url} -> unexpected content (proxy/block page?)`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // atomic: never leave a half-written file to be trusted for a week
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf;
}

// Every OurAirports CSV header contains "ident"; a captive-portal/HTML error
// page starts with '<' and doesn't.
const looksLikeOaCsv = buf => {
  const first = buf.slice(0, 4096).toString('utf8').split('\n', 1)[0];
  return buf.length > 50000 && first[0] !== '<' && first.includes('ident');
};

async function ensureOurAirports(force = false) {
  for (const f of OA_FILES) {
    const dest = path.join(DATA_DIR, f);
    if (force || fileAge(dest) > OA_MAX_AGE_MS) {
      try {
        await download(`${OA_BASE}/${f}`, dest, {}, looksLikeOaCsv);
      } catch (e) {
        if (!fs.existsSync(dest)) throw e; // no cache to fall back to
        state.lastError = `OurAirports refresh failed (${f}): ${e.message} — using cached copy`;
      }
    }
  }
}

// NASR per-domain ILS CSV zip. Needs a browser-ish User-Agent; 404s until a
// cycle is published, so fall back to the previous cycle.
async function ensureNasrIls(force = false) {
  const { current, previous } = currentCycle();
  const tryCycles = [current, previous];
  for (const cyc of tryCycles) {
    const dest = path.join(DATA_DIR, `ILS_BASE_${isoDate(cyc)}.csv`);
    if (!force && fs.existsSync(dest)) { state.ilsCycle = isoDate(cyc); return dest; }
    try {
      const url = `https://nfdc.faa.gov/webContent/28DaySub/extra/${nasrStamp(cyc)}_ILS_CSV.zip`;
      const buf = await download(url, path.join(DATA_DIR, `ils_${isoDate(cyc)}.zip`), {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) simbrief-flight-sheet/2.0',
      });
      const zip = new AdmZip(buf);
      const entry = zip.getEntries().find(e => /ILS_BASE\.csv$/i.test(e.entryName));
      if (!entry) throw new Error('ILS_BASE.csv not in zip');
      fs.writeFileSync(dest, entry.getData());
      state.ilsCycle = isoDate(cyc);
      return dest;
    } catch (e) {
      state.lastError = `NASR ILS ${isoDate(cyc)}: ${e.message}`;
    }
  }
  // Nothing downloadable — use any older cached cycle file if present.
  const cached = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter(f => /^ILS_BASE_\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().pop()
    : null;
  if (cached) {
    state.ilsCycle = cached.slice(9, 19);
    return path.join(DATA_DIR, cached);
  }
  return null;
}

function indexAll(ilsCsvPath) {
  const read = f => fs.readFileSync(path.join(DATA_DIR, f), 'utf8');

  const airports = new Map(), byLocal = new Map();
  for (const r of parseCsv(read('airports.csv'))) {
    if (r.type === 'closed') continue;
    airports.set(r.ident, {
      ident: r.ident, name: r.name, elevation: r.elevation_ft ? +r.elevation_ft : null,
      type: r.type, municipality: r.municipality, region: r.iso_region,
      localCode: r.local_code || null, iata: r.iata_code || null,
    });
    if (r.local_code && !byLocal.has(r.local_code)) byLocal.set(r.local_code, r.ident);
  }

  const freqs = new Map();
  for (const r of parseCsv(read('airport-frequencies.csv'))) {
    const t = (r.type || '').toUpperCase();
    if (!FREQ_LABEL[t]) continue; // drop MISC/RDO/etc.
    const mhz = parseFloat(r.frequency_mhz);
    if (!Number.isFinite(mhz) || mhz < 108 || mhz > 137) continue; // VHF comm/ATIS band only
    if (!freqs.has(r.airport_ident)) freqs.set(r.airport_ident, []);
    freqs.get(r.airport_ident).push({ type: t, label: FREQ_LABEL[t], desc: r.description || '', mhz });
  }
  for (const list of freqs.values()) {
    list.sort((a, b) => FREQ_ORDER.indexOf(a.type) - FREQ_ORDER.indexOf(b.type) || a.mhz - b.mhz);
  }

  const runways = new Map();
  for (const r of parseCsv(read('runways.csv'))) {
    if (r.closed === '1') continue;
    if (!runways.has(r.airport_ident)) runways.set(r.airport_ident, []);
    runways.get(r.airport_ident).push({
      leIdent: r.le_ident, heIdent: r.he_ident,
      lengthFt: r.length_ft ? +r.length_ft : null, widthFt: r.width_ft ? +r.width_ft : null,
      surface: r.surface || null, lighted: r.lighted === '1',
      leHeadingT: r.le_heading_degT ? +r.le_heading_degT : null,
      heHeadingT: r.he_heading_degT ? +r.he_heading_degT : null,
      leDisplacedFt: r.le_displaced_threshold_ft ? +r.le_displaced_threshold_ft : null,
      heDisplacedFt: r.he_displaced_threshold_ft ? +r.he_displaced_threshold_ft : null,
    });
  }

  const navaids = new Map();
  for (const r of parseCsv(read('navaids.csv'))) {
    // anchored: NDB-DME would match a loose /DME/ and leak kHz into the MHz column
    if (!/^(VOR|VOR-DME|VORTAC|TACAN|DME)$/.test(r.type || '')) continue;
    if (!navaids.has(r.ident)) {
      navaids.set(r.ident, { name: r.name, type: r.type, freqKhz: r.frequency_khz ? +r.frequency_khz : null });
    }
  }

  const ils = new Map();
  if (ilsCsvPath && fs.existsSync(ilsCsvPath)) {
    for (const r of parseCsv(fs.readFileSync(ilsCsvPath, 'utf8'))) {
      const apt = r.ARPT_ID || r.arpt_id, rwy = r.RWY_END_ID || r.rwy_end_id;
      if (!apt || !rwy) continue;
      const freq = parseFloat(r.LOC_FREQ || r.loc_freq);
      if (!Number.isFinite(freq)) continue;
      ils.set(`${apt}|${rwy}`, {
        locFreq: freq,
        course: r.APCH_BEAR ? Math.round(parseFloat(r.APCH_BEAR)) : null, // magnetic (FAA-published)
        category: r.CATEGORY || null,
        locId: r.ILS_LOC_ID || null,
        type: r.SYSTEM_TYPE_CODE || null,
      });
    }
  }

  state.airports = airports; state.byLocalCode = byLocal;
  state.freqs = freqs; state.runways = runways; state.navaids = navaids; state.ils = ils;
  state.loadedAt = new Date().toISOString();
}

let pendingForce = false;
async function init({ force = false } = {}) {
  if (state.refreshing) { if (force) pendingForce = true; return; }
  state.refreshing = true;
  state.lastError = null; // stale errors (e.g. a routine NASR 404) must not outlive the run that hit them
  try {
    await ensureOurAirports(force);
    const ilsPath = await ensureNasrIls(force);
    indexAll(ilsPath);
  } finally {
    state.refreshing = false;
    if (pendingForce) {
      pendingForce = false;
      init({ force: true }).catch(() => {});
    }
  }
}

// SimBrief icao -> OurAirports ident (handles L35-style US non-ICAO fields).
function resolveIdent(icao) {
  if (!icao || !state.airports) return null;
  if (state.airports.has(icao)) return icao;
  if (icao.length === 4 && icao.startsWith('K') && state.airports.has(icao.slice(1))) return icao.slice(1);
  if (state.byLocalCode.has(icao)) return state.byLocalCode.get(icao);
  return null;
}

// FAA NASR keys airports by FAA id (usually the ICAO minus the K).
function faaId(ident) {
  const a = state.airports && state.airports.get(ident);
  if (a && a.localCode) return a.localCode;
  return ident.length === 4 && ident.startsWith('K') ? ident.slice(1) : ident;
}

function airportInfo(icao) {
  const ident = resolveIdent(icao);
  if (!ident) return null;
  const a = state.airports.get(ident);
  const fid = faaId(ident);
  const rwys = (state.runways.get(ident) || []).map(r => {
    const ends = [
      { ident: r.leIdent, headingT: r.leHeadingT, displacedFt: r.leDisplacedFt, ils: state.ils.get(`${fid}|${r.leIdent}`) || null },
      { ident: r.heIdent, headingT: r.heHeadingT, displacedFt: r.heDisplacedFt, ils: state.ils.get(`${fid}|${r.heIdent}`) || null },
    ];
    return { ...r, ends };
  });
  return {
    ident, icao, name: a.name, elevation: a.elevation, type: a.type,
    municipality: a.municipality, region: a.region,
    freqs: state.freqs.get(ident) || [],
    runways: rwys,
  };
}

function navaid(ident) {
  return (state.navaids && state.navaids.get(ident)) || null;
}

function status() {
  return {
    loadedAt: state.loadedAt,
    refreshing: state.refreshing,
    ilsCycle: state.ilsCycle,
    lastError: state.lastError,
    airportCount: state.airports ? state.airports.size : 0,
    ilsCount: state.ils ? state.ils.size : 0,
    csvAges: Object.fromEntries(OA_FILES.map(f => {
      const age = fileAge(path.join(DATA_DIR, f));
      return [f, Number.isFinite(age) ? Math.round(age / 3600000) + 'h' : 'missing'];
    })),
  };
}

module.exports = { init, airportInfo, navaid, status, resolveIdent };
