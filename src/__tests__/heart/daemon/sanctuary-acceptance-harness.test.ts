import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createSanctuaryAcceptanceHarnessDependencies,
  executeSanctuaryAcceptanceHarness as executeHarness,
  type AcceptanceHarnessDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-harness"
import {
  createSanctuaryAcceptanceAdapterDependencies,
  executeSanctuaryAcceptanceAdapter,
  executeSanctuaryAcceptanceVaultProbe,
  type SanctuaryAcceptanceAdapterDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-acceptance-")))
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

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function executeSanctuaryAcceptanceHarness(command: string, rawConfig: unknown, deps?: AcceptanceHarnessDependencies): Promise<void> {
  if (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)) {
    const config = rawConfig as Record<string, unknown>
    if (typeof config.evidencePath === "string" && config.evidencePath.trim() && config.allowedRoot === undefined) {
      return executeHarness(command, { allowedRoot: fs.realpathSync(path.dirname(config.evidencePath)), ...config }, deps)
    }
  }
  return executeHarness(command, rawConfig, deps)
}

describe("Sanctuary acceptance harness", () => {
  const completeEvidenceLabels = [
    "unit-12c-1-opaque-identity",
    "unit-14b-3-opaque-identity-live",
    "unit-15c-1-no-callback-terminalization",
    "unit-16a-pre-reboot-checkpoint",
    "unit-16a-reboot-request",
    "unit-16a-boot-recovery-milestones",
    "unit-16b-runtime-vault-containment",
    "unit-16c-provider-readiness",
    "unit-16d-whats-up",
    "unit-16d-1-space",
    "unit-16d-2-unauthorized",
    "unit-16e-containment-audit",
    "unit-16e-1-stop-denial",
    "unit-16e-2-restart-denial",
    "unit-16f-cron-fingerprint",
    "unit-16g-health-transition",
    "unit-16h-daily-digest",
    "unit-16i-delayed-approval",
    "unit-16j-denial",
    "unit-16k-timeout-stale",
    "unit-16l-duplicate-callback",
    "unit-16m-restart-continuation",
  ]

  const evidenceProvenance = {
    imageDigest: "a".repeat(64),
    containerDigest: "b".repeat(64),
    cursorDigest: "c".repeat(64),
  }

  const completeEvidence = (label: string, harnessSha256: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    operation: label,
    phase: "complete",
    provenance: { ...evidenceProvenance, harnessSha256 },
    evidenceDigest: sha(label),
    ...extra,
  })

  it("builds and verifies one complete redacted Unit 16 evidence bundle", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const entries = completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `${index}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const bundlePath = path.join(dir, "unit-16-evidence-bundle.json")

    await executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      entries,
      harnessPath,
    }, dependencies())
    await executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      harnessPath,
    }, dependencies())

    const bundle = evidence(bundlePath)
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      operation: "sanctuary-unit-16-evidence-bundle",
      phase: "complete",
      imageDigest: "a".repeat(64),
      containerDigest: "b".repeat(64),
      cursorDigest: "c".repeat(64),
      harnessSha256,
      bundleDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect((bundle.entries as Array<{ label: string }>).map((entry) => entry.label)).toEqual(completeEvidenceLabels)
    expect(fs.statSync(bundlePath).mode & 0o777).toBe(0o600)
  })

  it("refuses incomplete, duplicate, unsafe, and tampered Unit 16 evidence bundles", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const createEntries = (labels: string[], unsafe = false) => labels.map((label, index) => {
      const file = path.join(dir, `refusal-${index}-${Math.random()}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256, unsafe && index === 0
        ? { neutral: "123456789" }
        : {}))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const config = (name: string, entries: Array<{ label: string; path: string }>) => ({
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries,
      harnessPath,
    })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("missing", createEntries(completeEvidenceLabels.slice(1))), dependencies())).rejects.toThrow(/complete Unit 16 evidence matrix/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("duplicate", createEntries([...completeEvidenceLabels, completeEvidenceLabels[0]!])), dependencies())).rejects.toThrow(/complete Unit 16 evidence matrix/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("unsafe", createEntries(completeEvidenceLabels, true)), dependencies())).rejects.toThrow(/raw Telegram identity|sensitive/u)

    const bundlePath = path.join(dir, "tampered.json")
    await executeSanctuaryAcceptanceHarness("evidence-bundle-index", { ...config("unused", createEntries(completeEvidenceLabels)), evidencePath: bundlePath }, dependencies())
    const tampered = evidence(bundlePath)
    ;(tampered.entries as Array<Record<string, unknown>>)[0]!.sha256 = "f".repeat(64)
    fs.writeFileSync(bundlePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      harnessPath,
    }, dependencies())).rejects.toThrow(/bundle digest|entry hash/u)
  })

  it("requires exact complete per-label evidence contracts and matching live provenance", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const createEntries = (mutate: (value: Record<string, any>, index: number) => void) => completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `contract-${index}-${Math.random()}.json`)
      const value = completeEvidence(label, harnessSha256) as Record<string, any>
      mutate(value, index)
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const run = (name: string, entries: Array<{ label: string; path: string }>, packagedHarness = harnessPath) => executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries,
      harnessPath: packagedHarness,
      imageDigest: "d".repeat(64),
      containerDigest: "e".repeat(64),
      cursorDigest: "f".repeat(64),
    }, dependencies())

    for (const [name, mutate] of [
      ["schema", (value: Record<string, any>, index: number) => { if (index === 0) value.schemaVersion = 2 }],
      ["operation", (value: Record<string, any>, index: number) => { if (index === 0) value.operation = completeEvidenceLabels[1] }],
      ["phase", (value: Record<string, any>, index: number) => { if (index === 0) value.phase = "requested" }],
      ["image-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.imageDigest = "d".repeat(64) }],
      ["container-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.containerDigest = "e".repeat(64) }],
      ["cursor-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.cursorDigest = "f".repeat(64) }],
      ["harness-attestation-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.harnessSha256 = "f".repeat(64) }],
    ] as const) {
      await expect(run(name, createEntries(mutate))).rejects.toThrow(/contract|provenance|harness/u)
    }

    const changedHarness = path.join(dir, "changed-harness.js")
    fs.writeFileSync(changedHarness, "different packaged bytes\n", { mode: 0o700 })
    await expect(run("changed-harness", createEntries(() => {}), changedHarness)).rejects.toThrow(/harness/u)
  })

  it("redacts neutral-key Telegram IDs without rejecting counters or timestamps", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const entries = (extra: Record<string, unknown>) => completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `redaction-${index}-${Math.random()}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256, index === 0 ? extra : {}))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const run = (name: string, extra: Record<string, unknown>) => executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries: entries(extra),
      harnessPath,
    }, dependencies())

    await expect(run("numeric-string", { neutral: "8541786263" })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("numeric-value", { neutral: 8541786263 })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("safe-operational-values", {
      arbitraryCounter: 8541786263,
      capturedAt: 1_800_000_000_000,
      nested: { retryCount: 123_456, completedAt: "2026-08-20T12:34:56.789Z" },
    })).resolves.toBeUndefined()
  })

  it("packages an exact operator-only adapter contract and config-file invocation", () => {
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as Record<string, any>
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-harness.sh", "utf8")
    const adapterWrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-adapter.sh", "utf8")
    expect(contract).toMatchObject({
      schemaVersion: 1,
      harnessExecutable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh",
      adapterExecutable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      adapterTimeoutMs: 15_000,
      telegramTimeoutMs: 10_000,
    })
    expect(Object.keys(contract.commands).sort()).toEqual([
      "callback-inject", "cursor-delta", "cursor-snapshot", "evidence-bundle-index", "evidence-bundle-verify",
      "evidence-snapshot", "reboot-request", "reboot-resume", "telegram-bootstrap", "unraid-key-rotate",
    ])
    expect(contract.adapters).toEqual(expect.objectContaining({
      "callback-inject": expect.objectContaining({ operation: "callback-inject" }),
      "reboot-request": expect.objectContaining({ operation: "reboot-request" }),
      "unraid-key-rotate": expect.objectContaining({ operation: "unraid-key-rotate" }),
    }))
    expect(wrapper).toContain("--config")
    expect(wrapper).toContain("--contract")
    expect(adapterWrapper).toContain("sanctuary-acceptance-adapter.js")
    expect(`${wrapper}\n${adapterWrapper}\n${JSON.stringify(contract)}`).not.toMatch(/token|password|api[_-]?key/iu)
  })

  it("hard-times-out packaged adapters and Telegram network requests", async () => {
    const dir = root()
    const sleeper = path.join(dir, "sleeper.sh")
    fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 2\nprintf '{}\\n'\n", { mode: 0o700 })
    const bounded = createSanctuaryAcceptanceHarnessDependencies(3, { adapterTimeoutMs: 25 })
    const started = Date.now()
    await expect(bounded.runAdapter(sleeper, {})).rejects.toThrow(/timed out/u)
    expect(Date.now() - started).toBeLessThan(1_000)

    vi.useFakeTimers()
    try {
      const evidencePath = path.join(dir, "telegram-timeout.json")
      const deps = dependencies({ secret: "descriptor-secret" }) as AcceptanceHarnessDependencies & { telegramTimeoutMs: number }
      deps.telegramTimeoutMs = 25
      deps.fetch = vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
      })) as typeof fetch
      const pending = executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
        allowedRoot: dir,
        evidencePath,
        offsetPath: path.join(dir, "offset.json"),
        expectedBotId: "8541786263",
        expectedUsername: "MendelowCloudButlerBot",
        currentOffset: 0,
        nonceAdapter: "/safe/send",
        vaultAdapter: "/safe/vault",
      }, deps)
      const assertion = expect(pending).rejects.toThrow(/timed out/u)
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses fixed outgoing argv and requests for the four legacy-key lifecycle operations", async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const keyFiles = [
      { id: "read-id", name: "Butler RO", permissions: readPermissions, roles: [] },
      { id: "write-id", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER" ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] } : permission), roles: [] },
      { id: "legacy-id", name: "Legacy Write", permissions: [{ resource: "API_KEY", actions: ["DELETE_ANY"] }], roles: [] },
      { id: "legacy-read-id", name: "Legacy Read", permissions: readPermissions, roles: [] },
    ]
    const adapterDeps: SanctuaryAcceptanceAdapterDependencies = {
      readKeyFiles: () => keyFiles,
      readDescriptor: () => JSON.stringify({ keyId: "legacy-id", descriptor: "revoked-secret" }),
      execFile: async (executable, args) => {
        calls.push({ executable, args })
        return args.includes("--delete")
          ? { status: 0, stdout: JSON.stringify({ deleted: 1, keys: [{ id: args.includes("Legacy Read") ? "legacy-read-id" : "legacy-id", name: args.at(-3) }] }) }
          : { status: 0, stdout: JSON.stringify({ valid: true, keyId: args.at(-2), capability: args.at(-1) }) }
      },
      fetch: async (input, init) => {
        requests.push({ url: String(input), init })
        return jsonResponse({ errors: [{ message: "Unauthorized" }] }, 401)
      },
    }
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "vault-backed-capability-verify", keyId: "read-id", capability: "read-only",
    }, adapterDeps)).resolves.toEqual({ verified: true, keyId: "read-id", capability: "read-only" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, adapterDeps)).resolves.toEqual({
      keys: [
        { id: "legacy-id", scope: "legacy-write", roles: "none" },
        { id: "legacy-read-id", scope: "read-only", roles: "none" },
        { id: "read-id", scope: "read-only", roles: "none" },
        { id: "write-id", scope: "bounded-write", roles: "none" },
      ],
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "legacy-id" }, adapterDeps)).resolves.toEqual({ revoked: true, id: "legacy-id" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "legacy-read-id" }, adapterDeps)).resolves.toEqual({ revoked: true, id: "legacy-read-id" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "revoked-key-auth-rejection", keyId: "legacy-id", endpoint: "http://127.0.0.1:2378/graphql",
    }, adapterDeps)).resolves.toEqual({ rejected: true, id: "legacy-id", status: 401 })

    expect(calls).toContainEqual({
      executable: "/usr/bin/docker",
      args: ["exec", "-i", "ouro-butler-staging", "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh", "vault-probe", "read-id", "read-only"],
    })
    expect(calls).toContainEqual({
      executable: "/usr/local/sbin/unraid-api",
      args: ["apikey", "--name", "Legacy Write", "--delete", "--json"],
    })
    expect(calls).toContainEqual({
      executable: "/usr/local/sbin/unraid-api",
      args: ["apikey", "--name", "Legacy Read", "--delete", "--json"],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:2378/graphql",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "revoked-secret" },
        body: JSON.stringify({ query: "query AcceptanceAuthProbe { info { os { hostname } } }", variables: {} }),
        signal: expect.any(AbortSignal),
      },
    })

    for (const permissions of [
      [{ resource: "DOCKER", actions: ["EXEC_ANY"] }],
      [{ resource: "DOCKER", actions: ["READ_ANY"], addedAuthority: true }],
    ]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, {
        ...adapterDeps,
        readKeyFiles: () => [{ id: "bad", name: "Bad", permissions, roles: [] }],
      })).rejects.toThrow(/permission/u)
    }

    const unsafeDirectory = path.join(root(), "keys")
    fs.mkdirSync(unsafeDirectory, { mode: 0o700 })
    fs.symlinkSync("missing.json", path.join(unsafeDirectory, "unexpected.json"))
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" },
      createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: unsafeDirectory }))).rejects.toThrow(/unexpected key directory entry/u)
  })

  it("runs the packaged inner vault probe through injected vault and network boundaries", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const refresh = vi.fn(async () => ({
      ok: true as const,
      itemPath: "vault:opaque",
      revision: "opaque",
      updatedAt: "2026-08-20T00:00:00.000Z",
      config: { unraidGraphqlUrl: "http://127.0.0.1:2378/graphql", unraidReadApiKey: "read-descriptor", unraidWriteApiKey: "write-descriptor" },
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.startsWith("mutation") && (init?.headers as Record<string, string>)["x-api-key"] === "read-descriptor") {
        return jsonResponse({ errors: [{ extensions: { code: "FORBIDDEN" } }] })
      }
      if (body.query.startsWith("mutation")) return jsonResponse({ errors: [{ extensions: { code: "NOT_FOUND" } }] })
      return jsonResponse({ data: { info: { os: { hostname: "opaque" } } } })
    }) as typeof fetch
    const readKeyRecords = () => [
      { id: "read-id", name: "Butler RO", permissions: readPermissions, roles: [], key: "read-descriptor" },
      { id: "write-id", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER"
        ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
        : permission), roles: [], key: "write-descriptor" },
    ]
    await expect(executeSanctuaryAcceptanceVaultProbe("read-id", "read-only", { refresh, readKeyRecords, fetch: fetchImpl })).resolves.toEqual({
      valid: true, keyId: "read-id", capability: "read-only", proof: "read-authorized-write-denied",
    })
    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", { refresh, readKeyRecords, fetch: fetchImpl })).resolves.toEqual({
      valid: true, keyId: "write-id", capability: "bounded-write", proof: "read-authorized-write-reached-not-found",
    })
    expect(requests.map((request) => request.init?.headers)).toEqual([
      { "content-type": "application/json", "x-api-key": "read-descriptor" },
      { "content-type": "application/json", "x-api-key": "read-descriptor" },
      { "content-type": "application/json", "x-api-key": "write-descriptor" },
      { "content-type": "application/json", "x-api-key": "write-descriptor" },
    ])
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:2378/graphql",
      init: { method: "POST", body: JSON.stringify({ query: "query AcceptanceAuthProbe { info { os { hostname } } }", variables: {} }), signal: expect.any(AbortSignal) },
    })
  })

  it("fails closed across packaged adapter filesystem, subprocess, inventory, revoke, and probe errors", async () => {
    const dir = root()
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const valid = { id: "key-id", name: "Butler RO", permissions: readPermissions, roles: [] }
    const deps = (keys: any[] = [valid], overrides: Partial<SanctuaryAcceptanceAdapterDependencies> = {}): SanctuaryAcceptanceAdapterDependencies => ({
      readKeyFiles: () => keys,
      readDescriptor: () => JSON.stringify({ keyId: "key-id", descriptor: "descriptor" }),
      execFile: async () => ({ status: 0, stdout: JSON.stringify({ valid: true, keyId: "key-id", capability: "read-only" }) }),
      fetch: async () => jsonResponse({}, 401),
      ...overrides,
    })
    await expect(executeSanctuaryAcceptanceAdapter(null, deps())).rejects.toThrow(/object/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "" }, deps())).rejects.toThrow(/nonempty/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "unknown" }, deps())).rejects.toThrow(/unknown/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "bad id", capability: "read-only" }, deps())).rejects.toThrow(/keyId/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "key-id", capability: "admin" }, deps())).rejects.toThrow(/capability/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "key-id", capability: "read-only" }, deps([], { execFile: async () => ({ status: 0, stdout: "{}" }) }))).rejects.toThrow(/verification failed/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([valid, { ...valid }]))).rejects.toThrow(/duplicate IDs/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([valid, { ...valid, id: "other" }]))).rejects.toThrow(/duplicate names/u)
    for (const permissions of [null, [{ resource: "UNKNOWN", actions: ["READ_ANY"] }], [{ resource: "DOCKER", actions: [] }]]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, permissions }]))).rejects.toThrow(/permission/u)
    }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, roles: [1] }]))).rejects.toThrow(/roles/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "absent" }, deps())).rejects.toThrow(/absent or ambiguous/u)
    for (const stdout of [JSON.stringify({ deleted: 0 }), JSON.stringify({ deleted: 1, keys: [{ id: "other", name: "Butler RO" }] })]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "key-id" }, deps([], {
        readKeyFiles: () => [valid], execFile: async () => ({ status: 0, stdout }),
      }))).rejects.toThrow(/revoke/u)
    }
    for (const endpoint of ["ftp://127.0.0.1/graphql", "http://example.com/graphql", "http://127.0.0.1/not-graphql", "http://user@127.0.0.1/graphql", "http://127.0.0.1/graphql?q=1"]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint }, deps())).rejects.toThrow(/loopback/u)
    }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { readDescriptor: () => "{}" }))).rejects.toThrow(/shape/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { readDescriptor: () => JSON.stringify({ keyId: "other", descriptor: "x" }) }))).rejects.toThrow(/ID mismatch/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { fetch: async () => jsonResponse({}, 200) }))).rejects.toThrow(/authentication rejection/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { fetch: async () => jsonResponse({}, 403) }))).resolves.toMatchObject({ rejected: true, status: 403 })

    const keyDirectory = path.join(dir, "valid-keys")
    fs.mkdirSync(keyDirectory, { mode: 0o700 })
    fs.writeFileSync(path.join(keyDirectory, "key.json"), JSON.stringify({ ...valid, key: "never-returned" }), { mode: 0o600 })
    const descriptorPath = path.join(dir, "descriptor.json")
    fs.writeFileSync(descriptorPath, JSON.stringify({ keyId: "key-id", descriptor: "descriptor" }), { mode: 0o600 })
    const descriptorFd = fs.openSync(descriptorPath, "r")
    const defaults = createSanctuaryAcceptanceAdapterDependencies(descriptorFd, { keyDirectory, adapterTimeoutMs: 25 })
    createSanctuaryAcceptanceAdapterDependencies()
    try {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, defaults)).resolves.toMatchObject({ keys: [{ id: "key-id" }] })
      expect(JSON.parse(defaults.readDescriptor())).toMatchObject({ keyId: "key-id" })
    } finally { fs.closeSync(descriptorFd) }
    const success = path.join(dir, "adapter-success.sh")
    const failed = path.join(dir, "adapter-failed.sh")
    const sleeping = path.join(dir, "adapter-sleeping.sh")
    fs.writeFileSync(success, "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o700 })
    fs.writeFileSync(failed, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    fs.writeFileSync(sleeping, "#!/bin/sh\nsleep 2\n", { mode: 0o700 })
    await expect(defaults.execFile(success, [])).resolves.toMatchObject({ status: 0, stdout: "{}\n" })
    await expect(defaults.execFile(failed, [])).rejects.toThrow(/failed/u)
    await expect(defaults.execFile(sleeping, [])).rejects.toThrow(/timed out/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, roles: ["ADMIN"] }]))).resolves.toMatchObject({ keys: [{ roles: "present" }] })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([], { readKeyFiles: () => { throw "opaque" } }))).rejects.toBe("opaque")

    const invalidRolesDirectory = path.join(dir, "invalid-roles")
    fs.mkdirSync(invalidRolesDirectory, { mode: 0o700 })
    fs.writeFileSync(path.join(invalidRolesDirectory, "key.json"), JSON.stringify({ ...valid, roles: [1] }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" },
      createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: invalidRolesDirectory }))).rejects.toThrow(/roles/u)
  })

  it("fails closed across inner vault-probe readiness and response branches", async () => {
    const ready = { ok: true as const, itemPath: "vault:opaque", revision: "opaque", updatedAt: "2026-08-20T00:00:00.000Z", config: { unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: "r", unraidWriteApiKey: "w" } }
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const run = (capability: string, refreshResult: any = ready, response = jsonResponse({ data: {} })) => executeSanctuaryAcceptanceVaultProbe("key", capability, {
      refresh: async () => refreshResult,
      readKeyRecords: () => [
        { id: "key", name: "Butler RO", permissions: readPermissions, roles: [], key: "r" },
        { id: "key", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER"
          ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
          : permission), roles: [], key: "w" },
      ],
      fetch: async () => response,
    })
    await expect(executeSanctuaryAcceptanceVaultProbe("key", "invalid")).rejects.toThrow(/capability/u)
    await expect(run("read-only", { ok: false, reason: "missing", itemPath: "vault:opaque", error: "missing" })).rejects.toThrow(/unavailable/u)
    await expect(run("read-only", { ...ready, config: { ...ready.config, unraidGraphqlUrl: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("read-only", { ...ready, config: { ...ready.config, unraidReadApiKey: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("bounded-write", { ...ready, config: { ...ready.config, unraidWriteApiKey: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("read-only", ready, jsonResponse({}, 500))).rejects.toThrow(/probe failed/u)
    await expect(run("read-only", ready, jsonResponse({ errors: [{}] }))).rejects.toThrow(/rejected/u)
  })

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
    expect(evidence(evidencePath)).toMatchObject({ operation: "telegram-bootstrap", phase: "complete", offsetDigest: sha(42) })
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
      expect(payload).toEqual({ operation: "snapshot", schema: "telegram-cursor-v1" })
      return { offsetDigest: createHash("sha256").update(String(offset)).digest("hex"), auditCursorDigest: createHash("sha256").update(String(offset + 5)).digest("hex"), ignoredToken: "must-not-persist" }
    } })
    const config = { adapters: [{ schema: "telegram-cursor-v1", executable: "/safe/snapshot" }] }
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: before, ...config }, deps)
    offset = 11
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: after, ...config }, deps)
    await executeSanctuaryAcceptanceHarness("cursor-delta", { evidencePath: delta, beforePath: before, afterPath: after }, deps)
    expect(evidence(before)).toMatchObject({ operation: "cursor-snapshot", values: { "telegram-cursor-v1.offsetDigest": createHash("sha256").update("10").digest("hex"), "telegram-cursor-v1.auditCursorDigest": createHash("sha256").update("15").digest("hex") } })
    expect(evidence(delta)).toMatchObject({ operation: "cursor-delta", changes: { "telegram-cursor-v1.offsetDigest": expect.any(Object), "telegram-cursor-v1.auditCursorDigest": expect.any(Object) } })
    expect(fs.readFileSync(before, "utf8")).not.toContain("must-not-persist")
  })

  it("injects one saved callback concurrently and proves one-shot mutation plus replay denial", async () => {
    const dir = root()
    const calls: unknown[] = []
    const update = { update_id: 99, callback_query: { id: "opaque", from: { id: 111 }, data: "a:opaque", message: { message_id: 4, chat: { id: 222 } } } }
    await executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "callback.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({
      secret: JSON.stringify(update),
      adapter: async (executable, payload) => {
        expect(executable).toBe("/safe/inject")
        calls.push(payload)
        return (payload as { operation: string }).operation === "inject_callbacks_concurrently"
          ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
          : { settled: true, claimed: false, mutated: false }
      },
    }))
    expect(calls).toEqual([
      { operation: "inject_callbacks_concurrently", update, concurrency: 2 },
      { operation: "inject_callback_replay", update },
    ])
    const raw = fs.readFileSync(path.join(dir, "callback.json"), "utf8")
    expect(raw).not.toContain("a:opaque")
    expect(evidence(path.join(dir, "callback.json"))).toMatchObject({ phase: "complete", claims: 1, mutations: 1, replayMutated: false })
  })

  it("rejects malformed callback material and unexpected callback totals before claiming success", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "bad.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({ secret: "{}" }))).rejects.toThrow(/callback_query/u)

    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "totals.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({
      secret: JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } }),
      adapter: async () => ({ results: [{ settled: true, claimed: true, mutated: false }, { settled: true, claimed: false, mutated: false }] }),
    }))).rejects.toThrow(/mutation total/u)
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
        if (inventoryCount === 1) return { keys: [{ id: "legacy-read", name: "Legacy", permissions: permissions, roles: [] }] }
        if (inventoryCount === 2) return { keys: [
          { id: "legacy-read", name: "Legacy", permissions, roles: [] },
          { id: "ro-id", name: "Butler RO", permissions, roles: [] },
          { id: "rw-id", name: "Butler RW", permissions: [...permissions, "DOCKER:UPDATE_ANY"], roles: [] },
        ] }
        return {
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
      evidencePath: file, schema: "postboot-health-v1", adapter: "/safe/health",
    }, dependencies({ adapter: async (_executable, payload) => {
      expect(payload).toEqual({ operation: "evidence_snapshot", schema: "postboot-health-v1" })
      return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64), apiToken: "secret" }
    } }))
    const saved = evidence(file)
    expect(saved).toMatchObject({ operation: "evidence-snapshot", schema: "postboot-health-v1", values: { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } })
    expect(saved).not.toHaveProperty("payloadDigest")
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
        if (executable === "/safe/reboot") return { accepted: true, targetId: "sanctuary", requestId: "request-1", prebootId: "boot-1" }
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
    expect(requested).toMatchObject({ phase: "requested", targetId: "sanctuary", requestId: "request-1", prebootDigest: sha("boot-1") })
    await executeSanctuaryAcceptanceHarness("reboot-resume", {
      evidencePath: file, adapter: "/safe/poll", timeoutMs: 100, intervalMs: 1,
    }, deps)
    expect(calls.filter((call) => call.executable === "/safe/reboot")).toHaveLength(1)
    expect(calls.filter((call) => call.executable === "/safe/poll")[0]!.payload).toEqual({ operation: "poll_reboot", targetId: "sanctuary", requestId: "request-1" })
    expect(evidence(file)).toMatchObject({ phase: "complete", targetId: "sanctuary", requestId: "request-1", postbootDigest: sha("boot-2") })
  })

  it("refuses duplicate reboot requests and fails resume on target drift or timeout", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    fs.writeFileSync(file, JSON.stringify({ operation: "reboot", phase: "requested", targetId: "sanctuary", requestId: "r", prebootDigest: sha("before") }), { mode: 0o600 })
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

  it("rejects unsupported snapshot schemas and unknown commands", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      evidencePath: path.join(dir, "bad.json"), schema: "unsupported", adapter: "/adapter",
    }, dependencies())).rejects.toThrow(/unsupported standalone evidence schema/u)
    await expect(executeSanctuaryAcceptanceHarness("nope", {}, dependencies())).rejects.toThrow(/unknown Sanctuary acceptance command/u)
  })

  it("ships an executable descriptor-only wrapper in deploy/unraid", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-harness.sh", "utf8")
    expect(wrapper).toContain('import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-harness.js")')
    expect(wrapper).toContain("module.executeSanctuaryAcceptanceHarness")
    expect(wrapper).toContain('3<&3')
    expect(wrapper).not.toMatch(/token|password|api[_-]?key/iu)
  })

  it("runs descriptor-only adapter executables with a minimal environment and redacted failures", async () => {
    const dir = root()
    const success = path.join(dir, "success.sh")
    const invalid = path.join(dir, "invalid.sh")
    const failed = path.join(dir, "failed.sh")
    const oversized = path.join(dir, "oversized.sh")
    fs.writeFileSync(success, "#!/bin/sh\nread payload\nprintf '{\"payload\":%s}' \"$payload\"\n", { mode: 0o700 })
    fs.writeFileSync(invalid, "#!/bin/sh\nprintf nope\n", { mode: 0o700 })
    fs.writeFileSync(failed, "#!/bin/sh\nexit 7\n", { mode: 0o700 })
    fs.writeFileSync(oversized, "#!/bin/sh\nhead -c 1048577 /dev/zero\n", { mode: 0o700 })
    const secretFile = path.join(dir, "descriptor")
    fs.writeFileSync(secretFile, "descriptor-secret")
    const secretFd = fs.openSync(secretFile, "r")
    const deps = createSanctuaryAcceptanceHarnessDependencies(secretFd)
    expect(deps.readSecret()).toBe("descriptor-secret")
    fs.closeSync(secretFd)
    expect(await deps.runAdapter(success, { safe: true })).toEqual({ payload: { safe: true } })
    await expect(deps.runAdapter(invalid, {})).rejects.toThrow(/invalid JSON/u)
    await expect(deps.runAdapter(failed, {})).rejects.toThrow(/adapter failed/u)
    await expect(deps.runAdapter(oversized, {})).rejects.toThrow(/output exceeded/u)
    await expect(deps.runAdapter(path.join(dir, "absent"), {})).rejects.toThrow(/adapter failed/u)
    await expect(deps.runAdapter("relative", {})).rejects.toThrow(/absolute/u)
    expect(typeof deps.fetch).toBe("function")
    expect(Number.isFinite(deps.now())).toBe(true)
    expect(deps.randomBytes(2)).toHaveLength(2)
    await expect(deps.sleep(0)).resolves.toBeUndefined()
    const previousPath = process.env.PATH
    delete process.env.PATH
    try { expect(await createSanctuaryAcceptanceHarnessDependencies().runAdapter(success, { fallback: true })).toEqual({ payload: { fallback: true } }) }
    finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
  })

  it("fails closed across malformed configs, selectors, Telegram responses, and private checkpoint rules", async () => {
    const dir = root()
    const reject = async (command: string, config: unknown, deps = dependencies(), pattern?: RegExp) => {
      const promise = executeSanctuaryAcceptanceHarness(command, config, deps)
      if (pattern) await expect(promise).rejects.toThrow(pattern)
      else await expect(promise).rejects.toThrow()
    }
    await reject("cursor-snapshot", null, undefined, /object/u)
    await reject("cursor-snapshot", { allowedRoot: dir, evidencePath: "", adapters: [] }, undefined, /nonempty text/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "empty.json"), adapters: [] }, undefined, /nonempty/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "bad-adapter.json"), adapters: [{ schema: "telegram-cursor-v1", executable: "relative" }] }, undefined, /absolute/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "duplicate-schema.json"), adapters: [{ schema: "telegram-cursor-v1", executable: "/x" }, { schema: "telegram-cursor-v1", executable: "/y" }] }, dependencies({ adapter: async () => ({ offsetDigest: "a".repeat(64), auditCursorDigest: "b".repeat(64) }) }), /unique/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "bad-schema.json"), adapters: [{ schema: "postboot-health-v1", executable: "/x" }] }, undefined, /unsupported/u)
    const existingSnapshot = path.join(dir, "existing-snapshot.json")
    fs.writeFileSync(existingSnapshot, "{}\n", { mode: 0o600 })
    let existingEvidenceAdapterCalls = 0
    const existingEvidenceDeps = dependencies({ adapter: async () => { existingEvidenceAdapterCalls += 1; return { ok: true } } })
    await reject("cursor-snapshot", { evidencePath: existingSnapshot, adapters: [{ schema: "telegram-cursor-v1", executable: "/x" }] }, existingEvidenceDeps, /inspect-before-retry/u)
    await reject("evidence-snapshot", { evidencePath: existingSnapshot, schema: "postboot-health-v1", adapter: "/x" }, existingEvidenceDeps, /inspect-before-retry/u)
    expect(existingEvidenceAdapterCalls).toBe(0)
    await reject("evidence-snapshot", { evidencePath: path.join(dir, "invalid-digest.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "raw", telegramOffsetDigest: "b".repeat(64) }) }), /opaque sha256/u)
    await reject("evidence-snapshot", { evidencePath: path.join(dir, "invalid-health.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: "yes", containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }), /boolean/u)
    const publicDir = path.join(dir, "public")
    fs.mkdirSync(publicDir, { mode: 0o755 })
    await reject("evidence-snapshot", { allowedRoot: publicDir, evidencePath: path.join(publicDir, "evidence.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies(), /allowed root must be private/u)
    const privateFile = path.join(dir, "not-private.json")
    fs.writeFileSync(privateFile, JSON.stringify({ values: {} }), { mode: 0o644 })
    await reject("cursor-delta", { evidencePath: path.join(dir, "delta-private.json"), beforePath: privateFile, afterPath: privateFile }, undefined, /owned private file/u)
    const longPath = path.join(dir, "x".repeat(300))
    await reject("evidence-snapshot", { evidencePath: longPath, schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }))

    const telegramConfig = (name: string) => ({
      evidencePath: path.join(dir, `${name}.json`), offsetPath: path.join(dir, `${name}-offset.json`),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
      nonceAdapter: "/send", vaultAdapter: "/vault",
    })
    await reject("telegram-bootstrap", telegramConfig("empty-token"), dependencies({ secret: "" }), /empty/u)
    await reject("telegram-bootstrap", telegramConfig("bad-json"), dependencies({ secret: "t", fetch: async () => new Response("nope") }), /invalid JSON/u)
    await reject("telegram-bootstrap", telegramConfig("api-fail"), dependencies({ secret: "t", fetch: async () => jsonResponse({ ok: false }, 401) }), /request failed/u)
    await reject("telegram-bootstrap", telegramConfig("send-fail"), dependencies({
      secret: "t", fetch: async () => jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }),
      adapter: async () => ({ sent: false }),
    }), /did not confirm/u)
    await reject("telegram-bootstrap", telegramConfig("updates-shape"), dependencies({
      secret: "t", fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: {} }),
      adapter: async () => ({ sent: true }),
    }), /must be an array/u)
    await reject("telegram-bootstrap", telegramConfig("invalid-update-shapes"), dependencies({
      secret: "t", fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [{ update_id: 1, message: null }, { update_id: 2, message: { chat: null } }] }),
      adapter: async () => ({ sent: true }),
    }), /missing or ambiguous/u)
    await reject("telegram-bootstrap", telegramConfig("vault-fail"), dependencies({
      secret: "t",
      fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: [{ update_id: 1, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 1 }, chat: { id: 2, type: "private" } } }] }),
      adapter: async (executable) => executable === "/send" ? { sent: true } : { stored: false },
    }), /did not attest/u)
    const offsetDirectory = telegramConfig("offset-cleanup")
    await reject("telegram-bootstrap", offsetDirectory, dependencies({
      secret: "t",
      fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: [{ update_id: 1, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 1 }, chat: { id: 2, type: "private" } } }] }),
      adapter: async (executable) => {
        if (executable === "/send") return { sent: true }
        fs.mkdirSync(offsetDirectory.offsetPath)
        return { stored: true }
      },
    }))

    const beforeMissing = path.join(dir, "before-missing.json")
    const afterMissing = path.join(dir, "after-missing.json")
    fs.writeFileSync(beforeMissing, JSON.stringify({ values: { beforeOnly: 1, unchanged: null } }), { mode: 0o600 })
    fs.writeFileSync(afterMissing, JSON.stringify({ values: { afterOnly: 2, unchanged: null } }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("cursor-delta", {
      evidencePath: path.join(dir, "missing-delta.json"), beforePath: beforeMissing, afterPath: afterMissing,
    }, dependencies())).rejects.toThrow(/exact complete cursor snapshot/u)
  })

  it("covers callback refusal variants and preserves redacted failed checkpoints", async () => {
    const dir = root()
    const update = JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } })
    const run = async (name: string, response: unknown, overrides: Record<string, unknown> = {}) => executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, `${name}.json`), adapter: "/inject", concurrency: 2, ...overrides,
    }, dependencies({ secret: update, adapter: async (_executable, payload) => (payload as { operation: string }).operation === "inject_callbacks_concurrently"
      ? { results: [response, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: false, mutated: false } }))
    await expect(run("settled", { settled: false, claimed: false, mutated: false })).rejects.toThrow(/did not settle/u)
    await expect(run("claim", { settled: true, claimed: "no", mutated: false })).rejects.toThrow(/claim must be boolean/u)
    await expect(run("mutation", { settled: true, claimed: false, mutated: "no" })).rejects.toThrow(/mutation must be boolean/u)
    await expect(run("claim-total", { settled: true, claimed: false, mutated: false })).rejects.toThrow(/claim total/u)
    await expect(run("mutation-total", { settled: true, claimed: true, mutated: false })).rejects.toThrow(/mutation total/u)
    await expect(run("concurrency", { settled: true, claimed: false, mutated: false }, { concurrency: 17 })).rejects.toThrow(/exceeds/u)
    await expect(run("integer", { settled: true, claimed: false, mutated: false }, { concurrency: "one" })).rejects.toThrow(/safe integer/u)
    await expect(run("minimum", { settled: true, claimed: false, mutated: false }, { concurrency: 1 })).rejects.toThrow(/>= 2/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "json.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: "{" }))).rejects.toThrow(/valid JSON/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "replay-shape.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async (_executable, payload) => (payload as { operation: string }).operation === "inject_callbacks_concurrently"
      ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: false, mutated: undefined } }))).rejects.toThrow(/did not settle canonically/u)
    let call = 0
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "replay-mutated.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => (++call === 1 ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] } : { settled: true, claimed: false, mutated: true }) }))).rejects.toThrow(/replay was claimed or mutated/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "batch-count.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => ({ results: [] }) }))).rejects.toThrow(/result count/u)
    const cleanupPath = path.join(dir, "cleanup.json")
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: cleanupPath, adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => {
      fs.unlinkSync(cleanupPath)
      fs.mkdirSync(cleanupPath)
      return { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
    } }))).rejects.toThrow()
  })

  it("fails every Unraid create/store/probe/revoke/final-inventory mismatch without leaking raw keys", async () => {
    const dir = root()
    const base = (name: string) => ({
      evidencePath: path.join(dir, `${name}.json`), targetServerId: "target", inventoryAdapter: "/inventory",
      createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    })
    const run = async (name: string, adapterImpl: (executable: string, payload: any) => Promise<unknown>, config: any = base(name)) => {
      await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", config, dependencies({ adapter: adapterImpl }))).rejects.toThrow()
      if (fs.existsSync(config.evidencePath)) expect(fs.readFileSync(config.evidencePath, "utf8")).not.toContain("raw-secret")
    }
    await run("inventory-shape", async () => ({}))
    await run("roles-shape", async () => ({ keys: [{ id: "x", name: "x", permissions: ["P"], roles: null }] }))
    await run("old-absent", async () => ({ keys: [] }), { ...base("old-absent"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })
    await run("create-scope", async (executable) => executable === "/inventory" ? { keys: [] } : { id: "new", name: "wrong", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" })
    await run("store", async (executable, payload) => executable === "/inventory" ? { keys: [] } : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: false, keyId: payload.keyId } : { valid: true })
    await run("new-probe", async (executable) => executable === "/inventory" ? { keys: [] } : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: true, keyId: "new" } : { valid: false })
    let inventoryCall = 0
    await run("final", async (executable) => executable === "/inventory" ? (++inventoryCall === 1 ? { keys: [] } : { keys: [] }) : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: true, keyId: "new" } : { valid: true })
    await run("duplicates", async () => ({ keys: [] }), { ...base("duplicates"), keys: [{ name: "x", vaultField: "a", permissions: ["P", "P"] }] })
    await run("duplicate-names", async () => ({ keys: [] }), { ...base("duplicate-names"), keys: [{ name: "x", vaultField: "a", permissions: ["P"] }, { name: "x", vaultField: "b", permissions: ["Q"] }] })
    await run("keys-empty", async () => ({ keys: [] }), { ...base("keys-empty"), keys: [] })
    await run("old-shape", async () => ({ keys: [] }), { ...base("old-shape"), oldKeys: null })
    const existing = base("existing")
    fs.writeFileSync(existing.evidencePath, "{}\n", { mode: 0o600 })
    await run("existing", async () => ({ keys: [] }), existing)

    let phase = 0
    let revokeInventory = 0
    await run("revoke", async (executable, payload) => {
      if (executable === "/inventory") return ++revokeInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/probe") return { valid: true }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: false, id: payload.id }
      return {}
    }, { ...base("revoke"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })
    let probeInventory = 0
    await run("revoked-probe", async (executable) => {
      if (executable === "/inventory") return ++probeInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      phase += 1
      return phase === 1 ? { valid: true } : { valid: true, status: 200 }
    }, { ...base("revoked-probe"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })

    let finalInventory = 0
    await run("old-remains", async (executable, payload) => {
      if (executable === "/inventory") return ++finalInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }, { id: "old", name: "Old", permissions: ["P"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 403 }
    }, { ...base("old-remains"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })

    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      ...base("non-error"), evidencePath: path.join(dir, "non-error.json"),
    }, dependencies({ adapter: async (executable) => executable === "/inventory" ? { keys: [] } : Promise.reject("non-error") }))).rejects.toBe("non-error")
    expect(evidence(path.join(dir, "non-error.json"))).toMatchObject({ errorCategory: "unknown" })
  })

  it("fails reboot request attestations and invalid resume states", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("reboot-request", {
      evidencePath: path.join(dir, "request.json"), targetId: "sanctuary", adapter: "/reboot",
    }, dependencies({ adapter: async () => ({ accepted: false, targetId: "sanctuary" }) }))).rejects.toThrow(/exact target/u)
    expect(evidence(path.join(dir, "request.json"))).toMatchObject({ phase: "failed" })
    const invalid = path.join(dir, "invalid.json")
    fs.writeFileSync(invalid, JSON.stringify({ operation: "other", phase: "requested" }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: invalid, adapter: "/poll", timeoutMs: 1, intervalMs: 1 }, dependencies())).rejects.toThrow(/not resumable/u)
    const state = path.join(dir, "state.json")
    fs.writeFileSync(state, JSON.stringify({ operation: "reboot", phase: "requested", targetId: "t", requestId: "r", prebootDigest: sha("boot-before") }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: state, adapter: "/poll", timeoutMs: 20, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "wrong", targetId: "t", requestId: "r" }),
    }))).rejects.toThrow(/invalid state/u)
  })

  it("persists only opaque Telegram identity and offset evidence", async () => {
    const dir = root()
    const file = path.join(dir, "telegram-opaque.json")
    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      allowedRoot: dir, evidencePath: file, offsetPath: path.join(dir, "offset.json"),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 40,
      nonceAdapter: "/send", vaultAdapter: "/vault",
    }, dependencies({
      secret: "token",
      adapter: async (executable) => executable === "/send" ? { sent: true } : { stored: true },
      fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [{ update_id: 41, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 111 }, chat: { id: 222, type: "private" } } }] }),
    }))
    const raw = fs.readFileSync(file, "utf8")
    for (const forbidden of ["8541786263", "MendelowCloudButlerBot", "111", "222", "41", "42", "0123456789abcdef0123456789abcdef"]) expect(raw).not.toContain(forbidden)
    expect(evidence(file)).toMatchObject({ phase: "complete", botIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), offsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(JSON.parse(fs.readFileSync(path.join(dir, "offset.json"), "utf8"))).toEqual({ nextUpdateId: 42 })
  })

  it("locks callback totals and requires an unclaimed nonmutating replay", async () => {
    const dir = root()
    const update = JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } })
    let call = 0
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      allowedRoot: dir, evidencePath: path.join(dir, "callback.json"), adapter: "/inject", concurrency: 2,
      expectedClaims: 0, expectedMutations: 0, replay: false,
    }, dependencies({ secret: update, adapter: async () => (++call === 1
      ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: true, mutated: false }) }))).rejects.toThrow(/replay/u)
  })

  it("rejects ambiguous Unraid identities and reconciles immediately before exact revoke", async () => {
    const dir = root()
    const base = {
      allowedRoot: dir, evidencePath: path.join(dir, "keys.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "same", permissions: ["READ"] }, { name: "Butler RW", vaultField: "same", permissions: ["READ", "WRITE"] }], oldKeys: [],
    }
    let calls = 0
    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", base, dependencies({ adapter: async () => { calls += 1; return { keys: [] } } }))).rejects.toThrow(/vault fields.*unique/u)
    expect(calls).toBe(0)

    const operations: string[] = []
    let inventoryCall = 0
    await executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      ...base, evidencePath: path.join(dir, "reconciled.json"), keys: [{ name: "Butler RO", vaultField: "read", permissions: ["READ"] }], oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable, payload: any) => {
      operations.push(payload.operation)
      if (executable === "/inventory") {
        inventoryCall += 1
        if (inventoryCall === 1) return { keys: [{ id: "old", name: "Legacy", permissions: ["READ"], roles: [] }] }
        if (inventoryCall === 2) return { keys: [{ id: "old", name: "Legacy", permissions: ["READ"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] }] }
        return { keys: [{ id: "new", name: "Butler RO", permissions: ["READ"], roles: [] }] }
      }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["READ"], roles: [], key: "raw" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "old-raw" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
    } }))
    expect(operations.lastIndexOf("inventory_keys")).toBeGreaterThan(operations.indexOf("revoke_key"))
    expect(operations[operations.indexOf("revoke_key") - 2]).toBe("inventory_keys")
  })

  it("rejects any added or changed authority in the final Unraid inventory", async () => {
    const dir = root()
    const base = {
      allowedRoot: dir,
      targetServerId: "target",
      inventoryAdapter: "/inventory",
      createAdapter: "/create",
      storeAdapter: "/store",
      revokeAdapter: "/revoke",
      probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["READ"] }],
      oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }
    for (const scenario of ["added", "changed"] as const) {
      let inventoryCall = 0
      await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
        ...base, evidencePath: path.join(dir, `${scenario}.json`),
      }, dependencies({ adapter: async (executable, payload: any) => {
        if (executable === "/inventory") {
          inventoryCall += 1
          if (inventoryCall === 1) return { keys: [
            { id: "old", name: "Legacy", permissions: ["READ"], roles: [] },
            { id: "retained", name: "Retained", permissions: ["READ"], roles: [] },
          ] }
          if (inventoryCall === 2) return { keys: [
            { id: "old", name: "Legacy", permissions: ["READ"], roles: [] },
            { id: "retained", name: "Retained", permissions: ["READ"], roles: [] },
            { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] },
          ] }
          return { keys: [
            { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] },
            scenario === "added"
              ? { id: "rogue", name: "Rogue Admin", permissions: ["WRITE"], roles: ["ADMIN"] }
              : { id: "retained", name: "Retained", permissions: ["WRITE"], roles: [] },
            ...(scenario === "added" ? [{ id: "retained", name: "Retained", permissions: ["READ"], roles: [] }] : []),
          ] }
        }
        if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["READ"], roles: [], key: "raw" }
        if (executable === "/store") return { stored: true, keyId: "new" }
        if (executable === "/old") return { key: "old-raw" }
        if (executable === "/revoke") return { revoked: true, id: "old" }
        return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
      } }))).rejects.toThrow(/final Unraid key inventory mismatch/u)
      expect(evidence(path.join(dir, `${scenario}.json`))).toMatchObject({ phase: "failed" })
    }
  })

  it("uses fixed evidence schemas without hashing untrusted adapter responses", async () => {
    const dir = root()
    const file = path.join(dir, "health-fixed.json")
    await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: file, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64), value: "raw-secret" }) }))
    expect(evidence(file)).toMatchObject({ schema: "postboot-health-v1", values: { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } })
    expect(fs.readFileSync(file, "utf8")).not.toContain("raw-secret")
    expect(evidence(file)).not.toHaveProperty("payloadDigest")
  })

  it("rejects cursor deltas unless both inputs are exact complete cursor snapshots", async () => {
    const dir = root()
    const valid = {
      schemaVersion: 1,
      operation: "cursor-snapshot",
      phase: "complete",
      schema: "telegram-cursor-v1",
      capturedAt: 1_800_000_000_000,
      values: {
        "telegram-cursor-v1.offsetDigest": "a".repeat(64),
        "telegram-cursor-v1.auditCursorDigest": "b".repeat(64),
      },
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ["raw", { ...valid, values: { token: "raw-secret" } }],
      ["version", { ...valid, schemaVersion: 2 }],
      ["operation", { ...valid, operation: "evidence-snapshot" }],
      ["phase", { ...valid, phase: "failed" }],
      ["schema", { ...valid, schema: "postboot-health-v1" }],
      ["values-shape", { ...valid, values: null }],
      ["extra-key", { ...valid, values: { ...valid.values, extra: "c".repeat(64) } }],
      ["invalid-digest", { ...valid, values: { ...valid.values, "telegram-cursor-v1.offsetDigest": "not-opaque" } }],
    ]
    for (const [name, malformed] of cases) {
      const before = path.join(dir, `${name}-before.json`)
      const after = path.join(dir, `${name}-after.json`)
      const delta = path.join(dir, `${name}-delta.json`)
      fs.writeFileSync(before, JSON.stringify(malformed), { mode: 0o600 })
      fs.writeFileSync(after, JSON.stringify(valid), { mode: 0o600 })
      await expect(executeSanctuaryAcceptanceHarness("cursor-delta", {
        allowedRoot: dir, evidencePath: delta, beforePath: before, afterPath: after,
      }, dependencies())).rejects.toThrow(/cursor snapshot/u)
      expect(fs.existsSync(delta)).toBe(false)
    }
    const exactBefore = path.join(dir, "exact-before.json")
    const exactAfter = path.join(dir, "exact-after.json")
    const exactDelta = path.join(dir, "exact-delta.json")
    fs.writeFileSync(exactBefore, JSON.stringify(valid), { mode: 0o600 })
    fs.writeFileSync(exactAfter, JSON.stringify({
      ...valid,
      values: { ...valid.values, "telegram-cursor-v1.offsetDigest": "c".repeat(64) },
    }), { mode: 0o600 })
    await executeSanctuaryAcceptanceHarness("cursor-delta", {
      allowedRoot: dir, evidencePath: exactDelta, beforePath: exactBefore, afterPath: exactAfter,
    }, dependencies())
    expect(evidence(exactDelta)).toMatchObject({
      changes: { "telegram-cursor-v1.offsetDigest": { before: "a".repeat(64), after: "c".repeat(64) } },
    })
    expect((evidence(exactDelta).changes as Record<string, unknown>)).not.toHaveProperty("telegram-cursor-v1.auditCursorDigest")
  })

  it("atomically grants only one concurrent process an initial checkpoint claim", async () => {
    const dir = root()
    const compiledRoot = path.join(dir, "compiled")
    const harnessPath = path.join(compiledRoot, "heart", "daemon", "sanctuary-acceptance-harness.cjs")
    const nervesPath = path.join(compiledRoot, "nerves", "runtime.js")
    fs.mkdirSync(path.dirname(harnessPath), { recursive: true })
    fs.mkdirSync(path.dirname(nervesPath), { recursive: true })
    const source = fs.readFileSync(path.join(process.cwd(), "src", "heart", "daemon", "sanctuary-acceptance-harness.ts"), "utf8")
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    fs.writeFileSync(harnessPath, compiled)
    fs.writeFileSync(nervesPath, "exports.emitNervesEvent = () => {};\n")
    const evidencePath = path.join(dir, "claim.json")
    const mutationPath = path.join(dir, "mutations.log")
    const runnerPath = path.join(dir, "runner.cjs")
    fs.writeFileSync(runnerPath, String.raw`
const fs = require("node:fs")
const [harnessPath, allowedRoot, evidencePath, mutationPath, marker] = process.argv.slice(2)
const originalExists = fs.existsSync
let exactCalls = 0
fs.existsSync = (candidate) => {
  if (candidate === evidencePath && ++exactCalls === 2) {
    fs.writeFileSync(marker, "ready")
    const peer = marker.endsWith("-a") ? marker.slice(0, -2) + "-b" : marker.slice(0, -2) + "-a"
    const deadline = Date.now() + 5000
    while (!originalExists(peer) && Date.now() < deadline) {}
    if (!originalExists(peer)) process.exit(19)
    return false
  }
  return originalExists(candidate)
}
const { executeSanctuaryAcceptanceHarness } = require(harnessPath)
executeSanctuaryAcceptanceHarness("reboot-request", {
  allowedRoot, evidencePath, targetId: "sanctuary", adapter: "/reboot",
}, {
  readSecret: () => "",
  runAdapter: async () => {
    fs.appendFileSync(mutationPath, process.pid + "\n")
    return { accepted: true, targetId: "sanctuary", requestId: String(process.pid), prebootId: "boot-before" }
  },
  fetch: globalThis.fetch,
  now: Date.now,
  randomBytes: require("node:crypto").randomBytes,
  sleep: async () => {},
}).then(() => process.exit(0), () => process.exit(17))
`)
    const markerBase = path.join(dir, "barrier")
    const run = (suffix: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath, harnessPath, dir, evidencePath, mutationPath, `${markerBase}-${suffix}`], { stdio: "ignore" })
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? -1))
    })
    const statuses = await Promise.all([run("a"), run("b")])
    expect(statuses.sort()).toEqual([0, 17])
    expect(fs.readFileSync(mutationPath, "utf8").trim().split("\n")).toHaveLength(1)
    expect(evidence(evidencePath)).toMatchObject({ operation: "reboot", phase: "requested" })
  })

  it("rejects a dangling checkpoint target before invoking an adapter", async () => {
    const dir = root()
    const evidencePath = path.join(dir, "dangling.json")
    fs.symlinkSync(path.join(dir, "missing.json"), evidencePath)
    let adapterCalls = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => { adapterCalls += 1; return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } } }))).rejects.toThrow(/inspect-before-retry|nonsymlink/u)
    expect(adapterCalls).toBe(0)
    expect(fs.lstatSync(evidencePath).isSymbolicLink()).toBe(true)
  })

  it("confines atomic private checkpoints to an owned nonsymlink allowed root", async () => {
    const dir = root()
    const outside = root()
    let adapterCalls = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: path.join(outside, "escape.json"), schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => { adapterCalls += 1; return { healthy: true, containerImageDigest: "x", telegramOffsetDigest: "y" } } }))).rejects.toThrow(/allowed root/u)
    expect(adapterCalls).toBe(0)
    const link = path.join(dir, "link")
    fs.symlinkSync(outside, link)
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: path.join(link, "evidence.json"), schema: "postboot-health-v1", adapter: "/health",
    }, dependencies())).rejects.toThrow(/symlink/u)
  })

  it("requires reboot resume to observe a different opaque boot identity", async () => {
    const dir = root()
    const file = path.join(dir, "reboot-identity.json")
    await executeSanctuaryAcceptanceHarness("reboot-request", { allowedRoot: dir, evidencePath: file, targetId: "sanctuary", adapter: "/reboot" }, dependencies({
      adapter: async () => ({ accepted: true, targetId: "sanctuary", requestId: "r", prebootId: "boot-a" }),
    }))
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { allowedRoot: dir, evidencePath: file, adapter: "/poll", timeoutMs: 10, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "ready", targetId: "sanctuary", requestId: "r", bootId: "boot-a" }),
    }))).rejects.toThrow(/boot identity did not change/u)
    expect(fs.readFileSync(file, "utf8")).not.toContain("boot-a")
  })

  it("covers every path confinement and identity uniqueness refusal branch", async () => {
    const dir = root()
    const snapshot = (evidencePath: string, allowedRoot: string = dir) => executeHarness("evidence-snapshot", {
      allowedRoot, evidencePath, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }))

    await expect(snapshot(path.join(dir, "relative-root.json"), "relative")).rejects.toThrow(/allowed root must be absolute/u)
    const getuid = process.getuid!()
    vi.spyOn(process, "getuid").mockReturnValue(getuid + 1)
    await expect(snapshot(path.join(dir, "wrong-owner.json"))).rejects.toThrow(/owned by the harness user/u)
    vi.restoreAllMocks()
    vi.spyOn(process, "getuid").mockReturnValue(undefined as never)
    await expect(snapshot(path.join(dir, "missing-identity.json"))).rejects.toThrow(/operating-system user identity/u)
    vi.restoreAllMocks()
    const rootFile = path.join(dir, "root-file")
    fs.writeFileSync(rootFile, "x", { mode: 0o600 })
    await expect(snapshot(path.join(dir, "root-file-evidence.json"), rootFile)).rejects.toThrow(/nonsymlink directory/u)
    await expect(executeHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: "relative.json", schema: "postboot-health-v1", adapter: "/health",
    }, dependencies())).rejects.toThrow(/evidencePath must be absolute/u)
    const publicAncestor = path.join(dir, "public-ancestor")
    fs.mkdirSync(publicAncestor, { mode: 0o755 })
    await expect(snapshot(path.join(publicAncestor, "evidence.json"))).rejects.toThrow(/owned private directory/u)
    const canonicalAlias = dir.startsWith("/private/") ? dir.slice("/private".length) : dir
    if (canonicalAlias !== dir) await expect(snapshot(path.join(dir, "canonical.json"), canonicalAlias)).rejects.toThrow(/canonical/u)

    const raced = path.join(dir, "raced.json")
    await expect(executeHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: raced, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => {
      fs.writeFileSync(raced, "{}\n", { mode: 0o600 })
      return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }
    } }))).rejects.toThrow(/inspect-before-retry/u)

    const base = (name: string) => ({
      allowedRoot: dir, evidencePath: path.join(dir, `${name}.json`), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "New", vaultField: "new", permissions: ["READ"] }], oldKeys: [],
    })
    await expect(executeHarness("unraid-key-rotate", base("inventory-id"), dependencies({ adapter: async () => ({ keys: [
      { id: "same", name: "one", permissions: ["READ"], roles: [] }, { id: "same", name: "two", permissions: ["READ"], roles: [] },
    ] }) }))).rejects.toThrow(/IDs must be unique/u)
    await expect(executeHarness("unraid-key-rotate", base("inventory-name"), dependencies({ adapter: async () => ({ keys: [
      { id: "one", name: "same", permissions: ["READ"], roles: [] }, { id: "two", name: "same", permissions: ["READ"], roles: [] },
    ] }) }))).rejects.toThrow(/names must be unique/u)
    await expect(executeHarness("unraid-key-rotate", { ...base("old-id"), oldKeys: [{ id: "old", secretAdapter: "/old" }, { id: "old", secretAdapter: "/old" }] }, dependencies())).rejects.toThrow(/old key IDs must be unique/u)
    await expect(executeHarness("unraid-key-rotate", {
      ...base("created-reuse"), oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return { keys: [{ id: "old", name: "Old", permissions: ["READ"], roles: [] }] }
      return { id: "old", name: "New", permissions: ["READ"], roles: [], key: "raw" }
    } }))).rejects.toThrow(/preexisting or reused/u)
    let inventoryCalls = 0
    await expect(executeHarness("unraid-key-rotate", {
      ...base("reconcile-drift"), oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return ++inventoryCalls === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["READ"], roles: [] }] }
        : { keys: [{ id: "old", name: "Changed", permissions: ["READ"], roles: [] }, { id: "new", name: "New", permissions: ["READ"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "New", permissions: ["READ"], roles: [], key: "raw" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      return { valid: true }
    } }))).rejects.toThrow(/changed ambiguously/u)
    await expect(executeHarness("unraid-key-rotate", { ...base("bad-permissions"), keys: [{ name: "New", vaultField: "new", permissions: [1] }] }, dependencies())).rejects.toThrow(/nonempty strings/u)
  })
})
