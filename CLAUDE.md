# instrument-flight-sheet — working notes for agents

SimBrief OFP → printable two-page IFR kneeboard (built for PilotEdge, US West
Coast; global data support in progress). Zero-framework Node server
(`server.js` + `lib/`) and a plain browser client (`public/`). One npm
dependency (adm-zip). Node >= 18.4.

## Architecture in one pass

- `server.js` — http routes, two modes: **personal** (default; single user,
  settings.json, server-side archive) and **PUBLIC_MODE=1** (multi-user:
  `?user=` per request, per-IP rate limits, browser-localStorage
  settings/archive, personal-only endpoints 403). Security headers + CSP.
- `lib/simbrief.js` — fetch + normalize the OFP (`json=v2`). All numeric
  leaves arrive as strings; **blank leaves arrive as `[]` or `''`** — `num()`
  must never turn those into 0.
- `lib/airports.js` — OurAirports CSVs (airports/freqs/runways/navaids,
  weekly refresh) + FAA NASR ILS (28-day cycle, `lib/cycle.js`) + optional
  `data/navdata-ils.json` (Navigraph-derived, from `tools/extract-navdata.js`).
  ILS lookup precedence: **Navigraph → NASR**.
- `lib/wx.js` — aviationweather.gov METAR/TAF (global, keyless, cached 3 min).
- `lib/peatis.js` — PilotEdge live network ATIS (optional layer, cached 90 s,
  degrades to null silently).
- `lib/metar-parse.js` — defensive parser; **must never throw**.
- `lib/sheetmodel.js` — assembles the sheet model + derived values (wind
  components, TOD, V-speeds from TLR, ETA local).
- `public/app.js` — renders front/back page HTML; `fitPages()` auto-densifies
  when a busy flight would overflow one printed side.

## Invariants (break these and the tool stops being trustworthy)

1. **Fields ATC assigns are blank handwriting lines**; SimBrief/PE knowledge
   goes in a small grey hint *below* the line. Never prefill assigned values.
2. **The sheet always renders.** Every data source fails independently; raw
   METAR always prints even if parsing fails; a read-only disk or a dead
   upstream must never blank the page.
3. **Absent data renders as blank/`—`, never as a fabricated 0.**
4. **Escape everything** that reaches innerHTML (`esc()` in app.js) — all
   upstream strings are untrusted.
5. **Licensing boundary:** `data/` is gitignored and machine-local.
   Navigraph-derived files (`navdata-ils.json`) are per-subscriber: they must
   never be committed, and PUBLIC_MODE responses must never depend on them
   being served to third parties.

## Process for any change

1. Edit; `node --check` the touched files.
2. `npm test` — must stay green (offline-safe; data tests self-skip on a
   fresh clone). `LIVE=1 npm test` adds real-upstream smoke tests.
3. UI/print changes: run the server, verify in a browser, and re-check the
   print budget (`fitPages` warns in the toolbar; fixed content must fit
   ~281 mm A4 minus the scratch-box floor).
4. **Regional features:** the suite has `todo` tests for known FAA-locale
   leaks (inHg-first altimeter, 91.185 lost-comms crib, PE notes shown
   everywhere, ft-only runway dims). When implementing one, flip its `todo`
   into an enforced assertion in the same commit.
5. Commit with a body that says what changed and why; push. Deployments pull
   from GitHub (see CLAUDE.local.md for the private targets, if present).

## Gotchas that have already bitten

- npm scripts run under cmd on Windows: no globbing, no `VAR=x` prefixes —
  `node --test` (bare) discovers tests; env vars are documented per-shell.
- `pkill -f` matches the *calling* command line too — patterns must
  bracket-escape (`"[s]erver.js"`), and env vars (PORT=…) are NOT in the
  cmdline; kill by port instead.
- FAA nfdc.faa.gov has real maintenance windows (503 for everyone); the app
  falls back to the previous/any cached cycle. Don't diagnose it as blocking.
- OurAirports runway headings and METAR winds are both TRUE degrees; NASR
  `APCH_BEAR` and Navigraph courses are MAGNETIC. Don't mix them.
- The v2 SimBrief JSON dict-wraps nothing (unlike json=1), but empty scalars
  are `[]`/`''` — see invariant 3.
