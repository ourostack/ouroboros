// How far the BlueBubbles server's address can be trusted (design §3.4, R3-M3). Fetches put the server password in
// the query string, so the letter answer reader runs only when nobody between the agent and the server can read or
// fake that traffic: the same Mac, an authenticated TLS connection, or a tailnet address, whose WireGuard tunnel does both.
import { emitNervesEvent } from "../../nerves/runtime"

export type BlueBubblesUrlTrust = "loopback" | "tls" | "tailnet" | "untrusted"

/**
 * The tailnet's own address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. This trusts Tailscale to be up: when it
 * is down, 100.64.0.0/10 routes like any carrier-grade NAT address. A MagicDNS name isn't trusted over plain http,
 * since whatever resolver answers when Tailscale is down could point it anywhere; over https it counts as TLS.
 */
function isTailnetHost(host: string): boolean {
  if (/^fd7a:115c:a1e0:/.test(host)) return true
  // new URL() has already written any numeric host as four decimal octets; a name with dots isn't one.
  const octets = host.split(".").map(Number)
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

/** Untrusted for anything but an http or https URL, including one that doesn't parse. */
export function blueBubblesUrlTrust(serverUrl: string): BlueBubblesUrlTrust {
  let url: URL | null = null
  try {
    url = new URL(serverUrl)
  } catch {
    // Judged untrusted below.
  }
  const host = url ? url.hostname.replace(/^\[|\]$/g, "") : ""
  const trust: BlueBubblesUrlTrust =
    url === null || (url.protocol !== "http:" && url.protocol !== "https:") ? "untrusted"
      : host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host) ? "loopback"
        : url.protocol === "https:" ? "tls"
          : isTailnetHost(host) ? "tailnet"
            : "untrusted"
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_url_trust", message: "judged the BlueBubbles server address", meta: { trust } })
  return trust
}
