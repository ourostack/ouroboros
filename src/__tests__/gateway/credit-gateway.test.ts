import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import * as zlib from "node:zlib"
import { emitNervesEvent } from "../../nerves/runtime"
import { loadGatewayKeys, loadGatewayState, saveGatewayState } from "../../gateway/keys"
import {
  creditGatewayOptionsFromCli,
  isCreditExhaustedBody,
  runCreditGatewayCommand,
  startCreditGateway,
  type CreditGatewayHandle,
  type CreditGatewayOptions,
} from "../../gateway/server"

function emitTestEvent(testName: string): void {
  emitNervesEvent({ component: "gateway", event: "gateway.test_run", message: testName, meta: { test: true } })
}

const MASTER = "ouro-gw-master-test"
const KEY1 = "sk-ant-usr-one"
const KEY2 = "sk-ant-usr-two"
const KEY3 = "sk-ant-usr-three"
const CREDIT_LOW = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })

interface StubRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

type StubHandler = (req: StubRequest, res: http.ServerResponse) => void

interface Stub {
  url: string
  requests: StubRequest[]
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void> | void> = []

async function startStub(handler: StubHandler): Promise<Stub> {
  const requests: StubRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }
      requests.push(entry)
      handler(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
  cleanups.push(stub.close)
  return stub
}

function makeKeysDir(files: Record<string, string> = { "master.key": `${MASTER}\n`, "acct1.key": ` ${KEY1}\n`, "acct2.key": KEY2, "acct3.key": KEY3 }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-gateway-"))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 })
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const keyLabel: Record<string, string> = { [KEY1]: "acct1", [KEY2]: "acct2", [KEY3]: "acct3" }
function labelsSeen(stub: Stub): string[] {
  return stub.requests.map((request) => keyLabel[String(request.headers["x-api-key"])])
}

async function startGateway(options: Partial<CreditGatewayOptions> & { keysDir: string }): Promise<{ gateway: CreditGatewayHandle; logs: string[] }> {
  const logs: string[] = []
  const gateway = await startCreditGateway({ port: 0, log: (line) => logs.push(line), ...options })
  cleanups.push(() => gateway.close())
  return { gateway, logs }
}

function post(gateway: CreditGatewayHandle, headers: Record<string, string> = { "x-api-key": MASTER }, body = '{"model":"m"}', urlPath = "/v1/messages?beta=true"): Promise<Response> {
  return fetch(`${gateway.url}${urlPath}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe("credit gateway keys and state", () => {
  beforeEach(() => emitTestEvent("credit gateway keys"))

  it("reads the master key and the upstream keys in file-name order, trimmed, labelled by file name", () => {
    const dir = makeKeysDir({ "master.key": ` ${MASTER} \n`, "acct2.key": KEY2, "acct1.key": `${KEY1}\n`, "notes.txt": "ignored", "gateway-state.json": "{}" })
    expect(loadGatewayKeys(dir)).toEqual({ masterKey: MASTER, upstream: [{ label: "acct1", key: KEY1 }, { label: "acct2", key: KEY2 }] })
  })

  it("refuses to start without a master key, without upstream keys, with an empty upstream key, or without the directory", () => {
    expect(() => loadGatewayKeys(makeKeysDir({ "acct1.key": KEY1 }))).toThrow(/master\.key is missing or empty/)
    expect(() => loadGatewayKeys(makeKeysDir({ "master.key": "  \n", "acct1.key": KEY1 }))).toThrow(/master\.key is missing or empty/)
    expect(() => loadGatewayKeys(makeKeysDir({ "master.key": MASTER }))).toThrow(/no upstream \*\.key files/)
    expect(() => loadGatewayKeys(makeKeysDir({ "master.key": MASTER, "acct1.key": "\n" }))).toThrow(/acct1\.key is empty/)
    expect(() => loadGatewayKeys(path.join(os.tmpdir(), "credit-gateway-missing-dir"))).toThrow(/cannot read keys directory/)
  })

  it("loads state, starting empty when the file is missing or corrupt and dropping invalid entries", () => {
    const dir = makeKeysDir({})
    const statePath = path.join(dir, "state.json")
    expect(loadGatewayState(statePath)).toEqual({ exhausted: {} })
    for (const corrupt of ["not json", "null", '{"exhausted":[]}', '{"exhausted":"x"}', "{}"]) {
      fs.writeFileSync(statePath, corrupt)
      expect(loadGatewayState(statePath)).toEqual({ exhausted: {} })
    }
    fs.writeFileSync(statePath, JSON.stringify({ exhausted: { acct1: "2026-01-01T00:00:00.000Z", acct2: "soon", acct3: 5 } }))
    expect(loadGatewayState(statePath)).toEqual({ exhausted: { acct1: "2026-01-01T00:00:00.000Z" } })
  })

  it("saves state with mode 0600", () => {
    const dir = makeKeysDir({})
    const statePath = path.join(dir, "gateway-state.json")
    saveGatewayState(statePath, { exhausted: { acct1: "2026-01-01T00:00:00.000Z" } })
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ exhausted: { acct1: "2026-01-01T00:00:00.000Z" } })
    expect(fs.readdirSync(dir)).toEqual(["gateway-state.json"])
  })

  it("detects the credit-low phrase in plain, gzip, deflate and brotli bodies, and falls back on undecodable ones", () => {
    const body = Buffer.from(CREDIT_LOW.toUpperCase())
    expect(isCreditExhaustedBody(body)).toBe(true)
    expect(isCreditExhaustedBody(zlib.gzipSync(body), "gzip")).toBe(true)
    expect(isCreditExhaustedBody(zlib.deflateSync(body), "deflate")).toBe(true)
    expect(isCreditExhaustedBody(zlib.brotliCompressSync(body), "br")).toBe(true)
    expect(isCreditExhaustedBody(Buffer.from("credit balance is too low"), "gzip")).toBe(true)
    expect(isCreditExhaustedBody(Buffer.from('{"error":{"message":"bad request"}}'), "identity")).toBe(false)
  })

  it("maps the CLI flags to gateway options", () => {
    expect(creditGatewayOptionsFromCli({ keysDir: "/keys" })).toEqual({ keysDir: "/keys" })
    expect(creditGatewayOptionsFromCli({ keysDir: "/keys", statePath: "/s.json", host: "0.0.0.0", port: 0, upstream: "http://u", cooldownMinutes: 2 })).toEqual({
      keysDir: "/keys", statePath: "/s.json", host: "0.0.0.0", port: 0, upstream: "http://u", cooldownMs: 120_000,
    })
  })
})

describe("credit gateway server", () => {
  beforeEach(() => emitTestEvent("credit gateway server"))

  it("serves /health without a key and without key material, using default state path and clock", async () => {
    const dir = makeKeysDir()
    const { gateway, logs } = await startGateway({ keysDir: dir })
    const response = await fetch(`${gateway.url}/health`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ ok: true, keys: [{ label: "acct1", available: true }, { label: "acct2", available: true }, { label: "acct3", available: true }] })
    expect(text).not.toContain("sk-ant")
    expect(text).not.toContain(MASTER)
    expect(logs).toEqual([expect.stringMatching(/^gateway: - GET \/health 200 \d+ms$/)])
  })

  it("rejects a missing or wrong master key with an Anthropic-shaped 401, and accepts x-api-key or Bearer", async () => {
    const stub = await startStub((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
    const { gateway } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url })
    for (const headers of [{}, { "x-api-key": "wrong" }, { authorization: "Bearer wrong" }, { "x-api-key": "  ", authorization: "Basic x" }]) {
      const response = await post(gateway, headers)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
    }
    expect(stub.requests).toHaveLength(0)
    expect((await post(gateway, { "x-api-key": MASTER })).status).toBe(200)
    expect((await post(gateway, { authorization: `Bearer ${MASTER}` })).status).toBe(200)
  })

  it("refuses a request path that would resolve to another host, so an upstream key never leaves for it", async () => {
    const stub = await startStub((_req, res) => { res.writeHead(200); res.end("{}") })
    const { gateway, logs } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url })
    const port = new URL(gateway.url).port
    for (const rawPath of ["//evil.example/v1/messages", "/\\evil.example/v1/messages", "http://evil.example/v1/messages"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: rawPath, headers: { "x-api-key": MASTER } }, (res) => { res.resume(); resolve(res.statusCode!) })
        req.on("error", reject)
        req.end("{}")
      })
      expect(status).toBe(400)
    }
    expect(stub.requests).toHaveLength(0)
    expect(logs.every((line) => / 400 \d+ms$/.test(line))).toBe(true)
  })

  it("forwards method, path, query, body and headers with the first upstream key, and strips the client's credentials", async () => {
    const stub = await startStub((_req, res) => { res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" }); res.end('{"id":"msg"}') })
    const { gateway, logs } = await startGateway({ keysDir: makeKeysDir(), upstream: `${stub.url}/prefix/` })
    const response = await post(gateway, { authorization: `Bearer ${MASTER}`, "anthropic-version": "2023-06-01" }, '{"model":"claude"}')
    expect(response.status).toBe(201)
    expect(response.headers.get("x-upstream")).toBe("yes")
    expect(await response.text()).toBe('{"id":"msg"}')
    const forwarded = stub.requests[0]
    expect(forwarded.method).toBe("POST")
    expect(forwarded.url).toBe("/prefix/v1/messages?beta=true")
    expect(forwarded.body).toBe('{"model":"claude"}')
    expect(forwarded.headers["x-api-key"]).toBe(KEY1)
    expect(forwarded.headers.authorization).toBeUndefined()
    expect(forwarded.headers["anthropic-version"]).toBe("2023-06-01")
    expect(forwarded.headers["content-length"]).toBe(String('{"model":"claude"}'.length))
    expect(logs).toEqual([expect.stringMatching(/^gateway: acct1 POST \/v1\/messages 201 \d+ms$/)])

    const get = await fetch(`${gateway.url}/v1/models`, { headers: { "x-api-key": MASTER } })
    expect(get.status).toBe(201)
    expect(stub.requests[1].method).toBe("GET")
    expect(stub.requests[1].headers["content-length"]).toBeUndefined()
  })

  it("streams SSE responses through without buffering", async () => {
    let releaseSecond!: () => void
    const second = new Promise<void>((resolve) => { releaseSecond = resolve })
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("event: message_start\ndata: {}\n\n")
      void second.then(() => res.end("event: message_stop\ndata: {}\n\n"))
    })
    const { gateway } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url })
    const response = await post(gateway)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("message_start")
    releaseSecond()
    let rest = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      rest += new TextDecoder().decode(chunk.value)
    }
    expect(rest).toContain("message_stop")
  })

  it("moves to the next key when one is out of credits, remembers the skip, and logs it", async () => {
    const stub = await startStub((req, res) => {
      if (req.headers["x-api-key"] === KEY1) {
        res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" })
        res.end(zlib.gzipSync(CREDIT_LOW))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
    const dir = makeKeysDir()
    let clock = Date.parse("2026-10-27T12:00:00.000Z")
    const { gateway, logs } = await startGateway({ keysDir: dir, upstream: stub.url, now: () => clock })
    const response = await post(gateway)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
    expect(labelsSeen(stub)).toEqual(["acct1", "acct2"])
    expect(logs).toContain("gateway: acct1 out of credits; moving on")
    expect(logs.at(-1)).toMatch(/^gateway: acct2 POST \/v1\/messages 200 \d+ms$/)
    const statePath = path.join(dir, "gateway-state.json")
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ exhausted: { acct1: "2026-10-27T13:00:00.000Z" } })
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600)

    expect((await post(gateway)).status).toBe(200)
    expect(labelsSeen(stub)).toEqual(["acct1", "acct2", "acct2"])
    const health = await (await fetch(`${gateway.url}/health`)).json()
    expect(health.keys[0]).toEqual({ label: "acct1", available: false, skipUntil: "2026-10-27T13:00:00.000Z" })

    // After the cooldown, the first key is tried again (and the stale entry is cleared).
    clock += 60 * 60 * 1000 + 1
    expect((await post(gateway)).status).toBe(200)
    expect(labelsSeen(stub).slice(3)).toEqual(["acct1", "acct2"])
  })

  it("returns a non-credit 400 as-is without trying another key", async () => {
    const stub = await startStub((_req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: required"}}') })
    const { gateway } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url })
    const response = await post(gateway)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("max_tokens: required")
    expect(labelsSeen(stub)).toEqual(["acct1"])
  })

  it("treats credit-low 402 and 403 the same, and returns the last credit-low body as a 400 when every key is out", async () => {
    const stub = await startStub((req, res) => {
      const status = req.headers["x-api-key"] === KEY1 ? 402 : 403
      res.writeHead(status, { "content-type": "application/json" })
      res.end(CREDIT_LOW.replace("too low", `too low (${status})`))
    })
    const { gateway, logs } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url, cooldownMs: 5_000 })
    const response = await post(gateway)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("(403)")
    expect(labelsSeen(stub)).toEqual(["acct1", "acct2", "acct3"])
    expect(logs.filter((line) => line.includes("out of credits"))).toHaveLength(3)
    expect(logs.at(-1)).toMatch(/^gateway: acct3 POST \/v1\/messages 400 \d+ms$/)

    // Every key is now skipped: the gateway answers without calling upstream.
    const skipped = await post(gateway)
    expect(skipped.status).toBe(400)
    expect(await skipped.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low on every gateway key" } })
    expect(stub.requests).toHaveLength(3)
  })

  it("answers 502 on a network error without advancing keys", async () => {
    const stub = await startStub(() => {})
    await stub.close()
    const dir = makeKeysDir()
    const { gateway, logs } = await startGateway({ keysDir: dir, upstream: stub.url })
    const response = await post(gateway)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "credit gateway could not reach the upstream API" } })
    expect(logs).toEqual([expect.stringMatching(/^gateway: acct1 POST \/v1\/messages 502 \d+ms$/)])
    expect(fs.existsSync(path.join(dir, "gateway-state.json"))).toBe(false)

    const { gateway: httpsGateway } = await startGateway({ keysDir: dir, upstream: "https://127.0.0.1:1" })
    expect((await post(httpsGateway)).status).toBe(502)
  })

  it("answers 502 when the upstream drops an error response mid-body, and ends a broken stream", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/broken-error")) {
        res.writeHead(400, { "content-type": "application/json", "content-length": "1000" })
        res.write('{"partial":')
        setTimeout(() => res.socket!.destroy(), 10)
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("event: message_start\ndata: {}\n\n")
      setTimeout(() => res.socket!.destroy(), 10)
    })
    const { gateway, logs } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url })
    const broken = await post(gateway, undefined, "{}", "/broken-error")
    expect(broken.status).toBe(502)
    expect(await broken.json()).toEqual({ type: "error", error: { type: "api_error", message: "credit gateway request failed" } })

    const stream = await post(gateway)
    expect(stream.status).toBe(200)
    await expect(stream.text()).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(logs.at(-1)).toMatch(/^gateway: acct1 POST \/v1\/messages 200 \d+ms$/)
  })

  it("rejects request bodies over the cap with 413", async () => {
    const stub = await startStub((_req, res) => res.end("{}"))
    const { gateway } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url, maxRequestBytes: 16 })
    const response = await post(gateway, undefined, JSON.stringify({ text: "x".repeat(64) }))
    expect(response.status).toBe(413)
    expect((await response.json()).error.type).toBe("request_too_large")
    expect(stub.requests).toHaveLength(0)
  })

  it("keeps serving when the state file cannot be written", async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(req.headers["x-api-key"] === KEY1 ? 400 : 200, { "content-type": "application/json" })
      res.end(req.headers["x-api-key"] === KEY1 ? CREDIT_LOW : "{}")
    })
    const { gateway } = await startGateway({ keysDir: makeKeysDir(), upstream: stub.url, statePath: path.join(os.tmpdir(), "no-such-dir", "state.json") })
    expect((await post(gateway)).status).toBe(200)
    expect(labelsSeen(stub)).toEqual(["acct1", "acct2"])
  })

  it("loads a saved skip list on start", async () => {
    const stub = await startStub((_req, res) => res.end("{}"))
    const dir = makeKeysDir()
    fs.writeFileSync(path.join(dir, "gateway-state.json"), JSON.stringify({ exhausted: { acct1: "2099-01-01T00:00:00.000Z" } }))
    const { gateway } = await startGateway({ keysDir: dir, upstream: stub.url })
    expect((await post(gateway)).status).toBe(200)
    expect(labelsSeen(stub)).toEqual(["acct2"])
  })

  it("fails to start when the port is taken", async () => {
    const dir = makeKeysDir()
    const { gateway } = await startGateway({ keysDir: dir })
    await expect(startCreditGateway({ keysDir: dir, host: "127.0.0.1", port: gateway.port, log: () => {} })).rejects.toThrow(/EADDRINUSE/)
  })

  it("runs the serve command until told to stop", async () => {
    const dir = makeKeysDir()
    const output: string[] = []
    let stop!: () => void
    const stopped = new Promise<void>((resolve) => { stop = resolve })
    const running = runCreditGatewayCommand({ keysDir: dir, host: "127.0.0.1", port: 0 }, { writeStdout: (text) => output.push(text), waitForStop: () => stopped })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(output[0]).toMatch(/^credit gateway listening on http:\/\/127\.0\.0\.1:\d+\nhealth: http:\/\/127\.0\.0\.1:\d+\/health$/)
    const url = /listening on (\S+)/.exec(output[0])![1]
    expect((await fetch(`${url}/health`)).status).toBe(200)
    stop()
    await expect(running).resolves.toBe(output[0])
  })
})
