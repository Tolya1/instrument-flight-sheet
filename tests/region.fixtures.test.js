'use strict';
// Mock airport-pair flights per region, pushed through the real normalize +
// weather pipeline. These catch "FAA assumption leaks into a non-FAA locale"
// class bugs. Known, not-yet-implemented regional rules are recorded as
// `todo` so every run lists them until they're built and enforced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOfp } = require('../lib/simbrief');
const { wxBlock } = require('../lib/sheetmodel');

// Minimal raw v2 OFP, region-parameterized. Everything normalizeOfp touches.
function makeOfp(o) {
  return {
    params: { units: o.units || 'lbs', time_generated: '2026-08-23T10:00:00Z', request_id: '900001', airac: '2608' },
    general: {
      route: o.route || 'DCT', initial_altitude: String(o.cruise || 24000),
      route_distance: '250', avg_wind_comp: o.avgWind !== undefined ? o.avgWind : '10',
      sid_ident: '', star_ident: '', passengers: '2', costindex: '10',
    },
    atc: { callsign: 'TEST01', route: o.route || 'DCT', flight_rules: 'I' },
    aircraft: { icaocode: 'B350', name: 'King Air 350', reg: 'N875AT', supports_tlr: '0' },
    origin: {
      icao_code: o.from, name: o.fromName || o.from, elevation: String(o.fromElev ?? 100),
      plan_rwy: o.fromRwy || '09', trans_alt: String(o.fromTA ?? 18000), trans_level: String(o.fromTA ?? 18000),
      pos_lat: '0', pos_long: '0', timezone: o.fromTz !== undefined ? o.fromTz : '-8',
      metar: o.fromMetar || null, taf: null,
    },
    destination: {
      icao_code: o.to, name: o.toName || o.to, elevation: String(o.toElev ?? 100),
      plan_rwy: o.toRwy || '27', trans_alt: String(o.toTA ?? 18000), trans_level: String(o.toTA ?? 18000),
      pos_lat: '0', pos_long: '0', timezone: o.toTz !== undefined ? o.toTz : '-8',
      metar: o.toMetar || null, taf: null,
    },
    alternate: [],
    fuel: { taxi: '100', enroute_burn: '900', contingency: '90', alternate_burn: '0', reserve: '450', extra: '0', min_takeoff: '1540', plan_takeoff: '1540', plan_ramp: '1640', plan_landing: '740', avg_fuel_flow: '600', max_tanks: '3600' },
    weights: { oew: '9955', est_zfw: '10400', max_zfw: '12500', est_tow: '12040', max_tow: '15000', est_ldw: '11140', max_ldw: '15000', est_ramp: '12140', payload: '445', cargo: '100', pax_count: '2', pax_weight: '175', bag_weight: '55' },
    times: { est_time_enroute: '01:00:00', endurance: '02:30:00', reserve_time: '00:45:00', est_out: '2026-08-23T11:00:00Z', est_off: '2026-08-23T11:10:00Z', est_on: '2026-08-23T12:10:00Z', est_in: '2026-08-23T12:20:00Z', taxi_out: '00:10:00', taxi_in: '00:10:00', sched_block: '01:20:00' },
    weather: { orig_metar: o.fromMetar || '', dest_metar: o.toMetar || '', altn_metar: [] },
    navlog: o.navlog || [],
    tlr: null,
  };
}

const REGIONS = {
  us: makeOfp({ from: 'KSAN', to: 'KSBA', fromRwy: '27', toRwy: '25', fromTz: '-7', toTz: '-7',
    fromMetar: 'KSAN 231451Z 27008KT 10SM FEW015 22/16 A2997', toMetar: 'KSBA 231453Z 25006KT 10SM SCT012 19/14 A2999' }),
  europe: makeOfp({ from: 'EPWA', to: 'EDDF', units: 'kgs', fromTA: 6500, toTA: 5000, fromTz: '2', toTz: '2', toRwy: '25C',
    fromMetar: 'EPWA 231430Z 29008KT 9999 SCT035 22/14 Q1018 NOSIG', toMetar: 'EDDF 231420Z 24010KT 9999 BKN040 21/12 Q1015 NOSIG' }),
  asia: makeOfp({ from: 'RJTT', to: 'ZBAA', units: 'kgs', fromTA: 14000, toTA: 9800, fromTz: '9', toTz: '8', fromRwy: '34L', toRwy: '36L',
    fromMetar: 'RJTT 231430Z 13007KT 9999 FEW020 28/24 Q1009', toMetar: 'ZBAA 231430Z 09002MPS CAVOK 30/27 Q1007 NOSIG' }),
  africa: makeOfp({ from: 'FAOR', to: 'FACT', units: 'kgs', fromElev: 5558, fromTA: 8000, toTA: 7500, fromTz: '2', toTz: '2', fromRwy: '03L', toRwy: '01',
    fromMetar: 'FAOR 231430Z VRB06KT CAVOK 25/M04 Q1030 NOSIG', toMetar: 'FACT 231430Z 32012KT 9999 FEW025 18/08 Q1022' }),
  oceania: makeOfp({ from: 'YSSY', to: 'YMML', units: 'kgs', fromTA: 10000, toTA: 10000, fromTz: '10', toTz: '10', fromRwy: '16R', toRwy: '16',
    fromMetar: 'YSSY 231430Z 03007KT 9999 SCT042 18/12 Q1026', toMetar: 'YMML 231430Z 35010KT 9999 BKN030 14/09 Q1024' }),
};

