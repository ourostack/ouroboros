import { spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";
import type { Detour } from "./first-run-detours.ts";
import type { FirstRunSession } from "./first-run-session.ts";
import { system, type System } from "./first-run-system.ts";

// First-run harness: a managed Mac's single sign-on extension, played on a machine the harness owns (a CI runner), beside
// first-run-network's holds. Generic: no app of its own in it.
//
// What the extension does: an MDM profile names an Extensible Enterprise SSO extension of type Redirect for the identity
// provider's URLs. Microsoft's (the Enterprise SSO plug-in, also behind Platform SSO) takes them for Apple and Microsoft
// apps by default (AppPrefixAllowList `com.microsoft.,com.apple.`). WebKit hands a main-frame navigation to those URLs to
// the extension instead of the network, but only for a web view in a window: with none, the navigation waits until one is
// attached (WebKit bug 227729), with no time limit, no network request and no delegate callback. A web view in a window
// gets the extension's answer (a 302 to the app's redirect with a code), its own UI over the app, or the network as usual.
// An app's own network stack never meets it.
//
// A runner has no MDM and no extension, so the stand-in plays the part on the wire: the identity provider's hosts point at
// it (/etc/hosts), its certificate authority is trusted for the run, and it holds every request matching `hold` (the
// silent sign-in, `prompt=none`, which an app runs in a web view no one sees) without ever answering, while every other
// request passes through to the real host unchanged. A connection whose TLS hello offers no ALPN (a client's own stack,
// such as rustls in ureq, never Apple's networking) is passed through untouched. Its one difference from the extension:
// WebKit gives up on a request the stand-in holds after the request's own time limit (60 s by default), where the
// extension's wait has none.
//
// As a process, `node first-run-sso-serve.ts '<json Serve>'` is the stand-in itself. Each stdout line is one event (JSON):
// `ready`, then `held`, `passed` and `failed` with the request's host, method, path and `prompt`, never its other query
// parameters, headers or body (the sign-in's codes and the password pass through here).

/**
 * The requests the extension holds: a path (a regular expression's source) and query parameters that must all match.
 * @claim "The requests the extension holds" scripts/check/first-run-sso.test.mts verify:testExists(scripts/check/first-run-sso.test.mts::first-run harness: a managed Mac's SSO extension > holds a request by its path and every named parameter)
 */
export type HoldRule = { path: string; params?: Record<string, string> };
/** A managed Mac's SSO extension: the identity provider's hosts it takes, and which requests it holds. */
export type SsoExtension = {
  hosts: string[];
  hold: HoldRule;
  /** The longest from the first held request to the app asking the identity provider in the open (a way in). */
  giveWayMs?: number;
};
export type StandInEvent =
  | { ev: "ready"; t: number }
  | { ev: "held" | "passed" | "failed"; t: number; host: string; method: string; path: string; prompt: string | null; status?: number; why?: string };
/** The stand-in's settings: its hosts, holds and certificate, where the hosts really are, and the port it takes. */
export type Serve = { hosts: string[]; hold: HoldRule; key: string; cert: string; upstream: Record<string, string[]>; port: number; upstreamPort?: number; ca?: string };

/** Whether the extension holds `url`. */
export function holds(rule: HoldRule, url: URL): boolean {
  return new RegExp(rule.path).test(url.pathname) && Object.entries(rule.params ?? {}).every(([k, v]) => url.searchParams.get(k) === v);
}

/**
 * The ALPN protocols a TLS ClientHello offers: null while the hello isn't all here yet, [] when it offers none (or isn't
 * a TLS hello at all).
 * @claim "The ALPN protocols a TLS ClientHello offers" scripts/check/first-run-sso.test.mts verify:testExists(scripts/check/first-run-sso.test.mts::first-run harness: a managed Mac's SSO extension > reads a TLS hello's ALPN and server name: Apple's networking offers ALPN, an app's own stack offers none)
 */
export function helloAlpn(b: Buffer): string[] | null {
  if (b.length < 5) return null;
  if (b[0] !== 0x16) return [];
  const end = 5 + b.readUInt16BE(3);
  if (b.length < end) return null;
  let i = 5 + 4 + 2 + 32;
  if (b[5] !== 0x01 || i >= end) return [];
  i += 1 + b[i]!;
  i += 2 + b.readUInt16BE(i);
  i += 1 + b[i]!;
  const extEnd = Math.min(end, i + 2 + b.readUInt16BE(i));
  i += 2;
  while (i + 4 <= extEnd) {
    const type = b.readUInt16BE(i);
    const len = b.readUInt16BE(i + 2);
    if (type === 0x0010) {
      const out: string[] = [];
      for (let j = i + 6; j < i + 4 + len; j += 1 + b[j]!) out.push(b.subarray(j + 1, j + 1 + b[j]!).toString("latin1"));
      return out;
    }
    i += 4 + len;
  }
  return [];
}

const HOP = new Set(["connection", "proxy-connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]);

/**
 * A lookup that answers `host` with the addresses it really has (`upstream`), read before the hosts pointed at the stand-in.
 * @claim "A lookup that answers `host` with" scripts/check/first-run-sso.test.mts verify:testExists(scripts/check/first-run-sso.test.mts::first-run harness: a managed Mac's SSO extension > looks a host up where it really is, one address or all, and fails a host it has none for)
 */
export function upstreamLookup(upstream: Record<string, string[]>, host: string): net.LookupFunction {
  return ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    const ips = upstream[host] ?? [];
    if (!ips.length) return cb(new Error(`no address for ${host}`));
    const list = ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    return o.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
  }) as unknown as net.LookupFunction;
}

/** The stand-in, for this machine's own connections on the port it's given; `emit` hears its events. */
export function serve(c: Serve, emit: (e: StandInEvent) => void): Promise<{ port: number; close: () => void }> {
  const context = tls.createSecureContext({ key: fs.readFileSync(c.key), cert: fs.readFileSync(c.cert) });
  const held = new Set<net.Socket>();

  const inner = http.createServer((req, res) => {
    // A request on the stand-in's own TLS socket, which carries the host its hello named.
    const host = (req.socket as net.Socket & { host: string }).host;
    const url = new URL(req.url!, `https://${host}`);
    const what = { host, method: req.method!, path: url.pathname, prompt: url.searchParams.get("prompt") };
    if (holds(c.hold, url)) {
      // Never answered, as a request the extension keeps waiting is: no response, no error, the connection left open.
      held.add(req.socket);
      req.socket.setTimeout(0);
      emit({ ev: "held", t: Date.now(), ...what });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    const out = https.request({ host, servername: host, port: c.upstreamPort ?? 443, method: req.method, path: req.url, headers, lookup: upstreamLookup(c.upstream, host), ...(c.ca ? { ca: fs.readFileSync(c.ca) } : {}) }, (r) => {
      const raw: string[] = [];
      for (let i = 0; i < r.rawHeaders.length; i += 2) if (!HOP.has(r.rawHeaders[i]!.toLowerCase())) raw.push(r.rawHeaders[i]!, r.rawHeaders[i + 1]!);
      res.writeHead(r.statusCode!, r.statusMessage, raw);
      r.pipe(res);
      emit({ ev: "passed", t: Date.now(), ...what, status: r.statusCode! });
    });
    out.on("error", (e) => {
      emit({ ev: "failed", t: Date.now(), ...what, why: e.message.slice(0, 160) });
      res.destroy();
    });
    req.pipe(out);
  });
  inner.keepAliveTimeout = 0;
  inner.requestTimeout = 0;
  inner.headersTimeout = 0;

  const onConnection = (socket: net.Socket) => {
    let buf = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
    const first = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const alpn = helloAlpn(buf);
      if (alpn === null && buf.length < 65_536) return;
      socket.off("data", first);
      socket.pause();
      const sni = sniOf(buf);
      const host = c.hosts.find((h) => h.toLowerCase() === sni) ?? c.hosts[0]!;
      if (!alpn || alpn.length === 0) {
        // Not Apple's networking: through to the real host, untouched, as the extension never meets it.
        const to = net.connect({ port: c.upstreamPort ?? 443, host: c.upstream[host]?.[0] ?? host });
        to.on("error", () => socket.destroy());
        socket.on("close", () => to.destroy());
        to.write(buf);
        to.pipe(socket);
        socket.pipe(to);
        socket.resume();
        return;
      }
      // The hello already read goes first, through a stream of its own: a TLS socket over the raw socket would miss it.
      const raw = new Duplex({
        read: () => void socket.resume(),
        write: (chunk: Buffer, _e, cb) => void socket.write(chunk, cb),
        final: (cb) => void (socket.end(), cb()),
        destroy: (e, cb) => void (socket.destroy(), cb(e)),
      });
      raw.push(buf);
      socket.on("data", (d: Buffer) => {
        if (!raw.push(d)) socket.pause();
      });
      socket.on("end", () => raw.push(null));
      socket.on("close", () => raw.destroy());
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] }) as tls.TLSSocket & { host?: string };
      secure.host = host;
      secure.on("error", () => socket.destroy());
      inner.emit("connection", secure);
      socket.resume();
    };
    socket.on("data", first);
  };

  // macOS lets a process that isn't root take port 443 only on every address (not on 127.0.0.1 alone), so it listens on
  // all of them and serves only this machine's own connections.
  const server = net.createServer((socket) => (/^(::1|127\.|::ffff:127\.)/.test(String(socket.remoteAddress)) ? onConnection(socket) : socket.destroy()));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::", port: c.port }, () => {
      emit({ ev: "ready", t: Date.now() });
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of held) s.destroy();
          server.close();
          inner.close();
        },
      });
    });
  });
}

