#!/usr/bin/env python3
"""The fake household the replay eval's agent container talks to: calibre-web, the libgen mirrors and an SMTP sink.

  household.py --seed <seed.json> --fixtures <dir> --state <dir> --tls-cert <pem> --tls-key <pem> [--host H] [--admin-host H]

It serves only what the books CLI calls, with the shapes it reads:
- calibre-web on 8083: `/login` with a CSRF token, `/`, `/ajax/listbooks`, `/upload`, `/book/<id>`,
  `/download/<id>/epub` and `/delete/<id>` (403 when the seed's `deleteAllowed` is false).
- libgen on 443 over TLS, under any of the mirror names: `/index.php` search results, `/ads.php` and `/get.php`.
- SMTP on 2525 with STARTTLS and AUTH, keeping every message and the SHA-256 of each attachment.
- `GET /__eval/state` on the admin port (8084), returning `{ library, mail, events }`. The admin port listens on
  `--admin-host`, loopback by default, so the agent cannot reach it through the sidecar's network address; the grader
  reads it from inside the sidecar, or reads the same snapshot from `state.json` in `--state`, which is written after
  every change. The other three services answer 404 for it.

Every HTTP request to calibre-web or libgen (any method, including ones that fail) and every SMTP command is an
event, with the Host header or the command's argument (AUTH keeps only its mechanism). Every message is kept with its
envelope and the SHA-256 of its raw bytes before it is parsed. Books are the fixture EPUBs in `--fixtures`, found by
SHA-256; the seed names them by hash. Standard library only, and no outbound connections.
"""
from __future__ import annotations

import argparse
import base64
import email
import email.policy
import hashlib
import html
import http.server
import io
import json
import os
import re
import secrets
import socketserver
import ssl
import threading
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
import zipfile

MAX_MESSAGE_BYTES = 52428800
SMTP_VERBS = {"EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA", "RSET", "NOOP", "QUIT", "VRFY", "EXPN", "HELP"}
OPF = "http://www.idpf.org/2007/opf"
DC = "http://purl.org/dc/elements/1.1/"


