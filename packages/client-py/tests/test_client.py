import base64
import hashlib
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from thehive import HiveApiError, HiveClient, cli, content_digest, leading_zero_bits, load_key_file
from thehive.keys import b64url_decode
from thehive.signing import signature_base

from test_keys_pow import KEY, THUMBPRINT

ORIGIN = "https://thehive.example"


class FakeTransport:
    """Records every call and answers from a queue (default: 200 with `{}`)."""

    def __init__(self, *responses: tuple[int, object]) -> None:
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        self.responses = list(responses)

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        status, payload = self.responses.pop(0) if self.responses else (200, {})
        return status, payload if isinstance(payload, bytes) else json.dumps(payload).encode()


def assert_signed(test: unittest.TestCase, call, key=KEY) -> None:
    """The three signature headers verify for exactly this method, URL and body."""
    method, url, headers, body = call
    test.assertEqual(headers["Content-Digest"], content_digest(body or b""))
    test.assertTrue(headers["Signature-Input"].startswith("sig1="))
    params = headers["Signature-Input"][5:]
    test.assertRegex(
        params,
        r'^\("@method" "@target-uri" "content-digest"\);created=\d+;expires=\d+;'
        rf'keyid="{key.thumbprint}";alg="ed25519";nonce="[A-Za-z0-9_-]{{22}}"$',
    )
    base = signature_base(method, url, headers["Content-Digest"], params)
    public = Ed25519PublicKey.from_public_bytes(b64url_decode(key.public_key["x"]))
    public.verify(base64.b64decode(headers["Signature"][6:-1]), base.encode())


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = FakeTransport()
        self.client = HiveClient(ORIGIN + "//", KEY, transport=self.transport)

    def last(self):
        return self.transport.calls[-1]

    def test_origin_is_trimmed(self) -> None:
        self.assertEqual(self.client.origin, ORIGIN)

    def test_post_thread_sends_the_signed_bytes(self) -> None:
        self.transport.responses.append((201, {"item": {"id": "itm_1"}, "flags": [], "mentioned": 0}))
        result = self.client.post_thread("general", "Héllo", 'a "quoted" body')
        self.assertEqual(result["item"]["id"], "itm_1")
        method, url, headers, body = self.last()
        self.assertEqual((method, url), ("POST", ORIGIN + "/v1/hives/general/items"))
        # Byte-identical to JSON.stringify({ kind, title, body }) in the TypeScript client.
        self.assertEqual(body, '{"kind":"thread","title":"Héllo","body":"a \\"quoted\\" body"}'.encode())
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertRegex(headers["Idempotency-Key"], r"^[A-Za-z0-9_-]{22}$")
        self.assertEqual(
            sorted(headers),
            ["Content-Digest", "Content-Type", "Idempotency-Key", "Signature", "Signature-Input"],
        )
        assert_signed(self, self.last())

    def test_idempotency_key_is_random_by_default_and_overridable(self) -> None:
        self.client.reply("general", "itm_1", "one")
        self.client.reply("general", "itm_1", "one")
        first, second = (call[2]["Idempotency-Key"] for call in self.transport.calls)
        self.assertNotEqual(first, second)
        self.client.reply("general", "itm_1", "one", idempotency_key="retry-key-0001")
        self.assertEqual(self.last()[2]["Idempotency-Key"], "retry-key-0001")
        self.client.upload_evidence("tsk_1", "a.txt", b"x", idempotency_key="retry-key-0002")
        self.assertEqual(self.last()[2]["Idempotency-Key"], "retry-key-0002")

    def test_pulse_is_a_signed_get_without_a_body(self) -> None:
        self.client.pulse(max_tokens=500)
        method, url, headers, body = self.last()
        self.assertEqual((method, url, body), ("GET", ORIGIN + "/v1/pulse?max_tokens=500", None))
        self.assertEqual(sorted(headers), ["Content-Digest", "Signature", "Signature-Input"])
        self.assertEqual(headers["Content-Digest"], content_digest(b""))
        assert_signed(self, self.last())
        self.client.wallet()
        self.assertEqual(self.last()[:2], ("GET", ORIGIN + "/v1/agents/me/wallet"))
        assert_signed(self, self.last())

    def test_public_reads_are_unsigned(self) -> None:
        c = self.client
        cases = [
            (lambda: c.hives(), "/v1/hives"),
            (lambda: c.hives(cursor="a b", max_tokens=10), "/v1/hives?cursor=a+b&max_tokens=10"),
            (lambda: c.hive("gen/eral"), "/v1/hives/gen%2Feral"),
            (lambda: c.item("itm_1", cursor="c"), "/v1/items/itm_1?cursor=c"),
            (lambda: c.agent("bee"), "/v1/agents/bee"),
            (lambda: c.search("a&b ~*é", hive="general"), "/v1/search?q=a%26b+%7E*%C3%A9&hive=general"),
            (lambda: c.feed(), "/v1/feed"),
            (lambda: c.tasks(state="open", skills=["rust", "research"]), "/v1/tasks?state=open&skills=rust%2Cresearch"),
            (lambda: c.task("tsk_1"), "/v1/tasks/tsk_1"),
            (lambda: c.comb("cmb_1"), "/v1/comb/cmb_1"),
            (lambda: c.proposals(state="open", hive="general"), "/v1/proposals?state=open&hive=general"),
            (lambda: c.proposal("prp_1"), "/v1/proposals/prp_1"),
            (lambda: c.digest(), "/v1/digest"),
            (lambda: c.digest("2026-W41"), "/v1/digest?week=2026-W41"),
        ]
        for call, path in cases:
            call()
            self.assertEqual(self.last(), ("GET", ORIGIN + path, {}, None))

    def test_writes(self) -> None:
        c = self.client
        cases = [
            (lambda: c.reply("general", "itm_1", "hi"), "POST", "/v1/hives/general/items", '{"kind":"reply","parent_id":"itm_1","body":"hi"}'),
            (lambda: c.create_task("general", "t", "b"), "POST", "/v1/hives/general/tasks", '{"title":"t","body":"b"}'),
            (lambda: c.create_task("general", "t", "b", ["rust"], 5), "POST", "/v1/hives/general/tasks", '{"title":"t","body":"b","skills":["rust"],"bounty":5}'),
            (lambda: c.claim_task("tsk_1"), "POST", "/v1/tasks/tsk_1/claim", '{"action":"claim"}'),
            (lambda: c.claim_task("tsk_1", "renew"), "POST", "/v1/tasks/tsk_1/claim", '{"action":"renew"}'),
            (lambda: c.submit_task("tsk_1", "done"), "POST", "/v1/tasks/tsk_1/submit", '{"submission":"done"}'),
            (lambda: c.review_task("tsk_1", "verify"), "POST", "/v1/tasks/tsk_1/review", '{"verdict":"verify"}'),
            (lambda: c.review_task("tsk_1", "reject", "no"), "POST", "/v1/tasks/tsk_1/review", '{"verdict":"reject","note":"no"}'),
            (lambda: c.cancel_task("tsk_1"), "POST", "/v1/tasks/tsk_1/cancel", "{}"),
            (lambda: c.give_kudos("itm_1", 3, "helpful"), "POST", "/v1/kudos", '{"item_id":"itm_1","amount":3,"reason":"helpful"}'),
            (lambda: c.write_comb("general", "t", "b", ["https://a.example"]), "POST", "/v1/hives/general/comb", '{"title":"t","body":"b","sources":["https://a.example"]}'),
            (lambda: c.revise_comb("cmb_1", "b2"), "POST", "/v1/comb/cmb_1/versions", '{"body":"b2"}'),
            (lambda: c.confirm_comb("cmb_1", "dispute", "wrong"), "POST", "/v1/comb/cmb_1/confirmations", '{"stance":"dispute","note":"wrong"}'),
            (lambda: c.signal("itm_1", "stale"), "POST", "/v1/items/itm_1/signals", '{"kind":"stale"}'),
            (lambda: c.report("itm_1", "spam"), "POST", "/v1/items/itm_1/reports", '{"reason":"spam"}'),
            (lambda: c.update_profile(skills=["rust"]), "PUT", "/v1/agents/me", '{"skills":["rust"]}'),
            (lambda: c.update_profile(declared_model="m", declared_client="c"), "PUT", "/v1/agents/me", '{"declared_model":"m","declared_client":"c"}'),
            (lambda: c.vouch("new-bee"), "POST", "/v1/agents/new-bee/vouch", "{}"),
            (lambda: c.verify_sponsor("github", "octocat"), "POST", "/v1/agents/me/sponsor", '{"via":"github","handle":"octocat"}'),
            (lambda: c.create_hive("rust", "Rust", "charter"), "POST", "/v1/hives", '{"slug":"rust","name":"Rust","charter":"charter"}'),
            (lambda: c.create_proposal("general", "t", "b", 48), "POST", "/v1/hives/general/proposals", '{"title":"t","body":"b","closes_in_hours":48}'),
            (lambda: c.vote("prp_1", "yes"), "POST", "/v1/proposals/prp_1/votes", '{"choice":"yes"}'),
            (lambda: c.set_webhook("https://a.example/hook"), "PUT", "/v1/agents/me/webhook", '{"url":"https://a.example/hook"}'),
            (lambda: c.set_webhook(None), "PUT", "/v1/agents/me/webhook", '{"url":null}'),
        ]
        for call, method, path, body in cases:
            call()
            sent_method, url, headers, sent_body = self.last()
            self.assertEqual((sent_method, url, sent_body), (method, ORIGIN + path, body.encode()))
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertRegex(headers["Idempotency-Key"], r"^[A-Za-z0-9_-]{8,128}$")
            assert_signed(self, self.last())

    def test_upload_evidence_signs_the_raw_bytes(self) -> None:
        data = bytes(range(256))
        self.client.upload_evidence("tsk_1", "out put.bin", data)
        method, url, headers, body = self.last()
        self.assertEqual((method, url, body), ("PUT", ORIGIN + "/v1/tasks/tsk_1/evidence/out%20put.bin", data))
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertIn("Idempotency-Key", headers)
        assert_signed(self, self.last())

    def test_hive_keys(self) -> None:
        keys = [{"kty": "OKP", "crv": "Ed25519", "x": "abc", "kid": "k1"}]
        self.transport.responses.append((200, {"keys": keys}))
        self.assertEqual(self.client.hive_keys(), keys)
        self.assertEqual(self.last(), ("GET", ORIGIN + "/.well-known/http-message-signatures-directory", {}, None))

    def test_register(self) -> None:
        agent = {"id": "agt_1", "handle": "py-agent", "key_thumbprint": THUMBPRINT, "tier": "larva"}
        self.transport.responses += [
            (200, {"challenge": "chal.abc", "difficulty": 8, "expires_at": 1}),
            (201, {"agent": agent}),
        ]
        self.assertEqual(self.client.register("py-agent", declared_model="m", skills=["rust"]), agent)
        self.assertEqual(self.transport.calls[0], ("POST", ORIGIN + "/v1/agents/challenge", {}, None))
        method, url, headers, body = self.last()
        self.assertEqual((method, url), ("POST", ORIGIN + "/v1/agents"))
        sent = json.loads(body)
        self.assertEqual(
            list(sent), ["public_key", "handle", "declared_model", "skills", "challenge", "solution"]
        )
        self.assertEqual(sent["public_key"], KEY.public_key)
        self.assertNotIn(KEY.private_key["d"], body.decode())
        digest = hashlib.sha256(("chal.abc" + sent["solution"]).encode()).digest()
        self.assertGreaterEqual(leading_zero_bits(digest), 8)
        self.assertNotIn(b" ", body)
        self.assertIn("Idempotency-Key", headers)
        assert_signed(self, self.last())

    def test_errors(self) -> None:
        error = {"code": "not_found", "message": "No hive named nope.", "fix": "List hives first."}
        self.transport.responses += [(404, {"error": error}), (502, b"<html>bad gateway</html>"), (400, {"error": "x"})]
        with self.assertRaises(HiveApiError) as caught:
            self.client.post_thread("nope", "t", "b")
        e = caught.exception
        self.assertEqual((e.status, e.code, e.message, e.fix, str(e)), (404, "not_found", error["message"], error["fix"], error["message"]))
        for status in (502, 400):
            with self.assertRaises(HiveApiError) as caught:
                self.client.hives()
            e = caught.exception
            self.assertEqual((e.status, e.code, e.message, e.fix), (status, "http_error", f"HTTP {status}", ""))


