import * as http from "node:http"
import * as https from "node:https"
import * as path from "node:path"
import * as zlib from "node:zlib"
import { createHash, timingSafeEqual } from "node:crypto"
import { pipeline } from "node:stream"
import { emitNervesEvent } from "../nerves/runtime"
import { loadGatewayKeys, loadGatewayState, saveGatewayState, type GatewayState, type GatewayUpstreamKey } from "./keys"

export const GATEWAY_DEFAULT_HOST = "127.0.0.1"
export const GATEWAY_DEFAULT_PORT = 8787
export const GATEWAY_DEFAULT_UPSTREAM = "https://api.anthropic.com"
export const GATEWAY_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
export const GATEWAY_MAX_REQUEST_BYTES = 32 * 1024 * 1024

const CREDIT_LOW_PHRASE = "credit balance is too low"
const CREDIT_CHECK_STATUSES = new Set([400, 402, 403])
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export interface CreditGatewayOptions {
  keysDir: string
  /** Defaults to `<keysDir>/gateway-state.json`. */
  statePath?: string
  host?: string
  /** 0 picks a free port. */
  port?: number
  upstream?: string
  cooldownMs?: number
  maxRequestBytes?: number
  now?: () => number
  /** One line per request and per skipped key. Defaults to stderr so `docker logs` shows it. */
  log?: (line: string) => void
}

export interface CreditGatewayHandle {
  server: http.Server
  url: string
  port: number
  close(): Promise<void>
}

export interface GatewayServeCommand {
  keysDir: string
  host?: string
  port?: number
  statePath?: string
  upstream?: string
  cooldownMinutes?: number
}

interface BufferedResponse {
  status: number
  headers: http.OutgoingHttpHeaders
  body: Buffer
}

class RequestTooLargeError extends Error {}

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } })
}

/* v8 ignore start -- defensive: Node and the HTTP stack always throw Error instances @preserve */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* v8 ignore stop */

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/** Compares digests so the comparison takes the same time whatever the presented key's length. */
function matchesMasterKey(presented: string | undefined, masterDigest: Buffer): boolean {
  if (!presented) return false
  return timingSafeEqual(digest(presented), masterDigest)
}

function presentedKey(req: http.IncomingMessage): string | undefined {
  const apiKey = req.headers["x-api-key"]
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")
  return bearer ? bearer[1].trim() : undefined
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new RequestTooLargeError())
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function readAll(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
  })
}

function forwardedRequestHeaders(req: http.IncomingMessage, upstreamKey: string, bodyLength: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || name === "host" || name === "content-length" || name === "x-api-key" || name === "authorization") continue
    headers[name] = value
  }
  headers["x-api-key"] = upstreamKey
  if (bodyLength > 0) headers["content-length"] = String(bodyLength)
  return headers
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    result[name] = value
  }
  return result
}

/** Decodes a compressed body for inspection only; the client still gets the original bytes. */
function decodeForInspection(body: Buffer, encoding: string | undefined): string {
  try {
    const normalized = (encoding ?? "").trim().toLowerCase()
    if (normalized === "gzip" || normalized === "x-gzip") return zlib.gunzipSync(body).toString("utf8")
    if (normalized === "deflate") return zlib.inflateSync(body).toString("utf8")
    if (normalized === "br") return zlib.brotliDecompressSync(body).toString("utf8")
    return body.toString("utf8")
  } catch {
    return body.toString("utf8")
  }
}

export function isCreditExhaustedBody(body: Buffer, encoding?: string): boolean {
  return decodeForInspection(body, encoding).toLowerCase().includes(CREDIT_LOW_PHRASE)
}

function upstreamUrl(base: URL, requestUrl: string): URL {
  const prefix = base.pathname.replace(/\/+$/, "")
  return new URL(`${prefix}${requestUrl}`, base.origin)
}

function sendUpstream(target: URL, method: string, headers: http.OutgoingHttpHeaders, body: Buffer): Promise<{ response: http.IncomingMessage; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http
    const request = transport.request(target, { method, headers }, (response) => resolve({ response, request }))
    request.on("error", reject)
    request.end(body.length > 0 ? body : undefined)
  })
}

function writeBuffered(res: http.ServerResponse, buffered: BufferedResponse): void {
  res.writeHead(buffered.status, { ...buffered.headers, "content-length": String(buffered.body.length) })
  res.end(buffered.body)
}

