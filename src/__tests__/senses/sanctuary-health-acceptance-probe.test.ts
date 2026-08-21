import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  finalizeSanctuaryHealthAcceptanceProbe,
  registerSanctuaryHealthAcceptanceProbeProcess,
  recoverSanctuaryHealthAcceptanceProbe,
  runSanctuaryHealthAcceptanceProbe,
  stopSanctuaryHealthAcceptanceProbeProcess,
  type SanctuaryHealthAcceptanceProbeInput,
} from "../../senses/sanctuary-health-acceptance-probe"
import { sanctuarySchedulerLivenessReceiptMac } from "../../heart/daemon/sanctuary-scheduler-liveness"

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const shaBytes = (value: string): string => createHash("sha256").update(value).digest("hex")

function healthyContext() {
  return { sanctuary: {
    listContainers: vi.fn().mockResolvedValue({ ok: true, data: { containers: [], truncated: false } }),
    getStorage: vi.fn().mockResolvedValue({ ok: true, data: { array: { usedPercent: 10, degraded: false }, shares: [] } }),
    getDisks: vi.fn().mockResolvedValue({ ok: true, data: { disks: [], parity: { result: "success", ageHours: 1 } } }),
    getNotifications: vi.fn().mockResolvedValue({ ok: true, data: { unacknowledged: [] } }),
  } } as any
}

function initialState() {
  return {
    incidents: {}, lastDigestDay: "2026-08-18", updatedAt: "2026-08-18T15:00:00.000Z",
    outbox: null, indeterminateDeliveries: [], deliveredReceipts: [], sweepReceipts: [],
  }
}

