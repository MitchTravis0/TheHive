"""HTTP Message Signatures (RFC 9421) with Ed25519 and Content-Digest (RFC 9530)."""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

from .keys import HiveKeypair, b64url

COVERED = '("@method" "@target-uri" "content-digest")'

_DEFAULT_PORTS = {"http": 80, "https": 443}
# Characters the WHATWG URL serializer leaves alone, so already-encoded URLs pass through.
_PATH_SAFE = "/%:@!$&'()*+,;=[]|~"
_QUERY_SAFE = "/%:@!$&()*+,;=[]|~^?`{}\\"


def _resolve_dots(path: str) -> str:
    out: list[str] = []
    segments = path.split("/")[1:]
    for index, segment in enumerate(segments):
        plain = segment.lower().replace("%2e", ".")
        if plain in (".", ".."):
            if plain == ".." and out:
                out.pop()
            if index == len(segments) - 1:
                out.append("")
        else:
            out.append(segment)
    return "/" + "/".join(out)


def normalize_url(url: str) -> str:
    """The URL as the server will see it, matching `new URL(url).href` for http(s) URLs with
    ASCII host names: lower-case scheme and host, no default port, `/` for an empty path, dot
    segments resolved, unsafe characters percent-encoded. A fragment is dropped, since it is
    never sent."""
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname or not parts.hostname.isascii():
        raise ValueError(f"Not an absolute http(s) URL with an ASCII host: {url}")
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    if parts.port is not None and parts.port != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{parts.port}"
    path = _resolve_dots(parts.path.replace("\\", "/") or "/")
    href = f"{scheme}://{host}{quote(path, safe=_PATH_SAFE)}"
    if "?" in url.split("#", 1)[0]:
        href += "?" + quote(parts.query, safe=_QUERY_SAFE)
    return href


def content_digest(body: bytes) -> str:
    """The Content-Digest header value for `body`."""
    return f"sha-256=:{base64.b64encode(hashlib.sha256(body).digest()).decode('ascii')}:"


def signature_params(created: int, expires: int, keyid: str, nonce: str) -> str:
    """The Signature-Input value after `sig1=`; also the `@signature-params` line."""
    return (
        f"{COVERED};created={created};expires={expires};"
        f'keyid="{keyid}";alg="ed25519";nonce="{nonce}"'
    )


def signature_base(method: str, url: str, digest: str, params: str) -> str:
    """The exact text that is signed. `url` is normalized with `normalize_url`."""
    return "\n".join(
        [
            f'"@method": {method.upper()}',
            f'"@target-uri": {normalize_url(url)}',
            f'"content-digest": {digest}',
            f'"@signature-params": {params}',
        ]
    )


@dataclass(frozen=True)
class SignedRequest:
    #: The URL that was signed. Send the request to exactly this URL.
    url: str
    #: The exact bytes that were signed. Send these, unchanged.
    body: bytes
    #: Content-Digest, Signature-Input and Signature.
    headers: dict[str, str]


def sign_request(
    method: str,
    url: str,
    key: HiveKeypair,
    body: bytes | str = b"",
    *,
    now: float | None = None,
    ttl_seconds: int = 60,
    nonce: str | None = None,
) -> SignedRequest:
    """Signs a request, covering the method, the full target URI and the digest of the body.

    `now` is unix seconds (default: the current time). The server accepts a `ttl_seconds` of
    at most 300. `nonce` defaults to 16 fresh random bytes; never reuse one.
    """
    data = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    href = normalize_url(url)
    created = int(time.time() if now is None else now)
    digest = content_digest(data)
    params = signature_params(
        created, created + ttl_seconds, key.thumbprint, nonce or b64url(secrets.token_bytes(16))
    )
    signature = key.signing_key().sign(signature_base(method, href, digest, params).encode("utf-8"))
    return SignedRequest(
        href,
        data,
        {
            "Content-Digest": digest,
            "Signature-Input": f"sig1={params}",
            "Signature": f"sig1=:{base64.b64encode(signature).decode('ascii')}:",
        },
    )
