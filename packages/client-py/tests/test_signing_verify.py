import base64
import hashlib
import json
import unittest

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from thehive import (
    content_digest,
    generate_keypair,
    normalize_url,
    sign_request,
    signature_base,
    verify_hive_request,
)
from thehive.keys import b64url_decode

from test_keys_pow import KEY, THUMBPRINT

NOW = 1_700_000_000
URL = "https://thehive.example/v1/echo"
PARAMS = (
    '("@method" "@target-uri" "content-digest");created=1700000000;expires=1700000060;'
    f'keyid="{THUMBPRINT}";alg="ed25519";nonce="fixed-nonce-0001"'
)


class SigningTest(unittest.TestCase):
    def test_content_digest(self) -> None:
        self.assertEqual(content_digest(b""), "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:")
        expected = base64.b64encode(hashlib.sha256(b'{"a":1}').digest()).decode()
        self.assertEqual(content_digest(b'{"a":1}'), f"sha-256=:{expected}:")

    def test_headers_and_signature_base(self) -> None:
        signed = sign_request("post", URL, KEY, '{"a":1}', now=NOW, nonce="fixed-nonce-0001")
        self.assertEqual(signed.url, URL)
        self.assertEqual(signed.body, b'{"a":1}')
        self.assertEqual(list(signed.headers), ["Content-Digest", "Signature-Input", "Signature"])
        self.assertEqual(signed.headers["Signature-Input"], "sig1=" + PARAMS)
        base = signature_base("post", URL, signed.headers["Content-Digest"], PARAMS)
        self.assertEqual(
            base,
            '"@method": POST\n'
            '"@target-uri": https://thehive.example/v1/echo\n'
            f'"content-digest": {content_digest(signed.body)}\n'
            f'"@signature-params": {PARAMS}',
        )
        self.assertRegex(signed.headers["Signature"], r"^sig1=:[A-Za-z0-9+/]{86}==:$")
        signature = base64.b64decode(signed.headers["Signature"][6:-1])
        public = Ed25519PublicKey.from_public_bytes(b64url_decode(KEY.public_key["x"]))
        public.verify(signature, base.encode())
        with self.assertRaises(InvalidSignature):
            public.verify(signature, base.encode() + b"\n")

    def test_signing_is_deterministic_for_fixed_inputs(self) -> None:
        one = sign_request("POST", URL, KEY, b"x", now=NOW, nonce="fixed-nonce-0001")
        two = sign_request("POST", URL, KEY, b"x", now=NOW, nonce="fixed-nonce-0001")
        self.assertEqual(one, two)

    def test_defaults(self) -> None:
        one = sign_request("GET", URL, KEY)
        two = sign_request("GET", URL, KEY)
        self.assertEqual(one.body, b"")
        self.assertEqual(one.headers["Content-Digest"], content_digest(b""))
        self.assertRegex(
            one.headers["Signature-Input"],
            r'created=(\d+);expires=(\d+);keyid="[^"]+";alg="ed25519";nonce="[A-Za-z0-9_-]{22}"$',
        )
        self.assertNotEqual(one.headers["Signature-Input"], two.headers["Signature-Input"])
        self.assertIn(";created=1700000000;expires=1700000300;", sign_request("GET", URL, KEY, now=NOW + 0.9, ttl_seconds=300).headers["Signature-Input"])

    def test_normalize_url_matches_whatwg(self) -> None:
        cases = {
            "https://thehive.example": "https://thehive.example/",
            "HTTPS://TheHive.Example:443/v1/x": "https://thehive.example/v1/x",
            "http://localhost:8799/v1/pulse?max_tokens=5": "http://localhost:8799/v1/pulse?max_tokens=5",
            "http://h:80/a/../b/./c/": "http://h/b/c/",
            "http://h/a//b": "http://h/a//b",
            "http://h/a b/ü?q=a b": "http://h/a%20b/%C3%BC?q=a%20b",
            "https://h:8443/a%20b?c=%7E": "https://h:8443/a%20b?c=%7E",
        }
        for url, expected in cases.items():
            self.assertEqual(normalize_url(url), expected)
        for bad in ("/v1/pulse", "ftp://h/x", "thehive.example"):
            with self.assertRaises(ValueError):
                normalize_url(bad)


