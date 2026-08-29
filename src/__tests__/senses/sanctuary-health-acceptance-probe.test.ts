import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  createSanctuaryHealthAcceptanceProbeCliHost,
  createSanctuaryHealthAcceptanceProbeCliOutput,
  createSanctuaryHealthAcceptanceProbeDependencies,
  createSanctuaryHealthAcceptanceProbeProcessHost,
  createSanctuaryHealthAcceptanceProbeProcessDependencies,
  createSanctuaryHealthAcceptanceLoopbackFixture,
  exactLocalDailyBoundary,
  finalizeSanctuaryHealthAcceptanceProbe,
  registerSanctuaryHealthAcceptanceProbeProcess,
  recoverSanctuaryHealthAcceptanceProbe,
  runSanctuaryHealthAcceptanceProbeCli,
  startSanctuaryHealthAcceptanceProbeCli,
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
    "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe-entry.js", "run",
    "--label", input.label, "--scenario", input.scenarioHandleDigest,
    "--owner-image", input.ownerImageDigest, "--owner-container", input.ownerContainerDigest,
  ].join("\0")
}

function cliArguments(input: SanctuaryHealthAcceptanceProbeInput, mode: "run" | "stop" | "recover" | "finalize" = "run"): string[] {
  return [mode, "--label", input.label, "--scenario", input.scenarioHandleDigest, "--owner-image", input.ownerImageDigest, "--owner-container", input.ownerContainerDigest]
}

