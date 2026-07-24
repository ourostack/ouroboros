import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ActivationBarrierStore,
  deriveActionWindowId,
  type BarrierCommandV1,
  type RepairGenerationReconciliationV1,
  type ResourceKey,
} from "../../../heart/activation/barrier-core"
import { canonicalizeJson, sha256CanonicalJson } from "../../../heart/runtime/canonical-json"
import {
  ProtectedStoreCorruptError,
  ProtectedStoreLockedError,
  nodeProtectedStoreIo,
  type ProtectedStoreIo,
} from "../../../heart/runtime/protected-json-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const owner: ProcessIdentity = {
  uid: 501,
  pid: 5151,
  startIdentity: "darwin-proc:1770000000:001234",
  bootId: "boot-a",
}
const resourceTarget = { resourceId: "resource-a", incarnationId: "incarnation-a" } as const
const scheduledTarget = { agent: "agent-a", habitId: "habit-a" } as const
const resourceKey: ResourceKey = {
  machineId: "machine-a",
  ownerUid: 501,
  serviceId: "service-a",
  incarnationId: resourceTarget.incarnationId,
}
const roots: string[] = []

function tempTarget(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-activation-barrier-"))
  roots.push(root)
  return path.join(root, "barriers.v1.json")
}

function state(value: ExactProcessState["state"]): (candidate: ProcessIdentity) => ExactProcessState {
  return (candidate) => value === "alive"
    ? { state: "alive", observed: candidate }
    : value === "dead"
      ? { state: "dead", reason: "process-absent" }
      : { state: "unobservable", reason: "process-evidence-unavailable" }
}

function repository(
  targetPath: string,
  options: {
    processState?: ExactProcessState["state"]
    reconciliationAuthority?: {
      resolve(ref: string, sha256: string): RepairGenerationReconciliationV1
    }
    io?: ProtectedStoreIo
  } = {},
): ActivationBarrierStore {
  return new ActivationBarrierStore({
    targetPath,
    owner,
    proveOwnerState: state(options.processState ?? "alive"),
    reconciliationAuthority: options.reconciliationAuthority,
    io: options.io,
  })
}

