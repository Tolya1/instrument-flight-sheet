# simbrief-flight-sheet (v2)

Printable one-sheet (front + back) IFR kneeboard for PilotEdge flying, filled
from the latest SimBrief OFP. Rebuild of the original Electron tool (lost with
D:\Harbor in Aug 2026) as a small Node server + browser page.

## Run

Double-click `start-simbrief-flight-sheet.cmd` (or `npm start`), then the page
opens at http://localhost:8420. Print with the Print button / Ctrl+P
(A4 default; switch to Letter in Settings).

## Data sources (all keyless)

- **SimBrief** `xml.fetcher.php?userid=...&json=v2` — OFP, weights, fuel,
  times, navlog, TLR v-speeds. Userid set in Settings (data/settings.json).
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
