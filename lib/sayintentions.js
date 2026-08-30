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

function parseSiAtis(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = { letter: null, arrivingRunways: null, departingRunways: null, approaches: null, text };
  const lm = text.match(/information\s+([A-Za-z-]+)/i);
  if (lm) out.letter = PHONETIC[lm[1].toUpperCase()] || (lm[1].length === 1 ? lm[1].toUpperCase() : null);
  let m;
  if ((m = text.match(/arriving and departing runways?\s+([0-9LRC,\s]+?)(?:\.|$)/im))) {
    out.arrivingRunways = out.departingRunways = m[1].trim();
  } else {
    if ((m = text.match(/arriving runways?\s+([0-9LRC,\s]+?)(?:\.|$)/im))) out.arrivingRunways = m[1].trim();
    if ((m = text.match(/departing runways?\s+([0-9LRC,\s]+?)(?:\.|$)/im))) out.departingRunways = m[1].trim();
  }
  if ((m = text.match(/([A-Za-z0-9 ,/-]*approach(?:es)?\s+in\s+use)/i))) out.approaches = m[1].trim();
  return out;
}

// api key: explicit setting wins; else ask the local SI app (it's only
// running when the user is actually flying with SI — cache briefly).
async function resolveKey({ apiKey = '', localUrl = '' } = {}) {
  if (apiKey && /^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) return apiKey;
  if (keyCache.key && Date.now() - keyCache.at < 10 * 60 * 1000) return keyCache.key;
  const candidates = localUrl ? [localUrl] : ['http://localhost:63287/flightJSON', 'http://localhost:43117/flightJSON'];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && typeof j.api_key === 'string' && j.api_key.length >= 8) {
        keyCache = { at: Date.now(), key: j.api_key };
        return j.api_key;
      }
    } catch (e) { /* SI app not running / URL unreachable */ }
  }
  return null;
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
      if (j && (j.atis || j.metar)) {
        data = { icao: cacheKey, metar: j.metar || null, taf: j.taf || null, atis: parseSiAtis(j.atis) };
      }
    }
  } catch (e) { /* optional layer */ }
  siCache.set(cacheKey, { at: Date.now(), data });
  if (siCache.size > 200) siCache.delete(siCache.keys().next().value);
  return data;
}

module.exports = { resolveKey, fetchSiWx, parseSiAtis };
