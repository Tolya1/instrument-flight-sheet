'use strict';
/* simbrief-flight-sheet renderer.
   Rendering rule (learned from the old sheet's cross-outs): values ATC
   assigns are ALWAYS blank handwriting lines; SimBrief/PE knowledge goes
   underneath as a small grey italic hint. */

const $ = sel => document.querySelector(sel);
let model = null;          // currently rendered sheet model
let liveModel = null;      // last live (non-archive) model
let settings = { userid: '', paper: 'A4' };

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LB_PER_KG = 2.2046226218;
function wPair(v, units) {
  if (v == null) return '—';
  const lbs = units === 'kgs' ? Math.round(v * LB_PER_KG) : Math.round(v);
  const kg = units === 'kgs' ? Math.round(v) : Math.round(v / LB_PER_KG);
  return `${lbs.toLocaleString('en-US')} / ${kg.toLocaleString('en-US')}`;
}
const hhmm = t => (t ? esc(String(t).slice(0, 5)) : '—');      // "00:51:39" -> "00:51"; esc: feeds innerHTML
const zTime = iso => { try { return iso ? new Date(iso).toISOString().slice(11, 16) + 'Z' : '—'; } catch (e) { return '—'; } };
const altFmt = a => (a == null ? '—' : a >= 18000 ? 'FL' + Math.round(a / 100) : a.toLocaleString('en-US') + ' ft');

function hw(hint) {
  return `<div class="hw"></div>${hint ? `<div class="hw-hint">${hint}</div>` : ''}`;
}
function kvRow(k, vHtml) {
  return `<div class="k">${esc(k)}</div><div class="v">${vHtml}</div>`;
}
function kvHwRow(k, hint) {
  return `<div class="k">${esc(k)}</div><div>${hw(hint)}</div>`;
}

/* ---------------- frequencies ---------------- */
const ARR_ORDER = ['ATIS', 'AWOS', 'ASOS', 'A/D', 'APP', 'TWR', 'GND', 'CTAF', 'UNIC', 'CTR', 'CLD', 'DEP'];
// descriptions that just repeat the type add noise — drop them
const REDUNDANT_DESC = {
  ATIS: ['ATIS', 'D-ATIS'], ASOS: ['ASOS'], AWOS: ['AWOS', 'AWOS-3'],
  TWR: ['TWR', 'TOWER'], GND: ['GND', 'GROUND'], CLD: ['CLD', 'CLNC', 'CLNC DEL', 'CLEARANCE', 'CLEARANCE DELIVERY'],
  CTAF: ['CTAF'], UNIC: ['UNIC', 'UNICOM'], 'A/D': ['A/D', 'APP/DEP', 'APCH/DEP'],
  APP: ['APP', 'APCH', 'APPROACH'], DEP: ['DEP', 'DEPARTURE'], CTR: ['CTR', 'CENTER'],
};
function freqDesc(f) {
  const d = (f.desc || '').trim();
  if (!d) return '';
  if ((REDUNDANT_DESC[f.type] || []).includes(d.toUpperCase())) return '';
  return d;
}
function freqTable(info, mode) {
  if (!info || !info.freqs.length) return `<div class="hw-hint">no frequency data</div>`;
  let rows = info.freqs;
  if (mode === 'arr') {
    rows = [...rows].sort((a, b) => ARR_ORDER.indexOf(a.type) - ARR_ORDER.indexOf(b.type) || a.mhz - b.mhz);
  }
  return `<table class="freq">${rows.map(f => {
    const d = freqDesc(f);
    return `
    <tr>
      <td><span class="f-label">${esc(f.label)}</span>${d ? ` <span class="f-desc">${esc(d)}</span>` : ''}</td>
      <td class="f-mhz">${f.mhz.toFixed(Math.round(f.mhz * 1000) % 10 ? 3 : 2)}</td>
    </tr>`;
  }).join('')}</table>`;
}

