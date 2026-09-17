"""Standing considerations: factors the user has asked the agent to always
weigh when explaining why a price moved or assessing risk for a security.

Unlike agent.py's conversation `history` (in-memory, session-only), these
are written to disk so they survive across sessions -- ask the agent to
"always consider X" once, and it applies X in every future run too.
"""

from .config import CONFIG_DIR

CONSIDERATIONS_FILE = CONFIG_DIR / "considerations.txt"


def load_considerations() -> list[str]:
    """Return the stored considerations, one per line.

    Blank lines and lines starting with '#' (for hand-written comments,
    since the file is plain text and fine to edit directly) are skipped.
    A missing file just means there are no considerations yet.
    """
    try:
        lines = CONSIDERATIONS_FILE.read_text().splitlines()
    except OSError:
        return []
    return [
        line.strip() for line in lines
        if line.strip() and not line.strip().startswith("#")
    ]


def add_consideration(text: str) -> None:
    """Append a new consideration, skipping an exact duplicate of one
    that's already stored."""
    text = text.strip()
    if not text or text in load_considerations():
        return
    CONSIDERATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with CONSIDERATIONS_FILE.open("a") as f:
        f.write(text + "\n")