describe("packaged Sanctuary health acceptance probe", () => {
  it("runs every CLI mode through the same production entry boundary", async () => {
    const runFixture = setup("unit-16g-health-transition")
    const listeners = new Map<string, () => void>()
    const host = {
      pid: 4321,
      once: (signal: "SIGTERM" | "SIGINT", listener: () => void) => { listeners.set(signal, listener) },
      removeListener: vi.fn(),
      signalSelf: vi.fn(),
    }
    try {
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(runFixture.input), { dependencies: runFixture.deps, host })).resolves.toMatchObject({ label: runFixture.input.label })
      expect(host.removeListener).toHaveBeenCalled()

      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(runFixture.input, "stop"), {
        processDependencies: { agentRoot: runFixture.agentRoot, listPids: () => [], processAlive: () => false, readCommandLine: vi.fn(), signal: vi.fn(), sleep: async () => {} },
      })).resolves.toEqual({ stopped: false })
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(runFixture.input, "recover"), { dependencies: runFixture.deps, host })).resolves.toEqual({ recovered: false })
    } finally { fs.rmSync(runFixture.agentRoot, { recursive: true, force: true }) }

    const finalFixture = setup("unit-16f-cron-fingerprint")
    try {
      await runSanctuaryHealthAcceptanceProbe(finalFixture.input, { ...finalFixture.deps, deferOwnerAttestation: true })
      await expect(runSanctuaryHealthAcceptanceProbeCli([
        ...cliArguments(finalFixture.input, "finalize"),
        "--owner-image-after", finalFixture.input.ownerImageDigest,
        "--owner-container-after", finalFixture.input.ownerContainerDigest,
      ], { dependencies: finalFixture.deps, host })).resolves.toMatchObject({ productionRestored: true })
    } finally { fs.rmSync(finalFixture.agentRoot, { recursive: true, force: true }) }
  })

  it("cleans CLI process ownership on both interrupt signals", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const signalSelf = vi.fn()
    const host = {
      pid: 4321,
      once: (_signal: "SIGTERM" | "SIGINT", listener: () => void) => { listener() },
      removeListener: vi.fn(),
      signalSelf,
    }
    try {
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(fixture.input), { dependencies: fixture.deps, host })).resolves.toMatchObject({ productionRestored: true })
      expect(signalSelf.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGINT"])
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("surfaces corrupted process ownership during CLI interrupt cleanup", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const marker = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-processes", `${fixture.input.scenarioHandleDigest}.json`)
    const host = {
      pid: 4321,
      once: (_signal: "SIGTERM" | "SIGINT", listener: () => void) => { fs.writeFileSync(marker, "not-json\n"); listener() },
      removeListener: vi.fn(), signalSelf: vi.fn(),
    }
    try {
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(fixture.input), { dependencies: fixture.deps, host })).rejects.toThrow()
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("adapts a process-like host without changing its signal semantics", () => {
    const target = { pid: 99, once: vi.fn(), removeListener: vi.fn(), kill: vi.fn() }
    const host = createSanctuaryHealthAcceptanceProbeCliHost(target as never)
    const listener = vi.fn()
    host.once("SIGTERM", listener)
    host.removeListener("SIGTERM", listener)
    host.signalSelf("SIGTERM")
    expect(target.once).toHaveBeenCalledWith("SIGTERM", listener)
    expect(target.removeListener).toHaveBeenCalledWith("SIGTERM", listener)
    expect(target.kill).toHaveBeenCalledWith(99, "SIGTERM")
  })

  it("adapts CLI failure output and reports rejected entry operations", async () => {
    const target = { stderr: { write: vi.fn() }, exitCode: undefined as number | undefined }
    const output = createSanctuaryHealthAcceptanceProbeCliOutput(target as never)
    output.writeError("first\n")
    output.setExitCode(2)
    expect(target.stderr.write).toHaveBeenCalledWith("first\n")
    expect(target.exitCode).toBe(2)

    const writeError = vi.fn()
    const setExitCode = vi.fn()
    startSanctuaryHealthAcceptanceProbeCli([], { writeError, setExitCode })
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("usage:"))
    expect(setExitCode).toHaveBeenCalledWith(1)

    const fixture = setup("unit-16f-cron-fingerprint")
    const host = { pid: 4321, once: vi.fn(), removeListener: vi.fn(), signalSelf: vi.fn() }
    try {
      startSanctuaryHealthAcceptanceProbeCli(cliArguments(fixture.input), { writeError, setExitCode }, {
        dependencies: { ...fixture.deps, waitForSchedulerReceipt: async () => { throw "non-error failure" } },
        host,
      })
      await vi.waitFor(() => { expect(writeError).toHaveBeenCalledWith("non-error failure\n") })
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it.each([
    { argv: [] },
    { argv: ["bad", "--label", "unit-16f-cron-fingerprint", "--scenario", "a".repeat(64), "--owner-image", "b".repeat(64), "--owner-container", "c".repeat(64)] },
    { argv: ["run", "--wrong", "unit-16f-cron-fingerprint", "--scenario", "a".repeat(64), "--owner-image", "b".repeat(64), "--owner-container", "c".repeat(64)] },
  ])("rejects malformed CLI coordinates %#", async ({ argv }) => {
    await expect(runSanctuaryHealthAcceptanceProbeCli(argv)).rejects.toThrow(/usage/u)
  })

  it("rejects extra non-finalize coordinates and incomplete finalize coordinates", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    try {
      await expect(runSanctuaryHealthAcceptanceProbeCli([...cliArguments(fixture.input), "x", "y", "z", "q"], { dependencies: fixture.deps })).rejects.toThrow(/coordinates are invalid/u)
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(fixture.input, "finalize"), { dependencies: fixture.deps })).rejects.toThrow(/finalize coordinates are invalid/u)
      await expect(runSanctuaryHealthAcceptanceProbeCli(cliArguments(fixture.input), { host: { pid: 4321, once: vi.fn(), removeListener: vi.fn(), signalSelf: vi.fn() } })).rejects.toThrow()
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })
  it("rejects invalid coordinates and process ids before writing", () => {
    const fixture = setup("unit-16g-health-transition")
    try {
      expect(() => registerSanctuaryHealthAcceptanceProbeProcess({ ...fixture.input, scenarioHandleDigest: "bad" }, { agentRoot: fixture.agentRoot, pid: 2 })).toThrow(/input is invalid/u)
      expect(() => registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 1 })).toThrow(/pid is invalid/u)
      const marker = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-processes", `${fixture.input.scenarioHandleDigest}.json`)
      fs.mkdirSync(marker, { recursive: true })
      expect(() => registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 2 })).toThrow()
      expect(fs.readdirSync(path.dirname(marker)).filter((entry) => entry.includes(".tmp-"))).toEqual([])
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("constructs the default process adapter before rejecting invalid input", async () => {
    const invalid = { label: "bad", scenarioHandleDigest: "bad", ownerImageDigest: "bad", ownerContainerDigest: "bad" } as never
    await expect(stopSanctuaryHealthAcceptanceProbeProcess(invalid)).rejects.toThrow(/input is invalid/u)
  })

  it("exercises the production process adapters through deterministic host seams", async () => {
    const rawKill = vi.fn((pid: number) => {
      if (pid === 404) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      if (pid === 403) throw Object.assign(new Error("denied"), { code: "EPERM" })
    })
    const rawReadDirectory = vi.fn(() => ["1", "22", "not-a-pid"])
    const rawReadFile = vi.fn((filePath: string) => `command:${filePath}`)
    const rawSetTimeout = vi.fn((callback: () => void) => { callback(); return 1 })
    const host = createSanctuaryHealthAcceptanceProbeProcessHost({
      readDirectory: rawReadDirectory,
      kill: rawKill,
      readFile: rawReadFile,
      setTimeout: rawSetTimeout,
    })
    expect(host.listProcEntries()).toEqual(["1", "22", "not-a-pid"])
    expect(host.readCommandLine(22)).toBe("command:/proc/22/cmdline")
    host.kill(22, "SIGTERM")
    await host.sleep(7)
    expect(rawReadDirectory).toHaveBeenCalledWith("/proc")
    expect(rawReadFile).toHaveBeenCalledWith("/proc/22/cmdline", "utf8")
    expect(rawKill).toHaveBeenCalledWith(22, "SIGTERM")
    expect(rawSetTimeout).toHaveBeenCalledWith(expect.any(Function), 7)

    const customKill = vi.fn((pid: number) => { if (pid === 404) throw Object.assign(new Error("gone"), { code: "ESRCH" }); if (pid === 403) throw Object.assign(new Error("denied"), { code: "EPERM" }) })
    const dependencies = createSanctuaryHealthAcceptanceProbeProcessDependencies({
      agentRoot: "/agent",
      listProcEntries: () => ["1", "22", "not-a-pid"],
      kill: customKill,
      readCommandLine: (pid) => `pid:${pid}`,
      sleep: async () => {},
    })
    expect(dependencies.listPids()).toEqual([1, 22])
    expect(dependencies.processAlive(22)).toBe(true)
    expect(dependencies.processAlive(404)).toBe(false)
    expect(() => dependencies.processAlive(403)).toThrow("denied")
    expect(dependencies.readCommandLine(22)).toBe("pid:22")
    dependencies.signal(22, "SIGTERM")
    await dependencies.sleep(1)

    const defaults = createSanctuaryHealthAcceptanceProbeProcessDependencies({ agentRoot: "/agent" }, host)
    expect(defaults.listPids()).toEqual([1, 22])
    expect(defaults.processAlive(22)).toBe(true)
    expect(defaults.processAlive(404)).toBe(false)
    expect(() => defaults.processAlive(403)).toThrow("denied")
    expect(defaults.readCommandLine(22)).toBe("command:/proc/22/cmdline")
    defaults.signal(22, "SIGTERM")
    await defaults.sleep(0)
  })

  it("constructs configurable production probe dependencies and waits for exact receipt files", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    const receiptRoot = path.join(fixture.agentRoot, "state", "acceptance", "scheduler-liveness-receipts")
    fs.mkdirSync(receiptRoot, { recursive: true })
    const receiptPath = path.join(receiptRoot, `${fixture.input.scenarioHandleDigest}.json`)
    const expected = { schemaVersion: "receipt" }
    fs.writeFileSync(receiptPath, `${JSON.stringify(expected)}\n`)
    const { waitForSchedulerReceipt: _wait, now: _now, ...overrides } = fixture.deps
    try {
      const dependencies = createSanctuaryHealthAcceptanceProbeDependencies(overrides)
      expect(dependencies.now()).toBeInstanceOf(Date)
      await expect(dependencies.waitForSchedulerReceipt!(fixture.agentRoot, fixture.input.scenarioHandleDigest)).resolves.toEqual(expected)

      fs.unlinkSync(receiptPath)
      fs.mkdirSync(receiptPath)
      await expect(dependencies.waitForSchedulerReceipt!(fixture.agentRoot, fixture.input.scenarioHandleDigest)).rejects.toThrow()
      fs.rmdirSync(receiptPath)

      const delayedDigest = "e".repeat(64)
      const delayedPath = path.join(receiptRoot, `${delayedDigest}.json`)
      const delayed = dependencies.waitForSchedulerReceipt!(fixture.agentRoot, delayedDigest)
      setTimeout(() => { fs.writeFileSync(delayedPath, `${JSON.stringify(expected)}\n`) }, 0)
      await expect(delayed).resolves.toEqual(expected)

      const timeout = createSanctuaryHealthAcceptanceProbeDependencies(overrides, { timeoutMs: -1, pollMs: 1 })
      await expect(timeout.waitForSchedulerReceipt!(fixture.agentRoot, "d".repeat(64))).rejects.toThrow(/timed out/u)

      const normalized = createSanctuaryHealthAcceptanceProbeDependencies({
        ...overrides,
        now: undefined,
        identityKey: undefined,
        waitForSchedulerReceipt: undefined,
        deferOwnerAttestation: undefined,
      })
      expect(normalized.now()).toBeInstanceOf(Date)
      expect(normalized.identityKey).toEqual(expect.any(Function))
      expect(normalized.waitForSchedulerReceipt).toEqual(expect.any(Function))
      expect(normalized.deferOwnerAttestation).toBe(true)

      const runnerOptions = { runPrivateTurn: vi.fn() }
      const acceptanceFs = { copyFile: vi.fn(), readFile: vi.fn() }
      const createLoopbackServer = vi.fn()
      const configured = createSanctuaryHealthAcceptanceProbeDependencies({
        ...overrides,
        runnerOptions,
        acceptanceFs,
        createLoopbackServer: createLoopbackServer as never,
      })
      expect(configured.runnerOptions).toBe(runnerOptions)
      expect(configured.acceptanceFs).toBe(acceptanceFs)
      expect(configured.createLoopbackServer).toBe(createLoopbackServer)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("propagates deterministic procfs scanner failures", async () => {
    const fixture = setup("unit-16g-health-transition")
    try {
      const dependencies = createSanctuaryHealthAcceptanceProbeProcessDependencies({
        agentRoot: fixture.agentRoot,
        listProcEntries: () => { throw Object.assign(new Error("procfs absent"), { code: "ENOENT" }) },
        kill: vi.fn(),
        readCommandLine: vi.fn(),
        sleep: async () => {},
      })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, dependencies)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("resolves exact Los Angeles daily boundaries across standard and daylight time", () => {
    expect(exactLocalDailyBoundary(new Date("2026-01-15T20:00:00Z")).toISOString()).toBe("2026-01-15T17:00:00.000Z")
    expect(exactLocalDailyBoundary(new Date("2026-08-18T20:00:00Z")).toISOString()).toBe("2026-08-18T16:00:00.000Z")
    expect(() => exactLocalDailyBoundary(new Date("0050-01-15T20:00:00Z"))).toThrow(/could not be resolved/u)
  })

  it("fails closed on exhausted or invalid loopback server boundaries", async () => {
    const fixture = await createSanctuaryHealthAcceptanceLoopbackFixture([], vi.fn() as typeof fetch)
    try {
      await expect(fixture.fetch("https://books.mendelow.cloud/")).resolves.toMatchObject({ status: 500 })
    } finally { await new Promise<void>((resolve) => { fixture.server.close(() => resolve()) }) }

    const fakeServer = (address: null | string, closeError?: Error) => ({
      once: vi.fn(), off: vi.fn(),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => { callback(); return undefined }),
      address: vi.fn(() => address),
      close: vi.fn((callback: (error?: Error) => void) => { callback(closeError); return undefined }),
    })
    await expect(createSanctuaryHealthAcceptanceLoopbackFixture([503], vi.fn() as typeof fetch, (() => fakeServer(null, new Error("close failed"))) as never)).rejects.toThrow("close failed")
    await expect(createSanctuaryHealthAcceptanceLoopbackFixture([503], vi.fn() as typeof fetch, (() => fakeServer(null)) as never)).rejects.toThrow(/address is invalid/u)
    await expect(createSanctuaryHealthAcceptanceLoopbackFixture([503], vi.fn() as typeof fetch, (() => fakeServer("pipe")) as never)).rejects.toThrow(/address is invalid/u)
  })

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
      }, { termGraceMs: 1 })).resolves.toEqual({ stopped: true })
      expect(signals).toEqual(["SIGTERM"])
    } finally {
      fs.rmSync(fixture.agentRoot, { recursive: true, force: true })
    }
  })

  it("waits within the grace window for an exact process to exit", async () => {
    const fixture = setup("unit-16g-health-transition")
    let alive = true
    const sleep = vi.fn(async () => { alive = false })
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => alive ? [4321] : [], processAlive: () => alive,
        readCommandLine: () => processCommand(fixture.input), signal: vi.fn(), sleep,
      }, { termGraceMs: 100 })).resolves.toEqual({ stopped: true })
      expect(sleep).toHaveBeenCalled()
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("escalates an exact stubborn process to SIGKILL and verifies absence", async () => {
    const fixture = setup("unit-16g-health-transition")
    let alive = true
    const signals: NodeJS.Signals[] = []
    try {
      registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 4321 })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => alive ? [4321] : [],
        processAlive: () => alive,
        readCommandLine: () => processCommand(fixture.input),
        signal: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false },
        sleep: async () => {},
      }, { termGraceMs: 0 })).resolves.toEqual({ stopped: true })
      expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("fails when an exact process survives SIGKILL", async () => {
    const fixture = setup("unit-16g-health-transition")
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => true,
        readCommandLine: () => processCommand(fixture.input),
        signal: vi.fn(),
        sleep: async () => {},
      }, { termGraceMs: 0, killGraceMs: 0 })).rejects.toThrow(/did not stop/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("covers dead, unreadable, ambiguous, and substituted process scans", async () => {
    const fixture = setup("unit-16g-health-transition")
    const base = {
      agentRoot: fixture.agentRoot,
      signal: vi.fn(),
      sleep: async () => {},
    }
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [1], processAlive: () => false, readCommandLine: vi.fn(),
      })).resolves.toEqual({ stopped: false })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [2], processAlive: () => true,
        readCommandLine: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }) },
      })).resolves.toEqual({ stopped: false })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [2], processAlive: () => true,
        readCommandLine: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
      })).rejects.toThrow("denied")
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [2, 3], processAlive: () => true, readCommandLine: () => processCommand(fixture.input),
      })).rejects.toThrow(/ambiguous/u)
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [2], processAlive: () => true,
        readCommandLine: () => `${processCommand(fixture.input)}\0extra`,
      })).rejects.toThrow(/identity/u)
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        ...base, listPids: () => [2], processAlive: () => true,
        readCommandLine: () => `${processCommand(fixture.input)}\0`,
      }, { termGraceMs: 0, killGraceMs: 0 })).rejects.toThrow(/did not stop/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("fails closed if an exact process disappears while its pid is being fenced", async () => {
    const fixture = setup("unit-16g-health-transition")
    let reads = 0
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => [4321],
        processAlive: () => true,
        readCommandLine: () => {
          reads += 1
          if (reads === 1) return processCommand(fixture.input)
          throw Object.assign(new Error("gone"), { code: "ESRCH" })
        },
        signal: vi.fn(),
        sleep: async () => {},
      })).rejects.toThrow(/process identity/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("surfaces an unexpected command-line read failure during pid fencing", async () => {
    const fixture = setup("unit-16g-health-transition")
    let reads = 0
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => [4321], processAlive: () => true,
        readCommandLine: () => {
          reads += 1
          if (reads === 1) return processCommand(fixture.input)
          throw Object.assign(new Error("denied"), { code: "EACCES" })
        },
        signal: vi.fn(), sleep: async () => {},
      })).rejects.toThrow("denied")
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects a pid identity change between a failed grace wait and escalation", async () => {
    const fixture = setup("unit-16g-health-transition")
    let reads = 0
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => [4321], processAlive: () => true,
        readCommandLine: () => { reads += 1; return reads <= 4 ? processCommand(fixture.input) : "/usr/local/bin/node\0unrelated.js" },
        signal: vi.fn(), sleep: async () => {},
      }, { termGraceMs: 0 })).rejects.toThrow(/identity/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects a process appearing only in the final absence scan", async () => {
    const fixture = setup("unit-16g-health-transition")
    let scans = 0
    try {
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot,
        listPids: () => { scans += 1; return scans === 1 ? [] : [4321] },
        processAlive: () => true,
        readCommandLine: () => `${processCommand(fixture.input)}\0extra`,
        signal: vi.fn(), sleep: async () => {},
      })).rejects.toThrow(/absence was not verified/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects dead-marker/live-process disagreement and malformed markers", async () => {
    const fixture = setup("unit-16g-health-transition")
    const marker = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-processes", `${fixture.input.scenarioHandleDigest}.json`)
    try {
      registerSanctuaryHealthAcceptanceProbeProcess(fixture.input, { agentRoot: fixture.agentRoot, pid: 4321 })
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => [9876], processAlive: (pid) => pid === 9876,
        readCommandLine: () => processCommand(fixture.input), signal: vi.fn(), sleep: async () => {},
      })).rejects.toThrow(/identity/u)
      fs.writeFileSync(marker, "not-json\n")
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => [], processAlive: () => false,
        readCommandLine: vi.fn(), signal: vi.fn(), sleep: async () => {},
      })).rejects.toThrow()
      fs.writeFileSync(marker, `${JSON.stringify({ schemaVersion: "wrong", pid: 4321, ...fixture.input })}\n`)
      await expect(stopSanctuaryHealthAcceptanceProbeProcess(fixture.input, {
        agentRoot: fixture.agentRoot, listPids: () => [], processAlive: () => false,
        readCommandLine: vi.fn(), signal: vi.fn(), sleep: async () => {},
      })).rejects.toThrow(/identity/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it.each([
    ["unit-16f-cron-fingerprint", 1, 0, 0, "ambient"],
    ["unit-16g-health-transition", 6, 0, 0, "ambient"],
    ["unit-16h-daily-digest", 2, 0, 0, "local-daily-boundary"],
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
          ["fixture-fail", 503, 1, 0, null],
          ["fixture-repeat", 503, 0, 0, null],
          ["fixture-recover", 200, 0, 1, null],
          ["fixture-refail", 503, 1, 0, null],
        ])
      }
      if (label === "unit-16h-daily-digest") {
        expect(receipt.effectiveNow).toMatch(/T(?:16|17):00:00\.000Z$/u)
        expect(receipt.phases.map((phase) => [phase.fixtureStatus, phase.digestDue, phase.deliveryKind])).toEqual([
          [503, false, null], [503, false, null],
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

  it("fails closed without fabricating or restoring an absent Unit16f observer state", async () => {
    const fixture = setup("unit-16f-cron-fingerprint")
    fs.unlinkSync(fixture.statePath)
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/observer state is absent/u)
      expect(fs.existsSync(fixture.statePath)).toBe(false)
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

  it("rejects occupied acceptance coordinates before mutating production state", async () => {
    for (const occupied of ["workspace", "receipt", "pending"] as const) {
      const fixture = setup("unit-16g-health-transition")
      const acceptance = path.join(fixture.agentRoot, "state", "acceptance")
      try {
        if (occupied === "workspace") fs.mkdirSync(path.join(acceptance, "health-probe-workspaces", fixture.input.scenarioHandleDigest), { recursive: true })
        else {
          const directory = path.join(acceptance, occupied === "receipt" ? "health-probe-receipts" : "health-probe-pending")
          fs.mkdirSync(directory, { recursive: true })
          fs.writeFileSync(path.join(directory, `${fixture.input.scenarioHandleDigest}.json`), "{}\n")
        }
        await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/inspect-before-retry/u)
        expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(fixture.before)
      } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
    }
  })

  it("surfaces a non-file production state snapshot", async () => {
    const fixture = setup("unit-16g-health-transition")
    fs.unlinkSync(fixture.statePath)
    fs.mkdirSync(fixture.statePath)
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow()
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("surfaces acceptance filesystem failures at normalization and verification boundaries", async () => {
    const normalization = setup("unit-16g-health-transition")
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(normalization.input, {
        ...normalization.deps,
        acceptanceFs: {
          copyFile: () => { throw Object.assign(new Error("copy denied"), { code: "EACCES" }) },
          readFile: (statePath) => fs.readFileSync(statePath, "utf8"),
        },
      })).rejects.toThrow("copy denied")
    } finally { fs.rmSync(normalization.agentRoot, { recursive: true, force: true }) }

    const verification = setup("unit-16g-health-transition")
    let copies = 0
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(verification.input, {
        ...verification.deps,
        acceptanceFs: {
          copyFile: (source, destination) => { copies += 1; if (copies === 2) throw Object.assign(new Error("verify copy denied"), { code: "EACCES" }); fs.copyFileSync(source, destination) },
          readFile: (statePath) => fs.readFileSync(statePath, "utf8"),
        },
      })).rejects.toThrow("verify copy denied")
    } finally { fs.rmSync(verification.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects a malformed normalization receipt read through the acceptance filesystem", async () => {
    const fixture = setup("unit-16g-health-transition")
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, {
        ...fixture.deps,
        acceptanceFs: {
          copyFile: fs.copyFileSync,
          readFile: (statePath) => {
            const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
            state.sweepReceipts.at(-1).incidentDigest = "invalid"
            return JSON.stringify(state)
          },
        },
      })).rejects.toThrow(/normalization receipt is invalid/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects malformed working state and a missing scenario sweep receipt", async () => {
    const malformed = setup("unit-16f-cron-fingerprint")
    const invalidState = { ...initialState(), incidents: [] }
    fs.writeFileSync(malformed.statePath, `${JSON.stringify(invalidState)}\n`)
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(malformed.input, malformed.deps)).rejects.toThrow(/working state is invalid/u)
    } finally { fs.rmSync(malformed.agentRoot, { recursive: true, force: true }) }

    const missing = setup("unit-16f-cron-fingerprint")
    const originalWait = missing.deps.waitForSchedulerReceipt
    missing.deps.waitForSchedulerReceipt = async (...args) => {
      const receipt = await originalWait(...args)
      const state = JSON.parse(fs.readFileSync(missing.statePath, "utf8"))
      state.sweepReceipts = []
      fs.writeFileSync(missing.statePath, `${JSON.stringify(state)}\n`)
      return receipt
    }
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(missing.input, missing.deps)).rejects.toThrow(/sweep receipt is missing/u)
    } finally { fs.rmSync(missing.agentRoot, { recursive: true, force: true }) }
  })

  it.each([
    { sweepReceipts: null, deliveredReceipts: [] },
    { sweepReceipts: [], deliveredReceipts: null },
  ])("rejects an invalid scheduler cursor shape %#", async (invalid) => {
    const fixture = setup("unit-16f-cron-fingerprint")
    fs.writeFileSync(fixture.statePath, `${JSON.stringify({ ...initialState(), ...invalid })}\n`)
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/observer state is invalid/u)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("retains recovery evidence when restoring an absent snapshot encounters a directory", async () => {
    const fixture = setup("unit-16g-health-transition")
    fs.unlinkSync(fixture.statePath)
    let fetches = 0
    const ambientFetch = vi.fn(async () => {
      fetches += 1
      if (fetches === 2) {
        try { fs.unlinkSync(fixture.statePath) } catch { /* already absent */ }
        fs.mkdirSync(fixture.statePath, { recursive: true })
        const workspace = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest)
        fs.writeFileSync(path.join(workspace, "unexpected.txt"), "retain recovery evidence\n")
        throw new Error("fixture failure")
      }
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, { ...fixture.deps, ambientFetch })).rejects.toThrow()
      expect(fs.existsSync(path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest))).toBe(true)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("never invokes the retired private-turn delivery seam", async () => {
    const fixture = setup("unit-16g-health-transition")
    const runPrivateTurn = vi.fn()
    ;(fixture.deps.runnerOptions as any).runPrivateTurn = runPrivateTurn
    try {
      await expect(runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toMatchObject({ deliveryCount: 0, privateTurnCount: 0 })
      expect(runPrivateTurn).not.toHaveBeenCalled()
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("restores an initially absent mutable health state", async () => {
    const fixture = setup("unit-16g-health-transition")
    fs.unlinkSync(fixture.statePath)
    try {
      const receipt = await runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)
      expect(receipt.productionRestored).toBe(true)
      expect(fs.existsSync(fixture.statePath)).toBe(false)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("reports cron degradation without rewriting the scheduler registration", async () => {
    const fixture = setup("unit-16g-health-transition")
    const cronPath = path.join(fixture.deps.runtimeRoot, "scheduler", "sanctuary.crontab")
    fs.writeFileSync(cronPath, "# unrelated\n")
    try {
      const receipt = await runSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)
      expect(receipt).toMatchObject({ cronRegisteredBefore: false, cronRegisteredAfter: false, cronDegradedBefore: true, cronDegradedAfter: true, productionRestored: false })
      expect(fs.readFileSync(cronPath, "utf8")).toBe("# unrelated\n")
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("recovers or rejects pending-only envelopes by their exact owner binding", async () => {
    const fixture = setup("unit-16g-health-transition")
    const pendingPath = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-pending", `${fixture.input.scenarioHandleDigest}.json`)
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true })
    try {
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toEqual({ recovered: false })
      for (const receipt of [
        null,
        { label: "unit-16h-daily-digest", scenarioHandleDigest: fixture.input.scenarioHandleDigest, ownerImageDigestBefore: fixture.input.ownerImageDigest, ownerContainerDigestBefore: fixture.input.ownerContainerDigest },
        { label: fixture.input.label, scenarioHandleDigest: "d".repeat(64), ownerImageDigestBefore: fixture.input.ownerImageDigest, ownerContainerDigestBefore: fixture.input.ownerContainerDigest },
        { label: fixture.input.label, scenarioHandleDigest: fixture.input.scenarioHandleDigest, ownerImageDigestBefore: "d".repeat(64), ownerContainerDigestBefore: fixture.input.ownerContainerDigest },
        { label: fixture.input.label, scenarioHandleDigest: fixture.input.scenarioHandleDigest, ownerImageDigestBefore: fixture.input.ownerImageDigest, ownerContainerDigestBefore: "d".repeat(64) },
      ]) {
        fs.writeFileSync(pendingPath, `${JSON.stringify({ receipt })}\n`)
        await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/pending recovery binding/u)
      }
      fs.writeFileSync(pendingPath, `${JSON.stringify({ receipt: {
        label: fixture.input.label, scenarioHandleDigest: fixture.input.scenarioHandleDigest,
        ownerImageDigestBefore: fixture.input.ownerImageDigest, ownerContainerDigestBefore: fixture.input.ownerContainerDigest,
      } })}\n`)
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toEqual({ recovered: true })
      expect(fs.existsSync(pendingPath)).toBe(false)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects invalid final owners and pending receipt bindings", () => {
    const fixture = setup("unit-16g-health-transition")
    const pendingPath = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-pending", `${fixture.input.scenarioHandleDigest}.json`)
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true })
    try {
      expect(() => finalizeSanctuaryHealthAcceptanceProbe(fixture.input, { ownerImageDigest: "bad", ownerContainerDigest: fixture.input.ownerContainerDigest }, { agentRoot: fixture.agentRoot })).toThrow(/final owner is invalid/u)
      for (const envelope of [
        {},
        { schemaVersion: "wrong", receipt: {} },
        { schemaVersion: "sanctuary-health-probe-pending-v1", receipt: { label: "unit-16h-daily-digest" } },
      ]) {
        fs.writeFileSync(pendingPath, `${JSON.stringify(envelope)}\n`)
        expect(() => finalizeSanctuaryHealthAcceptanceProbe(fixture.input, {
          ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest,
        }, { agentRoot: fixture.agentRoot })).toThrow(/pending receipt binding/u)
      }
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("retains an interrupted recovery workspace containing unexpected material", async () => {
    const fixture = setup("unit-16g-health-transition")
    const workspace = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest)
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, "snapshot.json"), `${JSON.stringify({ exists: true, bytes: Buffer.from(fixture.before).toString("base64") })}\n`)
    fs.writeFileSync(path.join(workspace, "checkpoint.json"), `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest })}\n`)
    fs.writeFileSync(path.join(workspace, "unexpected.txt"), "retain me\n")
    try {
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).rejects.toThrow(/unexpected entries/u)
      expect(fs.existsSync(workspace)).toBe(true)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })

  it("removes a pending envelope after workspace recovery", async () => {
    const fixture = setup("unit-16g-health-transition")
    const workspace = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-workspaces", fixture.input.scenarioHandleDigest)
    const pending = path.join(fixture.agentRoot, "state", "acceptance", "health-probe-pending", `${fixture.input.scenarioHandleDigest}.json`)
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(path.dirname(pending), { recursive: true })
    fs.writeFileSync(path.join(workspace, "snapshot.json"), `${JSON.stringify({ exists: true, bytes: Buffer.from(fixture.before).toString("base64") })}\n`)
    fs.writeFileSync(path.join(workspace, "checkpoint.json"), `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: fixture.input.ownerImageDigest, ownerContainerDigest: fixture.input.ownerContainerDigest })}\n`)
    fs.writeFileSync(pending, "{}\n")
    try {
      await expect(recoverSanctuaryHealthAcceptanceProbe(fixture.input, fixture.deps)).resolves.toEqual({ recovered: true })
      expect(fs.existsSync(pending)).toBe(false)
    } finally { fs.rmSync(fixture.agentRoot, { recursive: true, force: true }) }
  })
})