function airportInfoLines(info) {
  if (!info) return `<div class="hw-hint">airport not in database</div>`;
  const rwys = info.runways.map(r => {
    const likelyEnd = r.ends.find(e => e.likely);
    const pair = `${esc(r.leIdent)}/${esc(r.heIdent)}`;
    const dims = r.lengthFt ? `${r.lengthFt.toLocaleString('en-US')}×${r.widthFt || '?'} ${esc((r.surface || '').slice(0, 4).toUpperCase())}` : '';
    const ils = r.ends.filter(e => e.ils).map(e =>
      `<span class="ils">${e.ils.type && /LOC/i.test(e.ils.type) && !/ILS/i.test(e.ils.type) ? 'LOC' : 'ILS'} ${esc(e.ident)} ${e.ils.locFreq.toFixed(2).replace(/0$/, '')}${e.ils.course != null ? ` c${String(e.ils.course).padStart(3, '0')}°` : ''}</span>`
    ).join(' · ');
    return `<div class="rwyline"><span>${likelyEnd ? `<span class="likely">${pair}</span>` : pair} ${dims}</span><span>${ils}</span></div>`;
  }).join('');
  return `<div class="apinfo">
    <div class="rwyline"><span>Elev <b>${info.elevation != null ? info.elevation + ' ft' : '—'}</b></span><span>${esc(info.municipality || '')}</span></div>
    ${rwys}
  </div>`;
}

/* ---------------- weather ---------------- */
function windText(p) {
  if (!p) return '—';
  if (p.windVrb) return `VRB ${p.windSpd ?? '?'} kt`;
  if (p.windDir == null || p.windSpd == null) return '—';
  if (p.windSpd === 0) return 'calm';
  return `${String(p.windDir).padStart(3, '0')}° ${p.windSpd}${p.windGust ? 'G' + p.windGust : ''} kt`;
}

function windCompLines(info, likelyRwys) {
  if (!info) return '';
  const parts = [];
  const ends = info.runways.flatMap(r => r.ends).filter(e => e.wind);
  ends.sort((a, b) => (b.likely - a.likely) || (b.wind.head - a.wind.head));
  for (const e of ends.slice(0, 4)) {
    const h = e.wind.head >= 0 ? `${e.wind.head}H` : `${-e.wind.head}T`;
    const x = e.wind.cross ? `${e.wind.cross}${e.wind.side === '-' ? '' : e.wind.side}x` : '0x';
    parts.push(`${e.likely ? '<b>' : ''}${esc(e.ident)}: ${h} ${x}${e.likely ? '</b>' : ''}`);
  }
  return parts.length ? `<div class="windcomp">RWY wind: ${parts.join(' · ')}</div>` : '';
}

function wxBox(title, side, apInfo) {
  const wx = side && side.wx;
  if (!wx || !wx.raw) return `<div class="box wx"><h3>${esc(title)}</h3><div class="hw-hint">no weather available</div></div>`;
  const p = wx.parsed || {};
  const stale = wx.stale && wx.ageMin != null ? `<span class="stale">⚠ ${wx.ageMin} min old</span>`
    : wx.ageMin != null ? `<span class="hw-hint">${wx.ageMin} min old</span>` : `<span class="stale">⚠ obs time unknown</span>`;
  const pe = side.pe ? `<div class="pe-atis">PE ATIS <b>${esc(side.pe.letter || '?')}</b>${side.pe.departingRunways ? ` · dep rwy ${esc(side.pe.departingRunways)}` : ''}${side.pe.arrivingRunways ? ` · arr rwy ${esc(side.pe.arrivingRunways)}` : ''}${side.pe.approaches ? `<br>${esc(side.pe.approaches)}` : ''}</div>` : '';
  return `<div class="box wx">
    <h3>${esc(title)} <span class="h-note">${wx.source === 'awc' ? 'live' : 'from OFP'} · ${stale}</span></h3>
    <div class="raw">${esc(wx.raw)}</div>
    <div class="decoded">
      ${p.altimInHg != null ? `<span class="alt-inhg">${p.altimInHg.toFixed(2)}</span><span class="alt-hpa">${p.altimHpa != null ? Math.round(p.altimHpa) + ' hPa' : ''}</span>` : ''}
      <span>${windText(p)}</span>
      ${p.tempC != null ? `<span>${p.tempC}/${p.dewC != null ? p.dewC : '—'}°C</span>` : ''}
      ${wx.fltCat ? `<span class="cat">${esc(wx.fltCat)}</span>` : ''}
    </div>
    ${windCompLines(side.info, side.likelyRwys)}
    ${pe}
  </div>`;
}