function acquireResourceCommand(
  overrides: Partial<Extract<BarrierCommandV1, { kind: "barrier.acquire" }>> = {},
): Extract<BarrierCommandV1, { kind: "barrier.acquire" }> {
  return {
    kind: "barrier.acquire",
    barrierId: "barrier-resource",
    scope: "resource-repair",
    target: resourceTarget,
    holder: "rollout-owner",
    tokenHash: "a".repeat(64),
    releasePolicy: { kind: "one-shot-current", terminalTimeoutMs: 600_000 },
    writerEpoch: "epoch-1",
    at: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

function acquireScheduleCommand(): Extract<BarrierCommandV1, { kind: "barrier.acquire" }> {
  return {
    kind: "barrier.acquire",
    barrierId: "barrier-schedule",
    scope: "scheduled-dispatch",
    target: scheduledTarget,
    holder: "rollout-owner",
    tokenHash: "b".repeat(64),
    releasePolicy: { kind: "continuous" },
    writerEpoch: "epoch-1",
    at: "2026-07-24T12:00:00.000Z",
  }
}

function scheduledAdmission(): Extract<BarrierCommandV1, { kind: "admission.scheduled" }> {
  return {
    kind: "admission.scheduled",
    deferredId: "deferred-slot",
    target: scheduledTarget,
    scheduleRevision: "revision-a",
    slotKey: "slot-a",
    scheduledAtUtc: "2026-07-24T13:00:00.000Z",
    writerEpoch: "epoch-1",
    at: "2026-07-24T12:00:30.000Z",
  }
}

function repairAdmission(
  overrides: Partial<Extract<BarrierCommandV1, { kind: "admission.repair" }>> = {},
): Extract<BarrierCommandV1, { kind: "admission.repair" }> {
  return {
    kind: "admission.repair",
    deferredId: "deferred-repair",
    target: resourceTarget,
    observationId: "observation-a",
    repairEligibilityId: "eligibility-a",
    repairGeneration: 1,
    writerEpoch: "epoch-1",
    at: "2026-07-24T12:00:30.000Z",
    ...overrides,
  }
}

function armWindow(repo: ActivationBarrierStore): string {
  repo.apply(acquireResourceCommand())
  repo.withRepairAdmission(repairAdmission(), () => {
    throw new Error("held repair barrier invoked attempt")
  })
  const released = repo.apply({
    kind: "barrier.release",
    barrierId: "barrier-resource",
    holder: "rollout-owner",
    tokenHash: "a".repeat(64),
    currentDedupeKey: "eligibility-a",
    writerEpoch: "epoch-2",
    at: "2026-07-24T12:01:00.000Z",
  })
  if (released.result.kind !== "released" || released.result.actionWindow === null) {
    throw new Error("fixture did not arm a window")
  }
  return released.result.actionWindow.actionWindowId
}

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("protected activation barrier store", () => {
  it("persists canonical mode-0600 state and survives repository restart", () => {
    const targetPath = tempTarget()
    const first = repository(targetPath)
    first.apply(acquireResourceCommand())

    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600)
    const bytes = fs.readFileSync(targetPath, "utf8")
    expect(bytes).toBe(canonicalizeJson(JSON.parse(bytes)))
    const restarted = repository(targetPath)
    expect(restarted.read()).toEqual(first.read())
    expect(restarted.read().barriers["barrier-resource"].status).toBe("held")
  })

  it("rejects corrupt, noncanonical, symlinked, and wrong-mode state", () => {
    const corrupt = tempTarget()
    fs.writeFileSync(corrupt, "{}", { mode: 0o600 })
    expect(() => repository(corrupt).read()).toThrow(ProtectedStoreCorruptError)

    const wrongMode = tempTarget()
    repository(wrongMode).apply(acquireResourceCommand())
    fs.chmodSync(wrongMode, 0o644)
    expect(() => repository(wrongMode).read()).toThrow(/mode 0600/i)

    const linkTarget = tempTarget()
    repository(linkTarget).apply(acquireResourceCommand())
    const link = `${linkTarget}.symlink`
    fs.symlinkSync(linkTarget, link)
    expect(() => repository(link).read()).toThrow(/symlink|regular/i)
  })

  it("serializes concurrent writers with exact-owner lock proof", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    repo.apply(acquireScheduleCommand())
    let claimCalls = 0

    const result = repository(targetPath).withScheduledAdmission(
      { ...scheduledAdmission(), target: { agent: "agent-b", habitId: "habit-b" }, deferredId: "other" },
      () => {
        claimCalls += 1
        expect(() => repo.apply(acquireResourceCommand({ barrierId: "concurrent" }))).toThrow(ProtectedStoreLockedError)
        return { occurrenceId: "occurrence-a" }
      },
    )

    expect(result.admission).toEqual({ kind: "admitted", actionWindow: null })
    expect(result.claim).toEqual({ occurrenceId: "occurrence-a" })
    expect(claimCalls).toBe(1)
    expect(fs.existsSync(`${targetPath}.lock`)).toBe(false)
  })

  it("reclaims only an exactly dead prior writer and preserves restart evidence", () => {
    const targetPath = tempTarget()
    repository(targetPath).apply(acquireScheduleCommand())
    fs.writeFileSync(`${targetPath}.lock`, canonicalizeJson({ schemaVersion: 1, owner }), { mode: 0o600 })

    expect(() => repository(targetPath, { processState: "unobservable" }).apply(acquireResourceCommand())).toThrow(
      ProtectedStoreLockedError,
    )
    expect(repository(targetPath, { processState: "dead" }).apply(acquireResourceCommand()).result.kind).toBe("acquired")
  })
})

