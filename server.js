'use strict';
// simbrief-flight-sheet server — zero framework.
//
// Modes:
//   personal (default)  — single-user local install: binds 127.0.0.1, userid
//                         lives in data/settings.json, server-side archive,
//                         on-disk last-OFP fallback. Start via
//                         start-simbrief-flight-sheet.cmd or `npm start`.
//   public (PUBLIC_MODE=1) — multi-user hosting: every request carries the
//                         visitor's own SimBrief userid/alias (?user=...),
//                         nothing user-specific is persisted server-side,
//                         per-IP rate limiting, security headers. Archive and
//                         preferences live in the visitor's browser.
//
// Env: PORT (default 8420), HOST (default 127.0.0.1 personal / 0.0.0.0 public),
//      PUBLIC_MODE=1, TRUST_PROXY=1 (rate-limit on X-Forwarded-For's client IP
//      — set ONLY behind a trusted reverse proxy).

const http = require('http');
const fs = require('fs');
const path = require('path');
const airports = require('./lib/airports');
const { buildSheet } = require('./lib/sheetmodel');
const { fetchOfp, validUser } = require('./lib/simbrief');
const archive = require('./lib/archive');

const PUBLIC_MODE = process.env.PUBLIC_MODE === '1' || /^true$/i.test(process.env.PUBLIC_MODE || '');
const PORT = Number(process.env.PORT) || 8420;
const HOST = process.env.HOST || (PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const DEFAULT_SETTINGS = { userid: '', paper: 'A4' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

/* ---------------- settings (personal mode only) ---------------- */
function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch (e) { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

/* ---------------- rate limiting (per IP, sliding minute) ---------------- */
const RATE = { sheet: 12, api: 90 }; // requests per minute
const rateBuckets = new Map(); // `${ip}:${cls}` -> [timestamps]
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, arr] of rateBuckets) {
    const live = arr.filter(t => t > cutoff);
    if (live.length) rateBuckets.set(k, live); else rateBuckets.delete(k);
  }
}, 30000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    // The trusted proxy APPENDS the peer it saw to the RIGHT of X-Forwarded-For;
    // everything left of that is client-controlled and must not be trusted.
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^[0-9a-fA-F.:]+$/.test(last)) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Bucket key: normalize IPv4-mapped addresses and aggregate IPv6 to its /64 —
// a v6 client owns ~2^64 addresses, so per-/128 buckets would be a free bypass.
function bucketIp(addr) {
  let a = String(addr || 'unknown').split('%')[0].replace(/^\[|\]$/g, '');
  const m = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (m) return m[1];
  if (!a.includes(':')) return a;
  const [h, t = ''] = a.split('::');
  const head = h ? h.split(':') : [];
  const tail = t ? t.split(':') : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return groups.slice(0, 4).map(x => x || '0').join(':') + '::/64';
}

function rateLimited(req, cls) {
  if (!PUBLIC_MODE) return false; // local single user — no limits
  const key = `${bucketIp(clientIp(req))}:${cls}`;
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => t > now - 60000);
  if (arr.length >= RATE[cls]) return true;
  arr.push(now);
  rateBuckets.set(key, arr);
  return false;
}

