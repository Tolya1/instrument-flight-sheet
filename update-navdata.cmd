@echo off
rem Re-extract Navigraph ILS data from X-Plane Custom Data (kept current by
rem Navigraph Hub), reload the local server, and sync the NAS instance.
cd /d "%~dp0"
node tools\extract-navdata.js || exit /b 1
curl -s -X POST "http://localhost:8420/api/data/refresh?force=0" >nul 2>&1
ssh -o ConnectTimeout=5 tolya "true" >nul 2>&1
if errorlevel 1 (
  echo NAS unreachable - local only.
) else (
  scp -q data\navdata-ils.json tolya:instrument-flight-sheet/data/ && ssh tolya "curl -s -X POST \"http://127.0.0.1:8420/api/data/refresh?force=0\" >/dev/null" && echo NAS updated.
)
echo Done.