/* ---------------- front page ---------------- */
function frontPage(m) {
  const o = m.ofp;
  const dep = m.dep, arr = m.arr;
  const craftFHint = dep.info
    ? dep.info.freqs.filter(f => ['A/D', 'DEP', 'APP'].includes(f.type)).map(f => `${f.mhz.toFixed(Math.round(f.mhz * 1000) % 10 ? 3 : 2)}${f.desc ? ' (' + esc(f.desc) + ')' : ''}`).join(' · ')
    : '';
  const vsT = m.computed.vspeedsTakeoff, vsL = m.computed.vspeedsLanding;

  return `<section class="page">
    <div class="hdr">
      <div class="side">
        <div class="tag">DEP</div>
        <div class="icao">${esc(o.origin ? o.origin.icao : '????')}</div>
        <div class="apname">${esc((dep.info && dep.info.name) || (o.origin && o.origin.name) || '')}</div>
      </div>
      <div class="mid">
        <div class="callsign">${esc(o.callsign || '')}</div>
        <div class="subline">${esc(o.aircraft.icao || '')}${o.aircraft.reg ? ' ' + esc(o.aircraft.reg) : ''} / ${o.flightRules === 'I' ? 'IFR' : esc(o.flightRules)} / ${esc(o.timeGenerated || '')}</div>
        <div class="subline">AIRAC ${esc(o.airac || '—')} · ${esc(o.routeDistance != null ? o.routeDistance + ' NM' : '')}</div>
      </div>
      <div class="side arr">
        <div class="tag">ARR</div>
        <div class="icao">${esc(o.destination ? o.destination.icao : '????')}</div>
        <div class="apname">${esc((arr.info && arr.info.name) || (o.destination && o.destination.name) || '')}</div>
      </div>
    </div>
    <div class="hdr-rule"></div>

    <div class="strip">
      <div class="flow">
        <span>ATIS</span><span>CLRNC</span><span>TAXI</span><span>T/O BRIEF</span><span>CLB CHK</span><span>ARR ATIS</span><span>APCH BRIEF</span><span>TAXI IN</span>
      </div>
      <div class="wbox">SQUAWK
        <div class="cells"><div class="cell"></div><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>
      </div>
      <div class="wbox">ATIS D/A
        <div class="cells"><div class="cell round"></div><div class="cell round"></div></div>
      </div>
    </div>

    <div class="box route-box">
      <h3>SimBrief planned route <span class="h-note">copy/check against clearance</span></h3>
      <div class="route">${esc(o.route || '—')}</div>
    </div>

    <div class="cols2">
      <div class="box craft">
        <h3>Craft clearance</h3>
        <div class="row"><div class="letter">C</div><div class="val">${esc(o.destination ? o.destination.icao : '')}</div></div>
        <div class="row"><div class="letter">R</div><div>${hw('as filed (route above) — write reroute if given')}</div></div>
        <div class="row"><div class="letter">A</div><div>${hw(`filed ${altFmt(o.cruiseAltitude)}${o.sid ? ` · SID ${esc(o.sid)}` : ''}`)}</div></div>
        <div class="row"><div class="letter">F</div><div>${hw(craftFHint)}</div></div>
        <div class="row"><div class="letter">T</div><div>${hw('')}</div></div>
      </div>

      <div class="box">
        <h3>OFP loadsheet <span class="h-note">lbs / kg</span></h3>
        <div class="kv">
          ${kvRow('ZFW', `${wPair(o.weights.zfw, o.units)} <span class="v dim">(max ${wPair(o.weights.maxZfw, o.units).split(' / ')[0]})</span>`)}
          ${kvRow('TOW', `${wPair(o.weights.tow, o.units)} <span class="v dim">(max ${wPair(o.weights.maxTow, o.units).split(' / ')[0]})</span>`)}
          ${kvRow('Block fuel', wPair(o.fuel.ramp, o.units))}
          ${kvRow('PAX', o.weights.paxCount != null ? String(o.weights.paxCount) : '—')}
          ${kvRow('Cargo', wPair(o.weights.cargo, o.units))}
          ${kvRow('LDG fuel', wPair(o.fuel.landing, o.units))}
          ${kvRow('LDW', `${wPair(o.weights.ldw, o.units)} <span class="v dim">(max ${wPair(o.weights.maxLdw, o.units).split(' / ')[0]})</span>`)}
          ${kvRow('Endurance', hhmm(o.times.endurance))}
        </div>
      </div>
    </div>

    <div class="cols2">
      <div class="box">
        <h3>Departure</h3>
        <div class="kv">
          ${kvHwRow('Runway', dep.likelyRwys.length ? `${dep.pe ? 'PE active' : 'planned'}: ${esc(dep.likelyRwys.join(', '))}` : '')}
          ${kvHwRow('SID', o.sid ? `filed: ${esc(o.sid)}${o.sidTrans ? '.' + esc(o.sidTrans) : ''}` : 'none filed')}
          ${kvHwRow('Initial alt', `filed ${altFmt(o.cruiseAltitude)}`)}
          ${kvHwRow('Transition', '')}
        </div>
        <div style="margin-top:1mm">
          <div class="hw-hint" style="font-style:normal">Taxi</div>
          ${hw('')}
        </div>
      </div>
      <div class="box">
        <h3>Arrival</h3>
        <div class="kv">
          ${kvHwRow('STAR', o.star ? `filed: ${esc(o.star)}${o.starTrans ? ' via ' + esc(o.starTrans) : ''}` : 'none filed')}
          ${kvHwRow('Approach', arr.pe && arr.pe.approaches ? `PE: ${esc(arr.pe.approaches)}` : '')}
          ${kvHwRow('Runway', arr.likelyRwys.length ? `${arr.pe ? 'PE active' : 'planned'}: ${esc(arr.likelyRwys.join(', '))}` : '')}
          ${kvHwRow('Minimums', '')}
          ${kvRow('Landing fuel', wPair(o.fuel.landing, o.units))}
        </div>
      </div>
    </div>

    <div class="cols2">
      <div class="box">
        <h3>Dep frequencies · ${esc(o.origin ? o.origin.icao : '')}</h3>
        ${freqTable(dep.info, 'dep')}
        ${airportInfoLines(dep.info)}
      </div>
      <div class="box">
        <h3>Arr frequencies · ${esc(o.destination ? o.destination.icao : '')}</h3>
        ${freqTable(arr.info, 'arr')}
        ${airportInfoLines(arr.info)}
      </div>
    </div>

    <div class="cols2">
      ${wxBox('Dep wx — ' + (o.origin ? o.origin.icao : ''), dep, dep.info)}
      ${wxBox('Arr wx — ' + (o.destination ? o.destination.icao : ''), arr, arr.info)}
    </div>

    <div class="box">
      <div class="numstrip">
        <div class="cell"><div class="lab">ETE</div><div class="num">${hhmm(o.times.ete)}</div></div>
        <div class="cell"><div class="lab">ETA</div><div class="num">${zTime(m.computed.etaZ)}${m.computed.etaLocal ? ` <span style="font-size:8pt">(${m.computed.etaLocal} LT)</span>` : ''}</div></div>
        <div class="cell"><div class="lab">Cruise</div><div class="num">${altFmt(o.cruiseAltitude)}</div></div>
        <div class="cell"><div class="lab">TOD</div><div class="num">${m.computed.tod ? `~${m.computed.tod.distNm} NM out` : '—'}</div></div>
        <div class="cell"><div class="lab">Avg wind</div><div class="num">${o.avgWindComp != null ? (o.avgWindComp >= 0 ? '+' : '') + o.avgWindComp + ' kt' : '—'}</div></div>
        <div class="cell"><div class="lab">Reserve</div><div class="num">${hhmm(o.times.reserveTime)}</div></div>
      </div>
      ${vsT || vsL ? `<div class="numstrip" style="margin-top:1.2mm;border-top:1px dashed #999;padding-top:1mm">
        ${vsT ? `
          <div class="cell"><div class="lab">T/O ${esc(vsT.runway || '')} flp ${esc(vsT.flaps || '')}</div><div class="num">V1 ${vsT.v1 ?? '—'} · Vr ${vsT.vr ?? '—'} · V2 ${vsT.v2 ?? '—'}</div></div>
          <div class="cell"><div class="lab">T/O req/avail ft</div><div class="num">${vsT.reqFt != null && vsT.lengthFt != null ? `${vsT.reqFt.toLocaleString('en-US')}/${vsT.lengthFt.toLocaleString('en-US')}` : '—'}</div></div>` : ''}
        ${vsL ? `
          <div class="cell"><div class="lab">LDG ${esc(vsL.runway || '')} flp ${esc(vsL.flaps || '')}</div><div class="num">Vref ${vsL.vref ?? '—'}</div></div>
          <div class="cell"><div class="lab">LDG req dry${vsL.wet ? '/wet' : ''} ft</div><div class="num">${vsL.reqFt != null ? vsL.reqFt.toLocaleString('en-US') : '—'}${vsL.wet && vsL.wet.reqFt != null ? '/' + vsL.wet.reqFt.toLocaleString('en-US') : ''}</div></div>` : ''}
      </div>` : ''}
    </div>

    <div class="box scratch grow">
      <h3>Readback / vectors / scratch</h3>
      <div class="gridlines"></div>
    </div>

    ${foot(m, 1)}
  </section>`;
}