/* ---------------- helpers ---------------- */
function baseHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { ...baseHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, baseHeaders());
      res.end('not found');
      return;
    }
    res.writeHead(200, { ...baseHeaders(), 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
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

// Resolve which SimBrief user a request is for. Public mode: ?user= required.
// Personal mode: ?user= wins, else the configured one.
function resolveUser(url) {
  const q = (url.searchParams.get('user') || '').trim();
  if (q) return validUser(q) ? q : null;
  if (PUBLIC_MODE) return null;
  const s = readSettings().userid;
  return validUser(s) ? s : null;
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/healthz') {
      // readiness, not liveness: unhealthy until airport data is indexed
      const airportCount = airports.status().airportCount;
      const ok = airportCount > 0;
      return sendJson(res, ok ? 200 : 503, { ok, publicMode: PUBLIC_MODE, airports: airportCount });
    }

    if (p.startsWith('/api/')) {
      if (rateLimited(req, p === '/api/sheet' ? 'sheet' : 'api')) {
        return sendJson(res, 429, { error: 'rate limited — try again in a minute' });
      }
    }

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        publicMode: PUBLIC_MODE,
        // personal mode ships its stored settings so the UI can prefill
        settings: PUBLIC_MODE ? null : readSettings(),
      });
    }

    if (p === '/api/sheet' && req.method === 'GET') {
      const user = resolveUser(url);
      if (!user) return sendJson(res, 400, { error: 'missing or invalid SimBrief userid/alias — set it in Settings' });
      const model = await buildSheet(user, { diskCache: !PUBLIC_MODE });
      if (!model.error && !PUBLIC_MODE) {
        model.archived = archive.save(model);
      }
      return sendJson(res, 200, model);
    }

    if (p === '/api/poll' && req.method === 'GET') {
      const user = resolveUser(url);
      if (!user) return sendJson(res, 400, { error: 'missing or invalid SimBrief userid/alias' });
      try {
        // fetchOfp has a 45s per-user cache, so polling stays cheap upstream
        const raw = await fetchOfp(user, { diskCache: !PUBLIC_MODE });
        return sendJson(res, 200, { timeGenerated: raw.params.time_generated, requestId: raw.params.request_id });
      } catch (e) {
        return sendJson(res, 200, { error: e.message });
      }
    }

    if (p === '/api/settings' && req.method === 'GET') {
      if (PUBLIC_MODE) return sendJson(res, 403, { error: 'settings are per-browser in public mode' });
      return sendJson(res, 200, readSettings());
    }
    if (p === '/api/settings' && req.method === 'POST') {
      if (PUBLIC_MODE) return sendJson(res, 403, { error: 'settings are per-browser in public mode' });
      const body = await readBody(req);
      const s = readSettings();
      if (typeof body.userid === 'string' && (body.userid === '' || validUser(body.userid.trim()))) s.userid = body.userid.trim();
      if (body.paper === 'A4' || body.paper === 'Letter') s.paper = body.paper;
      writeSettings(s);
      return sendJson(res, 200, s);
    }

    if (p === '/api/archive' && req.method === 'GET') {
      if (PUBLIC_MODE) return sendJson(res, 403, { error: 'archive is per-browser in public mode' });
      return sendJson(res, 200, archive.list());
    }
    if (/^\/api\/archive\/\d+$/.test(p) && req.method === 'GET') {
      if (PUBLIC_MODE) return sendJson(res, 403, { error: 'archive is per-browser in public mode' });
      const m = archive.get(p.split('/').pop());
      return m ? sendJson(res, 200, m) : sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/api/data/status' && req.method === 'GET') {
      const s = airports.status();
      // visitors get counts only; internal error strings/paths stay private
      return sendJson(res, 200, PUBLIC_MODE
        ? { airportCount: s.airportCount, ilsCount: s.ilsCount, ilsCycle: s.ilsCycle }
        : s);
    }
    if (p === '/api/data/refresh' && req.method === 'POST') {
      if (PUBLIC_MODE) return sendJson(res, 403, { error: 'disabled in public mode' });
      // force=0 -> reindex only (picks up a new navdata-ils.json without re-downloading CSVs)
      const force = url.searchParams.get('force') !== '0';
      airports.init({ force }).catch(() => {});
      return sendJson(res, 202, { refreshing: true, force });
    }

    // static — resolve, then require the result to stay inside public/
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, baseHeaders());
      return res.end();
    }
    return sendFile(res, filePath);
  } catch (e) {
    return sendJson(res, e.code === 'ERR_INVALID_URL' ? 400 : 500, { error: e.message });
  }
});

// Anti slow-loris/socket-exhaustion ceilings for the directly-exposed case; a
// fronting reverse proxy typically enforces stricter ones anyway.
server.maxConnections = Number(process.env.MAX_CONN) || 512;
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.timeout = 30000;

// docker stop / ctrl-c: drain instead of hanging until SIGKILL
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(PORT, HOST, () => {
  console.log(`simbrief-flight-sheet [${PUBLIC_MODE ? 'PUBLIC' : 'personal'}]  ->  http://${HOST}:${PORT}`);
  console.log('Loading airport data (OurAirports + NASR ILS)...');
  airports.init()
    .then(() => {
      const s = airports.status();
      console.log(`Airport data ready: ${s.airportCount} airports, ${s.ilsCount} ILS records (NASR cycle ${s.ilsCycle}).`);
      if (s.lastError) console.log(`Note: ${s.lastError}`);
    })
    .catch(e => console.error(`Airport data failed to load: ${e.message} — sheet will render without freqs/runways until a refresh succeeds.`));
  // keep the caches fresh on long-running deployments (weekly CSVs, 28-day ILS)
  setInterval(() => airports.init().catch(() => {}), 12 * 3600 * 1000).unref();
});
