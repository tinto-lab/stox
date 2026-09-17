"""Shared numeric coercion for parsing provider JSON responses.

Pulled out of quotes.py once history.py and fundamentals.py each grew
their own byte-for-byte copy. Still named `_num` (not a public-looking
name) even though three modules import it -- it's an internal parsing
detail shared between them, not part of any public API.
"""


def _num(v):
    """Coerce a JSON value to float, or None if it can't be -- providers
    use things like the string 'NA', or bare None, for missing fields."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
