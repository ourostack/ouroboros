import { lookup } from "node:dns/promises"
import * as http from "node:http"
import * as https from "node:https"
import { isIP, type LookupFunction } from "node:net"
import { emitNervesEvent } from "../nerves/runtime"
import { TOOL_MAX_CHARS } from "./tool-limits"
import type { ToolContext, ToolDefinition } from "./tools-base"

const MAX_REDIRECTS = 5
/** Test hook: the request deadline. */
export const webTestHooks = { timeoutMs: 20_000 }
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024

function ipv4Private(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
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
    const [a, b, c] = ip.split(".").map(Number)
    return ipv4Private(a, b, c)
  }
  const g = ipv6Groups(ip)
  const embeddedV4 = ipv4Private(g[6] >> 8, g[6] & 255, g[7] >> 8)
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0 || g[5] === 0xffff)) return embeddedV4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return embeddedV4
  return (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00
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

class RefusedError extends Error {
  constructor(hostname: string, address: string) {
    super(`refused: ${hostname} resolves to a private or local address (${address})`)
  }
}

/** A person in the family circle, not an agent: they may fetch addresses inside the house. */
function isFamilyHuman(ctx?: ToolContext): boolean {
  const friend = ctx?.context?.friend
  return friend?.kind === "human" && friend.trustLevel === "family"
}

/** Resolves the name, refuses private addresses, and hands the socket the address that was checked. */
function checkedLookup(exempt: boolean): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true }).then((records) => {
      const bad = exempt ? undefined : records.map((r) => r.address).find(isPrivateAddress)
      if (bad) return callback(new RefusedError(hostname, bad), "", 4)
      if (options.all) return callback(null, records as never)
      return callback(null, records[0].address, records[0].family)
    }, (error: Error) => callback(error, "", 4))
  }
}

function get(url: URL, exempt: boolean, signal: AbortSignal): Promise<http.IncomingMessage> {
  const lib = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: "GET", signal, lookup: checkedLookup(exempt),
      headers: { "user-agent": "ouro-agent/1.0", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    }, resolve)
    req.on("error", reject)
    req.end()
  })
}

async function readCapped(response: http.IncomingMessage): Promise<{ bytes: Buffer; cut: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    chunks.push(chunk as Buffer)
    size += (chunk as Buffer).length
    if (size >= MAX_DOWNLOAD_BYTES) {
      response.destroy()
      break
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, MAX_DOWNLOAD_BYTES), cut: size >= MAX_DOWNLOAD_BYTES }
}

async function fetchPage(rawUrl: string, offset: number, exempt: boolean): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `error: not a valid URL: ${rawUrl}`
  }
  const signal = AbortSignal.timeout(webTestHooks.timeoutMs)
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return `error: only http and https URLs can be fetched, not ${url.protocol}`
    const literal = url.hostname.replace(/^\[|\]$/g, "")
    if (!exempt && isIP(literal) && isPrivateAddress(literal)) return `error: ${new RefusedError(url.hostname, literal).message}`
    const response = await get(url, exempt, signal)
    const status = response.statusCode as number
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.destroy()
      if (hop >= MAX_REDIRECTS) return `error: more than ${MAX_REDIRECTS} redirects fetching ${rawUrl}`
      url = new URL(location, url)
      continue
    }
    if (status === 204) {
      response.destroy()
      return "(no content: HTTP 204)"
    }
    if (status < 200 || status >= 300) {
      response.destroy()
      return `error: HTTP ${status} fetching ${url.href}`
    }
    const type = (response.headers["content-type"] ?? "text/plain").split(";")[0].trim().toLowerCase()
    const isHtml = type === "text/html" || type === "application/xhtml+xml"
    if (!isHtml && !type.startsWith("text/") && !type.includes("json") && !type.endsWith("xml")) {
      response.destroy()
      return `[content type ${type}; not shown]`
    }
    const { bytes, cut } = await readCapped(response)
    const decoded = new TextDecoder().decode(bytes)
    const text = isHtml ? htmlToText(decoded) : decoded
    const end = Math.min(text.length, offset + TOOL_MAX_CHARS)
    const page = text.slice(offset, end)
    const notes: string[] = []
    if (end < text.length) notes.push(`[characters ${offset}-${end} of ${text.length}; read on with offset=${end}]`)
    if (cut) notes.push("[download cut at 2 MB]")
    emitNervesEvent({ component: "repertoire", event: "repertoire.fetch_url", message: "fetched a web page", meta: { host: url.hostname, status, chars: text.length, cut } })
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
        if (error instanceof RefusedError) return `error: ${error.message}`
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        return timedOut ? `error: timed out after ${webTestHooks.timeoutMs / 1000} seconds fetching ${a.url}` : `error: could not fetch ${a.url}: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    summaryKeys: ["url"],
  },
]
