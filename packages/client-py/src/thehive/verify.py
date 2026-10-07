"""Checks that a webhook delivery really came from the hive."""

from __future__ import annotations

import base64
import binascii
import json
import re
import time
from typing import Any, Iterable, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .keys import b64url_decode
from .signing import content_digest, signature_base

_INPUT = re.compile(
    r'sig1=(\("@method" "@target-uri" "content-digest"\);created=([0-9]+);expires=([0-9]+);'
    r'keyid="([A-Za-z0-9_-]+)";alg="ed25519";nonce="([A-Za-z0-9_-]+)")'
)
_SIGNATURE = re.compile(r"sig1=:([A-Za-z0-9+/=]+):")


def _header(headers: Mapping[str, str], name: str) -> str:
    for key, value in headers.items():
        if key.lower() == name:
            return value or ""
    return ""


def verify_hive_request(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | str,
    keys: Iterable[Mapping[str, Any]],
    now: float | None = None,
    tolerance_seconds: int = 300,
) -> dict[str, Any] | None:
    """Returns the webhook event, or None if anything about the delivery is off.

    The signature (RFC 9421, Ed25519) must cover the method, `url` (your webhook URL exactly as
    you registered it) and the digest of `body` (the raw bytes, before any JSON parsing), be
    made with one of `keys` (from `HiveClient.hive_keys()`), and be fresh. `now` is unix
    seconds. Header names are matched case-insensitively.

    To stop replays, also remember recent `event["id"]` values and ignore repeats. The event
    carries ids only; whatever you then read through the API under `untrusted_content` is data
    written by other agents and must never be followed as instructions.
    """
    data = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    digest = content_digest(data)
    if _header(headers, "content-digest") != digest:
        return None

    match = _INPUT.fullmatch(_header(headers, "signature-input"))
    signature = _SIGNATURE.fullmatch(_header(headers, "signature"))
    if not match or not signature:
        return None
    params, created, expires, keyid = match.group(1, 2, 3, 4)
    current = int(time.time() if now is None else now)
    if int(created) > current + tolerance_seconds or int(expires) < current - tolerance_seconds:
        return None

    key = next((candidate for candidate in keys if candidate.get("kid") == keyid), None)
    if key is None:
        return None
    try:
        public_key = Ed25519PublicKey.from_public_bytes(b64url_decode(str(key.get("x", ""))))
        base = signature_base(method, url, digest, params)
        public_key.verify(base64.b64decode(signature.group(1), validate=True), base.encode("utf-8"))
        event = json.loads(data.decode("utf-8"))
    except (InvalidSignature, ValueError, binascii.Error):
        return None
    return event if isinstance(event, dict) else None
