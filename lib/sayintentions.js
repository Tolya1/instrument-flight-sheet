'use strict';
// SayIntentions live layer (verified against SI KB/docs 2026-08-30):
// - Local desktop app serves flight state at http://localhost:63287/flightJSON
//   (fallback :43117), including the pilot's api_key — so the key can be
//   discovered automatically whenever SI is running. A LAN URL can be
//   configured instead (e.g. the NAS polling the sim PC).
// - https://portal.sayintentions.ai/api/mep/getWX?key=..&icao=.. returns
//   {metar, taf, atis} where atis is the full generated ATIS text ("...
//   information Juliet ... Arriving and departing runways 34R, 34L, 35 ...").
// - SI frequencies come from Navigraph AIRAC (real-world), so the sheet's
//   numbers match; SI picks its OWN active runways -> the ATIS text is the
//   authority for runway highlighting, exactly like the PE feed.
// Personal-mode layer only: the API key is the pilot's own.

const fs = require('fs');
const path = require('path');

const SI_TTL_MS = 3 * 60 * 1000;
const siCache = new Map(); // icao -> {at, data}
let keyCache = { at: 0, key: null };

const PHONETIC = {
  ALPHA: 'A', ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F',
  GOLF: 'G', HOTEL: 'H', INDIA: 'I', JULIET: 'J', JULIETT: 'J', KILO: 'K', LIMA: 'L',
  MIKE: 'M', NOVEMBER: 'N', OSCAR: 'O', PAPA: 'P', QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S',
  TANGO: 'T', UNIFORM: 'U', VICTOR: 'V', WHISKEY: 'W', XRAY: 'X', 'X-RAY': 'X',
  YANKEE: 'Y', ZULU: 'Z',
};

// SI serves ATIS in two shapes (both verified live 2026-08-30):
//   abbreviated (the `atis` field):  "... INFO X-RAY. 0753Z. ARVG RWYS 30, 28L,
//     28R, 33. DPTG RWYS 30, 28R, 33. ... ALTIM 29.94."
//   spoken (the `phonetic` field):   "... information Juliet. ... Arriving and
//     departing runways 34R, 34L, 35. Visual approaches in use."
// Anchor strictly on ARVG/DPTG — KSFO also says "RWYS 1L, 1R, 19L AND 19R
// CLSD.", which must never be read as an active runway.
function parseSiAtis(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = { letter: null, arrivingRunways: null, departingRunways: null, approaches: null, transLevel: null, text };
  let m;

  if ((m = text.match(/\bINFO(?:RMATION)?\s+([A-Z][A-Z-]*)/i))) {
    const w = m[1].toUpperCase();
    out.letter = PHONETIC[w] || (w.length === 1 ? w : null);
  }

  const clean = s => s.replace(/\s+AND\s+/gi, ', ').replace(/\s+/g, ' ').trim();
  if ((m = text.match(/\bARVG\s+AND\s+DPTG\s+RWYS?\s+([^.]+)\./i))
    || (m = text.match(/\barriving and departing runways?\s+([^.]+)\./i))) {
    out.arrivingRunways = out.departingRunways = clean(m[1]);
  } else {
    if ((m = text.match(/\bARVG\s+RWYS?\s+([^.]+)\./i)) || (m = text.match(/\barriving runways?\s+([^.]+)\./i))) {
      out.arrivingRunways = clean(m[1]);
    }
    if ((m = text.match(/\bDPTG\s+RWYS?\s+([^.]+)\./i)) || (m = text.match(/\bdeparting runways?\s+([^.]+)\./i))) {
      out.departingRunways = clean(m[1]);
    }
  }

  if ((m = text.match(/([A-Za-z0-9 ,/-]*\bAPCH(?:ES)?\s+IN\s+USE)/i))
    || (m = text.match(/([A-Za-z0-9 ,/-]*approach(?:es)?\s+in\s+use)/i))) {
    out.approaches = m[1].trim().replace(/\s+/g, ' ');
  }
  // European ATIS carries the transition level ("TRL 80")
  if ((m = text.match(/\bTRL\s+(\d{2,3})\b/i))) out.transLevel = 'FL' + m[1];
  return out;
}

// api key: explicit setting wins; else ask the local SI app (it's only
// running when the user is actually flying with SI — cache briefly).
async function resolveKey({ apiKey = '', localUrl = '' } = {}) {
  if (apiKey && /^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) return apiKey;
  if (keyCache.key && Date.now() - keyCache.at < 10 * 60 * 1000) return keyCache.key;
  // Live app first, then the file it leaves behind (survives SI being closed).
  const candidates = localUrl ? [localUrl] : ['http://localhost:63287/flightJSON', 'http://localhost:43117/flightJSON'];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const k = keyFromFlightJson(await res.json());
      if (k) { keyCache = { at: Date.now(), key: k }; return k; }
    } catch (e) { /* SI app not running / URL unreachable */ }
  }
  try {
    const p = path.join(process.env.LOCALAPPDATA || '', 'SayIntentionsAI', 'flight.json');
    const k = keyFromFlightJson(JSON.parse(fs.readFileSync(p, 'utf8')));
    if (k) { keyCache = { at: Date.now(), key: k }; return k; }
  } catch (e) { /* no local SI install */ }
  return null;
}