describe("in-process admission boundary", () => {
  it("never invokes a scheduled claim while a matching barrier is held", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    repo.apply(acquireScheduleCommand())
    const claim = vi.fn(() => ({ occurrenceId: "must-not-exist" }))

    const result = repo.withScheduledAdmission(scheduledAdmission(), claim)

    expect(result.admission.kind).toBe("deferred")
    expect(result.claim).toBeUndefined()
    expect(claim).not.toHaveBeenCalled()
    expect(repo.read().deferredIntents["deferred-slot"].state).toBe("pending")
  })

  it("invokes an unrelated scheduled claim exactly once while admission is serialized", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    repo.apply(acquireScheduleCommand())
    const claim = vi.fn(() => ({ occurrenceId: "occurrence-b" }))

    const result = repo.withScheduledAdmission({
      ...scheduledAdmission(),
      deferredId: "deferred-unrelated",
      target: { agent: "agent-b", habitId: "habit-b" },
    }, claim)

    expect(result).toEqual({ admission: { kind: "admitted", actionWindow: null }, claim: { occurrenceId: "occurrence-b" } })
    expect(claim).toHaveBeenCalledTimes(1)
    expect(repo.read().deferredIntents).toEqual({})
  })

  it("never invokes a repair attempt while its barrier is held and mutates no external counters", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    repo.apply(acquireResourceCommand())
    const external = { attempts: 0, samples: 3, budget: 2 }

    const result = repo.withRepairAdmission(repairAdmission(), () => {
      external.attempts += 1
      external.budget -= 1
      return { takeoverId: "must-not-exist" }
    })

    expect(result.admission.kind).toBe("deferred")
    expect(result.attempt).toBeUndefined()
    expect(external).toEqual({ attempts: 0, samples: 3, budget: 2 })
  })

  it("persists one-shot consumption before invoking the exact repair attempt", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    const windowId = armWindow(repo)
    let stateSeenByAttempt: string | null = null

    const result = repo.withRepairAdmission(repairAdmission({
      deferredId: "replay-deferred",
      repairGeneration: 12,
      writerEpoch: "epoch-3",
      at: "2026-07-24T12:02:00.000Z",
    }), () => {
      stateSeenByAttempt = repository(targetPath).read().actionWindows[windowId].state
      return { takeoverId: "takeover-12" }
    })

    expect(stateSeenByAttempt).toBe("consumed")
    expect(result.admission).toMatchObject({ kind: "admitted", actionWindow: { repairGeneration: 12 } })
    expect(result.attempt).toEqual({ takeoverId: "takeover-12" })
    expect(() => repo.withRepairAdmission(repairAdmission({ repairGeneration: 13 }), () => ({}))).toThrow(/generation|blocked/i)
  })

  it("does not invoke a consumed one-shot generation again on exact replay", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    armWindow(repo)
    const command = repairAdmission({
      deferredId: "replay-deferred",
      repairGeneration: 12,
      writerEpoch: "epoch-3",
      at: "2026-07-24T12:02:00.000Z",
    })
    const attempt = vi.fn(() => ({ takeoverId: "takeover-12" }))

    repo.withRepairAdmission(command, attempt)
    const replay = repo.withRepairAdmission(command, attempt)

    expect(replay.admission).toMatchObject({ kind: "admitted", replayed: true })
    expect(replay.attempt).toBeUndefined()
    expect(attempt).toHaveBeenCalledOnce()
  })

  it("does not call the attempt when durable consumption fails", () => {
    const targetPath = tempTarget()
    const repo = repository(targetPath)
    armWindow(repo)
    const attempt = vi.fn(() => ({ takeoverId: "takeover-a" }))
    const failing = repository(targetPath, {
      io: {
        ...nodeProtectedStoreIo,
        renameSync: () => { throw new Error("rename denied") },
      },
    })

    expect(() => failing.withRepairAdmission(repairAdmission({ repairGeneration: 2 }), attempt)).toThrow("rename denied")
    expect(attempt).not.toHaveBeenCalled()
    expect(repository(targetPath).read().actionWindows[
      deriveActionWindowId("barrier-resource", "deferred-repair", "eligibility-a")
    ].state).toBe("armed")
  })
})