def epub_metadata(data: bytes) -> dict:
    """Title and authors from an EPUB's package file, or empty values when it has none."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            rootfile = container.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
            package = ET.fromstring(z.read(rootfile.get("full-path")))
    except (zipfile.BadZipFile, KeyError, ET.ParseError, AttributeError, TypeError):
        return {"title": "", "authors": []}
    title = package.find(f".//{{{DC}}}title")
    return {"title": (title.text or "").strip() if title is not None else "",
            "authors": [(c.text or "").strip() for c in package.findall(f".//{{{DC}}}creator")]}


def _words(text: str) -> list:
    return re.sub(r"[\W_]+", " ", text.lower()).split()


class Household:
    """All state, behind one lock. `snapshot()` is what the host reads back."""

    def __init__(self, seed: dict, fixtures_dir: str, state_dir: str):
        self.lock = threading.Lock()
        self.state_dir = state_dir
        os.makedirs(os.path.join(state_dir, "library"), exist_ok=True)
        self.files = {}
        for name in sorted(os.listdir(fixtures_dir)):
            with open(os.path.join(fixtures_dir, name), "rb") as f:
                data = f.read()
            self.files[hashlib.sha256(data).hexdigest()] = data
        self.delete_allowed = bool(seed.get("deleteAllowed", False))
        login = seed.get("calibreWeb", {})
        self.username = login.get("username", "butler")
        self.password = login.get("password", "eval-password")
        smtp = seed.get("smtp", {})
        self.smtp_user = smtp.get("user", "eval")
        self.smtp_password = smtp.get("password", "eval-password")
        self.csrf = secrets.token_hex(16)
        self.sessions = set()
        self.library = {}
        for book in seed.get("library", []):
            self._shelve(int(book["id"]), self._file(book["sha256"]), book.get("title"))
        self.next_id = max(self.library, default=0) + 1
        self.libgen = {}
        for entry in seed.get("libgen", []):
            data = self._file(entry["sha256"])
            self.libgen[hashlib.md5(data).hexdigest()] = data
        self.mail = []
        self.events = []
        self._save()

    def _file(self, sha256: str) -> bytes:
        if sha256 not in self.files:
            raise ValueError(f"the seed names {sha256}, which is not a fixture")
        return self.files[sha256]

    def _shelve(self, book_id: int, data: bytes, title: str | None = None) -> dict:
        meta = epub_metadata(data)
        with open(os.path.join(self.state_dir, "library", f"{book_id}.epub"), "wb") as f:
            f.write(data)
        book = {"id": book_id, "title": title or meta["title"] or f"book {book_id}", "authors": " & ".join(meta["authors"]),
                "sha256": hashlib.sha256(data).hexdigest()}
        self.library[book_id] = book
        return book

    def _save(self) -> None:
        target = os.path.join(self.state_dir, "state.json")
        with open(f"{target}.tmp", "w") as f:
            json.dump(self.snapshot(), f, indent=1)
        os.replace(f"{target}.tmp", target)

    def snapshot(self) -> dict:
        return {"library": [self.library[k] for k in sorted(self.library)], "mail": list(self.mail), "events": list(self.events)}

    def event(self, **fields) -> None:
        with self.lock:
            self.events.append({"at": round(time.time(), 3), **fields})
            self._save()

    def add_book(self, data: bytes) -> dict:
        with self.lock:
            book = self._shelve(self.next_id, data)
            self.next_id += 1
            self._save()
            return book

    def remove_book(self, book_id: int) -> None:
        with self.lock:
            self.library.pop(book_id)
            os.remove(os.path.join(self.state_dir, "library", f"{book_id}.epub"))
            self._save()

    def books(self) -> list:
        with self.lock:
            return [dict(b) for b in self.library.values()]

    def book(self, book_id: int) -> dict | None:
        with self.lock:
            found = self.library.get(book_id)
            return dict(found) if found else None

    def book_bytes(self, book_id: int) -> bytes:
        with open(os.path.join(self.state_dir, "library", f"{book_id}.epub"), "rb") as f:
            return f.read()

    def receive(self, sender: str, recipients: list, raw: bytes) -> str:
        """Keeps the envelope and the raw message's hash first, so a message that does not parse is still on record."""
        queued = str(uuid.uuid4())
        entry = {"id": queued, "from": sender, "to": list(recipients), "raw_sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                 "subject": "", "attachments": []}
        try:
            message = email.message_from_bytes(raw, policy=email.policy.default)
            entry["subject"] = str(message.get("Subject", ""))
            for part in message.iter_attachments():
                payload = part.get_payload(decode=True) or b""
                entry["attachments"].append({"filename": part.get_filename(), "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)})
        except Exception as problem:  # noqa: BLE001 - the envelope is already kept; note why the body was not read
            entry["parse_error"] = f"{type(problem).__name__}: {problem}"
        with self.lock:
            self.mail.append(entry)
            self._save()
        return queued


class _Handler(http.server.BaseHTTPRequestHandler):
    household: Household
    service = ""
    protocol_version = "HTTP/1.1"
    timeout = 30

    def log_message(self, format, *args):  # noqa: A002 - the base class's name; events replace the log
        pass

    def record(self, status: int) -> None:
        # A request that failed to parse has no command, path or headers yet; its raw first line stands in.
        raw = (getattr(self, "raw_requestline", b"") or b"")[:200].decode("latin-1").strip()
        headers = getattr(self, "headers", None)
        self.household.event(service=self.service, method=getattr(self, "command", None), path=getattr(self, "path", raw), status=status,
                             host=headers.get("Host", "") if headers else "")

    def send(self, status: int, body: bytes = b"", content_type: str = "text/html; charset=utf-8", headers: dict | None = None) -> None:
        # The event is recorded (and state.json written) before any byte is sent, so a client that has the response can
        # never read a state that lacks the request it just made.
        self.record(status)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        """A malformed request line or an unsupported method is answered by the base class; it is still an event."""
        self.record(code)
        super().send_error(code, message, explain)

    def run(self, handler) -> None:
        try:
            handler()
        except Exception:  # noqa: BLE001 - a fault in the fake is a 500 the grader can see, never a silent drop
            self.close_connection = True
            self.send(500, b"internal error")

    def do_GET(self):  # noqa: N802 - http.server's name
        self.run(self.get)

    def do_POST(self):  # noqa: N802
        self.run(self.post)

    def get(self) -> None:
        self.send(405, b"method not allowed")

    def post(self) -> None:
        self.send(405, b"method not allowed")

    def refuse(self) -> None:
        self.send(405, b"method not allowed")

    do_HEAD = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = refuse

    def redirect(self, location: str, headers: dict | None = None) -> None:
        self.send(302, b"", headers={"Location": location, **(headers or {})})

    def body(self) -> bytes:
        return self.rfile.read(max(0, int(self.headers.get("Content-Length") or 0)))

    def form(self, raw: bytes) -> dict:
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode("utf-8", "replace")).items()}


class CalibreWebHandler(_Handler):
    service = "calibre-web"

    def _page(self, inner: str) -> bytes:
        return (f'<html><head><title>calibre-web</title></head><body><form><input type="hidden" name="csrf_token" '
                f'value="{self.household.csrf}"></form>{inner}</body></html>').encode()

    def _signed_in(self) -> bool:
        cookie = self.headers.get("Cookie", "")
        return any(part.strip().removeprefix("session=") in self.household.sessions for part in cookie.split(";") if part.strip().startswith("session="))

    def _csrf_ok(self, form: dict) -> bool:
        return self.headers.get("X-CSRFToken") == self.household.csrf or form.get("csrf_token") == self.household.csrf

    def get(self) -> None:
        url = urllib.parse.urlparse(self.path)
        if url.path == "/login":
            return self.send(200, self._page('<form method="post" action="/login"></form>'))
        if url.path.startswith("/__eval"):
            return self.send(404, b"not found")
        if not self._signed_in():
            return self.redirect("/login")
        if url.path == "/":
            return self.send(200, self._page("<h1>Library</h1>"))
        if url.path == "/ajax/listbooks":
            query = urllib.parse.parse_qs(url.query)
            terms = _words(query.get("search", [""])[0])
            limit = int(query["limit"][0]) if query.get("limit", [""])[0].isdigit() else 20
            shelf = self.household.books()
            books = [b for b in sorted(shelf, key=lambda b: -b["id"]) if all(t in _words(f"{b['title']} {b['authors']}") for t in terms)]
            rows = [{"id": b["id"], "title": b["title"], "authors": b["authors"], "series": "", "series_index": "1.0", "tags": ""}
                    for b in books[:limit]]
            body = json.dumps({"totalNotFiltered": len(shelf), "total": len(books), "rows": rows}).encode()
            return self.send(200, body, "application/json")
        match = re.fullmatch(r"/book/(\d+)", url.path)
        if match:
            book = self.household.book(int(match.group(1)))
            if not book:
                return self.send(404, b"no such book")
            return self.send(200, self._page(f'<h2 id="title">{html.escape(book["title"])}</h2><p class="author">{html.escape(book["authors"])}</p>'
                                             f'<a href="/download/{book["id"]}/epub">EPUB</a>'))
        match = re.fullmatch(r"/download/(\d+)/epub", url.path)
        if match and self.household.book(int(match.group(1))):
            return self.send(200, self.household.book_bytes(int(match.group(1))), "application/epub+zip")
        return self.send(404, b"not found")

    def post(self) -> None:
        url = urllib.parse.urlparse(self.path)
        raw = self.body()
        if url.path == "/login":
            form = self.form(raw)
            if self._csrf_ok(form) and form.get("username") == self.household.username and form.get("password") == self.household.password:
                token = secrets.token_hex(16)
                self.household.sessions.add(token)
                return self.redirect("/", {"Set-Cookie": f"session={token}; Path=/; HttpOnly"})
            return self.redirect("/login")
        if not self._signed_in():
            return self.redirect("/login")
        if url.path == "/upload":
            parsed = email.message_from_bytes(f"Content-Type: {self.headers.get('Content-Type')}\r\n\r\n".encode() + raw, policy=email.policy.HTTP)
            parts = {p.get_param("name", header="content-disposition"): p for p in parsed.iter_parts()} if parsed.is_multipart() else {}
            token = parts["csrf_token"].get_payload(decode=True).decode("utf-8", "replace").strip() if "csrf_token" in parts else ""
            if not self._csrf_ok({"csrf_token": token}):
                return self.send(400, b"bad csrf token")
            upload = parts.get("btn-upload")
            data = (upload.get_payload(decode=True) or b"") if upload is not None else b""
            if data[:2] != b"PK":
                return self.send(200, json.dumps({"location": "/"}).encode(), "application/json")
            book = self.household.add_book(data)
            return self.send(200, json.dumps({"location": f"/book/{book['id']}"}).encode(), "application/json")
        match = re.fullmatch(r"/delete/(\d+)", url.path)
        if match:
            if not self._csrf_ok(self.form(raw)):
                return self.send(400, b"bad csrf token")
            if not self.household.delete_allowed:
                return self.send(403, b"forbidden")
            if self.household.book(int(match.group(1))):
                self.household.remove_book(int(match.group(1)))
            return self.redirect("/")
        return self.send(404, b"not found")


class LibgenHandler(_Handler):
    service = "libgen"

    @staticmethod
    def _key(md5: str) -> str:
        return hashlib.sha256(f"mirror-key:{md5}".encode()).hexdigest()[:16].upper()

    def get(self) -> None:
        url = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path in ("/", "/index.php"):
            terms = _words(query.get("req", ""))
            rows = []
            for n, (md5, data) in enumerate(sorted(self.household.libgen.items()), start=1):
                meta = epub_metadata(data)
                author = " & ".join(meta["authors"])
                if not terms or not all(t in _words(f"{meta['title']} {author}") for t in terms):
                    continue
                rows.append(f'<tr><td><a href="edition.php?id={n}">{html.escape(meta["title"])}</a></td><td>{html.escape(author)}</td>'
                            f"<td>Northsea Books</td><td>2020</td><td>English</td><td>200</td><td>{len(data) // 1024} kB</td><td>epub</td>"
                            f'<td><a href="/ads.php?md5={md5}">[1]</a></td></tr>')
            page = '<html><body><table id="tablelibgen"><tr><th>Title</th></tr>' + "".join(rows) + "</table></body></html>"
            return self.send(200, page.encode())
        md5 = query.get("md5", "")
        if md5 not in self.household.libgen:
            return self.send(404, b"not found")
        if url.path == "/ads.php":
            return self.send(200, f'<html><body><a href="get.php?md5={md5}&key={self._key(md5)}">GET</a></body></html>'.encode())
        if url.path == "/get.php" and query.get("key") == self._key(md5):
            return self.send(200, self.household.libgen[md5], "application/epub+zip")
        return self.send(403, b"forbidden")


class AdminHandler(_Handler):
    service = "admin"

    def record(self, status: int) -> None:
        """Reading the state back is the grader's, not the agent's, so it is not an event."""

    def get(self) -> None:
        if self.path != "/__eval/state":
            return self.send(404, b"not found")
        with self.household.lock:
            body = json.dumps(self.household.snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SmtpHandler(socketserver.StreamRequestHandler):
    """Enough SMTP for smtplib: EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET, NOOP and QUIT."""

    household: Household
    tls: ssl.SSLContext

    def reply(self, line: str) -> None:
        self.wfile.write(f"{line}\r\n".encode())
        self.wfile.flush()

    def readline(self) -> str:
        return self.rfile.readline(65536).decode("utf-8", "replace").rstrip("\r\n")

    def finish(self):
        super().finish()
        self.connection.close()

    def handle(self):
        self.connection.settimeout(60)
        self.reply("220 smtp ESMTP service ready")
        self.secure = self.authed = False
        self.sender, self.recipients = None, []
        while True:
            try:
                line = self.readline()
            except (OSError, ssl.SSLError):
                return
            verb, _, arg = line.partition(" ")
            verb = verb.upper()
            if not verb:
                return
            # AUTH keeps only its mechanism, and a line that is no command may be a credential sent after a refused AUTH.
            known = verb in SMTP_VERBS
            self.household.event(service="smtp", command=verb if known else "<unrecognised>",
                                 arg=(arg.split(" ")[0] if verb == "AUTH" else arg) if known else "")
            try:
                if self.command(verb, arg) == "quit":
                    return
            except (OSError, ssl.SSLError):
                return
            except Exception:  # noqa: BLE001 - a fault in the fake is answered, and the session goes on
                self.reply("451 local error in processing")

    def command(self, verb: str, arg: str) -> str | None:
        if verb in ("EHLO", "HELO"):
            self.wfile.write(b"250-smtp\r\n" + (b"250-AUTH PLAIN LOGIN\r\n" if self.secure else b"250-STARTTLS\r\n") + b"250 SIZE 52428800\r\n")
            self.wfile.flush()
        elif verb == "STARTTLS" and not self.secure:
            self.reply("220 ready to start TLS")
            self.connection = self.tls.wrap_socket(self.connection, server_side=True)
            self.rfile = self.connection.makefile("rb")
            self.wfile = self.connection.makefile("wb")
            self.secure = True
        elif verb == "AUTH" and self.secure:
            credentials = self.credentials(arg)
            if credentials is None:
                return None
            self.authed = credentials == (self.household.smtp_user, self.household.smtp_password)
            self.reply("235 authentication succeeded" if self.authed else "535 authentication failed")
        elif verb == "MAIL":
            if not self.authed:
                self.reply("530 authentication required")
                return None
            address = self.address(arg, "FROM")
            if address is None:
                return None
            self.sender, self.recipients = address, []
            self.reply("250 OK")
        elif verb == "RCPT" and self.sender is not None:
            address = self.address(arg, "TO")
            if address is None:
                return None
            self.recipients.append(address)
            self.reply("250 OK")
        elif verb == "DATA" and self.recipients:
            self.reply("354 end data with <CR><LF>.<CR><LF>")
            lines, size = [], 0
            while True:
                raw = self.rfile.readline(1 << 20)
                if raw in (b".\r\n", b".\n", b""):
                    break
                size += len(raw)
                if size <= MAX_MESSAGE_BYTES:
                    lines.append(raw[1:] if raw.startswith(b"..") else raw)
            if size > MAX_MESSAGE_BYTES:
                self.reply("552 message exceeds the size limit")
            else:
                queued = self.household.receive(self.sender, self.recipients, b"".join(lines))
                self.reply(f"250 OK queued as {queued}")
            self.sender, self.recipients = None, []
        elif verb == "RSET":
            self.sender, self.recipients = None, []
            self.reply("250 OK")
        elif verb == "NOOP":
            self.reply("250 OK")
        elif verb == "QUIT":
            self.reply("221 bye")
            return "quit"
        else:
            self.reply("503 bad sequence of commands")
        return None

    def credentials(self, arg: str) -> tuple | None:
        """(user, password) from AUTH PLAIN or LOGIN, or None after answering a malformed or unknown request."""
        method, _, initial = arg.partition(" ")
        try:
            if method.upper() == "PLAIN":
                if not initial:
                    self.reply("334 ")
                    initial = self.readline()
                parts = base64.b64decode(initial, validate=True).decode("utf-8", "replace").split("\0")
                if len(parts) != 3:
                    raise ValueError("AUTH PLAIN needs three parts")
                return parts[1], parts[2]
            if method.upper() == "LOGIN":
                self.reply("334 VXNlcm5hbWU6")
                user = base64.b64decode(self.readline(), validate=True).decode("utf-8", "replace")
                self.reply("334 UGFzc3dvcmQ6")
                return user, base64.b64decode(self.readline(), validate=True).decode("utf-8", "replace")
        except ValueError:
            self.reply("501 malformed authentication")
            return None
        self.reply("504 unrecognised authentication type")
        return None

    def address(self, arg: str, keyword: str) -> str | None:
        found = re.match(rf"{keyword}:\s*<?([^>\s]*)>?", arg, flags=re.I)
        if found is None or not found.group(1):
            self.reply(f"501 syntax: {'MAIL FROM' if keyword == 'FROM' else 'RCPT TO'}:<address>")
            return None
        return found.group(1)


class _ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


class _TLSHTTPServer(_ThreadingHTTPServer):
    """TLS per connection, in that connection's own thread, so one silent client cannot hold up the listener."""

    tls: ssl.SSLContext

    def finish_request(self, request, client_address):
        request.settimeout(30)
        try:
            request = self.tls.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            request.close()
            return
        try:
            super().finish_request(request, client_address)
        finally:
            request.close()


class _ThreadingTCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(seed: dict, fixtures_dir: str, state_dir: str, tls_cert: str, tls_key: str, host: str = "0.0.0.0",
          ports: dict | None = None, admin_host: str = "127.0.0.1") -> dict:
    """Start every service on its own thread. Returns the household, the bound ports and addresses, and `stop`."""
    ports = {"calibre-web": 8083, "libgen": 443, "smtp": 2525, "admin": 8084, **(ports or {})}
    household = Household(seed, fixtures_dir, state_dir)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(tls_cert, tls_key)

    def handler(base, **extra):
        return type(base.__name__, (base,), {"household": household, **extra})

    plan = {
        "calibre-web": (_ThreadingHTTPServer, host, handler(CalibreWebHandler)),
        "libgen": (type("_LibgenServer", (_TLSHTTPServer,), {"tls": tls}), host, handler(LibgenHandler)),
        "smtp": (_ThreadingTCPServer, host, handler(SmtpHandler, tls=tls)),
        "admin": (_ThreadingHTTPServer, admin_host, handler(AdminHandler)),
    }
    servers = {}
    try:
        for name, (server_class, address, handler_class) in plan.items():
            servers[name] = server_class((address, ports[name]), handler_class)
    except OSError:
        for server in servers.values():
            server.server_close()
        raise
    for server in servers.values():
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def stop() -> None:
        for server in servers.values():
            server.shutdown()
            server.server_close()

    return {"household": household, "ports": {name: s.server_address[1] for name, s in servers.items()},
            "addresses": {name: s.server_address[0] for name, s in servers.items()}, "stop": stop}


def main() -> None:
    parser = argparse.ArgumentParser(prog="household.py")
    parser.add_argument("--seed", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--tls-cert", required=True)
    parser.add_argument("--tls-key", required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--admin-host", default="127.0.0.1")
    a = parser.parse_args()
    with open(a.seed) as f:
        seed = json.load(f)
    running = start(seed, a.fixtures, a.state, a.tls_cert, a.tls_key, a.host, admin_host=a.admin_host)
    print(json.dumps({"ready": True, "ports": running["ports"]}), flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
