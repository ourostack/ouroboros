import * as fs from "node:fs"

import { describe, expect, it, vi } from "vitest"

import {
  createSanctuaryAcceptanceAdapterDependencies,
  createSanctuaryAcceptanceVaultProbeDependencies,
  executeSanctuaryAcceptanceCallbackProbe,
  executeSanctuaryAcceptanceAdapter,
  executeSanctuaryAcceptanceRevokedProbe,
  executeSanctuaryAcceptanceVaultProbe,
  type SanctuaryAcceptanceAdapterDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"

const READ_QUERY = "query AcceptanceAuthProbe { info { os { hostname } } }"
const WRITE_QUERY = "mutation AcceptanceWriteProbe($id: PrefixedID!) { docker { restart(id: $id) { id } } }"
const MISSING_CONTAINER_ID = "Docker:ouro-acceptance-guaranteed-missing"
const READ_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => ({ resource, actions: ["READ_ANY"] }))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function refreshed(config: Record<string, unknown>) {
  return {
    ok: true as const,
    itemPath: "vault:opaque",
    revision: "opaque",
    updatedAt: "2026-08-20T00:00:00.000Z",
    config,
  }
}

describe("Sanctuary acceptance adapter semantic proofs", () => {
  it("packages every Unit 16 harness operation with a fixed operator-only authority", () => {
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as any
    expect(Object.keys(contract.adapters).sort()).toEqual([
      "callback-inject", "callback-live", "capture-evidence-provenance", "closed-inventory", "config-materializer", "cursor-snapshot",
      "evidence-snapshot", "exact-id-revoke", "key-create", "key-inventory", "key-probe", "key-read-old", "key-revoke", "key-store",
      "reboot-live-request", "reboot-poll", "reboot-request", "revoked-key-auth-rejection", "telegram-nonce", "telegram-vault-store",
      "unraid-key-rotate", "vault-backed-capability-verify",
    ])
    expect(Object.values(contract.adapters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelReachable: false, timeoutMs: 15_000 }),
    ]))
    expect(Object.keys(contract.configTemplates).sort()).toEqual(Object.keys(contract.commands).sort())
    expect(contract.configTemplates["unraid-key-rotate"].fixed).toMatchObject({
      targetServerId: "sanctuary-unraid",
      inventoryAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      createAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      storeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      revokeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      probeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      keys: [{ name: "Butler RO", vaultField: "unraidReadApiKey" }, { name: "Butler RW", vaultField: "unraidWriteApiKey" }],
    })
    expect(contract.configTemplates["unraid-key-rotate"].oldKeyTemplate.secretAdapter).toBe("/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh")
    expect(JSON.stringify(contract)).not.toMatch(/(?:botToken|authorizedUserId|authorizedChatId|descriptor|rawKey)/u)
  })

  it("executes Telegram nonce delivery and exact vault storage without returning private coordinates", async () => {
    const calls: unknown[] = []
    const deps = unit16Deps({
      refreshRuntime: async () => refreshed({ telegramBotToken: "123:secret", telegramAuthorizedUserId: "111", telegramAuthorizedChatId: "222" }),
      mergeRuntime: async (_agent, patch) => { calls.push(patch); return refreshed(patch) },
      fetch: vi.fn(async (input, init) => {
        calls.push({ input: String(input), body: JSON.parse(String(init?.body)) })
        return jsonResponse({ ok: true, result: { message_id: 1 } })
      }) as typeof fetch,
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "send_telegram_nonce", nonce: "a".repeat(32) }, deps)).resolves.toEqual({ sent: true })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "store_telegram_bootstrap", botToken: "456:rotated", authorizedUserId: "333", authorizedChatId: "444",
    }, deps)).resolves.toEqual({ stored: true })
    expect(calls).toContainEqual({ telegramBotToken: "456:rotated", telegramAuthorizedUserId: "333", telegramAuthorizedChatId: "444" })
    expect(JSON.stringify(await executeSanctuaryAcceptanceAdapter({ operation: "send_telegram_nonce", nonce: "b".repeat(32) }, deps))).not.toMatch(/123:secret|222/u)
  })

  it("snapshots fixed cursor state and runs bounded concurrent callback plus replay probes", async () => {
    const active: number[] = []
    let inFlight = 0
    let peak = 0
    const deps = unit16Deps({
      readFixedFile: (file) => file.endsWith("offset.json") ? '{"nextUpdateId":42}\n' : '{"event":"tool"}\n',
      callbackProbe: async (_update, replay) => {
        inFlight += 1; peak = Math.max(peak, inFlight); active.push(replay ? 2 : 1)
        await Promise.resolve(); inFlight -= 1
        return replay ? { settled: true, claimed: false, mutated: false } : { settled: true, claimed: active.length === 1, mutated: active.length === 1 }
      },
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "snapshot", schema: "telegram-cursor-v1" }, deps)).resolves.toEqual({
      offsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), auditCursorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    const update = { update_id: 9, callback_query: { id: "q", from: { id: 111 }, data: "opaque", message: { message_id: 7, chat: { id: 222 } } } }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inject_callbacks_concurrently", update, concurrency: 3 }, deps)).resolves.toMatchObject({ results: { length: 3 } })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inject_callback_replay", update }, deps)).resolves.toEqual({ settled: true, claimed: false, mutated: false })
    expect(peak).toBeGreaterThan(1)
  })

  it("executes exact Unraid create/store/probe/read/revoke lifecycle operations", async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    const read = READ_PERMISSIONS.map((permission) => `${permission.resource}:READ_ANY`)
    const oldRecord = { id: "old-id", name: "Old", permissions: READ_PERMISSIONS, roles: [], key: "old-secret" }
    let machine = { unraidGraphqlUrl: "http://127.0.0.1:2378/graphql" } as Record<string, unknown>
    const deps = unit16Deps({
      readKeyFiles: () => [oldRecord, { ...oldRecord, id: "z-id", name: "Zed" }],
      readKeyRecords: () => [oldRecord],
      refreshMachine: async () => refreshed(machine),
      mergeMachine: async (_agent, _machine, patch) => { machine = { ...machine, ...patch }; return refreshed(machine) },
      execFile: async (executable, args) => {
        calls.push({ executable, args })
        if (args.includes("--create")) return { status: 0, stdout: JSON.stringify({ id: "new-id", name: args[args.indexOf("--name") + 1], key: "new-secret", permissions: read, roles: [] }) }
        return { status: 0, stdout: JSON.stringify({ deleted: 1, keys: [{ id: "old-id", name: "Old" }] }) }
      },
      fetch: vi.fn(async () => jsonResponse({ data: { info: { os: { hostname: "sanctuary" } } } })) as typeof fetch,
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" }, deps)).resolves.toMatchObject({ keys: [{ id: "old-id", name: "Old" }, { id: "z-id", name: "Zed" }] })
    const created = await executeSanctuaryAcceptanceAdapter({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO rotate-a1", permissions: read }, deps) as any
    expect(created).toMatchObject({ id: "new-id", key: "unraid-key:new-id:unraidReadApiKey" })
    expect(JSON.stringify(created)).not.toContain("new-secret")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "new-id", key: created.key }, deps)).resolves.toEqual({ stored: true, keyId: "new-id" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "new-id", key: created.key }, deps)).resolves.toEqual({ valid: true })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "old-id" }, deps)).resolves.toEqual({ key: "unraid-key:old-id:legacy" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoke_key", targetServerId: "sanctuary-unraid", id: "old-id" }, deps)).resolves.toEqual({ revoked: true, id: "old-id" })
    expect(calls.every((call) => call.executable === "/usr/local/sbin/unraid-api")).toBe(true)
  })

  it("captures fixed evidence provenance and bounded reboot request/poll state", async () => {
    const files: Record<string, string> = {
      "/run/ouro-acceptance/image-digest": "a".repeat(64),
      "/run/ouro-acceptance/container-digest": "b".repeat(64),
      "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json": '{"nextUpdateId":4}\n',
      "/home/ouro/AgentBundles/sanctuary.ouro/state/daemon/logs/telegram.ndjson": "event\n",
      "/run/ouro-acceptance/postboot-health.json": JSON.stringify({ healthy: true }),
      "/proc/sys/kernel/random/boot_id": "boot-after\n",
    }
    const calls: unknown[] = []
    const deps = unit16Deps({ readFixedFile: (file) => files[file]!, execFile: async (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: "" } } })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" }, deps)).resolves.toEqual({
      imageDigest: "a".repeat(64), containerDigest: "b".repeat(64), cursorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, deps)).resolves.toMatchObject({ healthy: true, containerImageDigest: "a".repeat(64) })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "c".repeat(32) }, deps)).resolves.toMatchObject({ accepted: true, targetId: "sanctuary", prebootId: "boot-after" })
    const requested = await executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "d".repeat(32) }, deps) as any
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "poll_reboot", targetId: "sanctuary", requestId: requested.requestId }, deps)).resolves.toEqual({ targetId: "sanctuary", requestId: requested.requestId, state: "ready", bootId: "boot-after" })
    expect(calls).toContainEqual({ executable: "/sbin/reboot", args: [] })
  })

  it("materializes executable configs from only fixed live state", async () => {
    const contract = fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")
    const deps = unit16Deps({ readFixedFile: (file) => {
      if (file.endsWith("sanctuary-acceptance-contract.json")) return contract
      if (file.endsWith("offset.json")) return '{"nextUpdateId":91}'
      if (file.endsWith("closed-inventory.json")) return '{"keys":[{"id":"old-rw"},{"id":"old-ro"}]}'
      throw new Error("unexpected fixed file")
    } })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "telegram-bootstrap" }, deps)).resolves.toMatchObject({
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 91,
      nonceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "cursor-snapshot", phase: "before" }, deps)).resolves.toMatchObject({ evidencePath: "/evidence/cursor-before.json" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, deps)).resolves.toMatchObject({
      oldKeys: [{ id: "old-ro", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" }, { id: "old-rw", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" }],
    })
    const bundle = await executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "evidence-bundle-index" }, deps) as any
    expect(bundle.entries).toHaveLength(22)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "evidence-bundle-verify" }, deps)).resolves.toMatchObject({ evidencePath: "/evidence/unit-16-evidence-bundle.json" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "missing" }, deps)).rejects.toThrow(/template/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "cursor-snapshot", phase: "invalid" }, deps)).rejects.toThrow(/phase/u)
    const malformed = (offset: string, inventory: string) => unit16Deps({ readFixedFile: (file) => file.endsWith("contract.json") ? contract : file.endsWith("offset.json") ? offset : inventory })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "telegram-bootstrap" }, malformed('{"nextUpdateId":-1}', "{}"))).rejects.toThrow(/offset/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, malformed("{}", '{"keys":[]}'))).rejects.toThrow(/empty/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, malformed("{}", '{"keys":[{"id":"same"},{"id":"same"}]}'))).rejects.toThrow(/ambiguous/u)
  })

  it("refuses invalid Unit 16 adapter inputs and failed bounded dependencies", async () => {
    const reject = (payload: Record<string, unknown>, deps = unit16Deps()) => expect(executeSanctuaryAcceptanceAdapter(payload, deps)).rejects.toThrow()
    await reject({ operation: "send_telegram_nonce", nonce: "bad" })
    await reject({ operation: "send_telegram_nonce", nonce: "a".repeat(32) }, unit16Deps({ refreshRuntime: async () => ({ ok: false, reason: "missing", itemPath: "x", error: "x" }) }))
    await reject({ operation: "send_telegram_nonce", nonce: "a".repeat(32) }, unit16Deps({ refreshRuntime: async () => refreshed({ telegramBotToken: "x", telegramAuthorizedChatId: "0" }) }))
    await reject({ operation: "send_telegram_nonce", nonce: "a".repeat(32) }, unit16Deps({ refreshRuntime: async () => refreshed({ telegramBotToken: "x", telegramAuthorizedChatId: "1" }), fetch: async () => { throw new Error("private") } }))
    await reject({ operation: "send_telegram_nonce", nonce: "a".repeat(32) }, unit16Deps({ refreshRuntime: async () => refreshed({ telegramBotToken: "x", telegramAuthorizedChatId: "1" }), fetch: async () => jsonResponse({ ok: false }, 400) }))
    await reject({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "1", authorizedChatId: "2" }, unit16Deps({ mergeRuntime: async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) }))
    await reject({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "1", authorizedChatId: "2" }, unit16Deps({ mergeRuntime: async () => refreshed({ telegramBotToken: "other" }) }))
    await reject({ operation: "snapshot", schema: "telegram-cursor-v1" }, unit16Deps({ readFixedFile: () => '{"nextUpdateId":-1}' }))
    await reject({ operation: "snapshot", schema: "telegram-cursor-v1" }, { ...unit16Deps(), readFixedFile: undefined })
    for (const concurrency of [1, 17, 2.5]) await reject({ operation: "inject_callbacks_concurrently", update: { callback_query: {} }, concurrency })
    await reject({ operation: "inject_callbacks_concurrently", update: {}, concurrency: 2 })
    await reject({ operation: "inject_callback_replay", update: { callback_query: {} } }, { ...unit16Deps(), callbackProbe: undefined })
    await reject({ operation: "inventory_keys", targetServerId: "other" })
    for (const permissions of [[], ["bad"], ["ARRAY:READ_ANY", "ARRAY:READ_ANY"]]) await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Admin", permissions: ["ARRAY:READ_ANY"] })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions: ["ARRAY:READ_ANY"] })
    const read = READ_PERMISSIONS.map((permission) => `${permission.resource}:READ_ANY`)
    const write = [...read, "DOCKER:UPDATE_ANY"]
    const createDeps = (created: unknown, mergeMachine = async (_agent: string, _machine: string, patch: Record<string, unknown>) => refreshed(patch)) => unit16Deps({
      execFile: async () => ({ status: 0, stdout: JSON.stringify(created) }), mergeMachine,
    })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions: read }, createDeps({ id: "id", name: "wrong", key: "k", permissions: read, roles: [] }))
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RW temp", permissions: write }, createDeps({ id: "id", name: "Butler RW temp", key: "k", permissions: write, roles: [] }, async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" })))
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "other", keyId: "id", key: "x" })
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "id", key: "wrong" })
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed({ unraidReadApiKey: "x", sanctuaryAcceptanceKeyHandles: { id: "y" } }) }))
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "bad" })
    const probeConfig = { unraidGraphqlUrl: "http://127.0.0.1/graphql", sanctuaryAcceptanceKeyHandles: { id: "k" } }
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed(probeConfig), fetch: async () => { throw new Error("x") } }))
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed(probeConfig), fetch: async () => jsonResponse({ errors: [{}] }, 403) }))
    await reject({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "id" })
    await reject({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "id" }, unit16Deps({ readKeyRecords: () => [{ id: "id", name: "Old", permissions: READ_PERMISSIONS, roles: [], key: "k" }], mergeMachine: async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) }))
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "bad" })
    const revokedDeps = (status: number, ok = true) => unit16Deps({ refreshMachine: async () => refreshed({ unraidGraphqlUrl: "http://127.0.0.1/graphql", sanctuaryAcceptanceKeyHandles: { id: "k" } }), fetch: async () => jsonResponse({}, status), mergeMachine: async () => ok ? refreshed({}) : ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) })
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(200))
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(401, false))
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(403))).resolves.toMatchObject({ valid: false, status: 403 })
    await reject({ operation: "capture_evidence_provenance", schema: "bad" })
    await reject({ operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" }, unit16Deps({ readFixedFile: () => "bad" }))
    await reject({ operation: "evidence_snapshot", schema: "bad" })
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":true,"extra":1}' : "a".repeat(64) }))
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":"yes"}' : "a".repeat(64) }))
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":true}' : "bad" }))
    await reject({ operation: "request_reboot", targetId: "other", idempotencyKey: "a".repeat(32) })
    await reject({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "bad" })
    await reject({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "a".repeat(32) }, unit16Deps({ readFixedFile: () => "!" }))
    await reject({ operation: "poll_reboot", targetId: "other", requestId: "a".repeat(64) })
    await reject({ operation: "poll_reboot", targetId: "sanctuary", requestId: "bad" })
  })

  it("maps live callback transport outcomes without exposing the approval runtime", async () => {
    const update = { callback_query: {} }
    const base = (result: Record<string, unknown>, refresh = async () => refreshed({})) => ({
      refresh,
      credentials: () => ({ botToken: "secret", authorizedUserId: "1", authorizedChatId: "2" }),
      identityKey: () => "a".repeat(43),
      createApi: () => ({ stop: vi.fn() }) as any,
      createRuntime: () => ({ transport: { handleUpdate: async () => result }, close: vi.fn() }) as any,
      toolContext: () => ({} as any),
    })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({ handled: true, accepted: true, reason: "accepted" }))).resolves.toEqual({ settled: true, claimed: true, mutated: true })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({ handled: true, accepted: false, reason: "decision_refused" }))).resolves.toEqual({ settled: true, claimed: true, mutated: false })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, true, base({ handled: true, accepted: false, reason: "stale_callback" }))).resolves.toEqual({ settled: true, claimed: false, mutated: false })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({}, async () => ({ ok: false, reason: "missing", itemPath: "x", error: "x" })))).rejects.toThrow(/unavailable/u)
  })

  it("loads fixed default adapter records and files", () => {
    const root = fs.mkdtempSync("/tmp/ouro-default-acceptance-")
    const keyFile = `${root}/key.json`
    fs.writeFileSync(keyFile, JSON.stringify({ id: "id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [], key: "secret" }))
    try {
      const deps = createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: root })
      expect(deps.readKeyRecords?.()).toEqual([expect.objectContaining({ id: "id", key: "secret" })])
      expect(deps.readFixedFile?.(keyFile)).toContain('"id":"id"')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses every ambiguous vault capability proof envelope", async () => {
    const run = (capability: "read-only" | "bounded-write", writeBody: unknown, status = 200) => {
      const permissions = capability === "read-only" ? READ_PERMISSIONS : READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER" ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] } : permission)
      const record = { id: `${capability}-id`, name: capability === "read-only" ? "Butler RO" : "Butler RW", permissions, roles: [], key: `${capability}-secret` }
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ data: { info: {} } })).mockResolvedValueOnce(jsonResponse(writeBody, status)) as typeof fetch
      return executeSanctuaryAcceptanceVaultProbe(record.id, capability, {
        refresh: async () => refreshed({ unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: record.key, unraidWriteApiKey: record.key }),
        readKeyRecords: () => [record], fetch: fetchImpl,
      })
    }
    await expect(run("read-only", { data: {} }, 403)).rejects.toThrow(/denial/u)
    await expect(run("read-only", { errors: [] })).rejects.toThrow(/denial/u)
    await expect(run("bounded-write", { data: {} })).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", { errors: [{ extensions: { code: "NOT_FOUND" } }] }, 500)).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", { errors: [{ extensions: null }, { extensions: { code: 1 } }] })).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", {})).rejects.toThrow(/not-found/u)
  })

  it("loads only the selected mounted key record for vault proof", () => {
    const root = fs.mkdtempSync("/tmp/ouro-selected-unraid-key-")
    const selected = `${root}/selected.json`
    fs.writeFileSync(selected, JSON.stringify({
      id: "read-id",
      name: "Butler RO",
      permissions: READ_PERMISSIONS,
      roles: [],
      key: "read-descriptor",
    }))
    try {
      const deps = createSanctuaryAcceptanceVaultProbeDependencies({ keyRecordPath: selected })
      expect(deps.readKeyRecords()).toEqual([expect.objectContaining({ id: "read-id", key: "read-descriptor" })])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("binds the read-only vault descriptor to the exact key ID and proves write denial", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] })) as typeof fetch
    const deps = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [
        { id: "read-id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [], key: "read-descriptor" },
        { id: "write-id", name: "Butler RW", permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
          ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
          : permission), roles: [], key: "write-descriptor" },
      ],
      fetch: fetchImpl,
    }

    await expect(executeSanctuaryAcceptanceVaultProbe("read-id", "read-only", deps)).resolves.toEqual({
      valid: true,
      keyId: "read-id",
      capability: "read-only",
      proof: "read-authorized-write-denied",
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: READ_QUERY, variables: {} }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: WRITE_QUERY, variables: { id: MISSING_CONTAINER_ID } }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
  })

  it("binds the bounded-write descriptor to exact metadata and proves harmless mutation authorization", async () => {
    const writeKey = {
      id: "write-id",
      name: "Butler RW",
      permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
        ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
        : permission),
      roles: [],
      key: "write-descriptor",
    }
    const base = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [writeKey],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Container not found", extensions: { code: "NOT_FOUND" } }] })) as typeof fetch

    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", { ...base, fetch: fetchImpl })).resolves.toEqual({
      valid: true,
      keyId: "write-id",
      capability: "bounded-write",
      proof: "read-authorized-write-reached-not-found",
    })
    expect(JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      query: WRITE_QUERY,
      variables: { id: MISSING_CONTAINER_ID },
    })

    await expect(executeSanctuaryAcceptanceVaultProbe("other-id", "bounded-write", {
      ...base,
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/descriptor.*exact key ID/iu)
    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", {
      ...base,
      readKeyRecords: () => [{ ...writeKey, permissions: READ_PERMISSIONS }],
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/scope/iu)
  })

  it("packages explicit vault and revoked probe modes without putting descriptors in argv", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-adapter.sh", "utf8")

    expect(wrapper).toContain("vault-probe")
    expect(wrapper).toContain("revoked-probe")
    expect(wrapper).toContain("callback-probe")
    expect(wrapper).toContain("3<&0")
    expect(wrapper).not.toMatch(/descriptor.*\$[234]/u)
  })

  it("binds a revoked raw key file from fd3 to argv ID without returning its descriptor", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }, 401)) as typeof fetch
    const rawKeyFile = JSON.stringify({ id: "revoked-id", name: "Legacy", key: "revoked-descriptor" })

    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "revoked-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).resolves.toEqual({ rejected: true, id: "revoked-id", status: 401 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:2378/graphql")
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "revoked-descriptor",
    })
    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "other-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).rejects.toThrow(/ID mismatch/u)
  })
})

function unit16Deps(overrides: Partial<SanctuaryAcceptanceAdapterDependencies> = {}): SanctuaryAcceptanceAdapterDependencies {
  return {
    readKeyFiles: () => [],
    readKeyRecords: () => [],
    readDescriptor: () => "",
    readFixedFile: () => "",
    execFile: async () => ({ status: 0, stdout: "{}" }),
    fetch: async () => jsonResponse({}),
    refreshRuntime: async () => refreshed({}),
    mergeRuntime: async (_agent, patch) => refreshed(patch),
    refreshMachine: async () => refreshed({}),
    mergeMachine: async (_agent, _machine, patch) => refreshed(patch),
    callbackProbe: async () => ({ settled: true, claimed: false, mutated: false }),
    ...overrides,
  }
}
