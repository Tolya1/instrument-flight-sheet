'use strict';
// SimBrief xml.fetcher client + OFP normalization.
// Endpoint verified 2026-08-20: json=v2 gives clean types (arrays are arrays),
// CORS open, all numeric leaves are strings -> Number() everywhere.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'last-ofp.json');

// SimBrief accepts a numeric userid or a pilot alias. Strict shapes — these
// go into an upstream URL.
const USERID_RE = /^\d{1,10}$/;
const ALIAS_RE = /^[A-Za-z0-9_-]{2,30}$/;
function validUser(u) {
  return typeof u === 'string' && (USERID_RE.test(u) || ALIAS_RE.test(u));
}

// Per-user in-memory OFP cache: protects SimBrief from poll traffic and
// makes /api/poll cheap. LRU-ish: prune oldest when over cap.
const OFP_TTL_MS = 45 * 1000;
const OFP_CACHE_MAX = 300;
const ofpCache = new Map(); // user -> {at, data}

// v2 serializes blank leaves as [] (and sometimes '') — Number([]) === 0 and
// Number('') === 0 would fabricate zeros, so only strings/numbers qualify.
const num = v => {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = v => (typeof v === 'string' && v.length ? v : null);

async function fetchOfp(user, { timeoutMs = 15000, diskCache = true } = {}) {
  if (!validUser(user)) throw new Error('invalid SimBrief userid/alias');
  const hit = ofpCache.get(user);
  if (hit && Date.now() - hit.at < OFP_TTL_MS) return hit.data;

  const param = USERID_RE.test(user) ? 'userid' : 'username';
  const url = `https://www.simbrief.com/api/xml.fetcher.php?${param}=${encodeURIComponent(user)}&json=v2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`SimBrief HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.params) {
    // Error responses come back as {fetch:{status:"Error: ..."}}-ish shapes
    const status = data && data.fetch && data.fetch.status;
    throw new Error(`SimBrief: ${status || 'unexpected response shape'}`);
  }
  ofpCache.set(user, { at: Date.now(), data });
  if (ofpCache.size > OFP_CACHE_MAX) {
    const oldest = [...ofpCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) ofpCache.delete(oldest[0]);
  }
  if (diskCache) {
    // personal-mode convenience: survive a SimBrief outage across restarts.
    // Best-effort — a read-only disk must not turn a good fetch into an error.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch (e) { /* ignored */ }
  }
  return data;
}

function readCachedOfp() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) { return null; }
}

function airportBlock(a) {
  if (!a || !a.icao_code) return null;
  return {
    icao: str(a.icao_code),
    iata: str(a.iata_code),
    name: str(a.name),
    elevation: num(a.elevation),
    planRwy: str(a.plan_rwy),
    transAlt: num(a.trans_alt),
    transLevel: num(a.trans_level),
    lat: num(a.pos_lat), lon: num(a.pos_long),
    tzOffsetHours: num(a.timezone),
    metar: str(a.metar), metarTime: str(a.metar_time), metarCat: str(a.metar_category),
    taf: str(a.taf) && !/no valid taf/i.test(a.taf) ? a.taf : null,
  };
}