/* ---------------- back page ---------------- */
function tafEtaNote(wx, etaZ) {
  if (!wx || !wx.tafFcsts || !wx.tafFcsts.length || !etaZ) return '';
  const eta = new Date(etaZ).getTime();
  const asMs = v => (v == null ? null : typeof v === 'number' || /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v));
  const hit = wx.tafFcsts.find(f => {
    const a = asMs(f.timeFrom), b = asMs(f.timeTo);
    return a != null && b != null && eta >= a && eta < b;
  });
  if (!hit) return '';
  const f = new Date(asMs(hit.timeFrom)).toISOString().slice(11, 16);
  const t = new Date(asMs(hit.timeTo)).toISOString().slice(11, 16);
  return `<div class="hw-hint">ETA ${zTime(etaZ)} falls in TAF period ${f}Z–${t}Z.</div>`;
}

function backPage(m) {
  const o = m.ofp;
  const a = m.altn;
  const vors = m.computed.routeVors;
  const checks = m.computed.fuelChecks;

  return `<section class="page">
    <div class="cols2">
      <div class="box">
        <h3>Alternate${a ? ' — ' + esc(a.ofp.icao) : ''}</h3>
        ${a ? `
          <div class="kv">
            ${kvRow('Airport', `${esc(a.ofp.icao)} <span class="v dim">${esc((a.info && a.info.name) || a.ofp.name || '')}</span>`)}
            ${kvRow('Route', esc(a.ofp.route || 'DCT'))}
            ${kvRow('Dist / ETE', `${a.ofp.distance != null ? a.ofp.distance + ' NM' : '—'} / ${hhmm(a.ofp.ete)}`)}
            ${kvRow('Cruise', altFmt(a.ofp.cruise))}
            ${kvRow('Altn fuel', wPair(o.fuel.alternate, o.units))}
            ${kvRow('Elev', a.info && a.info.elevation != null ? a.info.elevation + ' ft' : '—')}
          </div>
          ${a.info ? freqTable(a.info, 'arr') : ''}
          ${a.wx && a.wx.raw ? `<div class="raw" style="font-family:Consolas,monospace;font-size:7.5pt;margin-top:1mm">${esc(a.wx.raw)}</div>` : ''}
        ` : `<div class="hw-hint">no alternate filed</div>`}
      </div>

      <div class="box">
        <h3>Arrival TAF — ${esc(o.destination ? o.destination.icao : '')}</h3>
        ${m.arr.wx && m.arr.wx.taf ? `<div class="wx"><div class="raw">${esc(m.arr.wx.taf)}</div></div>${tafEtaNote(m.arr.wx, m.computed.etaZ)}` : '<div class="hw-hint">no TAF available</div>'}
        ${m.dep.wx && m.dep.wx.taf ? `<h3 style="margin-top:2mm">Departure TAF</h3><div class="wx"><div class="raw" style="font-size:7pt">${esc(m.dep.wx.taf)}</div></div>` : ''}
      </div>
    </div>

    <div class="cols2">
      <div class="box">
        <h3>Route VORs <span class="h-note">radio-nav cross-check</span></h3>
        ${vors.length ? `<table class="plain">
          <tr><th>Ident</th><th>Name</th><th>Freq</th><th>Via</th></tr>
          ${vors.map(v => `<tr><td><b>${esc(v.ident)}</b></td><td>${esc(v.name)}</td><td class="num">${v.mhz != null ? v.mhz.toFixed(v.mhz * 100 % 10 ? 2 : 1) : '—'}</td><td>${esc(v.via || '')}</td></tr>`).join('')}
        </table>` : '<div class="hw-hint">no VORs on this route</div>'}
      </div>

      <div class="box">
        <h3>Fuel plan &amp; checks <span class="h-note">${esc(o.units)}</span></h3>
        <div class="kv" style="font-size:8.5pt">
          ${kvRow('Taxi', wPair(o.fuel.taxi, o.units))}
          ${kvRow('Trip', wPair(o.fuel.trip, o.units))}
          ${kvRow('Contingency', wPair(o.fuel.contingency, o.units))}
          ${kvRow('Alternate', wPair(o.fuel.alternate, o.units))}
          ${kvRow('Reserve', wPair(o.fuel.reserve, o.units))}
          ${kvRow('Block', wPair(o.fuel.ramp, o.units))}
        </div>
        ${checks.length ? `<table class="plain" style="margin-top:1.5mm">
          <tr><th>Fix</th><th>Plan time</th><th>Plan fuel</th><th>Actual</th></tr>
          ${checks.map(c => `<tr><td><b>${esc(c.ident)}</b></td><td>${hhmm(c.timeTotal)}</td><td class="num">${c.planFuel != null ? Math.round(c.planFuel).toLocaleString('en-US') : '—'}</td><td class="hwcell"></td></tr>`).join('')}
        </table>` : ''}
      </div>
    </div>

    <div class="cols2">
      <div class="box lostcomms">
        <h3>Lost comms — 91.185 <span class="h-note">squawk 7600</span></h3>
        <ul style="margin:0;padding-left:4mm">
          <li><b>VMC:</b> remain VMC, land as soon as practicable.</li>
          <li><b>Route (AVEF):</b> <b>A</b>ssigned → <b>V</b>ectored (fly direct) → <b>E</b>xpected → <b>F</b>iled.</li>
          <li><b>Altitude (MEA):</b> highest of <b>M</b>inimum IFR alt, <b>E</b>xpected, <b>A</b>ssigned — per segment.</li>
          <li><b>Clearance limit w/ EFC:</b> leave holding at EFC; at a fix: begin approach as close as able to ETA.</li>
          <li>PE tip: try text/private message before going full 7600.</li>
        </ul>
      </div>
      <div class="box">
        <h3>PilotEdge notes</h3>
        <div class="lostcomms">
          <ul style="margin:0;padding-left:4mm">
            <li>ATC staffed <b>08:00–23:00 Pacific</b> daily; unstaffed field → real-world CTAF, self-announce.</li>
            <li>Freqs on this sheet are current real-world FAA — exactly what PE uses.</li>
            <li>ATIS letters roll hourly — re-check before clearance and before approach.</li>
            <li>IFR in Class B/C: expect full route readback; taxi: read back rwy + hold short verbatim.</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="box scratch big grow">
      <h3>Notes / holds / reroutes</h3>
      <div class="gridlines"></div>
    </div>

    ${foot(m, 2)}
  </section>`;
}

