'use strict';
// VATSIM live layer: who is online for the dep/arr airports, on which
// frequencies, and the current ATIS. Feed facts (verified 2026-08-30):
// v3 datafeed regenerates every 15 s behind Cloudflare (max-age=15); poll
// gently and reuse snapshots. Controller `frequency` is a 3-decimal string
// and IS the number to tune (divisions can lag/lead real-world AIP — the
// live feed always wins on VATSIM). Observers sit in `controllers` with
// facility 0 / frequency "199.998". Callsign prefixes are NOT always ICAO
// (KSAN -> SAN_TWR, YMML -> ML_APP): the VAT-Spy data project is the
// canonical prefix map, cached like our other datasets.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VATSPY_FILE = path.join(DATA_DIR, 'VATSpy.dat');
const VATSPY_URL = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/VATSpy.dat';
const VATSPY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FEED_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const FEED_TTL_MS = 120 * 1000;

// facility index -> kneeboard label (feed's own facilities table, stable)
const FACILITY = { 1: 'FSS', 2: 'Clearance', 3: 'Ground', 4: 'Tower', 5: 'Apch/Dep', 6: 'Center' };

let vatspy = null; // { byIcao: Map icao -> {prefix, fir}, firPrefixes: Map fir -> Set(prefixes) }
let feedCache = { at: 0, data: null };

function parseVatspy(text) {
  const byIcao = new Map();
  const firPrefixes = new Map();
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith(';')) continue;
    if (l.startsWith('[')) { section = l.toLowerCase(); continue; }
    const p = l.split('|');
    if (section === '[airports]' && p.length >= 6) {
      // ICAO|Name|Lat|Lon|prefix|FIR|IsPseudo
      byIcao.set(p[0], { prefix: p[4] || null, fir: p[5] || null });
    } else if (section === '[firs]' && p.length >= 3) {
      // ICAO|NAME|CALLSIGN PREFIX|BOUNDARY
      if (!firPrefixes.has(p[0])) firPrefixes.set(p[0], new Set([p[0]]));
      if (p[2]) firPrefixes.get(p[0]).add(p[2]);
    }
  }
  return { byIcao, firPrefixes };
}

async function ensureVatspy() {
  const age = (() => { try { return Date.now() - fs.statSync(VATSPY_FILE).mtimeMs; } catch (e) { return Infinity; } })();
  if (age > VATSPY_MAX_AGE_MS) {
    try {
      const res = await fetch(VATSPY_URL, { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('[Airports]')) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(VATSPY_FILE + '.tmp', text);
          fs.renameSync(VATSPY_FILE + '.tmp', VATSPY_FILE);
          vatspy = null; // reparse
        }
      }
    } catch (e) { /* keep cache */ }
  }
  if (!vatspy && fs.existsSync(VATSPY_FILE)) {
    vatspy = parseVatspy(fs.readFileSync(VATSPY_FILE, 'utf8'));
  }
  return vatspy;
}

async function getFeed() {
  if (feedCache.data && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache.data;
  const res = await fetch(FEED_URL, {
    headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'instrument-flight-sheet (personal kneeboard)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`VATSIM feed HTTP ${res.status}`);
  const data = await res.json();
  feedCache = { at: Date.now(), data };
  return data;
}

// first token before _ or - ; "EPWA__GND" and "NZCH-S_CTR" both behave
const firstToken = cs => String(cs || '').split(/[_-]/)[0];
const suffix = cs => { const p = String(cs || '').split('_').filter(Boolean); return p[p.length - 1] || ''; };

// atis_code may be null — fall back to parsing "ATIS YMAV Z 300506"-style line
function atisLetter(a) {
  if (a.atis_code) return a.atis_code;
  const m = ((a.text_atis || [])[0] || '').match(/\bATIS\s+\S+\s+([A-Z])\b/);
  return m ? m[1] : null;
}

function matchAirport(icao, spy, feed) {
  const rec = spy && spy.byIcao.get(icao);
  const prefixes = new Set([icao]);
  if (rec && rec.prefix) prefixes.add(rec.prefix);
  const firSet = rec && rec.fir && spy.firPrefixes.get(rec.fir)
    ? spy.firPrefixes.get(rec.fir) : new Set(rec && rec.fir ? [rec.fir] : []);

  const positions = [];
  for (const c of feed.controllers || []) {
    if (!c.callsign || c.frequency === '199.998' || !(c.facility >= 1)) continue;
    const tok = firstToken(c.callsign);
    const isLocal = prefixes.has(tok) && c.facility >= 2;
    const isOverlying = firSet.has(tok) && (c.facility === 6 || c.facility === 1);
    if (!isLocal && !isOverlying) continue;
    positions.push({
      callsign: c.callsign,
      label: FACILITY[c.facility] || suffix(c.callsign),
      mhz: c.frequency,
      info: Array.isArray(c.text_atis) ? c.text_atis.join(' ') : null,
      overlying: isOverlying && !isLocal,
    });
  }
  positions.sort((a, b) => Object.values(FACILITY).indexOf(a.label) - Object.values(FACILITY).indexOf(b.label));

  let atis = null;
  const atisEntries = (feed.atis || []).filter(a => prefixes.has(firstToken(a.callsign)));
  if (atisEntries.length) {
    atis = atisEntries.map(a => ({
      callsign: a.callsign,
      kind: /_D_ATIS$/.test(a.callsign) ? 'DEP' : /_A_ATIS$/.test(a.callsign) ? 'ARR' : 'ATIS',
      mhz: a.frequency,
      letter: atisLetter(a),
      firstLine: (a.text_atis || [])[1] || (a.text_atis || [])[0] || null,
    }));
  }
  return { icao, positions, atis };
}

// -> { updateTs, dep: {positions, atis}, arr: {...} } or null on any failure
async function getVatsimFor(depIcao, arrIcao) {
  try {
    const [spy, feed] = await Promise.all([ensureVatspy(), getFeed()]);
    return {
      updateTs: feed.general && feed.general.update_timestamp,
      dep: depIcao ? matchAirport(depIcao, spy, feed) : null,
      arr: arrIcao ? matchAirport(arrIcao, spy, feed) : null,
    };
  } catch (e) {
    return null; // optional layer — degrade silently like PE ATIS
  }
}

module.exports = { getVatsimFor, parseVatspy, matchAirport, atisLetter, firstToken };
