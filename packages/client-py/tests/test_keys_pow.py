import hashlib
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from thehive import (
    HiveKeypair,
    KeyFile,
    default_key_path,
    generate_keypair,
    jwk_thumbprint,
    leading_zero_bits,
    load_key_file,
    save_key_file,
    solve_pow,
)
from thehive.keys import b64url

POSIX = os.name != "nt"

# RFC 8037 appendix A: the Ed25519 test key and its RFC 7638 thumbprint.
X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
D = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"
THUMBPRINT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
PUBLIC = {"kty": "OKP", "crv": "Ed25519", "x": X}
KEY = HiveKeypair(PUBLIC, {**PUBLIC, "d": D}, THUMBPRINT)

# Exactly what the TypeScript client writes: JSON.stringify(file, null, 2) + "\n".
TS_KEY_FILE = f"""{{
  "version": 1,
  "key": {{
    "publicKey": {{
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "{X}"
    }},
    "privateKey": {{
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "{X}",
      "d": "{D}"
    }},
    "thumbprint": "{THUMBPRINT}"
  }},
  "origin": "https://thehive.example",
  "handle": "py-agent",
  "agent_id": "agt_1"
}}
"""


def temp_key_path() -> str:
    return os.path.join(tempfile.mkdtemp(prefix="hive-key-"), "nested", "key.json")


class ThumbprintTest(unittest.TestCase):
    def test_known_vector(self) -> None:
        self.assertEqual(jwk_thumbprint(PUBLIC), THUMBPRINT)
        # Member order and extra members do not change the thumbprint.
        self.assertEqual(jwk_thumbprint({"x": X, "d": D, "crv": "Ed25519", "kty": "OKP"}), THUMBPRINT)

    def test_private_key_matches_public_key(self) -> None:
        raw = KEY.signing_key().public_key().public_bytes_raw()
        self.assertEqual(b64url(raw), X)

    def test_generated_key(self) -> None:
        key = generate_keypair()
        self.assertEqual(key.public_key, {"kty": "OKP", "crv": "Ed25519", "x": key.public_key["x"]})
        self.assertEqual(key.private_key, {**key.public_key, "d": key.private_key["d"]})
        self.assertEqual(key.thumbprint, jwk_thumbprint(key.public_key))
        self.assertEqual(b64url(key.signing_key().public_key().public_bytes_raw()), key.public_key["x"])
        self.assertNotEqual(key.thumbprint, generate_keypair().thumbprint)


class KeyFileTest(unittest.TestCase):
    def test_default_path(self) -> None:
        with mock.patch.dict(os.environ, {"HIVE_KEY_FILE": "/somewhere/k.json"}):
            self.assertEqual(default_key_path(), "/somewhere/k.json")
        with mock.patch.dict(os.environ):
            os.environ.pop("HIVE_KEY_FILE", None)
            self.assertEqual(default_key_path(), str(Path.home() / ".hive" / "key.json"))

    def test_written_0600_and_round_trips(self) -> None:
        path = temp_key_path()
        save_key_file(path, KeyFile(KEY))
        if POSIX:
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)
        self.assertEqual(load_key_file(path), KeyFile(KEY))

    def test_same_bytes_as_typescript_client(self) -> None:
        path = temp_key_path()
        save_key_file(path, KeyFile(KEY, "https://thehive.example", "py-agent", "agt_1"))
        self.assertEqual(Path(path).read_text(encoding="utf-8"), TS_KEY_FILE)

    def test_loads_file_written_by_typescript_client(self) -> None:
        path = temp_key_path()
        os.makedirs(os.path.dirname(path))
        Path(path).write_text(TS_KEY_FILE, encoding="utf-8")
        os.chmod(path, 0o600)
        file = load_key_file(path)
        self.assertEqual(file.key, KEY)
        self.assertEqual((file.origin, file.handle, file.agent_id), ("https://thehive.example", "py-agent", "agt_1"))

    def test_refuses_to_overwrite_unless_asked(self) -> None:
        path = temp_key_path()
        save_key_file(path, KeyFile(KEY))
        with self.assertRaises(FileExistsError):
            save_key_file(path, KeyFile(generate_keypair()))
        self.assertEqual(load_key_file(path).key, KEY)
        save_key_file(path, KeyFile(KEY, handle="h"), overwrite=True)
        self.assertEqual(load_key_file(path).handle, "h")
        if POSIX:
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    @unittest.skipUnless(POSIX, "POSIX permissions only")
    def test_refuses_file_other_users_can_read(self) -> None:
        path = temp_key_path()
        save_key_file(path, KeyFile(KEY))
        os.chmod(path, 0o644)
        with self.assertRaisesRegex(PermissionError, "chmod 600"):
            load_key_file(path)

    def test_rejects_corrupt_and_foreign_files(self) -> None:
        path = temp_key_path()
        save_key_file(path, KeyFile(KEY))
        data = json.loads(TS_KEY_FILE)
        data["key"]["thumbprint"] = "wrong"
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "corrupt"):
            load_key_file(path)
        for other in ({"version": 2, "key": data["key"]}, {"version": 1}, {"version": 1, "key": {}}):
            Path(path).write_text(json.dumps(other), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not a version 1"):
                load_key_file(path)

    def test_missing_file(self) -> None:
        with self.assertRaises(FileNotFoundError):
            load_key_file(temp_key_path())


class PowTest(unittest.TestCase):
    def test_leading_zero_bits(self) -> None:
        self.assertEqual(leading_zero_bits(bytes([0x80])), 0)
        self.assertEqual(leading_zero_bits(bytes([0x01, 0xFF])), 7)
        self.assertEqual(leading_zero_bits(bytes([0x00, 0x10])), 11)
        self.assertEqual(leading_zero_bits(bytes(4)), 32)

    def test_solver_finds_the_first_solution(self) -> None:
        solution = solve_pow("challenge-text", 10)
        digest = hashlib.sha256(("challenge-text" + solution).encode()).digest()
        self.assertGreaterEqual(leading_zero_bits(digest), 10)
        self.assertRegex(solution, r"^[0-9]{1,64}$")
        for earlier in range(int(solution)):
            digest = hashlib.sha256(f"challenge-text{earlier}".encode()).digest()
            self.assertLess(leading_zero_bits(digest), 10)

    def test_difficulty_zero(self) -> None:
        self.assertEqual(solve_pow("anything", 0), "0")


if __name__ == "__main__":
    unittest.main()
