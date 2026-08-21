'use strict';
// PilotEdge live network ATIS — undocumented but verified feed:
//   https://www.pilotedge.net/atis/KSAN.json
// Gives the network's actual ATIS letter, active runways, and approach in
// use. Optional layer: any failure (outside PE hours, feed gone, non-JSON)
// degrades to null and the sheet simply omits it.

const PE_TTL_MS = 90 * 1000;
const PE_CACHE_MAX = 300;
const peCache = new Map(); // icao -> {at, data} (nulls cached too)

async function fetchPeAtisLive(icao) {
  try {
    const res = await fetch(`https://www.pilotedge.net/atis/${encodeURIComponent(icao)}.json`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    const j = await res.json();
    if (!j || !j.icao) return null;
    return {
      icao: j.icao,
      letter: j.letter || null,
      hasDAtis: !!j.has_d_atis,
      metar: j.metar || null,
      arrivingRunways: j.arriving_runways || null,
      departingRunways: j.departing_runways || null,
      approaches: j.approaches || null,
      text: j.text || null,
    };
  } catch (e) {
    return null;
  }
}

async function fetchPeAtis(icao) {
  if (typeof icao !== 'string' || !/^[A-Za-z0-9]{3,4}$/.test(icao)) return null;
  const key = icao.toUpperCase();
  const hit = peCache.get(key);
  if (hit && Date.now() - hit.at < PE_TTL_MS) return hit.data;
  const data = await fetchPeAtisLive(key);
  peCache.set(key, { at: Date.now(), data });
  if (peCache.size > PE_CACHE_MAX) {
    const oldest = [...peCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) peCache.delete(oldest[0]);
  }
  return data;
}

module.exports = { fetchPeAtis };