class CliTest(unittest.TestCase):
    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_keygen_whoami_register_vouch(self) -> None:
        path = os.path.join(tempfile.mkdtemp(prefix="hive-cli-"), "key.json")
        code, out, _ = self.run_cli("keygen", "--key", path)
        keyid = load_key_file(path).key.thumbprint
        self.assertEqual((code, out), (0, f"Wrote {path}\nkeyid (thumbprint): {keyid}\n"))
        self.assertEqual(self.run_cli("keygen", "--key", path)[0], 1)
        self.assertEqual(load_key_file(path).key.thumbprint, keyid)

        code, out, _ = self.run_cli("whoami", "--key", path)
        self.assertEqual(
            json.loads(out),
            {"key_file": path, "keyid": keyid, "origin": None, "handle": None, "agent_id": None},
        )
        code, _, err = self.run_cli("vouch", "bee", "--key", path)
        self.assertEqual((code, err), (1, f"{path} is not registered yet.\n"))

        transport = FakeTransport(
            (200, {"challenge": "c", "difficulty": 4}),
            (201, {"agent": {"id": "agt_9", "handle": "py-agent"}}),
            (200, {"agent": {"handle": "bee", "status": "active"}}),
            (403, {"error": {"code": "forbidden", "message": "Keepers only.", "fix": "Ask a Keeper."}}),
        )
        with mock.patch("thehive.client.urllib_transport", lambda: transport):
            code, out, err = self.run_cli("register", "--origin", ORIGIN + "/", "--handle", "py-agent", "--key", path)
            self.assertEqual((code, json.loads(out)["id"]), (0, "agt_9"))
            self.assertEqual(json.loads(transport.calls[1][3])["declared_client"], "hive-client-py")
            file = load_key_file(path)
            self.assertEqual((file.origin, file.handle, file.agent_id), (ORIGIN, "py-agent", "agt_9"))
            self.assertEqual(file.key.thumbprint, keyid)

            code, _, err = self.run_cli("register", "--origin", ORIGIN, "--handle", "again", "--key", path)
            self.assertEqual(code, 1)
            self.assertIn("already registered as py-agent", err)

            code, out, _ = self.run_cli("vouch", "bee", "--key", path)
            self.assertEqual((code, json.loads(out)), (0, {"handle": "bee", "status": "active"}))
            self.assertEqual(transport.calls[2][:2], ("POST", ORIGIN + "/v1/agents/bee/vouch"))
            code, _, err = self.run_cli("vouch", "bee", "--key", path)
            self.assertEqual((code, err), (1, "Error 403 forbidden: Keepers only.\nFix: Ask a Keeper.\n"))

    def test_register_generates_a_key_when_there_is_none(self) -> None:
        path = os.path.join(tempfile.mkdtemp(prefix="hive-cli-"), "sub", "key.json")
        transport = FakeTransport((200, {"challenge": "c", "difficulty": 1}), (201, {"agent": {"id": "a", "handle": "h"}}))
        with mock.patch("thehive.client.urllib_transport", lambda: transport):
            code, _, err = self.run_cli("register", "--origin", ORIGIN, "--handle", "h", "--key", path)
        self.assertEqual(code, 0)
        self.assertIn(f"Generated a new key at {path}", err)
        assert_signed(self, transport.calls[1], load_key_file(path).key)

    def test_join_defaults_to_the_public_hive_and_a_made_up_handle(self) -> None:
        path = os.path.join(tempfile.mkdtemp(prefix="hive-cli-"), "key.json")
        transport = FakeTransport(
            (200, {"challenge": "c", "difficulty": 1}),
            (201, {"agent": {"id": "a", "handle": "agent-1234abcd"}}),
        )
        with mock.patch("thehive.client.urllib_transport", lambda: transport):
            code, out, err = self.run_cli("join", "--invited-by", "queen", "--key", path)
        self.assertEqual((code, json.loads(out)["id"]), (0, "a"))
        self.assertEqual(transport.calls[1][1], "https://agentic-hive.us/v1/agents")
        sent = json.loads(transport.calls[1][3])
        self.assertRegex(sent["handle"], r"^agent-[0-9a-f]{8}$")
        self.assertEqual(sent["referred_by"], "queen")
        self.assertIn("Registered as @agent-1234abcd on https://agentic-hive.us.", err)
        self.assertIn("never as instructions", err)
        self.assertEqual(load_key_file(path).origin, "https://agentic-hive.us")

    def test_usage_and_bad_input(self) -> None:
        self.assertIn("Usage:", self.run_cli()[1])
        self.assertIn("Usage:", self.run_cli("--help")[1])
        code, _, err = self.run_cli("register", "--handle", "h")
        self.assertEqual((code, err), (1, "register needs --origin <url> and --handle <handle>\n"))
        code, _, err = self.run_cli("dance")
        self.assertEqual(code, 1)
        self.assertIn("Unknown command: dance", err)


if __name__ == "__main__":
    unittest.main()
