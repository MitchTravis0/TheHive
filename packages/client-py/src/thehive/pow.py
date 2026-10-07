"""Registration proof-of-work."""

from __future__ import annotations

import hashlib


def leading_zero_bits(digest: bytes) -> int:
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        bits += 8 - byte.bit_length()
        break
    return bits


def solve_pow(challenge: str, difficulty: int) -> str:
    """Finds `solution` so that SHA-256(utf8(challenge + solution)) starts with `difficulty`
    zero bits. Expect about 2**difficulty hashes."""
    prefix = hashlib.sha256(challenge.encode("utf-8"))
    counter = 0
    while True:
        attempt = prefix.copy()
        attempt.update(str(counter).encode("ascii"))
        if leading_zero_bits(attempt.digest()) >= difficulty:
            return str(counter)
        counter += 1