class VerifyHiveRequestTest(unittest.TestCase):
    hook = "https://agent.example/hook?token=abc"
    event = {"id": "evt_1", "type": "reply", "created_at": 1, "origin": "o", "agent": "me", "data": {"item_id": "itm_1"}}

    def setUp(self) -> None:
        self.body = json.dumps(self.event).encode()
        self.signed = sign_request("POST", self.hook, KEY, self.body, now=NOW)
        self.keys = [{**generate_keypair().public_key, "kid": "other"}, {**KEY.public_key, "kid": THUMBPRINT}]

    def check(self, **changes):
        args = {"method": "POST", "url": self.hook, "headers": self.signed.headers, "body": self.body, "keys": self.keys, "now": NOW + 5}
        return verify_hive_request(**{**args, **changes})

    def test_accepts_a_good_delivery(self) -> None:
        self.assertEqual(self.check(), self.event)
        self.assertEqual(self.check(method="post", body=self.body.decode()), self.event)
        lower = {name.lower(): value for name, value in self.signed.headers.items()}
        self.assertEqual(self.check(headers=lower), self.event)
        self.assertEqual(self.check(url="HTTPS://Agent.Example:443/hook?token=abc"), self.event)

    def test_rejects_changed_body_method_or_url(self) -> None:
        self.assertIsNone(self.check(body=self.body + b" "))
        self.assertIsNone(self.check(method="PUT"))
        self.assertIsNone(self.check(url="https://agent.example/hook?token=abd"))
        self.assertIsNone(self.check(url="https://agent.example/hook"))

    def test_rejects_unknown_or_wrong_key(self) -> None:
        self.assertIsNone(self.check(keys=[]))
        self.assertIsNone(self.check(keys=self.keys[:1]))
        impostor = {**generate_keypair().public_key, "kid": THUMBPRINT}
        self.assertIsNone(self.check(keys=[impostor]))
        self.assertIsNone(self.check(keys=[{"kid": THUMBPRINT, "x": "not a key"}]))

    def test_rejects_stale_and_future_signatures(self) -> None:
        self.assertEqual(self.check(now=NOW + 360), self.event)
        self.assertIsNone(self.check(now=NOW + 361))
        self.assertEqual(self.check(now=NOW - 300), self.event)
        self.assertIsNone(self.check(now=NOW - 301))
        self.assertIsNone(self.check(now=NOW + 61, tolerance_seconds=0))
        self.assertIsNone(self.check(now=None))

    def test_rejects_missing_or_malformed_headers(self) -> None:
        for name in self.signed.headers:
            headers = dict(self.signed.headers)
            del headers[name]
            self.assertIsNone(self.check(headers=headers))
        headers = dict(self.signed.headers)
        for name, value in (
            ("Signature", "sig1=:AAAA:"),
            ("Signature", headers["Signature"] + "\n"),
            ("Signature", headers["Signature"].replace("sig1", "sig2")),
            ("Signature-Input", headers["Signature-Input"].replace("fixed", "other") + ";tag=\"x\""),
            ("Signature-Input", headers["Signature-Input"].replace('"content-digest"', "")),
            ("Signature-Input", headers["Signature-Input"].replace("expires=1700000060", "expires=1700000061")),
        ):
            self.assertIsNone(self.check(headers={**headers, name: value}), (name, value))

    def test_rejects_a_signed_body_that_is_not_a_json_object(self) -> None:
        for body in (b"not json", b"[1]", b"\xff"):
            signed = sign_request("POST", self.hook, KEY, body, now=NOW)
            self.assertIsNone(self.check(body=body, headers=signed.headers))


if __name__ == "__main__":
    unittest.main()
