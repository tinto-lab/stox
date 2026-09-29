from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import notify
from stoxlib.notify import NotifyError


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("CALLMEBOT_PHONE", "+14155550123")
    monkeypatch.setenv("CALLMEBOT_APIKEY", "123456")


def test_not_configured_raises_without_a_request():
    assert notify.whatsapp_configured() is False
    with patch("stoxlib.notify.requests.get") as get:
        with pytest.raises(NotifyError, match="isn't set up"):
            notify.send_whatsapp("hi")
    get.assert_not_called()


def test_sends_phone_key_and_text(configured):
    with patch("stoxlib.notify.requests.get",
               return_value=Mock(status_code=200, text="Message queued.")) as get:
        notify.send_whatsapp("oil ↑")

    assert notify.whatsapp_configured() is True
    params = get.call_args.kwargs["params"]
    assert params == {"phone": "+14155550123", "apikey": "123456", "text": "oil ↑"}


def test_long_text_is_truncated(configured):
    with patch("stoxlib.notify.requests.get",
               return_value=Mock(status_code=200, text="ok")) as get:
        notify.send_whatsapp("x" * 5000)
    assert len(get.call_args.kwargs["params"]["text"]) == notify.MAX_MESSAGE_CHARS


def test_rejection_in_a_200_body_is_an_error(configured):
    with patch("stoxlib.notify.requests.get",
               return_value=Mock(status_code=200, text="<p>APIKey is invalid.</p>")):
        with pytest.raises(NotifyError, match="APIKey is invalid"):
            notify.send_whatsapp("hi")


def test_http_error(configured):
    with patch("stoxlib.notify.requests.get", return_value=Mock(status_code=503, text="")):
        with pytest.raises(NotifyError, match="HTTP 503"):
            notify.send_whatsapp("hi")


def test_network_error(configured):
    with patch("stoxlib.notify.requests.get", side_effect=requests.ConnectionError("down")):
        with pytest.raises(NotifyError, match="network error"):
            notify.send_whatsapp("hi")