describe("rearm authority boundary", () => {
  function blockedRepository(targetPath: string): { repo: ActivationBarrierStore; windowId: string } {
    const repo = repository(targetPath)
    const windowId = armWindow(repo)
    repo.withRepairAdmission(repairAdmission({ repairGeneration: 1 }), () => ({ takeoverId: "takeover-a" }))
    repo.apply({
      kind: "action-window.block",
      actionWindowId: windowId,
      repairGeneration: 1,
      disposition: "outcome_unknown",
      terminalRef: "authority/unknown.json",
      terminalSha256: "4".repeat(64),
      writerEpoch: "epoch-4",
      at: "2026-07-24T12:05:00.000Z",
    })
    repo.apply(acquireResourceCommand({
      barrierId: "barrier-rearm",
      tokenHash: "d".repeat(64),
      writerEpoch: "epoch-5",
      at: "2026-07-24T12:06:00.000Z",
    }))
    repo.withRepairAdmission(repairAdmission({
      deferredId: "deferred-rearm",
      repairEligibilityId: "eligibility-b",
      repairGeneration: 2,
      writerEpoch: "epoch-5",
      at: "2026-07-24T12:06:30.000Z",
    }), () => {
      throw new Error("held rearm barrier invoked attempt")
    })
    repo.apply(acquireScheduleCommand())
    return { repo, windowId }
  }

  function proof(windowId: string): RepairGenerationReconciliationV1 {
    return {
      schemaVersion: 1,
      resourceId: resourceTarget.resourceId,
      resourceKey,
      repairGeneration: 1,
      takeoverId: "takeover-a",
      disposition: "rolled_back",
      requestRef: `authority/${windowId}/request.json`,
      requestSha256: "1".repeat(64),
      ownerAuthorityRef: `authority/${windowId}/receipt.json`,
      ownerAuthoritySha256: "2".repeat(64),
      inspectRef: `authority/${windowId}/inspect.json`,
      inspectSha256: "3".repeat(64),
      observedAt: "2026-07-24T12:07:00.000Z",
    }
  }

  it("rejects raw inference, absent authority, and dead-owner process evidence", () => {
    const targetPath = tempTarget()
    const { repo, windowId } = blockedRepository(targetPath)

    expect(() => repo.rearm({
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "d".repeat(64),
      blockedActionWindowId: windowId,
      currentDedupeKey: "eligibility-b",
      reconciliationRef: "authority/reconciliation.json",
      reconciliationSha256: "9".repeat(64),
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-6",
      at: "2026-07-24T12:08:00.000Z",
    })).toThrow(/reconciliation authority/i)

    expect(() => repository(targetPath, { processState: "dead" }).rearm({
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "d".repeat(64),
      blockedActionWindowId: windowId,
      currentDedupeKey: "eligibility-b",
      reconciliationRef: "process-is-absent",
      reconciliationSha256: "0".repeat(64),
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-6",
      at: "2026-07-24T12:08:00.000Z",
    })).toThrow(/reconciliation authority/i)
  })

  it("resolves exact authority bytes before one CAS supersedes and rearms", () => {
    const targetPath = tempTarget()
    const initial = blockedRepository(targetPath)
    const expectedProof = proof(initial.windowId)
    const expectedProofSha256 = sha256CanonicalJson(expectedProof)
    const resolve = vi.fn((ref: string, sha256: string) => {
      expect(ref).toBe("authority/reconciliation.json")
      expect(sha256).toBe(expectedProofSha256)
      return expectedProof
    })
    const repo = repository(targetPath, { reconciliationAuthority: { resolve } })

    const result = repo.rearm({
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "d".repeat(64),
      blockedActionWindowId: initial.windowId,
      currentDedupeKey: "eligibility-b",
      reconciliationRef: "authority/reconciliation.json",
      reconciliationSha256: expectedProofSha256,
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-6",
      at: "2026-07-24T12:08:00.000Z",
    })

    const nextId = deriveActionWindowId("barrier-rearm", "deferred-rearm", "eligibility-b")
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result.result).toMatchObject({ kind: "rearmed", priorActionWindowId: initial.windowId, actionWindow: { actionWindowId: nextId } })
    expect(repo.read().actionWindows[initial.windowId]).toMatchObject({ state: "superseded", supersededBy: nextId })
    expect(repo.read().actionWindows[nextId].state).toBe("armed")
  })

  it("rejects authority bytes that do not match the requested reconciliation hash", () => {
    const targetPath = tempTarget()
    const initial = blockedRepository(targetPath)
    const expectedProof = proof(initial.windowId)
    const repo = repository(targetPath, {
      reconciliationAuthority: { resolve: () => expectedProof },
    })

    expect(() => repo.rearm({
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "d".repeat(64),
      blockedActionWindowId: initial.windowId,
      currentDedupeKey: "eligibility-b",
      reconciliationRef: "authority/reconciliation.json",
      reconciliationSha256: "9".repeat(64),
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-6",
      at: "2026-07-24T12:08:00.000Z",
    })).toThrow(/bytes.*hash|hash.*bytes/i)
  })

  it("lets only one concurrent rearm CAS win and leaves unrelated resources byte-identical", async () => {
    const targetPath = tempTarget()
    const initial = blockedRepository(targetPath)
    const expectedProof = proof(initial.windowId)
    const expectedProofSha256 = sha256CanonicalJson(expectedProof)
    const makeRepo = () => repository(targetPath, {
      reconciliationAuthority: { resolve: () => expectedProof },
    })
    const unrelatedBefore = JSON.stringify(makeRepo().read().barriers["barrier-schedule"] ?? null)
    const input = {
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "d".repeat(64),
      blockedActionWindowId: initial.windowId,
      currentDedupeKey: "eligibility-b",
      reconciliationRef: "authority/reconciliation.json",
      reconciliationSha256: expectedProofSha256,
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-6",
      at: "2026-07-24T12:08:00.000Z",
    } as const

    const settled = await Promise.allSettled([
      Promise.resolve().then(() => makeRepo().rearm(input)),
      Promise.resolve().then(() => makeRepo().rearm(input)),
    ])
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect(JSON.stringify(makeRepo().read().barriers["barrier-schedule"] ?? null)).toBe(unrelatedBefore)
  })
})