function foot(m, page) {
  const s = m.status || {};
  return `<div class="foot">
    <span>OFP ${esc(m.ofp.requestId || '')} gen ${esc(m.ofp.timeGenerated || '')} · sheet built ${esc(m.builtAt ? m.builtAt.slice(0, 16).replace('T', ' ') + 'Z' : '')} · SimBrief: ${esc(s.simbrief || '')} · wx: ${esc(s.wx || '')} · PE: ${esc(s.peAtis || '')}</span>
    <span>p.${page}</span>
  </div>`;
}

/* ---------------- render + chrome ---------------- */
function render(m) {
  model = m;
  if (m.error) {
    $('#err').textContent = m.error;
    $('#err').classList.remove('hidden');
    $('#sheet').innerHTML = '';
    return;
  }
  $('#err').classList.add('hidden');
  $('#sheet').innerHTML = frontPage(m) + backPage(m);
  requestAnimationFrame(fitPages);
  const o = m.ofp;
  $('#tb-flight').textContent = `${o.callsign || ''} ${o.origin ? o.origin.icao : ''}→${o.destination ? o.destination.icao : ''} (${o.aircraft.icao || ''}) OFP ${o.timeGenerated || ''}`;
  document.title = `${o.origin ? o.origin.icao : ''}→${o.destination ? o.destination.icao : ''} — SimBrief Flight Sheet`;
}

