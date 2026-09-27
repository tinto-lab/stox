#!/usr/bin/env bash
# Force-kills any running Stox.app processes (main, helpers, and the
# bundled Python backend). macOS apps keep running in the background
# after their window is closed -- only Cmd+Q or this actually stops
# them -- and a rebuilt .app on disk has no effect on an already-running
# process, so this is the "make sure I'm testing the build I just made"
# command during development. Safe to run any time; no-ops if nothing
# is running.
set -uo pipefail

killed=0
for pattern in \
  "Stox.app/Contents/MacOS/Stox" \
  "Stox.app/Contents/Resources/backend/stox-backend" \
  "Stox Helper"
do
  if pkill -f "$pattern" 2>/dev/null; then
    killed=1
  fi
done

if [ "$killed" = "1" ]; then
  echo "stopped running Stox instance(s)"
else
  echo "no running Stox instance found"
fi
