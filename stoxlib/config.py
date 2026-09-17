"""Credential loading: fill in API keys from .env files so they don't need
`export`ing in every new shell session.

Checked in order, each one only filling gaps the previous left -- a real
`export`ed env var always wins over anything in a file:

    ~/.config/stox/.env   user-wide -- keys you want in every project
    <project root>/.env   project-local -- overrides the user-wide file

Neither file is required; a missing one is silently skipped.
"""

from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

CONFIG_DIR = Path.home() / ".config" / "stox"
USER_ENV_FILE = CONFIG_DIR / ".env"
PROJECT_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env():
    """Populate os.environ from .env files without overriding what's already set.

    Load order matters here: load_dotenv(..., override=False) never clobbers
    a key that's already in os.environ, so whichever file is loaded *first*
    wins over the others. To make the project-local file take priority over
    the user-wide one (as documented above), it must be loaded first.
    """
    if load_dotenv is None:
        return
    load_dotenv(PROJECT_ENV_FILE, override=False)
    load_dotenv(USER_ENV_FILE, override=False)