// Real files nest everything under flight_details; the docs show it flat.
function keyFromFlightJson(j) {
  const k = j && ((j.flight_details && j.flight_details.api_key) || j.api_key);
  return typeof k === 'string' && k.length >= 8 ? k : null;
}

async function fetchSiWx(icao, key) {
  if (!icao || !key) return null;
  const cacheKey = icao.toUpperCase();
  const hit = siCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SI_TTL_MS) return hit.data;
  let data = null;
  try {
    const res = await fetch(
      `https://portal.sayintentions.ai/api/mep/getWX?key=${encodeURIComponent(key)}&icao=${encodeURIComponent(cacheKey)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const j = await res.json();
      if (j && (j.atis || j.metar || j.comms)) {
        data = {
          icao: cacheKey, metar: j.metar || null, taf: j.taf || null,
          atis: parseSiAtis(j.atis), comms: Array.isArray(j.comms) ? j.comms : null,
        };
      }
    }
  } catch (e) { /* optional layer */ }
  siCache.set(cacheKey, { at: Date.now(), data });
  if (siCache.size > 200) siCache.delete(siCache.keys().next().value);
  return data;
}

// SI's own comms list per airport, collapsed to ONE frequency per position.
// Verified 2026-08-30: getWX returns `comms:[{callsign,freq,type}]` and the
// list is sorted numerically, NOT by priority — so at split-complex fields
// (KOAK TWR 118.3/127.2 = North/South, KLAX TWR 120.95/133.9) the order says
// nothing about which one SI's controller is actually on. We print one number
// and flag that others exist rather than implying certainty.
const SI_TYPE_ORDER = ['ATIS', 'CLR', 'GND', 'TWR', 'APP', 'DEP', 'CTAF', 'FSS', 'FIS'];
const SI_TYPE_LABEL = {
  ATIS: 'ATIS', CLR: 'Clearance', GND: 'Ground', TWR: 'Tower', APP: 'Approach',
  DEP: 'Departure', CTAF: 'CTAF', FSS: 'FSS', FIS: 'FIS',
};

function collapseComms(comms) {
  const byType = new Map();
  for (const c of Array.isArray(comms) ? comms : []) {
    const t = String(c.type || '').toUpperCase();
    if (!SI_TYPE_LABEL[t]) continue; // drops RMP and anything unmodelled
    const mhz = parseFloat(c.freq);
    if (!Number.isFinite(mhz)) continue;
    if (!byType.has(t)) byType.set(t, { type: t, label: SI_TYPE_LABEL[t], callsign: c.callsign || null, freqs: new Set() });
    byType.get(t).freqs.add(mhz);
  }
  return [...byType.values()]
    .map(e => {
      const freqs = [...e.freqs].sort((a, b) => a - b);
      return { type: e.type, label: e.label, callsign: e.callsign, mhz: freqs[0], altCount: freqs.length - 1, all: freqs };
    })
    .sort((a, b) => SI_TYPE_ORDER.indexOf(a.type) - SI_TYPE_ORDER.indexOf(b.type));
}

// Live truth, but only while SI has an active flight (returns null otherwise).
// Shape is undocumented — accept anything that looks like {type/position, freq}.
async function fetchCurrentFrequencies(key, host = 'https://apipri.sayintentions.ai') {
  if (!key) return null;
  try {
    const res = await fetch(`${host}/sapi/getCurrentFrequencies?api_key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j !== 'object') return null;
    const rows = Array.isArray(j) ? j : (Array.isArray(j.frequencies) ? j.frequencies : Object.values(j));
    const out = {};
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const t = String(r.type || r.position || '').toUpperCase();
      const f = parseFloat(r.freq || r.frequency);
      if (SI_TYPE_LABEL[t] && Number.isFinite(f)) out[t] = f;
    }
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; }
}

// -> [{label, mhz, altCount, live}] for one airport, or null
async function fetchSiFreqs(icao, key, liveOverride = null) {
  const wx = await fetchSiWx(icao, key);
  if (!wx || !wx.comms) return null;
  const rows = collapseComms(wx.comms);
  if (liveOverride) {
    for (const r of rows) {
      if (liveOverride[r.type] && liveOverride[r.type] !== r.mhz) {
        r.mhz = liveOverride[r.type];
        r.live = true;
        r.altCount = Math.max(0, r.all.length - 1);
      } else if (liveOverride[r.type]) {
        r.live = true;
      }
    }
  }
  return rows;
}

module.exports = { resolveKey, fetchSiWx, parseSiAtis, collapseComms, fetchSiFreqs, fetchCurrentFrequencies, keyFromFlightJson };