test('all regional fixtures normalize cleanly with correct units', () => {
  for (const [region, raw] of Object.entries(REGIONS)) {
    const ofp = normalizeOfp(raw);
    assert.equal(ofp.origin.icao, raw.origin.icao_code, region);
    assert.equal(ofp.units, region === 'us' ? 'lbs' : 'kgs', `${region}: units`);
    assert.ok(ofp.origin.transAlt > 0, `${region}: transition altitude present`);
    assert.ok(Number.isFinite(ofp.weights.tow), `${region}: TOW numeric`);
  }
});

test('non-US transition altitudes survive into the model (not assumed FL180)', () => {
  const eu = normalizeOfp(REGIONS.europe);
  assert.equal(eu.origin.transAlt, 6500);   // Warsaw
  assert.equal(eu.destination.transAlt, 5000); // Frankfurt
  const oz = normalizeOfp(REGIONS.oceania);
  assert.equal(oz.origin.transAlt, 10000);  // Australia-wide
});

test('regional METARs through wxBlock: both altimeter units always present', () => {
  for (const [region, raw] of Object.entries(REGIONS)) {
    for (const side of ['origin', 'destination']) {
      const wx = wxBlock(raw[side].icao_code, null, raw[side].metar, null, null);
      assert.ok(wx.parsed.altimInHg > 25 && wx.parsed.altimInHg < 32, `${region}/${side}: inHg derived`);
      assert.ok(wx.parsed.altimHpa > 900 && wx.parsed.altimHpa < 1060, `${region}/${side}: hPa derived`);
      assert.equal(wx.source, 'simbrief-ofp', `${region}/${side}: OFP fallback used`);
    }
  }
});

test('blank v2 leaves ([]) become null, never 0 (review fix)', () => {
  const raw = makeOfp({ from: 'KSAN', to: 'KSBA' });
  raw.destination.timezone = [];
  raw.general.avg_wind_comp = [];
  const ofp = normalizeOfp(raw);
  assert.equal(ofp.destination.tzOffsetHours, null);
  assert.equal(ofp.avgWindComp, null);
});

test('TOC/TOD removal carries leg distances (navlog stays consecutive)', () => {
  const raw = makeOfp({ from: 'KSAN', to: 'KSBA', navlog: [
    { ident: 'OCN', name: 'Oceanside', type: 'vor', via_airway: 'DCT', distance: '30', time_total: '00:10:00', fuel_plan_onboard: '1500', altitude_feet: '10000' },
    { ident: 'TOC', name: 'TOP OF CLIMB', type: 'ltlg', distance: '14', time_total: '00:12:00', fuel_plan_onboard: '1480', altitude_feet: '24000' },
    { ident: 'LAX', name: 'Los Angeles', type: 'vor', via_airway: 'V23', distance: '50', time_total: '00:25:00', fuel_plan_onboard: '1300', altitude_feet: '24000' },
    { ident: 'TOD', name: 'TOP OF DESCENT', type: 'ltlg', distance: '15', time_total: '00:40:00', fuel_plan_onboard: '1100', altitude_feet: '24000' },
    { ident: 'KWANG', name: '', type: 'fix', via_airway: 'V299', distance: '40', time_total: '00:52:00', fuel_plan_onboard: '1000', altitude_feet: '8000' },
  ] });
  const ofp = normalizeOfp(raw);
  const total = ofp.navlog.reduce((a, f) => a + (f.dist || 0), 0);
  assert.equal(total, 149, 'sum of kept legs equals sum of all legs');
  assert.equal(ofp.navlog.find(f => f.ident === 'LAX').dist, 64, 'TOC leg folded into LAX');
  assert.equal(ofp.tod && typeof ofp.tod.distFromDest, 'number');
});

test('stale/future observation flags (never a silent stale altimeter)', () => {
  const old = wxBlock('KSAN', { raw: 'KSAN 010000Z 27008KT 10SM FEW015 22/16 A2997', obsTime: '2026-01-01T00:00:00Z', wdir: 270, wspd: 8, tempC: 22, dewC: 16, altimHpa: 1015, altimInHg: 29.97, wgst: null, fltCat: 'VFR' }, null, null, null);
  assert.equal(old.stale, true, 'month-old obs flagged');
  const future = wxBlock('KSAN', { raw: 'x', obsTime: new Date(Date.now() + 3600e3).toISOString(), wdir: 270, wspd: 8, tempC: 22, dewC: 16, altimHpa: 1015, altimInHg: 29.97, wgst: null, fltCat: 'VFR' }, null, null, null);
  assert.equal(future.stale, true, 'future obs flagged as suspect');
});

// ---- Known regional gaps, on the record until implemented ----
test('altimeter PRIMARY unit should follow the METAR group (Q -> hPa first)', { todo: 'client renders inHg-first everywhere; planned: auto-detect from A/Q group' }, () => {});
test('lost-comms crib should be region-appropriate (91.185 is FAA-only)', { todo: 'client back page is static FAA text; planned: per-region static content by ICAO prefix' }, () => {});
test('PilotEdge notes/flow strip should hide outside PE coverage', { todo: 'client always prints PE notes; planned: gate on dep/arr FIR or PE coverage list' }, () => {});
test('runway dimensions should show meters outside the US', { todo: 'client prints feet only; planned: dual ft/m for non-K/P idents' }, () => {});
