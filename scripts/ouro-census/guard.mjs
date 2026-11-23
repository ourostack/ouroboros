// Preloaded in the census child with --import: every socket, datagram and fetch may reach loopback or a Unix socket
// only, so importing a product's modules can't touch the network. Anything else throws
// `ax-census: refused a connection to <host>`. It doesn't reach processes the child starts or worker threads; the
// parent's process group kill and empty environment bound those.
import dgram from "node:dgram";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "[::1]"]);

function isLoopback(host) {
  return host === undefined || host === null || host === "" || LOOPBACK.has(host) || (net.isIPv4(host) && host.startsWith("127."));
}

function refuse(host) {
  return new Error(`ax-census: refused a connection to ${host}`);
}

/** The host a Socket#connect, net.connect or tls.connect call would reach, or null for a Unix socket path or fd. */
function hostOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    if (first.path !== undefined || first.fd !== undefined) return null;
    // A custom lookup could turn "localhost" into any address.
    if (typeof first.lookup === "function") return `${first.host ?? "localhost"} (custom lookup)`;
    return first.host ?? first.hostname ?? "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

function wrap(owner, key, hostFrom) {
  const original = owner[key];
  owner[key] = function guarded(...args) {
    const host = hostFrom(args);
    if (host !== null && !isLoopback(host)) throw refuse(host);
    return original.apply(this, args);
  };
}

wrap(net.Socket.prototype, "connect", hostOf);
wrap(net, "connect", hostOf);
wrap(net, "createConnection", hostOf);
wrap(tls, "connect", hostOf);

// dgram: send(msg, [offset, length,] port, [address], [callback]) and connect(port, [address], [callback]).
const datagramHost = (args) => args.slice(1).find((a) => typeof a === "string") ?? "localhost";
wrap(dgram.Socket.prototype, "send", datagramHost);
wrap(dgram.Socket.prototype, "connect", (args) => (typeof args[1] === "string" ? args[1] : "localhost"));

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = new globalThis.URL(typeof input === "string" || input instanceof globalThis.URL ? String(input) : input.url);
    if (!isLoopback(url.hostname)) return Promise.reject(refuse(url.hostname));
    return originalFetch.call(this, input, init);
  };
}

syncBuiltinESMExports();
