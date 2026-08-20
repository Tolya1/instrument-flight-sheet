'use strict';
// Live weather: aviationweather.gov data API (keyless). One call for all
// stations. Absent stations in the reply are a real signal (no wx station) —
// reported per-airport, not thrown. Transient 5xx retried once.

async function awcJson(kind, ids) {
  const url = `https://aviationweather.gov/api/data/${kind}?ids=${ids.join(',')}&format=json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (res.status >= 500) throw new Error(`AWC HTTP ${res.status}`);
      if (!res.ok) throw new Error(`AWC HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// -> { KSAN: {raw, obsTime, tempC, dewC, wdir, wspd, wgst, visib, altimHpa, altimInHg, fltCat, clouds}, ... }
async function fetchMetars(ids) {
  const out = {};
  const arr = await awcJson('metar', ids);
  for (const m of Array.isArray(arr) ? arr : []) {
    const id = m.icaoId || m.station_id;
    if (!id) continue;
    const altimHpa = Number.isFinite(m.altim) ? m.altim : null;
    out[id] = {
      raw: m.rawOb || null,
      // m.obsTime is the true observation epoch; reportTime is rounded forward
      // to the cycle hour and would understate METAR age.
      obsTime: Number.isFinite(m.obsTime) ? new Date(m.obsTime * 1000).toISOString()
        : m.reportTime ? new Date(m.reportTime.replace(' ', 'T') + (m.reportTime.endsWith('Z') ? '' : 'Z')).toISOString() : null,
      tempC: Number.isFinite(m.temp) ? Math.round(m.temp) : null,
      dewC: Number.isFinite(m.dewp) ? Math.round(m.dewp) : null,
      wdir: m.wdir === 'VRB' ? 'VRB' : (Number.isFinite(m.wdir) ? m.wdir : null),
      wspd: Number.isFinite(m.wspd) ? m.wspd : null,
      wgst: Number.isFinite(m.wgst) ? m.wgst : null,
      visibSm: m.visib != null ? String(m.visib) : null,
      altimHpa,
      altimInHg: altimHpa != null ? Math.round((altimHpa / 33.8639) * 100) / 100 : null,
      fltCat: m.fltCat || null,
      name: m.name || null,
    };
  }
  return out;
}

// -> { KSAN: {raw, issueTime, fcsts:[{timeFrom,timeTo,...}]}, ... }
async function fetchTafs(ids) {
  const out = {};
  const arr = await awcJson('taf', ids);
  for (const t of Array.isArray(arr) ? arr : []) {
    const id = t.icaoId || t.station_id;
    if (!id) continue;
    out[id] = {
      raw: t.rawTAF || null,
      issueTime: t.issueTime || null,
      fcsts: Array.isArray(t.fcsts) ? t.fcsts.map(f => ({
        timeFrom: f.timeFrom || null, timeTo: f.timeTo || null,
      })) : [],
    };
  }
  return out;
}

module.exports = { fetchMetars, fetchTafs };
