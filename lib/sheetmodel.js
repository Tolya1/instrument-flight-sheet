'use strict';
// Assembles the full sheet model: SimBrief OFP + airport DB + live wx + PE
// ATIS + derived values (wind components, TOD, V-speeds, ETA local). Each
// source fails independently; the model always comes back with whatever
// could be gathered, stamped with per-source status.

const { fetchOfp, readCachedOfp, normalizeOfp } = require('./simbrief');
const airports = require('./airports');
const { fetchMetars, fetchTafs } = require('./wx');
const { fetchPeAtis } = require('./peatis');
const { getVatsimFor } = require('./vatsim');
const si = require('./sayintentions');
const { parseMetar, metarAgeMin } = require('./metar-parse');

// Only strings/numbers qualify — v2 blanks arrive as [] or '' and Number()
// would turn both into a fabricated 0 (e.g. TLR flex_temperature === '').
const num = v => {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// PilotEdge coverage: ZLA + the Western-US expansion ARTCCs.
const PE_FIRS = new Set(['KZLA', 'KZOA', 'KZSE', 'KZLC', 'KZDV', 'KZAB']);
const NETWORKS = ['auto', 'pilotedge', 'sayintentions', 'vatsim'];

// User rule: inside PE coverage default to PilotEdge, elsewhere SayIntentions.
function resolveNetwork(selected, ofp) {
  if (NETWORKS.includes(selected) && selected !== 'auto') {
    return { selected, resolved: selected, reason: 'manual' };
  }
  const inPe = ofp.firOrig && ofp.firDest && PE_FIRS.has(ofp.firOrig) && PE_FIRS.has(ofp.firDest);
  return {
    selected: 'auto',
    resolved: inPe ? 'pilotedge' : 'sayintentions',
    reason: inPe ? `both FIRs (${ofp.firOrig}/${ofp.firDest}) in PE coverage` : 'outside PE coverage',
  };
}

// Head/crosswind per runway end. METAR winds and OurAirports runway headings
// are both TRUE degrees, so the subtraction is consistent.
function windComponents(headingT, wdir, wspd) {
  if (headingT == null || wdir == null || wdir === 'VRB' || !wspd) return null;
  const rad = ((wdir - headingT) * Math.PI) / 180;
  const head = Math.round(wspd * Math.cos(rad));
  const cross = Math.round(wspd * Math.sin(rad));
  return { head, cross: Math.abs(cross), side: cross > 0 ? 'R' : cross < 0 ? 'L' : '-' };
}

function wxBlock(icao, awcMetar, sbMetarRaw, sbTaf, awcTaf) {
  const raw = (awcMetar && awcMetar.raw) || sbMetarRaw || null;
  const parsed = parseMetar(raw || '');
  // Prefer AWC's decoded numbers when we have them.
  if (awcMetar) {
    if (awcMetar.wdir !== null) parsed.windDir = awcMetar.wdir === 'VRB' ? null : awcMetar.wdir;
    if (awcMetar.wdir === 'VRB') parsed.windVrb = true;
    if (awcMetar.wspd !== null) parsed.windSpd = awcMetar.wspd;
    if (awcMetar.wgst !== null) parsed.windGust = awcMetar.wgst;
    if (awcMetar.tempC !== null) parsed.tempC = awcMetar.tempC;
    if (awcMetar.dewC !== null) parsed.dewC = awcMetar.dewC;
    if (awcMetar.altimInHg !== null) { parsed.altimInHg = awcMetar.altimInHg; parsed.altimHpa = awcMetar.altimHpa; }
    if (awcMetar.obsTime) parsed.obsTime = awcMetar.obsTime;
  }
  const ageMin = metarAgeMin(parsed);
  return {
    icao,
    raw,
    source: awcMetar ? 'awc' : (sbMetarRaw ? 'simbrief-ofp' : null),
    parsed,
    ageMin,
    stale: ageMin !== null ? (ageMin > 65 || ageMin < -10) : true, // future obs = clock skew/bad parse = suspect
    fltCat: (awcMetar && awcMetar.fltCat) || null,
    taf: (awcTaf && awcTaf.raw) || sbTaf || null,
    tafFcsts: (awcTaf && awcTaf.fcsts) || [],
  };
}

// "27" / "24R, 25L" / "27 AND 33L" -> ["27","33L"]
function parseRunwayList(s) {
  if (!s) return [];
  return String(s).toUpperCase().match(/\d{1,2}[LRC]?/g) || [];
}

function attachDerived(apInfo, wx, likelyRwys) {
  if (!apInfo) return null;
  const wdir = wx && wx.parsed ? wx.parsed.windDir : null;
  const wspd = wx && wx.parsed ? wx.parsed.windSpd : null;
  for (const r of apInfo.runways) {
    for (const end of r.ends) {
      end.wind = windComponents(end.headingT, wdir, wspd);
      end.likely = likelyRwys.includes(end.ident);
    }
  }
  return apInfo;
}

function tlrTakeoff(tlr, planRwy) {
  try {
    const rws = tlr && tlr.takeoff && Array.isArray(tlr.takeoff.runway) ? tlr.takeoff.runway : [];
    const r = rws.find(x => x.identifier === planRwy) || rws[0];
    if (!r) return null;
    return {
      runway: r.identifier, v1: num(r.speeds_v1), vr: num(r.speeds_vr), v2: num(r.speeds_v2),
      flaps: r.flap_setting || null, thrust: r.thrust_setting || null,
      lengthFt: num(r.length), reqFt: num(r.distance_reject), marginFt: num(r.distance_margin),
      maxWeight: num(r.max_weight), limitCode: r.limit_code || null,
    };
  } catch (e) { return null; }
}

function tlrLanding(tlr) {
  try {
    const c = tlr && tlr.landing && tlr.landing.conditions;
    const d = tlr && tlr.landing && tlr.landing.distance_dry;
    if (!d) return null;
    return {
      runway: c ? c.planned_runway : null, flaps: c ? c.flap_setting : null,
      vref: num(d.speeds_vref), reqFt: num(d.actual_distance), factoredFt: num(d.factored_distance),
      wet: tlr.landing.distance_wet ? { reqFt: num(tlr.landing.distance_wet.actual_distance), vref: num(tlr.landing.distance_wet.speeds_vref) } : null,
    };
  } catch (e) { return null; }
}

function localTime(isoZ, tzOffsetHours) {
  if (!isoZ || tzOffsetHours == null) return null;
  const d = new Date(new Date(isoZ).getTime() + tzOffsetHours * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Route VORs for radio-nav cross-check: navlog fixes that are VOR-type or
// resolve in the navaid DB.
function routeVors(ofp) {
  const seen = new Set(); const out = [];
  for (const f of ofp.navlog) {
    if (!f.ident || seen.has(f.ident)) continue;
    const isVorType = /vor/i.test(f.type || '');
    const db = airports.navaid(f.ident);
    if (!isVorType && !db) continue;
    seen.add(f.ident);
    let mhz = null;
    if (isVorType && f.freq && Number.isFinite(parseFloat(f.freq))) mhz = parseFloat(f.freq);
    else if (db && db.freqKhz) mhz = Math.round(db.freqKhz) / 1000;
    out.push({ ident: f.ident, name: (db && db.name) || f.name || '', mhz, via: f.via });
    if (out.length >= 8) break;
  }
  return out;
}

// Howgozit rows: up to 3 evenly spaced enroute fixes with planned fuel.
function fuelChecks(ofp) {
  const fixes = ofp.navlog.filter(f => f.fuelOnboard != null && f.timeTotal);
  if (fixes.length < 3) return [];
  const picks = [0.25, 0.5, 0.75].map(p => fixes[Math.min(fixes.length - 1, Math.round(p * (fixes.length - 1)))]);
  const uniq = [...new Map(picks.map(f => [f.ident, f])).values()];
  return uniq.map(f => ({ ident: f.ident, timeTotal: f.timeTotal, planFuel: f.fuelOnboard }));
}

async function buildSheet(user, { diskCache = true, network = 'auto', siAuth = null } = {}) {
  const status = { simbrief: 'live', wx: 'ok', peAtis: 'ok', airportData: 'ok', ils: airports.status().ilsSource };

  let rawOfp;
  try {
    rawOfp = await fetchOfp(user, { diskCache });
  } catch (e) {
    // The on-disk last-OFP fallback belongs to the single-user install only —
    // in public mode it would hand user A the last plan fetched for user B.
    rawOfp = diskCache ? readCachedOfp() : null;
    status.simbrief = rawOfp ? `cached (${e.message})` : `failed (${e.message})`;
    if (!rawOfp) return { error: `SimBrief unreachable: ${e.message}`, status };
  }
  const ofp = normalizeOfp(rawOfp);

  const depIcao = ofp.origin && ofp.origin.icao;
  const arrIcao = ofp.destination && ofp.destination.icao;
  const altn = ofp.alternates[0] || null;
  const wxIds = [depIcao, arrIcao, altn && altn.icao].filter(Boolean);

  let metars = {}, tafs = {};
  try {
    [metars, tafs] = await Promise.all([fetchMetars(wxIds), fetchTafs(wxIds)]);
  } catch (e) {
    status.wx = `failed (${e.message}) — falling back to OFP-embedded wx`;
  }

  const net = resolveNetwork(network, ofp);

  // One shape for whichever network supplies a live ATIS:
  // {net, letter, arrivingRunways, departingRunways, approaches}
  let depNet = null, arrNet = null, vatsim = null, siFreqs = null;
  if (net.resolved === 'pilotedge') {
    try {
      const [peDep, peArr] = await Promise.all([fetchPeAtis(depIcao), fetchPeAtis(arrIcao)]);
      const map = p => p && {
        net: 'PE', letter: p.letter,
        arrivingRunways: p.arrivingRunways, departingRunways: p.departingRunways,
        approaches: p.approaches,
      };
      depNet = map(peDep); arrNet = map(peArr);
      if (!depNet && !arrNet) status.peAtis = 'unavailable (outside PE hours or feed down)';
    } catch (e) { status.peAtis = 'unavailable'; }
  } else {
    status.peAtis = `n/a (network: ${net.resolved})`;
  }

  if (net.resolved === 'sayintentions') {
    const key = siAuth ? await si.resolveKey(siAuth) : null;
    if (key) {
      // Live per-position frequencies exist only while SI has an active
      // flight; otherwise we fall back to SI's own per-airport comms list.
      const live = await si.fetchCurrentFrequencies(key);
      const [siDep, siArr, fDep, fArr] = await Promise.all([
        si.fetchSiWx(depIcao, key), si.fetchSiWx(arrIcao, key),
        si.fetchSiFreqs(depIcao, key, live), si.fetchSiFreqs(arrIcao, key, live),
      ]);
      const map = s => s && s.atis && {
        net: 'SI', letter: s.atis.letter,
        arrivingRunways: s.atis.arrivingRunways, departingRunways: s.atis.departingRunways,
        approaches: s.atis.approaches,
      };
      depNet = map(siDep); arrNet = map(siArr);
      siFreqs = { dep: fDep, arr: fArr, live: !!live };
      status.siAtis = depNet || arrNet ? 'live' : 'no ATIS returned';
      status.siFreqs = fDep || fArr
        ? `SI comms list${live ? ' + live position freqs' : ' (no active SI flight — live freqs unavailable)'}`
        : 'unavailable';
    } else {
      status.siAtis = siAuth ? 'no API key (set it in Settings, or start the SI app)' : 'n/a';
    }
  }

  if (net.resolved === 'vatsim') {
    vatsim = await getVatsimFor(depIcao, arrIcao);
    status.vatsim = vatsim ? 'live' : 'feed unavailable';
    const va = vatsim && vatsim.arr && vatsim.arr.atis && vatsim.arr.atis[0];
    const vd = vatsim && vatsim.dep && vatsim.dep.atis && vatsim.dep.atis[0];
    if (va) arrNet = { net: 'VATSIM', letter: va.letter, arrivingRunways: null, departingRunways: null, approaches: null };
    if (vd) depNet = { net: 'VATSIM', letter: vd.letter, arrivingRunways: null, departingRunways: null, approaches: null };
  }

  let depInfo = null, arrInfo = null, altnInfo = null;
  try {
    depInfo = airports.airportInfo(depIcao);
    arrInfo = airports.airportInfo(arrIcao);
    altnInfo = altn ? airports.airportInfo(altn.icao) : null;
    if (!depInfo || !arrInfo) status.airportData = `partial (missing: ${[!depInfo && depIcao, !arrInfo && arrIcao].filter(Boolean).join(', ')})`;
  } catch (e) { status.airportData = `failed (${e.message})`; }

  const depWx = wxBlock(depIcao, metars[depIcao], ofp.weather.origMetar || (ofp.origin && ofp.origin.metar), ofp.origin && ofp.origin.taf, tafs[depIcao]);
  const arrWx = wxBlock(arrIcao, metars[arrIcao], ofp.weather.destMetar || (ofp.destination && ofp.destination.metar), ofp.destination && ofp.destination.taf, tafs[arrIcao]);
  const altnWx = altn ? wxBlock(altn.icao, metars[altn.icao], ofp.weather.altnMetar[0] || altn.metar, altn.taf, tafs[altn.icao]) : null;

  // Likely runways: the active network's ATIS wins, SimBrief plan is fallback.
  const arrLikely = parseRunwayList(arrNet && arrNet.arrivingRunways);
  if (!arrLikely.length && ofp.destination && ofp.destination.planRwy) arrLikely.push(ofp.destination.planRwy);
  const depLikely = parseRunwayList(depNet && (depNet.departingRunways || depNet.arrivingRunways));
  if (!depLikely.length && ofp.origin && ofp.origin.planRwy) depLikely.push(ofp.origin.planRwy);

  attachDerived(depInfo, depWx, depLikely);
  attachDerived(arrInfo, arrWx, arrLikely);
  attachDerived(altnInfo, altnWx, altn && altn.planRwy ? [altn.planRwy] : []);

  // TOD: SimBrief's own navlog fix when present, else 3:1 to 2000 AGL.
  let tod = null;
  if (ofp.tod && ofp.tod.distFromDest != null) {
    tod = { distNm: ofp.tod.distFromDest, source: 'simbrief' };
  } else if (ofp.cruiseAltitude != null && ofp.destination && arrInfo && arrInfo.elevation != null) {
    const lose = ofp.cruiseAltitude - (arrInfo.elevation + 2000);
    if (lose > 0) tod = { distNm: Math.round((lose / 1000) * 3), source: '3:1 rule to 2000 AGL' };
  }

  return {
    builtAt: new Date().toISOString(),
    status,
    network: net,
    vatsim,
    ofp,
    dep: { info: depInfo, wx: depWx, netAtis: depNet, likelyRwys: depLikely, siFreqs: siFreqs && siFreqs.dep },
    arr: { info: arrInfo, wx: arrWx, netAtis: arrNet, likelyRwys: arrLikely, siFreqs: siFreqs && siFreqs.arr },
    altn: altn ? { ofp: altn, info: altnInfo, wx: altnWx } : null,
    computed: {
      tod,
      etaZ: ofp.times.estOn,
      etaLocal: localTime(ofp.times.estOn, ofp.destination && ofp.destination.tzOffsetHours),
      vspeedsTakeoff: ofp.aircraft.supportsTlr ? tlrTakeoff(ofp.tlr, ofp.origin && ofp.origin.planRwy) : null,
      vspeedsLanding: ofp.aircraft.supportsTlr ? tlrLanding(ofp.tlr) : null,
      routeVors: routeVors(ofp),
      fuelChecks: fuelChecks(ofp),
    },
  };
}

module.exports = { buildSheet, windComponents, parseRunwayList, wxBlock, localTime, resolveNetwork, NETWORKS };