/* If a busy flight's fixed content would overflow one printed side, step the
   page down to the dense style; warn if even that isn't enough. */
function fitPages() {
  const MM = 96 / 25.4;
  const budgetMm = (settings.paper === 'Letter' ? 279.4 : 297) - 16; // @page margins
  const scratchPrintMinMm = { false: 14, true: 30 };
  let warned = false;
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('dense');
    for (const dense of [false, true]) {
      if (dense) page.classList.add('dense');
      const scratch = page.querySelector('.scratch');
      const big = !!(scratch && scratch.classList.contains('big'));
      const scratchH = scratch ? scratch.offsetHeight : 0;
      // subtract the screen-only 8mm top+bottom .page padding — print uses
      // padding:0 with the 8mm @page margins already inside budgetMm
      const fixedMm = (page.scrollHeight - scratchH) / MM - 16;
      if (fixedMm + scratchPrintMinMm[big] <= budgetMm) return;
    }
    warned = true;
  });
  if (warned) $('#tb-status').textContent = '⚠ very busy flight — a page may spill onto an extra sheet when printing';
}

function applyPaper() {
  const a4 = settings.paper !== 'Letter';
  let st = $('#pagesize');
  if (!st) { st = document.createElement('style'); st.id = 'pagesize'; document.head.appendChild(st); }
  st.textContent = `@page { size: ${a4 ? 'A4' : 'Letter'} portrait; margin: 8mm; }
    :root { --page-w: ${a4 ? '210mm' : '215.9mm'}; --page-h: ${a4 ? '296mm' : '279.4mm'}; }`;
}

