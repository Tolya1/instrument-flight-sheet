'use strict';
// Print archive: one JSON per OFP request_id, saved whenever a sheet is
// built for a not-yet-archived plan. Reprint = re-render the stored model.

const fs = require('fs');
const path = require('path');

const ARCHIVE_DIR = path.join(__dirname, '..', 'archive');

function idFor(model) {
  return model && model.ofp && model.ofp.requestId ? String(model.ofp.requestId) : null;
}

function save(model) {
  try {
    const id = idFor(model);
    if (!id) return null;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const file = path.join(ARCHIVE_DIR, `${id}.json`);
    const isNew = !fs.existsSync(file);
    fs.writeFileSync(file, JSON.stringify(model));
    return { id, isNew };
  } catch (e) {
    return null; // read-only disk must not fail the sheet
  }
}

function list() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter(f => /^\d+\.json$/.test(f))
    .map(f => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
        return {
          id: f.replace('.json', ''),
          generated: m.ofp.timeGenerated,
          callsign: m.ofp.callsign,
          aircraft: m.ofp.aircraft && m.ofp.aircraft.icao,
          from: m.ofp.origin && m.ofp.origin.icao,
          to: m.ofp.destination && m.ofp.destination.icao,
        };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.id) - Number(a.id));
}

function get(id) {
  if (!/^\d+$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, `${id}.json`), 'utf8'));
  } catch (e) { return null; }
}

module.exports = { save, list, get };
