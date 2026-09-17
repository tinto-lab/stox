#!/usr/bin/env python3
"""stox — a tiny terminal stock research console.

Entry point only. The implementation lives in stoxlib/ (quotes, rendering,
providers, agent, shell) — see stoxlib/__init__.py for what each module
owns, and README.md for setup and usage.
"""

from stoxlib.shell import main

if __name__ == "__main__":
    main()
