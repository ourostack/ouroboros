import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  executeSanctuaryAcceptanceHarness,
  type AcceptanceHarnessDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-harness"

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-acceptance-"))
  roots.push(created)
  return created
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function dependencies(input: {
  secret?: string
  adapter?: (executable: string, payload: unknown) => Promise<unknown>
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
} = {}): AcceptanceHarnessDependencies {
  return {
    readSecret: () => input.secret ?? "",
    runAdapter: input.adapter ?? (async () => ({ ok: true })),
    fetch: input.fetch ?? (async () => jsonResponse({ ok: true, result: [] })),
    now: input.now ?? (() => 1_800_000_000_000),
    randomBytes: () => Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
    sleep: input.sleep ?? (async () => {}),
  }
}

function evidence(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

describe("Sanctuary acceptance harness", () => {
  it("performs a Telegram identity/nonce/vault/offset transaction without persisting secrets", async () => {
    const dir = root()
    const evidencePath = path.join(dir, "telegram-evidence.json")
    const offsetPath = path.join(dir, "offset.json")
    const adapterCalls: Array<{ executable: string; payload: unknown }> = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const token = "123456:top-secret-token"
    const deps = dependencies({
      secret: `${token}\n`,
      adapter: async (executable, payload) => {
        adapterCalls.push({ executable, payload })
        if (executable === "/safe/send-nonce") return { sent: true }
        if (executable === "/safe/store-vault") return { stored: true }
        throw new Error("unexpected adapter")
      },
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 40, message: { message_id: 2, date: 1_800_000_000, from: { id: 111 }, chat: { id: 222, type: "private" }, text: "unrelated" } },
            { update_id: 41, message: { message_id: 3, date: 1_800_000_000, from: { id: 111 }, chat: { id: 222, type: "private" }, text: "0123456789abcdef0123456789abcdef" } },
          ],
        })
      },
    })

    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      evidencePath,
      offsetPath,
      expectedBotId: "8541786263",
      expectedUsername: "MendelowCloudButlerBot",
      currentOffset: 40,
      nonceAdapter: "/safe/send-nonce",
      vaultAdapter: "/safe/store-vault",
    }, deps)

    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toBe(`https://api.telegram.org/bot${token}/getMe`)
    expect(requests[1]!.url).toBe(`https://api.telegram.org/bot${token}/getUpdates`)
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ offset: 40, timeout: 0, allowed_updates: ["message"] })
    expect(adapterCalls).toEqual([
      { executable: "/safe/send-nonce", payload: { operation: "send_telegram_nonce", nonce: "0123456789abcdef0123456789abcdef" } },
      { executable: "/safe/store-vault", payload: { operation: "store_telegram_bootstrap", botToken: token, authorizedUserId: "111", authorizedChatId: "222" } },
    ])
    expect(JSON.parse(fs.readFileSync(offsetPath, "utf8"))).toEqual({ nextUpdateId: 42 })
    expect(fs.statSync(offsetPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600)
    const rawEvidence = fs.readFileSync(evidencePath, "utf8")
    expect(rawEvidence).not.toContain(token)
    expect(rawEvidence).not.toContain("111")
    expect(rawEvidence).not.toContain("222")
    expect(rawEvidence).not.toContain("0123456789abcdef0123456789abcdef")
    expect(evidence(evidencePath)).toMatchObject({ operation: "telegram-bootstrap", phase: "complete", nextUpdateId: 42 })
  })

  it("fails Telegram bootstrap before mutation on identity, nonce, or checkpoint ambiguity", async () => {
    const cases = [
      { label: "identity", getMe: { id: 7, username: "wrong" }, updates: [] },
      { label: "nonce", getMe: { id: 8541786263, username: "MendelowCloudButlerBot" }, updates: [] },
      { label: "duplicate", getMe: { id: 8541786263, username: "MendelowCloudButlerBot" }, updates: [41, 42].map((update_id) => ({ update_id, message: { message_id: update_id, date: 1_800_000_000, from: { id: 1 }, chat: { id: 2, type: "private" }, text: "0123456789abcdef0123456789abcdef" } })) },
    ]
    for (const testCase of cases) {
      const dir = root()
      const mutations: string[] = []
      const deps = dependencies({
        secret: "token",
        adapter: async (executable) => { mutations.push(executable); return { sent: true } },
        fetch: async (request) => String(request).endsWith("/getMe")
          ? jsonResponse({ ok: true, result: testCase.getMe })
          : jsonResponse({ ok: true, result: testCase.updates }),
      })
      await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
        evidencePath: path.join(dir, "evidence.json"), offsetPath: path.join(dir, "offset.json"),
        expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
        nonceAdapter: "/safe/send", vaultAdapter: "/safe/vault",
      }, deps), testCase.label).rejects.toThrow()
      expect(mutations).not.toContain("/safe/vault")
      expect(fs.existsSync(path.join(dir, "offset.json"))).toBe(false)
    }

    const dir = root()
    fs.writeFileSync(path.join(dir, "evidence.json"), "{}\n", { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      evidencePath: path.join(dir, "evidence.json"), offsetPath: path.join(dir, "offset.json"),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
      nonceAdapter: "/safe/send", vaultAdapter: "/safe/vault",
    }, dependencies({ secret: "token" }))).rejects.toThrow(/inspect-before-retry/u)
  })

  it("captures selected cursor snapshots and computes a redacted delta", async () => {
    const dir = root()
    const before = path.join(dir, "before.json")
    const after = path.join(dir, "after.json")
    const delta = path.join(dir, "delta.json")
    let offset = 10
    const deps = dependencies({ adapter: async (executable, payload) => {
      expect(executable).toBe("/safe/snapshot")
      expect(payload).toEqual({ operation: "snapshot", name: "telegram" })
      return { offset, nested: { auditCursor: offset + 5 }, ignoredToken: "must-not-persist" }
    } })
    const config = { adapters: [{ name: "telegram", executable: "/safe/snapshot", select: ["offset", "nested.auditCursor"] }] }
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: before, ...config }, deps)
    offset = 11
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: after, ...config }, deps)
    await executeSanctuaryAcceptanceHarness("cursor-delta", { evidencePath: delta, beforePath: before, afterPath: after }, deps)
    expect(evidence(before)).toMatchObject({ operation: "cursor-snapshot", values: { "telegram.offset": 10, "telegram.nested.auditCursor": 15 } })
    expect(evidence(delta)).toMatchObject({ operation: "cursor-delta", changes: { "telegram.offset": { before: 10, after: 11 }, "telegram.nested.auditCursor": { before: 15, after: 16 } } })
    expect(fs.readFileSync(before, "utf8")).not.toContain("must-not-persist")
  })

  it("injects one saved callback concurrently and proves one-shot mutation plus replay denial", async () => {
    const dir = root()
    const calls: unknown[] = []
    let count = 0
    const update = { update_id: 99, callback_query: { id: "opaque", from: { id: 111 }, data: "a:opaque", message: { message_id: 4, chat: { id: 222 } } } }
    await executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "callback.json"), adapter: "/safe/inject", concurrency: 2,
      replay: true, expectedClaims: 1, expectedMutations: 1,
    }, dependencies({
      secret: JSON.stringify(update),
      adapter: async (executable, payload) => {
        expect(executable).toBe("/safe/inject")
        calls.push(payload)
        count += 1
        return count === 1
          ? { settled: true, claimed: true, mutated: true }
          : { settled: true, claimed: false, mutated: false }
      },
    }))
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ operation: "inject_callback", update })))
    const raw = fs.readFileSync(path.join(dir, "callback.json"), "utf8")
    expect(raw).not.toContain("a:opaque")
    expect(evidence(path.join(dir, "callback.json"))).toMatchObject({ phase: "complete", claims: 1, mutations: 1, replayMutated: false })
  })

  it("rejects malformed callback material and unexpected callback totals before claiming success", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "bad.json"), adapter: "/safe/inject", concurrency: 1,
      replay: false, expectedClaims: 0, expectedMutations: 0,
    }, dependencies({ secret: "{}" }))).rejects.toThrow(/callback_query/u)

    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "totals.json"), adapter: "/safe/inject", concurrency: 1,
      replay: false, expectedClaims: 0, expectedMutations: 0,
    }, dependencies({
      secret: JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } }),
      adapter: async () => ({ settled: true, claimed: true, mutated: false }),
    }))).rejects.toThrow(/claim total/u)
    expect(evidence(path.join(dir, "totals.json"))).toMatchObject({ phase: "failed" })
  })

  it("creates exact Unraid keys once, stores them through stdin adapters, and revokes/probes old secrets", async () => {
    const dir = root()
    const calls: Array<{ executable: string; payload: any }> = []
    const permissions = ["ARRAY:READ_ANY", "DOCKER:READ_ANY"]
    let inventoryCount = 0
    await executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "keys.json"), targetServerId: "sanctuary-unraid",
      inventoryAdapter: "/safe/inventory", createAdapter: "/safe/create", storeAdapter: "/safe/store",
      revokeAdapter: "/safe/revoke", probeAdapter: "/safe/probe",
      keys: [
        { name: "Butler RO", vaultField: "unraidReadApiKey", permissions },
        { name: "Butler RW", vaultField: "unraidWriteApiKey", permissions: [...permissions, "DOCKER:UPDATE_ANY"] },
      ],
      oldKeys: [{ id: "legacy-read", secretAdapter: "/safe/old-read" }],
    }, dependencies({ adapter: async (executable, payload: any) => {
      calls.push({ executable, payload })
      if (executable === "/safe/inventory") {
        inventoryCount += 1
        return inventoryCount === 1 ? { keys: [{ id: "legacy-read", name: "Legacy", permissions: permissions, roles: [] }] } : {
          keys: [
            { id: "ro-id", name: "Butler RO", permissions, roles: [] },
            { id: "rw-id", name: "Butler RW", permissions: [...permissions, "DOCKER:UPDATE_ANY"], roles: [] },
          ],
        }
      }
      if (executable === "/safe/create") {
        const isRo = payload.name === "Butler RO"
        return { id: isRo ? "ro-id" : "rw-id", name: payload.name, permissions: payload.permissions, roles: [], key: isRo ? "raw-ro" : "raw-rw" }
      }
      if (executable === "/safe/store") return { stored: true, keyId: payload.keyId }
      if (executable === "/safe/probe") return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
      if (executable === "/safe/old-read") return { key: "raw-old" }
      if (executable === "/safe/revoke") return { revoked: true, id: payload.id }
      throw new Error("unexpected adapter")
    } }))

    expect(calls.find((call) => call.executable === "/safe/create")!.payload).toEqual({
      operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions,
    })
    expect(calls).toContainEqual({ executable: "/safe/store", payload: { operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "ro-id", key: "raw-ro" } })
    expect(calls).toContainEqual({ executable: "/safe/revoke", payload: { operation: "revoke_key", targetServerId: "sanctuary-unraid", id: "legacy-read" } })
    expect(calls).toContainEqual({ executable: "/safe/probe", payload: { operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "legacy-read", key: "raw-old" } })
    const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8")
    for (const secret of ["raw-ro", "raw-rw", "raw-old"]) expect(raw).not.toContain(secret)
    expect(evidence(path.join(dir, "keys.json"))).toMatchObject({ phase: "complete", createdKeyIds: ["ro-id", "rw-id"], revokedKeyIds: ["legacy-read"] })
  })

  it("refuses Unraid mutation before checkpoint on existing labels and leaves a failed checkpoint after adapter error", async () => {
    const dir = root()
    const mutations: string[] = []
    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "exists.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    }, dependencies({ adapter: async (executable) => {
      if (executable !== "/inventory") mutations.push(executable)
      return { keys: [{ id: "already", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
    } }))).rejects.toThrow(/already exists/u)
    expect(mutations).toEqual([])
    expect(fs.existsSync(path.join(dir, "exists.json"))).toBe(false)

    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "failed.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return { keys: [] }
      throw new Error("adapter failed")
    } }))).rejects.toThrow(/adapter failed/u)
    expect(evidence(path.join(dir, "failed.json"))).toMatchObject({ phase: "failed" })
  })

  it("records generic health evidence by digest and only selected safe values", async () => {
    const dir = root()
    const file = path.join(dir, "health.json")
    await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      evidencePath: file, name: "postboot-health", adapter: "/safe/health",
      select: ["healthy", "container.image", "telegram.offset"],
    }, dependencies({ adapter: async (_executable, payload) => {
      expect(payload).toEqual({ operation: "evidence_snapshot", name: "postboot-health" })
      return { healthy: true, container: { image: "sha256:abc" }, telegram: { offset: 44 }, apiToken: "secret" }
    } }))
    const saved = evidence(file)
    expect(saved).toMatchObject({ operation: "evidence-snapshot", name: "postboot-health", values: { healthy: true, "container.image": "sha256:abc", "telegram.offset": 44 } })
    expect(saved).toHaveProperty("payloadDigest", createHash("sha256").update(JSON.stringify({ healthy: true, container: { image: "sha256:abc" }, telegram: { offset: 44 }, apiToken: "secret" })).digest("hex"))
    expect(fs.readFileSync(file, "utf8")).not.toContain('"secret"')
  })

  it("checkpoints one reboot request and resumes only that request until the exact target is ready", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    const calls: Array<{ executable: string; payload: unknown }> = []
    let poll = 0
    const deps = dependencies({
      adapter: async (executable, payload) => {
        calls.push({ executable, payload })
        if (executable === "/safe/reboot") return { accepted: true, targetId: "sanctuary", requestId: "request-1" }
        poll += 1
        return poll === 1
          ? { state: "booting", targetId: "sanctuary", requestId: "request-1" }
          : { state: "ready", targetId: "sanctuary", requestId: "request-1", bootId: "boot-2" }
      },
      now: (() => { let value = 1000; return () => value += 10 })(),
    })
    await executeSanctuaryAcceptanceHarness("reboot-request", {
      evidencePath: file, targetId: "sanctuary", adapter: "/safe/reboot",
    }, deps)
    const requested = evidence(file)
    expect(requested).toMatchObject({ phase: "requested", targetId: "sanctuary", requestId: "request-1" })
    await executeSanctuaryAcceptanceHarness("reboot-resume", {
      evidencePath: file, adapter: "/safe/poll", timeoutMs: 100, intervalMs: 1,
    }, deps)
    expect(calls.filter((call) => call.executable === "/safe/reboot")).toHaveLength(1)
    expect(calls.filter((call) => call.executable === "/safe/poll")[0]!.payload).toEqual({ operation: "poll_reboot", targetId: "sanctuary", requestId: "request-1" })
    expect(evidence(file)).toMatchObject({ phase: "complete", targetId: "sanctuary", requestId: "request-1", bootId: "boot-2" })
  })

  it("refuses duplicate reboot requests and fails resume on target drift or timeout", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    fs.writeFileSync(file, JSON.stringify({ operation: "reboot", phase: "requested", targetId: "sanctuary", requestId: "r" }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-request", { evidencePath: file, targetId: "sanctuary", adapter: "/reboot" }, dependencies())).rejects.toThrow(/inspect-before-retry/u)
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: file, adapter: "/poll", timeoutMs: 10, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "ready", targetId: "other", requestId: "r", bootId: "b" }),
    }))).rejects.toThrow(/target drift/u)

    let now = 0
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: file, adapter: "/poll", timeoutMs: 5, intervalMs: 1 }, dependencies({
      now: () => now += 3,
      adapter: async () => ({ state: "booting", targetId: "sanctuary", requestId: "r" }),
    }))).rejects.toThrow(/timed out/u)
  })

  it("rejects secret-looking snapshot selectors and unknown commands", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      evidencePath: path.join(dir, "bad.json"), name: "bad", adapter: "/adapter", select: ["apiToken"],
    }, dependencies())).rejects.toThrow(/secret-bearing selector/u)
    await expect(executeSanctuaryAcceptanceHarness("nope", {}, dependencies())).rejects.toThrow(/unknown Sanctuary acceptance command/u)
  })

  it("ships an executable descriptor-only wrapper in deploy/unraid", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-harness.sh", "utf8")
    expect(wrapper).toContain("exec node /opt/ouro/dist/heart/daemon/sanctuary-acceptance-harness-main.js")
    expect(wrapper).toContain('3<&3')
    expect(wrapper).not.toMatch(/token|password|api[_-]?key/iu)
  })
})