// Normalize the sprawling v2 OFP into just what the sheet needs.
function normalizeOfp(d) {
  const g = d.general || {}, atc = d.atc || {}, fuel = d.fuel || {},
    w = d.weights || {}, t = d.times || {}, p = d.params || {},
    ac = d.aircraft || {}, wx = d.weather || {};
  const alternates = Array.isArray(d.alternate) ? d.alternate : (d.alternate ? [d.alternate] : []);
  const navlog = Array.isArray(d.navlog) ? d.navlog : [];

  const findFix = ident => navlog.find(f => f && f.ident === ident) || null;
  const toc = findFix('TOC'), tod = findFix('TOD');

  // Distance remaining to destination at SimBrief's TOD fix.
  let todDistFromDest = null;
  if (tod) {
    const idx = navlog.indexOf(tod);
    let rem = 0;
    for (let i = idx + 1; i < navlog.length; i++) rem += num(navlog[i].distance) || 0;
    todDistFromDest = Math.round(rem);
  }

  return {
    fetchedAt: new Date().toISOString(),
    units: str(p.units) || 'lbs',
    timeGenerated: str(p.time_generated),
    requestId: str(p.request_id),
    airac: str(p.airac),
    callsign: str(atc.callsign) || `${str(g.icao_airline) || ''}${str(g.flight_number) || ''}` || null,
    aircraft: {
      icao: str(ac.icaocode) || str(ac.icao_code),
      name: str(ac.name),
      reg: str(ac.reg),
      supportsTlr: num(ac.supports_tlr) > 0,
      equip: str(atc.section18),
    },
    route: str(g.route),
    atcRoute: str(atc.route),
    flightRules: str(atc.flight_rules) || 'I',
    cruiseAltitude: num(g.initial_altitude),
    stepclimb: str(g.stepclimb_string),
    costIndex: str(g.costindex),
    cruiseTas: num(g.cruise_tas), cruiseMach: str(g.cruise_mach),
    routeDistance: num(g.route_distance),
    avgWindComp: num(g.avg_wind_comp),
    sid: str(g.sid_ident), sidTrans: str(g.sid_trans),
    star: str(g.star_ident), starTrans: str(g.star_trans),
    origin: airportBlock(d.origin),
    destination: airportBlock(d.destination),
    alternates: alternates.map(a => ({
      ...airportBlock(a),
      cruise: num(a.cruise_altitude), distance: num(a.distance),
      ete: str(a.ete), burn: num(a.burn), route: str(a.route),
    })),
    fuel: {
      taxi: num(fuel.taxi), trip: num(fuel.enroute_burn), contingency: num(fuel.contingency),
      alternate: num(fuel.alternate_burn), reserve: num(fuel.reserve), extra: num(fuel.extra),
      minTakeoff: num(fuel.min_takeoff), planTakeoff: num(fuel.plan_takeoff),
      ramp: num(fuel.plan_ramp), landing: num(fuel.plan_landing),
      avgFlow: num(fuel.avg_fuel_flow), maxTanks: num(fuel.max_tanks),
    },
    weights: {
      oew: num(w.oew), zfw: num(w.est_zfw), maxZfw: num(w.max_zfw),
      tow: num(w.est_tow), maxTow: num(w.max_tow),
      ldw: num(w.est_ldw), maxLdw: num(w.max_ldw),
      ramp: num(w.est_ramp), payload: num(w.payload), cargo: num(w.cargo),
      paxCount: num(w.pax_count),
    },
    times: {
      ete: str(t.est_time_enroute), block: str(t.est_block) || str(t.sched_block),
      endurance: str(t.endurance), reserveTime: str(t.reserve_time),
      schedOut: str(t.sched_out), schedOff: str(t.sched_off),
      estOff: str(t.est_off), estOn: str(t.est_on), estIn: str(t.est_in),
      taxiOut: str(t.taxi_out), taxiIn: str(t.taxi_in),
    },
    weather: {
      origMetar: str(wx.orig_metar), origTaf: str(wx.orig_taf),
      destMetar: str(wx.dest_metar), destTaf: str(wx.dest_taf),
      altnMetar: Array.isArray(wx.altn_metar) ? wx.altn_metar : [],
    },
    toc: toc ? { timeTotal: str(toc.time_total) } : null,
    tod: tod ? { timeTotal: str(tod.time_total), distFromDest: todDistFromDest } : null,
    // Dropping the TOC/TOD pseudo-fixes must not lose their leg distances —
    // carry each removed leg into the next kept fix so legs stay consecutive.
    navlog: (() => {
      const out = [];
      let carry = 0;
      for (const f of navlog) {
        if (!f) continue;
        if (f.ident === 'TOC' || f.ident === 'TOD') { carry += num(f.distance) || 0; continue; }
        out.push({
          ident: str(f.ident), name: str(f.name), type: str(f.type),
          via: str(f.via_airway), freq: str(f.frequency),
          dist: carry ? (num(f.distance) || 0) + carry : num(f.distance),
          track: str(f.track_mag),
          alt: num(f.altitude_feet), timeTotal: str(f.time_total),
          fuelOnboard: num(f.fuel_plan_onboard),
        });
        carry = 0;
      }
      return out;
    })(),
    tlr: d.tlr || null,
  };
}

module.exports = { fetchOfp, readCachedOfp, normalizeOfp, validUser };
