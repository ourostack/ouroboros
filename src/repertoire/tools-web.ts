import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { emitNervesEvent } from "../nerves/runtime"
import { TOOL_MAX_CHARS } from "./tool-limits"
import type { ToolContext, ToolDefinition } from "./tools-base"

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 20_000
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024

function ipv4Private(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function ipv6Groups(ip: string): number[] {
  const [left, right] = ip.split("%")[0].split("::")
  const head = left ? left.split(":") : []
  const tail = right ? right.split(":") : []
  const gap = right === undefined ? [] : Array<string>(8 - head.length - tail.length).fill("0")
  return [...head, ...gap, ...tail].map((p) => parseInt(p, 16))
}

/** True for loopback, private, link-local, CGNAT, multicast and other addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number)
    return ipv4Private(a, b)
  }
  const g = ipv6Groups(ip)
  const embeddedV4 = ipv4Private(g[6] >> 8, g[6] & 255)
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0 || g[5] === 0xffff)) return embeddedV4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return embeddedV4
  return (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole
    const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** Readable text from HTML: the title first, script/style/nav dropped, block tags as line breaks, entities decoded. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|noscript|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|main|pre|blockquote|form)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
  const text = decodeEntities(body).split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
  const heading = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : ""
  return heading ? `${heading}\n\n${text}`.trim() : text
}

/** Refuse a host that is, or resolves to, a non-public address. Returns the reason, or undefined when the host is fine. */
async function refusalForHost(hostname: string): Promise<string | undefined> {
  const host = hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address)
  const bad = addresses.find(isPrivateAddress)
  return bad ? `error: refused: ${hostname} resolves to a private or local address (${bad})` : undefined
}

/** A person in the family circle, not another agent: they may fetch addresses inside the house. */
function isFamilyHuman(ctx?: ToolContext): boolean {
  const friend = ctx?.context?.friend
  return friend?.trustLevel === "family" && !friend.agentMeta
}

async function readCapped(response: Response): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_DOWNLOAD_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  const cut = size >= MAX_DOWNLOAD_BYTES
  if (cut) await reader.cancel()
  return { bytes: Buffer.concat(chunks).subarray(0, MAX_DOWNLOAD_BYTES), cut }
}

async function fetchPage(rawUrl: string, offset: number, exempt: boolean): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `error: not a valid URL: ${rawUrl}`
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return `error: only http and https URLs can be fetched, not ${url.protocol}`
    if (!exempt) {
      const refusal = await refusalForHost(url.hostname)
      if (refusal) return refusal
    }
    const response = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": "ouro-agent/1.0", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } })
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return `error: more than ${MAX_REDIRECTS} redirects fetching ${rawUrl}`
      url = new URL(location, url)
      continue
    }
    if (!response.ok) return `error: HTTP ${response.status} fetching ${url.href}`
    const type = (response.headers.get("content-type") ?? "text/plain").split(";")[0].trim().toLowerCase()
    const isHtml = type === "text/html" || type === "application/xhtml+xml"
    if (!isHtml && !type.startsWith("text/") && !type.includes("json") && !type.endsWith("xml")) return `[content type ${type}; not shown]`
    const { bytes, cut } = await readCapped(response)
    const decoded = new TextDecoder().decode(bytes)
    const text = isHtml ? htmlToText(decoded) : decoded
    const end = Math.min(text.length, offset + TOOL_MAX_CHARS)
    const page = text.slice(offset, end)
    const notes: string[] = []
    if (end < text.length) notes.push(`[characters ${offset}-${end} of ${text.length}; read on with offset=${end}]`)
    if (cut) notes.push("[download cut at 2 MB]")
    emitNervesEvent({ component: "repertoire", event: "repertoire.fetch_url", message: "fetched a web page", meta: { host: url.hostname, status: response.status, chars: text.length, cut } })
    return notes.length > 0 ? `${page}\n${notes.join("\n")}` : page
  }
}

export const webToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Read a web page (http or https) as text; HTML is turned into readable text, and local or private addresses are refused. Shows up to 30,000 characters and tells you the offset to read on from; downloads stop at 2 MB and the request times out after 20 seconds.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            offset: { type: "number", description: "character offset to start from, as given in a read-on notice" },
          },
          required: ["url"],
        },
      },
    },
    handler: async (a, ctx) => {
      try {
        return await fetchPage(a.url, a.offset ? Math.max(0, parseInt(a.offset, 10) || 0) : 0, isFamilyHuman(ctx))
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        return timedOut ? `error: timed out after ${TIMEOUT_MS / 1000} seconds fetching ${a.url}` : `error: could not fetch ${a.url}: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    summaryKeys: ["url"],
  },
]
