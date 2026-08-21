# instrument-flight-sheet

Printable two-page IFR kneeboard sheet, filled from your latest
[SimBrief](https://www.simbrief.com) OFP — built for flying on
[PilotEdge](https://www.pilotedge.net) but useful on any network. A small
zero-framework Node server + a browser page with print CSS. MIT licensed.

## Run locally (personal mode)

```
npm install
npm start          # -> http://localhost:8420
```

On Windows, `start-simbrief-flight-sheet.cmd` does both and opens the page.
Set your SimBrief userid (or alias) once in Settings (⚙); print with the
Print button / Ctrl+P (A4 default; Letter switchable). Your sheets are
archived server-side in `archive/` and reprintable from the Archive button.

## Host it (public mode)

`PUBLIC_MODE=1` turns the server multi-user: every visitor enters their own
SimBrief userid (stored in their browser, sent per-request), nothing
user-specific is persisted server-side, per-IP rate limiting is on, and the
archive lives in each visitor's localStorage.

```
docker compose up -d                                # public mode (default)
PUBLIC_MODE=0 BIND_ADDR=127.0.0.1 docker compose up # personal single-user container
```

Personal mode has **no auth and no rate limiting** — never publish it beyond
localhost (that's what `BIND_ADDR=127.0.0.1` is for).

Or without Docker: `PUBLIC_MODE=1 node server.js` (PowerShell:
`$env:PUBLIC_MODE='1'; node server.js`).

Env vars: `PORT` (8420), `HOST` (127.0.0.1 personal / 0.0.0.0 public),
`PUBLIC_MODE`, `TRUST_PROXY=1` (rate-limit on `X-Forwarded-For` — set only
behind a reverse proxy you control). `/healthz` is the health endpoint.
Mount/keep `data/` (compose does) so the ~20 MB of airport data isn't
re-downloaded on every restart; it self-refreshes weekly (CSVs) and per
28-day AIRAC cycle (FAA ILS data).

## Data sources (all keyless)

- **SimBrief** `xml.fetcher.php?userid=...&json=v2` — OFP, weights, fuel,
  times, navlog, TLR v-speeds. Userid/alias set in Settings (stored in
  `data/settings.json` in personal mode, in your browser in public mode).
- **OurAirports CSVs** (public domain, refreshed weekly) — frequencies,
  runways, elevations, VORs.
- **FAA NASR** `ILS_CSV.zip` (28-day cycle, falls back to previous cycle) —
  localizer freq + approach course per runway end.
- **aviationweather.gov** data API — live METAR/TAF for dep/arr/altn.
- **PilotEdge** `pilotedge.net/atis/{ICAO}.json` — network ATIS letter and
  active runways (optional; silently absent outside PE hours).

## Design rules

- Anything ATC assigns is a **blank handwriting line**; SimBrief/PE knowledge
  is a small grey *hint* below it (the old sheet prefilled initial-alt and it
  had to be crossed out — never again).
- Altimeter is **inHg first**, hPa secondary.
- Raw METAR always prints even if parsing fails; parse errors can't blank the sheet.
- Every source fails independently: last-good OFP is cached, airport DB is
  cached, wx/PE just degrade.

## Layout

Front: header + squawk/ATIS boxes + checkbox flow strip, route, CRAFT block,
loadsheet, departure/arrival blocks, dep+arr frequencies & airport info
(ILS freq/course, likely runway highlighted from PE ATIS), both METARs with
runway wind components, V-speeds (TLR), ETE/ETA/TOD strip, scratch box.

Back: alternate card, arrival TAF (ETA period flagged), route VORs, fuel plan
+ howgozit check rows, lost-comms (91.185) crib, PilotEdge notes, big scratch.

Archive: every new OFP's sheet model is stored in `archive/` — reopen and
reprint from the Archive button.
