'use strict';
// PilotEdge live network ATIS — undocumented but verified feed:
//   https://www.pilotedge.net/atis/KSAN.json
// Gives the network's actual ATIS letter, active runways, and approach in
// use. Optional layer: any failure (outside PE hours, feed gone, non-JSON)
// degrades to null and the sheet simply omits it.

async function fetchPeAtis(icao) {
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

module.exports = { fetchPeAtis };