async function loadSheet() {
  $('#tb-status').textContent = 'building…';
  try {
    const res = await fetch('/api/sheet');
    const m = await res.json();
    liveModel = m;
    render(m);
    $('#tb-status').textContent = m.error ? 'error' : '';
    $('#banner-newplan').classList.add('hidden');
  } catch (e) {
    $('#err').textContent = 'Server error: ' + e.message;
    $('#err').classList.remove('hidden');
    $('#tb-status').textContent = 'error';
  }
}

async function loadSettings() {
  settings = await (await fetch('/api/settings')).json();
  $('#set-userid').value = settings.userid;
  $('#set-paper').value = settings.paper;
  applyPaper();
}

/* poll for a newer OFP */
setInterval(async () => {
  if (!liveModel || liveModel.error || !liveModel.ofp) return;
  try {
    const p = await (await fetch('/api/poll')).json();
    if (p.timeGenerated && p.timeGenerated !== liveModel.ofp.timeGenerated) {
      $('#banner-newplan').classList.remove('hidden');
    }
  } catch (e) { /* offline — ignore */ }
}, 90000);

/* toolbar wiring */
$('#btn-refresh').addEventListener('click', loadSheet);
$('#btn-loadnew').addEventListener('click', loadSheet);
$('#btn-print').addEventListener('click', () => window.print());
$('#btn-settings').addEventListener('click', () => {
  $('#panel-settings').classList.toggle('hidden');
  fetch('/api/data/status').then(r => r.json()).then(s => {
    $('#set-dbinfo').textContent = `${s.airportCount} airports · ${s.ilsCount} ILS · NASR ${s.ilsCycle || '—'}${s.lastError ? ' · ' + s.lastError : ''}`;
  }).catch(() => {});
});
$('#btn-savesettings').addEventListener('click', async () => {
  const body = { userid: $('#set-userid').value.trim(), paper: $('#set-paper').value };
  settings = await (await fetch('/api/settings', { method: 'POST', body: JSON.stringify(body) })).json();
  applyPaper();
  $('#panel-settings').classList.add('hidden');
  loadSheet();
});
$('#btn-dataRefresh').addEventListener('click', () => {
  fetch('/api/data/refresh', { method: 'POST' });
  $('#set-dbinfo').textContent = 'refreshing in background…';
});
$('#btn-archive').addEventListener('click', async () => {
  const panel = $('#panel-archive');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const list = await (await fetch('/api/archive')).json();
  panel.innerHTML = list.length
    ? `<table><tr><th>OFP</th><th>Generated</th><th>Flight</th><th></th></tr>${list.map(x =>
      `<tr><td>${esc(x.id)}</td><td>${esc(x.generated || '')}</td><td>${esc(x.callsign || '')} ${esc(x.from || '')}→${esc(x.to || '')} (${esc(x.aircraft || '')})</td><td><a data-id="${esc(x.id)}">open</a></td></tr>`).join('')}</table>`
    : 'No archived sheets yet.';
  panel.classList.remove('hidden');
  panel.querySelectorAll('a[data-id]').forEach(a => a.addEventListener('click', async () => {
    const m = await (await fetch('/api/archive/' + a.dataset.id)).json();
    render(m);
    $('#tb-status').textContent = `ARCHIVED sheet ${a.dataset.id} — Refresh returns to live`;
    panel.classList.add('hidden');
  }));
});

/* boot */
(async () => {
  await loadSettings();
  await loadSheet();
})();
