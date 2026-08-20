'use strict';
// Defensive METAR parser. Must NEVER throw — worst case returns {} and the
// sheet prints the raw text. Handles COR/AMD/AUTO/NIL, VRB, gusts, MPS,
// fractional SM visibility, metric visibility, VV ceilings, M-prefixed temps,
// A/Q altimeter groups. (The old tool's parser died on a COR token.)

const CLOUD_RE = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/;

function parseMetar(raw) {
  const out = {
    station: null, timeZ: null, obsTime: null,
    windDir: null, windSpd: null, windGust: null, windVrb: false,
    visSm: null, visM: null,
    clouds: [], ceilingFt: null,
    tempC: null, dewC: null,
    altimInHg: null, altimHpa: null,
    auto: false, cor: false,
    ok: false,
  };
  if (typeof raw !== 'string' || !raw.trim()) return out;
  try {
    // Everything after RMK is remarks — ignore for the parsed summary.
    const body = raw.split(/\bRMK\b/)[0];
    const toks = body.trim().split(/\s+/);
    let i = 0;
    if (toks[i] === 'METAR' || toks[i] === 'SPECI') i++;
    if (/^[A-Z0-9]{4}$/.test(toks[i] || '')) { out.station = toks[i]; i++; }
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t === 'COR') { out.cor = true; continue; }
      if (t === 'AMD') continue;
      if (t === 'AUTO') { out.auto = true; continue; }
      if (t === 'NIL' || t === 'CNL' || t === '$') continue;

      let m;
      if ((m = t.match(/^(\d{2})(\d{2})(\d{2})Z$/)) && !out.timeZ) {
        out.timeZ = t;
        // Resolve to a real Date: this month unless the day is in the future
        // (then it was last month).
        const now = new Date();
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +m[1], +m[2], +m[3]));
        if (d.getTime() - now.getTime() > 2 * 24 * 3600 * 1000) {
          d.setUTCMonth(d.getUTCMonth() - 1);
          // Day absent in previous month (e.g. Feb 30): JS normalized forward
          // into the future — obs time unresolvable, leave obsTime null so the
          // sheet shows "obs time unknown" instead of a bogus negative age.
          if (d.getUTCDate() !== +m[1]) continue;
        }
        out.obsTime = d.toISOString();
        continue;
      }
      if ((m = t.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/))) {
        const toKt = m[4] === 'MPS' ? 1.94384 : 1;
        if (m[1] === 'VRB') out.windVrb = true; else out.windDir = +m[1];
        out.windSpd = Math.round(+m[2] * toKt);
        if (m[3]) out.windGust = Math.round(+m[3] * toKt);
        continue;
      }
      if (/^\d{3}V\d{3}$/.test(t)) continue; // wind variability group
      if ((m = t.match(/^([MP])?(\d{1,2})?(?: )?(\d)\/(\d{1,2})SM$/)) || (m = t.match(/^([MP])?(\d{1,2})SM$/))) {
        // "1/2SM", "M1/4SM", "P6SM", "10SM" — also "1 1/2SM" arrives as two
        // tokens; catch the whole-number prefix case below.
        if (m.length === 5) out.visSm = (+m[2] || 0) + (+m[3]) / (+m[4]);
        else out.visSm = +m[2];
        continue;
      }
      if (/^\d{1,2}$/.test(t) && /^\d\/\d{1,2}SM$/.test(toks[i + 1] || '')) {
        const f = toks[i + 1].match(/^(\d)\/(\d{1,2})SM$/);
        out.visSm = +t + (+f[1]) / (+f[2]);
        i++;
        continue;
      }
      if (/^\d{4}(NDV)?$/.test(t) && out.visM === null && out.windSpd !== null && out.tempC === null) {
        out.visM = parseInt(t, 10); // metric visibility (non-US)
        continue;
      }
      if ((m = t.match(CLOUD_RE))) {
        const base = +m[2] * 100;
        out.clouds.push({ cover: m[1], baseFt: base, mod: m[3] || null });
        if ((m[1] === 'BKN' || m[1] === 'OVC' || m[1] === 'VV') && (out.ceilingFt === null || base < out.ceilingFt)) {
          out.ceilingFt = base;
        }
        continue;
      }
      if (t === 'CLR' || t === 'SKC' || t === 'NCD' || t === 'NSC' || t === 'CAVOK') {
        out.clouds.push({ cover: t, baseFt: null, mod: null });
        continue;
      }
      if ((m = t.match(/^(M?\d{2})\/(M?\d{2})?$/))) {
        out.tempC = parseInt(m[1].replace('M', '-'), 10);
        if (m[2]) out.dewC = parseInt(m[2].replace('M', '-'), 10);
        continue;
      }
      if ((m = t.match(/^A(\d{4})$/))) {
        out.altimInHg = +m[1] / 100;
        out.altimHpa = Math.round(out.altimInHg * 33.8639 * 10) / 10;
        continue;
      }
      if ((m = t.match(/^Q(\d{4})$/))) {
        out.altimHpa = +m[1];
        out.altimInHg = Math.round((+m[1] / 33.8639) * 100) / 100;
        continue;
      }
      // anything else (wx phenomena, RVR, etc.) — tolerated, not modeled
    }
    out.ok = true;
  } catch (e) {
    // Deliberately swallowed: raw METAR always prints; parsed view is best-effort.
  }
  return out;
}

// Age in whole minutes of a METAR observation vs now; null when unknown.
function metarAgeMin(parsed, now = new Date()) {
  if (!parsed || !parsed.obsTime) return null;
  return Math.round((now.getTime() - new Date(parsed.obsTime).getTime()) / 60000);
}

module.exports = { parseMetar, metarAgeMin };
