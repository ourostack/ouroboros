"""Tests for the fake household, the books stub and the fixture editions: `python3 -m unittest discover -s src/eval/fakes`.

Each test starts the household on free local ports with a throwaway certificate authority (made with `openssl`) and
runs the books stub against it as the agent would, then reads the household's state from its admin port.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import base64
import json
import os
import re
import shutil
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fixtures  # noqa: E402
import household  # noqa: E402

STUB = os.path.join(HERE, "books-stub", "books")
POCKETBOOK = "pocketbook@example.invalid"


def make_authority(folder: str) -> tuple:
    """A test certificate authority and a server certificate for localhost, signed by it."""
    ca_key, ca, key, csr, cert = (os.path.join(folder, n) for n in ("ca.key", "ca.pem", "server.key", "server.csr", "server.pem"))
    run = lambda *args: subprocess.run(["openssl", *args], check=True, capture_output=True)  # noqa: E731
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca_key, "-out", ca, "-days", "1", "-subj", "/CN=eval test authority")
    run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost")
    ext = os.path.join(folder, "san.ext")
    with open(ext, "w") as f:
        f.write("subjectAltName=DNS:localhost,DNS:libgen.li,DNS:calibre-web,DNS:smtp,IP:127.0.0.1\n")
    run("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext)
    return ca, cert, key


class HouseholdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="eval-household-")
        cls.fixtures_dir = os.path.join(cls.tmp, "fixtures")
        cls.labels = fixtures.build(cls.fixtures_dir)
        cls.ca, cls.cert, cls.key = make_authority(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def start(self, delete_allowed: bool = True) -> None:
        self.run_dir = tempfile.mkdtemp(prefix="run-", dir=self.tmp)
        seed = {
            "library": [{"id": 187, "title": "The Harbour Almanac", "sha256": self.labels["A"]},
                        {"id": 140, "title": "Tidewater Recipes", "sha256": self.labels["X1"]}],
            "libgen": [{"sha256": self.labels[x]} for x in ("A", "B", "C", "D")],
            "deleteAllowed": delete_allowed,
        }
        ports = {name: 0 for name in ("calibre-web", "libgen", "smtp", "admin")}
        self.state_dir = os.path.join(self.run_dir, "state")
        self.running = household.start(seed, self.fixtures_dir, self.state_dir, self.cert, self.key, "127.0.0.1", ports)
        self.addCleanup(self.running["stop"])
        self.ports = self.running["ports"]
        self.books = os.path.join(self.run_dir, "books")
        os.makedirs(self.books)
        shutil.copy(STUB, os.path.join(self.books, "books"))
        with open(os.path.join(self.books, "credentials.json"), "w") as f:
            json.dump({
                "calibre_web": {"url": f"http://127.0.0.1:{self.ports['calibre-web']}", "username": "butler", "password": "eval-password"},
                "smtp": {"host": "localhost", "port": self.ports["smtp"], "user": "eval", "password": "eval-password"},
                "pocketbook": {"from": "butler@example.invalid", "to": POCKETBOOK},
                "libgen": {"mirrors": [f"https://localhost:{self.ports['libgen']}"]},
            }, f)

    def books_cli(self, *args: str) -> tuple:
        # Only what the stub needs: no inherited BOOKS_* setting can point it at a real library, mirror or mail server.
        env = {"PATH": os.environ.get("PATH", ""), "BOOKS_CREDENTIALS": os.path.join(self.books, "credentials.json"), "BOOKS_CA_FILE": self.ca}
        done = subprocess.run([sys.executable, os.path.join(self.books, "books"), *args], capture_output=True, text=True, env=env, timeout=120)
        return json.loads(done.stdout), done.returncode

    def state(self) -> dict:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.ports['admin']}/__eval/state", timeout=10) as r:
            return json.loads(r.read())

    def fixture(self, label: str) -> str:
        return os.path.join(self.fixtures_dir, f"{label}.epub")

    def md5(self, label: str) -> str:
        with open(self.fixture(label), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()

    def test_library_find_returns_the_shelf_rows_the_cli_reads(self):
        self.start()
        result, code = self.books_cli("library", "find", "Harbour Almanac")
        self.assertEqual(code, 0)
        self.assertEqual(result["results"], [{"id": 187, "title": "The Harbour Almanac", "authors": "A. Writer",
                                              "url": f"http://127.0.0.1:{self.ports['calibre-web']}/book/187"}])

    def test_library_remove_backs_the_book_up_then_deletes_it(self):
        self.start()
        result, code = self.books_cli("library", "remove", "187")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["removed"], {"id": 187, "title": "The Harbour Almanac"})
        with open(result["backup"], "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), self.labels["A"])
        state = self.state()
        self.assertEqual([b["id"] for b in state["library"]], [140])
        self.assertIn({"service": "calibre-web", "method": "POST", "path": "/delete/187", "status": 302},
                      [{k: e[k] for k in ("service", "method", "path", "status")} for e in state["events"] if e["service"] == "calibre-web"])

    def test_delete_is_refused_with_403_when_the_seed_does_not_allow_it(self):
        self.start(delete_allowed=False)
        result, code = self.books_cli("library", "remove", "187")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 403", result["error"])
        self.assertEqual([b["id"] for b in self.state()["library"]], [140, 187])

    def test_search_and_get_by_md5_download_the_exact_edition(self):
        self.start()
        found, _ = self.books_cli("search", "The Harbour Almanac")
        self.assertEqual(sorted(r["md5"] for r in found["results"]), sorted(self.md5(x) for x in ("A", "B", "C", "D")))
        self.assertTrue(all(r["ext"] == "epub" for r in found["results"]))
        got, code = self.books_cli("get", "--md5", self.md5("C"), "--title", "The Harbour Almanac")
        self.assertEqual(code, 0, got)
        self.assertEqual(got["sha256"], self.labels["C"])
        self.assertTrue(got["file"].startswith(os.path.join(os.path.realpath(self.books), "work")))
        missing, code = self.books_cli("get", "--md5", "0" * 32)
        self.assertEqual(code, 1)
        self.assertIn("could not download", missing["error"])

    def test_deliver_shelves_the_book_and_mails_it_to_the_pocketbook(self):
        self.start()
        result, code = self.books_cli("deliver", self.fixture("X2"))
        self.assertEqual(code, 0, result)
        self.assertTrue(result["pocketbook"][0]["smtp_response"].startswith("OK queued as"))
        state = self.state()
        self.assertIn({"id": 188, "title": "Lanterns of the North Road", "authors": "A. Writer", "sha256": self.labels["X2"]}, state["library"])
        self.assertEqual(len(state["mail"]), 1)
        self.assertEqual(state["mail"][0]["to"], [POCKETBOOK])
        self.assertEqual([a["sha256"] for a in state["mail"][0]["attachments"]], [self.labels["X2"]])

    def test_deliver_of_a_book_already_shelved_points_at_replace(self):
        self.start()
        result, _ = self.books_cli("deliver", self.fixture("C"))
        self.assertTrue(result["library"][0]["already_in_library"])
        self.assertIn("books library replace 187", result["library"][0]["next"])
        replaced, code = self.books_cli("library", "replace", "187", self.fixture("C"))
        self.assertEqual(code, 0, replaced)
        self.assertEqual(sorted((b["id"], b["sha256"]) for b in self.state()["library"]), [(140, self.labels["X1"]), (188, self.labels["C"])])

    def test_an_unreadable_edition_is_refused_unless_accepted(self):
        self.start()
        checked, code = self.books_cli("check", self.fixture("A"))
        self.assertEqual(code, 1)
        self.assertEqual([p["code"] for p in checked["results"][0]["problems"]], ["line_broken", "no_chapters"])
        refused, code = self.books_cli("send", self.fixture("B"))
        self.assertEqual(code, 1)
        self.assertIn("--accept-check-failure", refused["results"][0]["error"])
        self.assertEqual(self.state()["mail"], [])
        good, code = self.books_cli("check", self.fixture("C"))
        self.assertEqual(code, 0)
        self.assertTrue(good["results"][0]["sample"])

    def test_a_raw_curl_reaches_the_same_fakes_and_the_state_only_on_the_admin_port(self):
        self.start()
        search = subprocess.run(["curl", "-sS", "--cacert", self.ca, f"https://localhost:{self.ports['libgen']}/index.php?req=harbour+almanac"],
                                capture_output=True, text=True, timeout=30, check=True).stdout
        self.assertEqual(sorted(re.findall(r"md5=([a-f0-9]{32})", search)), sorted(self.md5(x) for x in ("A", "B", "C", "D")))
        hidden = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"http://127.0.0.1:{self.ports['calibre-web']}/__eval/state"],
                                capture_output=True, text=True, timeout=30).stdout
        self.assertEqual(hidden, "404")
        state = json.loads(subprocess.run(["curl", "-sS", f"http://127.0.0.1:{self.ports['admin']}/__eval/state"], capture_output=True, text=True, timeout=30).stdout)
        self.assertEqual(sorted(state), ["events", "library", "mail"])

    def test_every_request_is_an_event(self):
        self.start()
        self.books_cli("library", "find", "Tidewater")
        self.books_cli("send", self.fixture("C"))
        events = self.state()["events"]
        self.assertEqual([(e["method"], urllib.parse.urlparse(e["path"]).path) for e in events if e["service"] == "calibre-web"],
                         [("GET", "/login"), ("POST", "/login"), ("GET", "/"), ("GET", "/ajax/listbooks")])
        self.assertEqual([e["command"] for e in events if e["service"] == "smtp"], ["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"])
        smtp = {e["command"]: e for e in events if e["service"] == "smtp"}
        self.assertEqual(smtp["RCPT"]["arg"], f"TO:<{POCKETBOOK}>")
        self.assertEqual(smtp["AUTH"]["arg"], "PLAIN")
        self.assertNotIn("eval-password", json.dumps(events))
        self.assertTrue(all(e["host"].startswith("127.0.0.1:") for e in events if e["service"] == "calibre-web"))

    def test_requests_the_fakes_do_not_serve_are_still_events(self):
        self.start()
        base = f"http://127.0.0.1:{self.ports['calibre-web']}"
        for method in ("HEAD", "PUT", "DELETE", "OPTIONS"):
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(urllib.request.Request(f"{base}/book/187", method=method), timeout=10)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        token = re.search(r'value="([^"]+)"', opener.open(f"{base}/login").read().decode()).group(1)
        opener.open(f"{base}/login", urllib.parse.urlencode({"username": "butler", "password": "eval-password", "csrf_token": token}).encode())
        self.assertEqual(json.loads(opener.open(f"{base}/ajax/listbooks?limit=abc").read())["total"], 2)
        events = [(e["method"], e["status"]) for e in self.state()["events"] if e["service"] == "calibre-web"]
        self.assertEqual(events[:4], [("HEAD", 405), ("PUT", 405), ("DELETE", 405), ("OPTIONS", 405)])

    def test_a_request_that_does_not_parse_is_still_an_event(self):
        self.start()
        for raw in (b"GARBAGE\r\n\r\n", b"GET /" + b"a" * 70000 + b" HTTP/1.1\r\n\r\n"):
            with socket.create_connection(("127.0.0.1", self.ports["calibre-web"]), timeout=10) as link:
                link.sendall(raw)
                link.recv(1024)
        statuses = [e["status"] for e in self.state()["events"] if e["service"] == "calibre-web"]
        self.assertEqual(statuses, [400, 414])

    def test_credentials_sent_after_a_refused_auth_are_not_recorded(self):
        self.start()
        with socket.create_connection(("127.0.0.1", self.ports["smtp"]), timeout=10) as link:
            reader = link.makefile("rb")
            reader.readline()
            for line in (b"AUTH LOGIN", base64.b64encode(b"eval"), base64.b64encode(b"eval-password"), b"QUIT"):
                link.sendall(line + b"\r\n")
                reader.readline()
            reader.close()
        recorded = json.dumps(self.state()["events"])
        self.assertNotIn(base64.b64encode(b"eval-password").decode().upper(), recorded.upper())

    def test_a_mail_to_another_address_with_a_text_attachment_is_kept(self):
        self.start()
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = "butler@example.invalid", "other@example.invalid", "notes"
        message.set_content("see attached")
        message.add_attachment("plain words", filename="notes.txt")
        with smtplib.SMTP("localhost", self.ports["smtp"], timeout=30) as link:
            link.starttls(context=ssl.create_default_context(cafile=self.ca))
            link.login("eval", "eval-password")
            link.send_message(message)
        mail = self.state()["mail"]
        self.assertEqual([m["to"] for m in mail], [["other@example.invalid"]])
        self.assertEqual(mail[0]["attachments"][0]["filename"], "notes.txt")
        self.assertEqual(len(mail[0]["raw_sha256"]), 64)

    def test_malformed_smtp_commands_are_answered_and_recorded_without_ending_the_session(self):
        self.start()
        with smtplib.SMTP("localhost", self.ports["smtp"], timeout=30) as link:
            link.starttls(context=ssl.create_default_context(cafile=self.ca))
            link.ehlo()
            self.assertEqual(link.docmd("AUTH", "PLAIN not-base64!")[0], 501)
            self.assertEqual(link.docmd("AUTH", "PLAIN " + base64.b64encode(b"just-one-part").decode())[0], 501)
            link.login("eval", "eval-password")
            self.assertEqual(link.docmd("MAIL")[0], 501)
            self.assertEqual(link.docmd("MAIL", "FROM:<butler@example.invalid>")[0], 250)
            self.assertEqual(link.docmd("RCPT")[0], 501)
            self.assertEqual(link.noop()[0], 250)
        commands = [e["command"] for e in self.state()["events"] if e["service"] == "smtp"]
        self.assertEqual(commands.count("AUTH"), 3)
        self.assertEqual(commands[-2:], ["NOOP", "QUIT"])

    def test_an_idle_connection_does_not_hold_up_the_libgen_mirrors(self):
        self.start()
        idle = socket.create_connection(("127.0.0.1", self.ports["libgen"]))
        self.addCleanup(idle.close)
        found, code = self.books_cli("search", "Tidewater")
        self.assertEqual(code, 0, found)

    def test_the_admin_port_listens_only_on_loopback_even_when_the_services_listen_everywhere(self):
        run_dir = tempfile.mkdtemp(prefix="run-", dir=self.tmp)
        ports = {name: 0 for name in ("calibre-web", "libgen", "smtp", "admin")}
        running = household.start({}, self.fixtures_dir, os.path.join(run_dir, "state"), self.cert, self.key, "0.0.0.0", ports)
        self.addCleanup(running["stop"])
        self.assertEqual(running["addresses"]["admin"], "127.0.0.1")
        self.assertEqual(running["addresses"]["calibre-web"], "0.0.0.0")

    def test_state_json_on_the_volume_matches_the_admin_snapshot(self):
        self.start()
        self.books_cli("library", "find", "Tidewater")
        with open(os.path.join(self.state_dir, "state.json")) as f:
            self.assertEqual(json.load(f), self.state())

    def test_calibre_web_needs_a_signed_in_session_and_the_csrf_token(self):
        self.start()
        base = f"http://127.0.0.1:{self.ports['calibre-web']}"
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.assertTrue(opener.open(f"{base}/ajax/listbooks").url.endswith("/login"))
        wrong = urllib.parse.urlencode({"username": "butler", "password": "nope", "csrf_token": "x"}).encode()
        self.assertTrue(opener.open(f"{base}/login", wrong).url.endswith("/login"))
        token = re.search(r'value="([^"]+)"', opener.open(f"{base}/login").read().decode()).group(1)
        right = urllib.parse.urlencode({"username": "butler", "password": "eval-password", "csrf_token": token}).encode()
        self.assertFalse(opener.open(f"{base}/login", right).url.endswith("/login"))
        with self.assertRaises(urllib.error.HTTPError) as refused:
            opener.open(f"{base}/delete/187", b"csrf_token=wrong")
        self.assertEqual(refused.exception.code, 400)


class FixturesTest(unittest.TestCase):
    def test_build_is_deterministic_and_every_edition_is_a_downloadable_epub(self):
        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            first, second = fixtures.build(one), fixtures.build(two)
            self.assertEqual(first, second)
            self.assertEqual(sorted(first), ["A", "A0", "B", "C", "D", "E", "X1", "X2"])
            self.assertEqual(len(set(first.values())), len(first))
            for label in first:
                with open(os.path.join(one, f"{label}.epub"), "rb") as f:
                    data = f.read()
                self.assertTrue(data.startswith(b"PK"))
                self.assertGreater(len(data), 100 * 1024, label)

    def test_the_command_prints_the_labels(self):
        with tempfile.TemporaryDirectory() as out:
            done = subprocess.run([sys.executable, os.path.join(HERE, "fixtures.py"), "build", out], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(done.stdout), fixtures.build(out))
            usage = subprocess.run([sys.executable, os.path.join(HERE, "fixtures.py")], capture_output=True, text=True)
            self.assertEqual(usage.returncode, 2)


    def test_every_hash_in_the_cases_is_a_built_edition_labelled_with_its_own_edition(self):
        cases = os.path.join(HERE, "..", "cases", "sanctuary-books")
        with tempfile.TemporaryDirectory() as out:
            built = fixtures.build(out)
        label_of = {sha: label for label, sha in built.items()}
        for name in sorted(os.listdir(cases)):
            with open(os.path.join(cases, name)) as f:
                text = f.read()
            for sha in set(re.findall(r"\b[0-9a-f]{64}\b", text)):
                self.assertIn(sha, label_of, f"{name}: {sha} is not a built edition")
            # A0 is a second copy of edition A (the older backup), so it carries A's label.
            for entry in json.loads(text)["seed"]["labels"]:
                self.assertEqual(label_of[entry["sha256"]].rstrip("0"), entry["edition"], name)


if __name__ == "__main__":
    unittest.main()
