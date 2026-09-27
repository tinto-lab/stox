#!/usr/bin/env python3
"""stox_bridge — JSON-lines entry point for a non-terminal frontend (e.g.
the macOS app) driving the same backend as stox.py.

Reads one JSON command per line on stdin, writes one JSON event per line
on stdout. See stoxlib/bridge.py for the protocol.
"""

from stoxlib.bridge import main

if __name__ == "__main__":
    main()
