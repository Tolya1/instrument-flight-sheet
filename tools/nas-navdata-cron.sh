#!/bin/sh
# Weekly AIRAC refresh, run by cron on the NAS.
#
# The Navigraph data lives in the X-Plane install on the sim PC, so this job
# can only extract when that folder is reachable — mount it read-only first
# (see README "Navdata on a headless host"). When it is not reachable the job
# does nothing but say so, loudly and with the current cycle, rather than
# leaving stale data to be discovered mid-flight. The sheet itself already
# prints CYCLE EXPIRED once validTo passes.
#
# Install (preserving any other crontab entries):
#   (crontab -l 2>/dev/null | grep -v nas-navdata-cron; \
#    echo '17 6 * * 1 $HOME/instrument-flight-sheet/tools/nas-navdata-cron.sh') | crontab -

set -u
APP="$HOME/instrument-flight-sheet"
XP="${XPLANE_DIR:-/srv/xplane}"          # mount point of the "X-Plane 12" folder
LOG="$APP/navdata-cron.log"
PORT="${NETGATE_PORT:-8420}"
export PATH="$HOME/opt/node/bin:$PATH"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(stamp) $*" >>"$LOG"; }

# keep the log from growing forever
[ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 1000000 ] && : >"$LOG"

cycle_now() {
  node -e '
    try {
      const d = require(process.argv[1]);
      process.stdout.write((d.meta.cycle || "?") + " valid to " + (d.meta.validTo || "?"));
    } catch (e) { process.stdout.write("none"); }
  ' "$APP/data/navdata-ils.json" 2>/dev/null || echo "unknown"
}

if [ ! -r "$XP/Custom Data/earth_nav.dat" ]; then
  say "X-Plane data not readable at '$XP' — navdata still $(cycle_now). Mount the sim PC's X-Plane folder to enable automatic updates."
  exit 0
fi

before="$(cycle_now)"
if node "$APP/tools/extract-navdata.js" "$XP" "$APP/data/navdata-ils.json" >>"$LOG" 2>&1; then
  after="$(cycle_now)"
  if [ "$before" = "$after" ]; then
    say "no change: $after"
  else
    # reindex only; the CSV/NASR caches refresh on their own schedule
    curl -sf -X POST "http://127.0.0.1:$PORT/api/data/refresh?force=0" >/dev/null 2>&1 \
      && say "updated $before -> $after, server reindexed" \
      || say "updated $before -> $after, but the server did not answer on :$PORT"
  fi
else
  say "extraction failed — navdata still $before"
fi
