'use strict';
// simbrief-flight-sheet server — zero framework, ~six routes + static files.
// Start:  node server.js   (or start-simbrief-flight-sheet.cmd)

const http = require('http');
const fs = require('fs');
const path = require('path');
const airports = require('./lib/airports');
const { buildSheet } = require('./lib/sheetmodel');
const { fetchOfp } = require('./lib/simbrief');
const archive = require('./lib/archive');

const PORT = Number(process.env.PORT) || 8420;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const DEFAULT_SETTINGS = { userid: '567212', paper: 'A4' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch (e) { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function readBody(req, limit = 10 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Cheap poll cache so the client can ask often without hammering SimBrief.
let pollCache = { at: 0, value: null };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (p === '/api/sheet' && req.method === 'GET') {
      const settings = readSettings();
      const model = await buildSheet(settings.userid);
      if (!model.error) {
        const arch = archive.save(model);
        model.archived = arch;
      }
      return sendJson(res, 200, model);
    }
    if (p === '/api/poll' && req.method === 'GET') {
      if (Date.now() - pollCache.at < 60000 && pollCache.value) return sendJson(res, 200, pollCache.value);
      const settings = readSettings();
      try {
        const raw = await fetchOfp(settings.userid);
        pollCache = { at: Date.now(), value: { timeGenerated: raw.params.time_generated, requestId: raw.params.request_id } };
      } catch (e) {
        pollCache = { at: Date.now(), value: { error: e.message } };
      }
      return sendJson(res, 200, pollCache.value);
    }
    if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, readSettings());
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const s = readSettings();
      if (typeof body.userid === 'string' && /^\d{1,10}$/.test(body.userid.trim())) s.userid = body.userid.trim();
      if (body.paper === 'A4' || body.paper === 'Letter') s.paper = body.paper;
      writeSettings(s);
      pollCache = { at: 0, value: null };
      return sendJson(res, 200, s);
    }
    if (p === '/api/archive' && req.method === 'GET') return sendJson(res, 200, archive.list());
    if (/^\/api\/archive\/\d+$/.test(p) && req.method === 'GET') {
      const m = archive.get(p.split('/').pop());
      return m ? sendJson(res, 200, m) : sendJson(res, 404, { error: 'not found' });
    }
    if (p === '/api/data/status' && req.method === 'GET') return sendJson(res, 200, airports.status());
    if (p === '/api/data/refresh' && req.method === 'POST') {
      airports.init({ force: true }).catch(() => {});
      return sendJson(res, 202, { refreshing: true });
    }

    // static
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return sendFile(res, filePath);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`simbrief-flight-sheet  ->  http://localhost:${PORT}`);
  console.log('Loading airport data (OurAirports + NASR ILS)...');
  airports.init()
    .then(() => {
      const s = airports.status();
      console.log(`Airport data ready: ${s.airportCount} airports, ${s.ilsCount} ILS records (NASR cycle ${s.ilsCycle}).`);
      if (s.lastError) console.log(`Note: ${s.lastError}`);
    })
    .catch(e => console.error(`Airport data failed to load: ${e.message} — sheet will render without freqs/runways until /api/data/refresh succeeds.`));
});