/** The server name a TLS ClientHello asks for, lower case, or "". */
export function sniOf(b: Buffer): string {
  if (b.length < 5 || b[0] !== 0x16 || b[5] !== 0x01) return "";
  const end = Math.min(b.length, 5 + b.readUInt16BE(3));
  let i = 5 + 4 + 2 + 32;
  i += 1 + b[i]!;
  i += 2 + b.readUInt16BE(i);
  i += 1 + b[i]!;
  const extEnd = Math.min(end, i + 2 + b.readUInt16BE(i));
  i += 2;
  while (i + 4 <= extEnd) {
    const type = b.readUInt16BE(i);
    const len = b.readUInt16BE(i + 2);
    if (type === 0x0000 && len > 5) return b.subarray(i + 9, i + 9 + b.readUInt16BE(i + 7)).toString("latin1").toLowerCase();
    i += 4 + len;
  }
  return "";
}

const MARK = "# ouro first-run: SSO extension stand-in";
const KEYCHAIN = "/Library/Keychains/System.keychain";
/** The stand-in as a process of its own, which takes the identity provider's port for the run. */
const SERVE = path.join(import.meta.dirname, "first-run-sso-serve.ts");

/**
 * A throwaway certificate authority (`ca.pem`, named `name`) and a leaf for `hosts` signed by it, in `dir`, for two days.
 * @claim "A throwaway certificate authority" registry/ouro/check/first-run-sso.ts verify:fileLine(registry/ouro/check/first-run-sso.ts, /"-sha256", "-days", "2", "-subj"/)
 */