function writeJsonError(res: http.ServerResponse, status: number, type: string, message: string): void {
  const body = Buffer.from(anthropicError(type, message))
  writeBuffered(res, { status, headers: { "content-type": "application/json" }, body })
}

/** Maps `ouro gateway serve` flags to gateway options. */
export function creditGatewayOptionsFromCli(command: GatewayServeCommand): CreditGatewayOptions {
  return {
    keysDir: command.keysDir,
    ...(command.statePath ? { statePath: command.statePath } : {}),
    ...(command.host ? { host: command.host } : {}),
    ...(command.port !== undefined ? { port: command.port } : {}),
    ...(command.upstream ? { upstream: command.upstream } : {}),
    ...(command.cooldownMinutes !== undefined ? { cooldownMs: command.cooldownMinutes * 60 * 1000 } : {}),
  }
}

/* v8 ignore start -- the default log writes to the real stderr; tests inject log @preserve */
function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`)
}
/* v8 ignore stop */

/**
 * Starts the credit gateway: a byte-passthrough proxy to the Anthropic API that accepts one master key
 * and spends the upstream keys in a fixed order, moving to the next key only when the current one
 * reports that its credit balance is too low.
 */
export async function startCreditGateway(options: CreditGatewayOptions): Promise<CreditGatewayHandle> {
  const keys = loadGatewayKeys(options.keysDir)
  const statePath = options.statePath ?? path.join(options.keysDir, "gateway-state.json")
  const state: GatewayState = loadGatewayState(statePath)
  const host = options.host ?? GATEWAY_DEFAULT_HOST
  const upstreamBase = new URL(options.upstream ?? GATEWAY_DEFAULT_UPSTREAM)
  const cooldownMs = options.cooldownMs ?? GATEWAY_DEFAULT_COOLDOWN_MS
  const maxRequestBytes = options.maxRequestBytes ?? GATEWAY_MAX_REQUEST_BYTES
  const now = options.now ?? Date.now
  const log = options.log ?? defaultLog
  const masterDigest = digest(keys.masterKey)

  function persist(): void {
    try {
      saveGatewayState(statePath, state)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "gateway",
        event: "gateway.state_save_error",
        message: "credit gateway could not save its state",
        meta: { statePath, error: errorMessage(error) },
      })
    }
  }

  /** Returns the skip-until time for a label, or undefined when the key is usable. Expired entries are dropped. */
  function skipUntil(label: string): string | undefined {
    const until = state.exhausted[label]
    if (!until) return undefined
    if (Date.parse(until) > now()) return until
    delete state.exhausted[label]
    persist()
    return undefined
  }

  function markExhausted(entry: GatewayUpstreamKey): void {
    state.exhausted[entry.label] = new Date(now() + cooldownMs).toISOString()
    persist()
    log(`gateway: ${entry.label} out of credits; moving on`)
    emitNervesEvent({
      level: "warn",
      component: "gateway",
      event: "gateway.key_exhausted",
      message: "credit gateway key is out of credits",
      meta: { label: entry.label, skipUntil: state.exhausted[entry.label] },
    })
  }

  function logRequest(label: string, method: string, pathname: string, status: number, startedAt: number): void {
    const ms = now() - startedAt
    log(`gateway: ${label} ${method} ${pathname} ${status} ${ms}ms`)
    emitNervesEvent({
      component: "gateway",
      event: "gateway.request",
      message: "credit gateway request",
      meta: { label, method, path: pathname, status, ms },
    })
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = now()
    /* v8 ignore start -- Node always supplies url and method for accepted HTTP requests @preserve */
    const requestUrl = req.url ?? "/"
    const method = req.method ?? "GET"
    /* v8 ignore stop */
    const pathname = new URL(requestUrl, "http://gateway.local").pathname

    if (method === "GET" && pathname === "/health") {
      const body = JSON.stringify({
        ok: true,
        keys: keys.upstream.map((entry) => {
          const until = skipUntil(entry.label)
          return until ? { label: entry.label, available: false, skipUntil: until } : { label: entry.label, available: true }
        }),
      })
      writeBuffered(res, { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) })
      logRequest("-", method, pathname, 200, startedAt)
      return
    }

    if (!matchesMasterKey(presentedKey(req), masterDigest)) {
      writeJsonError(res, 401, "authentication_error", "invalid x-api-key")
      logRequest("-", method, pathname, 401, startedAt)
      return
    }

    let body: Buffer
    try {
      body = await readRequestBody(req, maxRequestBytes)
    } catch (error) {
      /* v8 ignore start -- the client went away while sending its body; there is no one to answer @preserve */
      if (!(error instanceof RequestTooLargeError)) {
        res.destroy()
        return
      }
      /* v8 ignore stop */
      res.setHeader("connection", "close")
      writeJsonError(res, 413, "request_too_large", `request body exceeds ${maxRequestBytes} bytes`)
      logRequest("-", method, pathname, 413, startedAt)
      return
    }

    let lastCredit: BufferedResponse | undefined
    let lastCreditLabel = "-"
    for (const entry of keys.upstream) {
      if (skipUntil(entry.label)) continue
      let upstream: { response: http.IncomingMessage; request: http.ClientRequest }
      try {
        upstream = await sendUpstream(upstreamUrl(upstreamBase, requestUrl), method, forwardedRequestHeaders(req, entry.key, body.length), body)
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "gateway",
          event: "gateway.upstream_error",
          message: "credit gateway could not reach the upstream API",
          meta: { label: entry.label, error: errorMessage(error) },
        })
        writeJsonError(res, 502, "api_error", "credit gateway could not reach the upstream API")
        logRequest(entry.label, method, pathname, 502, startedAt)
        return
      }
      /* v8 ignore next -- Node always sets statusCode on an upstream response @preserve */
      const status = upstream.response.statusCode ?? 502
      if (CREDIT_CHECK_STATUSES.has(status)) {
        const buffered: BufferedResponse = {
          status,
          headers: responseHeaders(upstream.response.headers),
          body: await readAll(upstream.response),
        }
        if (isCreditExhaustedBody(buffered.body, upstream.response.headers["content-encoding"])) {
          markExhausted(entry)
          lastCredit = buffered
          lastCreditLabel = entry.label
          continue
        }
        writeBuffered(res, buffered)
        logRequest(entry.label, method, pathname, status, startedAt)
        return
      }
      res.writeHead(status, responseHeaders(upstream.response.headers))
      res.flushHeaders()
      pipeline(upstream.response, res, (error) => {
        if (error) upstream.request.destroy()
        logRequest(entry.label, method, pathname, status, startedAt)
      })
      return
    }

    if (lastCredit) {
      writeBuffered(res, { ...lastCredit, status: 400 })
    } else {
      writeJsonError(res, 400, "invalid_request_error", "Your credit balance is too low on every gateway key")
    }
    logRequest(lastCreditLabel, method, pathname, 400, startedAt)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      emitNervesEvent({
        level: "error",
        component: "gateway",
        event: "gateway.request_error",
        message: "credit gateway request failed",
        meta: { error: errorMessage(error) },
      })
      /* v8 ignore next 4 -- failures after the headers went out are reported by the stream pipeline instead @preserve */
      if (res.headersSent) {
        res.destroy()
        return
      }
      writeJsonError(res, 502, "api_error", "credit gateway request failed")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    /* v8 ignore next -- tests always bind port 0; the default is for production @preserve */
    const port = options.port ?? GATEWAY_DEFAULT_PORT
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as { port: number }
  const url = `http://${host}:${address.port}`
  emitNervesEvent({
    component: "gateway",
    event: "gateway.server_started",
    message: "credit gateway started",
    meta: { url, upstream: upstreamBase.origin, labels: keys.upstream.map((entry) => entry.label), statePath },
  })
  return {
    server,
    url,
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        emitNervesEvent({
          component: "gateway",
          event: "gateway.server_stopped",
          message: "credit gateway stopped",
          meta: { url },
        })
        resolve()
      })
    }),
  }
}

/* v8 ignore start -- waits for real process signals; tests inject waitForStop @preserve */
export function waitForShutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
}
/* v8 ignore stop */

/** Runs `ouro gateway serve` in the foreground until `waitForStop` resolves. */
export async function runCreditGatewayCommand(
  command: GatewayServeCommand,
  deps: { writeStdout: (text: string) => void; waitForStop?: () => Promise<void> },
): Promise<string> {
  const handle = await startCreditGateway(creditGatewayOptionsFromCli(command))
  const message = `credit gateway listening on ${handle.url}\nhealth: ${handle.url}/health`
  deps.writeStdout(message)
  /* v8 ignore next -- production waits for SIGINT/SIGTERM; tests inject waitForStop @preserve */
  await (deps.waitForStop ?? waitForShutdownSignal)()
  await handle.close()
  return message
}
