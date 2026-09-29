"""Alert delivery: WhatsApp via CallMeBot (free, personal-use relay).

CallMeBot sends WhatsApp messages to your own number with no business
account: message their bot once ("I allow callmebot to send me messages")
and it replies with an API key. Configured by two env vars, set from the
app's Settings panel or ~/.config/stox/.env like every other key:

    CALLMEBOT_PHONE    your number in international format, e.g. +14155550123
    CALLMEBOT_APIKEY   the key CallMeBot sent you

It's one GET per message and is rate-limited on their side, so watcher.py
sends one message per alert, never per headline.
"""

import os
import re

import requests

CALLMEBOT_URL = "https://api.callmebot.com/whatsapp.php"
REQUEST_TIMEOUT = 20
# WhatsApp itself allows far more, but CallMeBot passes the text in a query
# string; keep well clear of URL length limits.
MAX_MESSAGE_CHARS = 1500


class NotifyError(Exception):
    """Raised when an alert couldn't be delivered."""


def whatsapp_configured():
    return bool(os.environ.get("CALLMEBOT_PHONE") and os.environ.get("CALLMEBOT_APIKEY"))


def send_whatsapp(text):
    phone = os.environ.get("CALLMEBOT_PHONE", "").strip()
    apikey = os.environ.get("CALLMEBOT_APIKEY", "").strip()
    if not (phone and apikey):
        raise NotifyError("WhatsApp isn't set up -- add CALLMEBOT_PHONE and CALLMEBOT_APIKEY in Settings")
    params = {"phone": phone, "apikey": apikey, "text": text[:MAX_MESSAGE_CHARS]}
    try:
        r = requests.get(CALLMEBOT_URL, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        raise NotifyError("network error: %s" % e) from e
    # CallMeBot reports a bad key or an unregistered phone with an HTML page
    # that may still come back 200, so the body has to be checked too.
    body = (r.text or "").lower()
    if r.status_code != 200 or "invalid" in body or "error" in body:
        raise NotifyError("CallMeBot rejected the message (HTTP %s): %s"
                          % (r.status_code, _plain(r.text)[:200]))


def _plain(html):
    """Crude tag strip, just so an error message is readable."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()
