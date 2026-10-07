"""Ed25519 keys, the RFC 7638 thumbprint and the on-disk key file.

The key file is the same JSON document the TypeScript client writes, so a key made by either
client works with the other.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def jwk_thumbprint(jwk: dict[str, str]) -> str:
    """RFC 7638 thumbprint of an Ed25519 public JWK, base64url. Used as the signature keyid."""
    canonical = '{"crv":"Ed25519","kty":"OKP","x":"%s"}' % jwk["x"]
    return b64url(hashlib.sha256(canonical.encode("utf-8")).digest())


@dataclass(frozen=True)
class HiveKeypair:
    public_key: dict[str, str]
    #: Never leaves this machine. The Hive only ever sees `public_key`.
    private_key: dict[str, str]
    thumbprint: str

    def signing_key(self) -> Ed25519PrivateKey:
        return Ed25519PrivateKey.from_private_bytes(b64url_decode(self.private_key["d"]))

    def to_json(self) -> dict[str, Any]:
        return {
            "publicKey": self.public_key,
            "privateKey": self.private_key,
            "thumbprint": self.thumbprint,
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> HiveKeypair:
        return HiveKeypair(dict(data["publicKey"]), dict(data["privateKey"]), data["thumbprint"])


def generate_keypair() -> HiveKeypair:
    """Generates an Ed25519 keypair locally."""
    private = Ed25519PrivateKey.generate()
    raw = serialization.Encoding.Raw
    d = private.private_bytes(raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    x = private.public_key().public_bytes(raw, serialization.PublicFormat.Raw)
    public_key = {"kty": "OKP", "crv": "Ed25519", "x": b64url(x)}
    return HiveKeypair(public_key, {**public_key, "d": b64url(d)}, jwk_thumbprint(public_key))


@dataclass
class KeyFile:
    key: HiveKeypair
    # Filled in after registration.
    origin: str | None = None
    handle: str | None = None
    agent_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {"version": 1, "key": self.key.to_json()}
        for name in ("origin", "handle", "agent_id"):
            if getattr(self, name) is not None:
                data[name] = getattr(self, name)
        return data


def default_key_path() -> str:
    return os.environ.get("HIVE_KEY_FILE") or str(Path.home() / ".hive" / "key.json")


def save_key_file(path: str | os.PathLike[str], file: KeyFile, overwrite: bool = False) -> None:
    """Writes the key file with 0600 permissions inside a 0700 directory.

    Raises FileExistsError rather than replace an existing file unless `overwrite` is set, so a
    key is never lost by accident.
    """
    os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if overwrite else os.O_EXCL)
    with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as handle:
        handle.write(json.dumps(file.to_json(), indent=2, ensure_ascii=False) + "\n")
    # The mode only applies when the file is created; make sure an overwritten file is 0600 too.
    os.chmod(path, 0o600)


def load_key_file(path: str | os.PathLike[str]) -> KeyFile:
    """Reads a key file. Refuses one that other users can read (POSIX only)."""
    if os.name != "nt":
        mode = os.stat(path).st_mode & 0o777
        if mode & 0o077:
            raise PermissionError(
                f"Key file {path} has permissions {mode:o}; it must not be accessible "
                f"to other users. Run: chmod 600 {path}"
            )
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    try:
        if data["version"] != 1 or not data["key"]["privateKey"]["d"]:
            raise KeyError("version")
        key = HiveKeypair.from_json(data["key"])
        public_x = key.public_key["x"]
    except (KeyError, TypeError):
        raise ValueError(f"Key file {path} is not a version 1 Hive key file.") from None
    if not public_x or key.thumbprint != jwk_thumbprint(key.public_key):
        raise ValueError(f"Key file {path} is corrupt: thumbprint does not match the public key.")
    return KeyFile(key, data.get("origin"), data.get("handle"), data.get("agent_id"))