function setup(label: SanctuaryHealthAcceptanceProbeInput["label"]) {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), `sanctuary-${label}-`))
  const runtimeRoot = path.join(agentRoot, "runtime")
  const statePath = path.join(agentRoot, "state", "health", "sanctuary-health.json")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.mkdirSync(path.join(runtimeRoot, "scheduler"), { recursive: true })
  const before = `${JSON.stringify(initialState())}\n`
  fs.writeFileSync(statePath, before, { mode: 0o600 })
  fs.writeFileSync(path.join(runtimeRoot, "scheduler", "sanctuary.crontab"), [
    "# ouro:habit:sanctuary:sanctuary:sanctuary-health",
    "*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron",
    "",
  ].join("\n"))
  let messageId = 100
  let privateTurns = 0
  const input: SanctuaryHealthAcceptanceProbeInput = {
    label,
    scenarioHandleDigest: "a".repeat(64),
    ownerImageDigest: "b".repeat(64),
    ownerContainerDigest: "c".repeat(64),
  }
  const deps = {
    agentRoot,
    runtimeRoot,
    toolContext: healthyContext(),
    ambientFetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch,
    now: () => new Date("2026-08-18T17:00:00.000Z"),
    identityKey: () => "k".repeat(43),
    waitForSchedulerReceipt: async () => {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
      state.sweepReceipts.push({ sweepId: "scheduler-sweep", startedAt: "2026-08-18T17:00:00.000Z", completedAt: "2026-08-18T17:00:01.000Z", incidentDigest: sha({}), opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest: input.scenarioHandleDigest })
      fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`)
      const unsigned = {
        schemaVersion: "sanctuary-scheduler-liveness-receipt-v1" as const, label: "unit-16f-cron-fingerprint" as const,
        scenarioHandleDigest: input.scenarioHandleDigest, trigger: "cron" as const, occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", recordedAt: "2026-08-18T17:00:01.000Z",
        before: { sweepCount: 0, deliveryCount: 0 }, after: { sweepCount: 1, deliveryCount: 0 }, sweepDelta: 1 as const, deliveryDelta: 0 as const,
        providerInvocationCount: 0 as const, privateTurnCount: 0 as const, sweep: { recordDigest: "d".repeat(64), opened: 0 as const, recovered: 0 as const, digestDue: false as const, deliveryId: null },
        supervisor: { schemaVersion: "supercronic-supervisor-snapshot-v1" as const, daemonPid: 1, childCount: 1 as const, childPid: 42, healthy: true as const, binaryPath: "/usr/local/bin/supercronic", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"] as ["-split-logs", "-inotify", string], crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab", namespace: "habit:sanctuary", manifest: [], renderedCrontab: "canonical" },
        schedulerOrigin: { slot: "2026-08-18T17:00:00.000Z", occurrenceId: "cron:2026-08-18T17:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest: input.scenarioHandleDigest },
        nonReplay: true as const,
      }
      return { ...unsigned, receiptMac: sanctuarySchedulerLivenessReceiptMac("k".repeat(43), unsigned) }
    },
    runnerOptions: {
      credentials: () => ({ botToken: "test-token", authorizedChatId: "42" }),
      createApi: () => ({ request: vi.fn(async () => ({ message_id: ++messageId })), stop: vi.fn() }),
      runPrivateTurn: async ({ payload, deliver, onProviderInvocation }: { payload: string; deliver(content: string): Promise<void>; onProviderInvocation?: () => void }) => {
        privateTurns += 1
        onProviderInvocation?.()
        await deliver(payload)
        return { delivered: true }
      },
    },
  }
  return { agentRoot, before, deps, input, statePath, privateTurns: () => privateTurns }
}

function processCommand(input: SanctuaryHealthAcceptanceProbeInput): string {
  return [
    "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe.js", "run",
    "--label", input.label, "--scenario", input.scenarioHandleDigest,
    "--owner-image", input.ownerImageDigest, "--owner-container", input.ownerContainerDigest,
  ].join("\0")
}

describe("packaged Sanctuary health acceptance probe", () => {
  it("stops and verifies the exact scenario-bound in-container process before recovery", async () => {
    const fixture = setup("unit-16g-health-transition")
    const processPath = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-processes", `${fixture.input.scenarioHandleDigest}.json`)
    let alive = true
    const signals: NodeJS.Signals[] = []
    try {
      registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 4321 })
      expect(fs.statSync(processPath).mode & 0o777).toBe(0o600)
      const record = JSON.parse(fs.readFileSync(processPath, "utf8")) as Record<string, unknown>
      expect(record).toMatchObject({ schemaVersion: "sanctuary-health-probe-process-v1", pid: 4321, ...fixture.input })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => alive,
        readCommandLine: () => processCommand(fixture.input),
        signal: (_pid, signal) => { signals.push(signal); alive = false },
        sleep: async () => {},
      })).resolves.toEqual({ stopped: true })
      expect(signals).toEqual(["SIGTERM"])
      expect(fs.existsSync(processPath)).toBe(false)
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("rejects a stale or substituted process identity without signalling it", async () => {
    const fixture = setup("unit-16g-health-transition")
    const signals: NodeJS.Signals[] = []
    try {
      registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 4321 })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => true,
        readCommandLine: () => "/usr/local/bin/node\0another-program.js\0run",
        signal: (_pid, signal) => { signals.push(signal) },
        sleep: async () => {},
      })).rejects.toThrow(/process identity/u)
      expect(signals).toEqual([])
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("finds, terminates, and verifies an exact live process even after its marker was removed", async () => {
    const fixture = setup("unit-16g-health-transition")
    let alive = true
    const signals: NodeJS.Signals[] = []
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => alive,
        readCommandLine: () => processCommand(fixture.input),
        signal: (_pid, signal) => { signals.push(signal); alive = false },
        sleep: async () => {},
      })).resolves.toEqual({ stopped: true })
      expect(signals).toEqual(["SIGTERM"])
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ["label drift", (input: SanctuaryHealthAcceptanceProbeInput) => processCommand({ ...input, label: "unit-16f-cron-fingerprint" })],
    ["owner drift", (input: SanctuaryHealthAcceptanceProbeInput) => processCommand({ ...input, ownerImageDigest: "d".repeat(64) })],
    ["duplicate scenario token", (input: SanctuaryHealthAcceptanceProbeInput) => `${processCommand(input)}\0--scenario\0${input.scenarioHandleDigest}`],
  ])("rejects canonical argv decoys with %s", async (_name, command) => {
    const fixture = setup("unit-16g-health-transition")
    const signals: NodeJS.Signals[] = []
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => true,
        readCommandLine: () => command(fixture.input),
        signal: (_pid, signal) => { signals.push(signal) },
        sleep: async () => {},
      })).rejects.toThrow(/process identity/u)
      expect(signals).toEqual([])
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("does not SIGKILL a reused pid after the exact probe process exits", async () => {
    const fixture = setup("unit-16g-health-transition")
    let command = processCommand(fixture.input)
    const signals: NodeJS.Signals[] = []
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => true,
        readCommandLine: () => command,
        signal: (_pid, signal) => { signals.push(signal); command = "/usr/local/bin/node\0unrelated.js" },
        sleep: async () => {},
      }, { termGraceMs: 1, killGraceMs: 1 })).resolves.toEqual({ stopped: true })
      expect(signals).toEqual(["SIGTERM"])
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ["unit-16f-cron-fingerprint", 1, 0, 0, "ambient"],
    ["unit-16g-health-transition", 6, 3, 3, "ambient"],
    ["unit-16h-daily-digest", 2, 1, 1, "local-daily-boundary"],
  ] as const)("runs and restores %s through the real health runner", async (label, phaseCount, providers, deliveries, clockMode) => {
    const fixture = setup(label)
    try {
      const receipt = await runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)
      expect(receipt).toMatchObject({
        schemaVersion: "sanctuary-health-probe-receipt-v1",
        label,
        scenarioHandleDigest: fixture.input.scenarioHandleDigest,
        ownerImageDigestBefore: fixture.input.ownerImageDigest,
        ownerImageDigestAfter: fixture.input.ownerImageDigest,
        ownerContainerDigestBefore: fixture.input.ownerContainerDigest,
        ownerContainerDigestAfter: fixture.input.ownerContainerDigest,
        beforeStateDigest: shaBytes(fixture.before),
        restoredStateDigest: label === "unit-16f-cron-fingerprint" ? expect.stringMatching(/^[0-9a-f]{64}$/u) : shaBytes(fixture.before),
        clockMode,
        providerInvocationCount: providers,
        privateTurnCount: providers,
        deliveryCount: deliveries,
        cronRegisteredBefore: true,
        cronRegisteredAfter: true,
        cronDegradedBefore: false,
        cronDegradedAfter: false,
        workspaceAbsent: true,
        socketAbsent: true,
        snapshotAbsent: true,
        realCheckEquivalent: true,
        productionRestored: true,
        schedulerReceipt: label === "unit-16f-cron-fingerprint" ? expect.objectContaining({ trigger: "cron", sweepDelta: 1, deliveryDelta: 0, nonReplay: true }) : null,
      })
      expect(receipt.phases).toHaveLength(phaseCount)
      expect(receipt.fixtureSequenceDigest).toBe(sha(receipt.phases.flatMap((phase) => phase.fixtureStatus === null ? [] : [phase.fixtureStatus])))
      expect(fixture.privateTurns()).toBe(providers)
      if (label === "unit-16f-cron-fingerprint") expect(JSON.parse(fs.readFileSync(fixture.statePath, "utf8")).sweepReceipts).toHaveLength(1)
      else expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(fixture.before)
      expect(fs.statSync(path.join(fixture.agentRoot, "state", "acceptance", "health-probe-receipts", `${fixture.input.scenarioHandleDigest}.json`)).mode & 0o777).toBe(0o600)
      expect(fs.existsSync(path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest))).toBe(false)
      if (label === "unit-16f-cron-fingerprint") expect(receipt.phases[0]).toMatchObject({ name: "cron-unchanged", trigger: "cron", fixtureStatus: null, opened: 0, recovered: 0, digestDue: false, deliveryKind: null, deliveryReceiptDigest: null })
      if (label === "unit-16g-health-transition") {
        expect(receipt.phases.map((phase) => [phase.name, phase.fixtureStatus, phase.opened, phase.recovered, phase.deliveryKind])).toEqual([
          ["live-baseline", null, 0, 0, null],
          ["live-repeat", null, 0, 0, null],
          ["fixture-fail", 503, 1, 0, "transition"],
          ["fixture-repeat", 503, 0, 0, null],
          ["fixture-recover", 200, 0, 1, "transition"],
          ["fixture-refail", 503, 1, 0, "transition"],
        ])
      }
      if (label === "unit-16h-daily-digest") {
        expect(receipt.effectiveNow).toMatch(/T(?:16|17):00:00\.000Z$/u)
        expect(receipt.phases.map((phase) => [phase.fixtureStatus, phase.digestDue, phase.deliveryKind])).toEqual([
          [503, true, "digest"], [503, false, null],
        ])
      }
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("restores an interrupted workspace only for the exact owner and removes it", async () => {
    const fixture = setup("unit-16g-health-transition")
    const workspace = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest)
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(workspace, "snapshot.json"), `${JSON.stringify({ exists: true, bytes: Buffer.from(fixture.before).toString("base64") })}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(workspace, "checkpoint.json"), `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest })}\n`, { mode: 0o600 })
    fs.writeFileSync(fixture.statePath, "mutated\n")
    try {
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toEqual({ recovered: true })
      expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(fixture.before)
      expect(fs.existsSync(workspace)).toBe(false)
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(workspace, "snapshot.json"), "{}\n", { mode: 0o600 })
      fs.writeFileSync(path.join(workspace, "checkpoint.json"), `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: "d".repeat(64), ownerContainerDigest: fixture.input.ownerContainerDigest })}\n`, { mode: 0o600 })
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/owner binding/u)
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("never rolls back a Unit16f scheduler sweep when receipt verification fails after the wait", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const originalWait = fixture.deps.waitForSchedulerReceipt
    fixture.deps.waitForSchedulerReceipt = async (...args) => ({
      ...await originalWait(...args),
      providerInvocationCount: 1 as 0,
    })
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/receipt is invalid/u)
      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))
      expect(state.sweepReceipts).toHaveLength(1)
      expect(state.sweepReceipts[0]).toMatchObject({ sweepId: "scheduler-sweep", scenarioHandleDigest: fixture.input.scenarioHandleDigest })
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("recovers a crashed Unit16f waiter without restoring its stale shared-state snapshot", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const workspace = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest)
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(workspace, "snapshot.json"), `${JSON.stringify({ exists: true, bytes: Buffer.from(fixture.before).toString("base64") })}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(workspace, "checkpoint.json"), `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest })}\n`, { mode: 0o600 })
    const state = initialState()
    state.sweepReceipts.push({ sweepId: "scheduler-sweep", opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest: fixture.input.scenarioHandleDigest } as never)
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`)
    try {
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toEqual({ recovered: true })
      expect(JSON.parse(fs.readFileSync(fixture.statePath, "utf8")).sweepReceipts).toHaveLength(1)
      expect(fs.existsSync(workspace)).toBe(false)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("withholds the final receipt until an independently observed owner is attested", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const receiptPath = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-receipts", `${fixture.input.scenarioHandleDigest}.json`)
    const pendingPath = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-pending", `${fixture.input.scenarioHandleDigest}.json`)
    try {
      await runSanctuaryHealthAcceptanceProbe(fixture.input, { ...fixture.deps, deferOwnerAttestation: true })
      expect(fs.existsSync(receiptPath)).toBe(false)
      expect(fs.existsSync(pendingPath)).toBe(true)
      expect(() => finalizeSanctuaryHealthAcceptanceProbe(fixture.input, {
        ownerImageDigest: "d".repeat(64), ownerContainerDigest: fixture.input.ownerContainerDigest,
      }, { agentRoot: fixture.agentRoot })).toThrow(/owner drifted/u)
      expect(fs.existsSync(receiptPath)).toBe(false)
      const receipt = finalizeSanctuaryHealthAcceptanceProbe(fixture.input, {
        ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest,
      }, { agentRoot: fixture.agentRoot })
      expect(receipt.productionRestored).toBe(true)
      expect(fs.existsSync(receiptPath)).toBe(true)
      expect(fs.existsSync(pendingPath)).toBe(false)
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })
})
