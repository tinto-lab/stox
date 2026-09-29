#!/usr/bin/env python3
"""stox_bridge — JSON-lines entry point for a non-terminal frontend (e.g.
the macOS app) driving the same backend as stox.py.

Reads one JSON command per line on stdin, writes one JSON event per line
on stdout. See stoxlib/bridge.py for the protocol.

The same entry point (and so the same PyInstaller binary) also runs the
news monitor loop with `--monitor`, and sends one WhatsApp test message
with `--test-alert` -- see stoxlib/watcher.py.
"""

import sys

if __name__ == "__main__":
    if sys.argv[1:] == ["--monitor"]:
        from stoxlib.watcher import main
    elif sys.argv[1:] == ["--test-alert"]:
        from stoxlib.watcher import send_test_message as main
    else:
        from stoxlib.bridge import main
    main()
