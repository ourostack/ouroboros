import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  recoverSanctuaryHealthAcceptanceProbe,
  runSanctuaryHealthAcceptanceProbe,
  type SanctuaryHealthAcceptanceProbeInput,
} from "../../senses/sanctuary-health-acceptance-probe"

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
    runnerOptions: {
      credentials: () => ({ botToken: "test-token", authorizedChatId: "42" }),
      createApi: () => ({ request: vi.fn(async () => ({ message_id: ++messageId })), stop: vi.fn() }),
      runPrivateTurn: async ({ payload, deliver }: { payload: string; deliver(content: string): Promise<void> }) => {
        privateTurns += 1
        await deliver(payload)
        return { delivered: true }
      },
    },
  }
  return { agentRoot, before, deps, input, statePath, privateTurns: () => privateTurns }
}

describe("packaged Sanctuary health acceptance probe", () => {
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
        restoredStateDigest: shaBytes(fixture.before),
        clockMode,
        providerInvocationCount: providers,
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
      })
      expect(receipt.phases).toHaveLength(phaseCount)
      expect(receipt.fixtureSequenceDigest).toBe(sha(receipt.phases.flatMap((phase) => phase.fixtureStatus === null ? [] : [phase.fixtureStatus])))
      expect(fixture.privateTurns()).toBe(providers)
      expect(fs.readFileSync(fixture.statePath, "utf8")).toBe(fixture.before)
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
})