export function makeCerts(dir: string, hosts: string[], name: string, sys: System = system): { ok: boolean; why: string } {
  const sh = (cmd: string, args: string[]) => sys.run(cmd, args, { timeout: 60_000 });
  fs.mkdirSync(dir, { recursive: true });
  const f = (n: string) => path.join(dir, n);
  fs.writeFileSync(f("ca.cnf"), `[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n`);
  fs.writeFileSync(f("leaf.cnf"), `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((h) => `DNS:${h}`).join(",")}\n`);
  const made = [
    sh("openssl", ["req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-subj", `/CN=${name}`, "-config", f("ca.cnf"), "-extensions", "ca", "-keyout", f("ca.key"), "-out", f("ca.pem")]),
    sh("openssl", ["req", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-subj", `/CN=${hosts[0]}`, "-config", f("ca.cnf"), "-keyout", f("leaf.key"), "-out", f("leaf.csr")]),
    sh("openssl", ["x509", "-req", "-sha256", "-days", "2", "-in", f("leaf.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-extfile", f("leaf.cnf"), "-extensions", "leaf", "-out", f("leaf.pem")]),
  ];
  const ok = made.every((r) => r.status === 0);
  if (ok) fs.writeFileSync(f("chain.pem"), fs.readFileSync(f("leaf.pem"), "utf8") + fs.readFileSync(f("ca.pem"), "utf8"));
  return { ok, why: made.map((r) => (r.status === 0 ? "" : r.stderr.trim())).filter(Boolean).join("; ").slice(0, 200) };
}

/**
 * Where the stand-in runs: the machine (its commands), its platform, its hosts file, the port it takes, and where the
 * identity provider's hosts really are (by default, as they resolve before the hosts point at the stand-in).
 */
export type Machine = { sys?: System; platform?: string; hostsFile?: string; port?: number; upstream?: Record<string, string[]>; upstreamPort?: number; ca?: string };

export type StandIn = { ok: boolean; evidence: string; lift: () => void; events: () => (StandInEvent & { at: number })[] };

/**
 * The extension, until lifted: certificates made in `dir` (keep it out of what a run uploads; lifting deletes the keys),
 * the authority trusted by the system, the stand-in started, and the hosts pointed at it. Proved by a read through
 * Apple's networking (NSData, so URLSession) that the stand-in passes. `at` is the session's clock; `log` gets each event.
 * macOS only, and only on a machine the harness owns.
 * @claim "`at` is the session's clock; `log`" scripts/check/first-run-sso.test.mts verify:testExists(scripts/check/first-run-sso.test.mts::first-run harness: a managed Mac's SSO extension > on a made-up Mac > says why it can't play the extension, and changes nothing it didn't put back)
 */
export async function ssoExtension(o: SsoExtension, dir: string, at: () => number, log?: string, m: Machine = {}): Promise<StandIn> {
  const { sys = system, platform = process.platform, hostsFile: HOSTS = "/etc/hosts", port = 443 } = m;
  const sh = (cmd: string, args: string[]) => sys.run(cmd, args, { timeout: 60_000 });
  // Bounded: a command that waits on an authorization dialog no one can answer (a CI runner) gives up rather than hang the run.
  const sudo = (args: string[], input?: string) => sys.run("sudo", ["-n", ...args], input === undefined ? { timeout: 30_000 } : { input, timeout: 30_000 });
  const events: (StandInEvent & { at: number })[] = [];
  const none = (why: string): StandIn => ({ ok: false, evidence: `no SSO extension stand-in: ${why}`, lift: () => {}, events: () => events });
  if (platform !== "darwin") return none("it plays a Mac's extension, and this isn't a Mac");
  const f = (n: string) => path.join(dir, n);
  const name = `Ouro first-run SSO stand-in ${process.pid}-${Date.now()}`;
  const made = makeCerts(dir, o.hosts, name, sys);
  if (!made.ok) return none(`openssl couldn't make its certificates (${made.why})`);
  // The authority's SHA-1, which names the one certificate to take out of the System keychain when the hold lifts.
  const sha1 = sh("openssl", ["x509", "-noout", "-fingerprint", "-sha1", "-in", f("ca.pem")]).stdout.replace(/^[^=]*=|[:\s]/g, "");
  // Where each host really is, read before the hosts point at the stand-in.
  const upstream: Record<string, string[]> = { ...m.upstream };
  for (const h of o.hosts) upstream[h] ??= (await dns.promises.lookup(h, { all: true }).catch(() => [])).map((a) => a.address);

  const offset = Date.now() - at();
  // JSON leaves out the settings the machine doesn't give.
  const config = JSON.stringify({ hosts: o.hosts, hold: o.hold, key: f("leaf.key"), cert: f("chain.pem"), upstream, port, upstreamPort: m.upstreamPort, ca: m.ca });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVE, config], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  const ready = await new Promise<boolean>((resolve) => {
    let buf = "";
    /* node:coverage ignore next -- the stand-in starts in a second or answers with an error; this bounds a hung start */
    const timer = setTimeout(() => resolve(false), 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let k = buf.indexOf("\n"); k >= 0; k = buf.indexOf("\n")) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        // Every line the stand-in writes is an event (first-run-sso-serve.ts).
        const e = JSON.parse(line) as StandInEvent;
        events.push({ ...e, at: e.t - offset });
        if (log) fs.appendFileSync(log, `${JSON.stringify({ ...e, at: e.t - offset })}\n`);
        if (e.ev === "ready") {
          clearTimeout(timer);
          resolve(true);
        }
      }
    });
    // Once its output is all read, so a stand-in that failed to start has said why.
    child.on("close", () => resolve(false));
  });
  if (!ready) {
    child.kill();
    return none(`the stand-in didn't start on port ${port} (${stderr.split("\n").filter((l) => /Error|code:/.test(l)).concat("no message")[0]!.trim()})`);
  }

  const trust = sudo(["security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", KEYCHAIN, f("ca.pem")]);
  const verified = sh("security", ["verify-cert", "-c", f("leaf.pem"), "-p", "ssl", "-s", o.hosts[0]!]).status === 0;
  const before = fs.readFileSync(HOSTS, "utf8");
  const mapped = sudo(["tee", HOSTS], `${before.replace(/\n?$/, "\n")}${MARK}\n${o.hosts.flatMap((h) => [`127.0.0.1 ${h}`, `::1 ${h}`]).join("\n")}\n`).status === 0;
  const flush = () => {
    sudo(["dscacheutil", "-flushcache"]);
    sudo(["killall", "-HUP", "mDNSResponder"]);
  };
  flush();
  const resolves = o.hosts.every((h) => /ip_address: 127\.0\.0\.1/.test(sh("dscacheutil", ["-q", "host", "-a", "name", h]).stdout));
  // Proof that Apple's networking reaches it: a read of the identity provider's root through Foundation (URLSession).
  let routed = false;
  if (verified && resolves) {
    sh("osascript", ["-l", "JavaScript", "-e", `ObjC.import("Foundation"); const d = $.NSData.dataWithContentsOfURL($.NSURL.URLWithString("https://${o.hosts[0]}/")); d.isNil() ? "nothing" : "read " + d.length`]);
    for (let i = 0; i < 20 && !routed; i++) {
      routed = events.some((e) => e.ev === "passed" && e.host === o.hosts[0] && e.path === "/");
      if (!routed) await new Promise((r) => setTimeout(r, 250));
    }
  }
  const lift = () => {
    if (mapped) sudo(["tee", HOSTS], before);
    flush();
    // Out of the System keychain, every copy of it, so nothing trusts it. Removing its admin trust setting too
    // (remove-trusted-cert -d, or delete-certificate -t) waits for an authorization no one can give on a runner; the
    // setting left names a certificate no keychain holds.
    const kept = () => sh("security", ["find-certificate", "-a", "-Z", "-c", name, KEYCHAIN]).stdout.includes(sha1);
    for (let i = 0; i < 5 && kept(); i++) {
      if (i) sh("sleep", ["1"]);
      sudo(["security", "delete-certificate", "-Z", sha1, KEYCHAIN]);
    }
    child.kill();
    for (const k of ["ca.key", "leaf.key"]) fs.rmSync(f(k), { force: true });
  };
  const ok = verified && mapped && resolves && routed;
  const why = !verified
    ? `the system doesn't trust its certificate (add-trusted-cert: ${trust.stderr.trim().slice(0, 160) || "no message"}); run it where sudo -n works, as on a CI runner`
    : !mapped
      ? "it couldn't point the hosts at the stand-in (sudo -n tee /etc/hosts)"
      : !resolves
        ? `${o.hosts.join(", ")} don't resolve to the stand-in after /etc/hosts and a flush`
        : "a read through Apple's networking never reached it";
  if (!ok) lift();
  return {
    ok,
    evidence: ok
      ? `the SSO extension's stand-in takes ${o.hosts.join(", ")} (pointed at it, its certificate trusted for the run, and a read through Apple's networking reached it) and holds ${o.hold.path}${o.hold.params ? ` with ${Object.entries(o.hold.params).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""} unanswered`
      : `no SSO extension stand-in: ${why}`,
    lift: ok ? lift : () => {},
    events: () => events,
  };
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

/**
 * What the stand-in saw, judged: a managed Mac's first run must not hang on the silent sign-in the extension holds. Its
 * first held request must be followed, within `giveWayMs`, by the app asking the identity provider in the open (the
 * same path, not held: its sign-in page, which a person can finish), and the run must have held one at all.
 * @claim "Its first held request must be followed" scripts/check/first-run-sso.test.mts verify:testExists(scripts/check/first-run-sso.test.mts::first-run harness: a managed Mac's SSO extension > the judge: a silent sign-in held for ever with no way in fails, and one that gives way in time passes)
 */
export function judgeHeld(events: (StandInEvent & { at: number })[], rule: HoldRule, giveWayMs: number): { ok: boolean; evidence: string } {
  const held = events.filter((e) => e.ev === "held");
  const first = held[0];
  if (!first) return { ok: false, evidence: "the stand-in never held a silent sign-in, so this run proves nothing about a managed Mac" };
  const asked = events.find((e) => (e.ev === "passed" || e.ev === "failed") && e.at > first.at && new RegExp(rule.path).test(e.path));
  const n = `${held.length} silent sign-in${held.length > 1 ? "s" : ""} held unanswered, the first at ${secs(first.at)} s`;
  if (!asked) return { ok: false, evidence: `${n}; the app never asked for the sign-in page in the open after it, so the silent sign-in never ended and there was no way in` };
  const ms = asked.at - first.at;
  return { ok: ms <= giveWayMs, evidence: `${n}; the app asked for the sign-in page in the open ${secs(ms)} s later (the limit is ${giveWayMs / 1000} s)` };
}

/** A detour whose hold lasts the whole path: `end` lifts it and judges what it saw, after the session's path. */
export type LastingDetour = Detour & { end(s: FirstRunSession): void };

/**
 * The managed-Mac detour: the app opened on a Mac whose SSO extension holds the identity provider's silent sign-in, for
 * the whole path. It must still end signed in and synced, with a way in, and give way from the held sign-in in time.
 */
export function managedMac(o: SsoExtension & { dir: string; log?: string; machine?: Omit<Machine, "sys"> }): LastingDetour {
  let standIn: StandIn | null = null;
  return {
    id: "managed-mac",
    title: "a managed Mac: its SSO extension holds the silent sign-in and never answers it",
    async before(s) {
      standIn = await ssoExtension(o, o.dir, () => s.report.at(), o.log, { ...o.machine, sys: s.sys });
      s.report.step("sso-extension", standIn.ok, standIn.evidence);
      // Held for the whole path, as a managed Mac stays managed: `end` lifts it.
    },
    end(s) {
      if (!standIn?.ok) return;
      standIn.lift();
      const events = standIn.events();
      for (const e of events) if (e.ev !== "ready") s.report.note(`sso-stand-in ${e.ev}`, { at: e.at, host: e.host, method: e.method, path: e.path, prompt: e.prompt, status: e.status, why: e.why });
      const v = judgeHeld(events, o.hold, o.giveWayMs ?? 20_000);
      s.report.step("sso-extension-held", v.ok, v.evidence);
    },
  };
}

