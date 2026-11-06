import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createApprovedUnraidRestartExecutor, SANCTUARY_RESTART_MUTATION, type ApprovedUnraidRestartOptions, type RoutineRestartAuthority, type UnraidRestartExecution } from "../../repertoire/unraid-restart"
import * as policy from "../../heart/steward-policy"
import { claimExternalEvent, commitExternalEventDisposition, readExternalEventRecord, recordExternalEvent, renewExternalEventClaim } from "../../heart/external-events/router"
import { acquireSessionTurnLease, currentSessionTurnLease } from "../../mind/session-transaction"
import { authorizeRoutineActionRequester } from "../../repertoire/relationship-authorization"
import type { ToolContext } from "../../repertoire/tools-base"

const running = (id = "Docker:abc", name = "calibre-web") => ({
  ok: true as const,
  data: { containers: [{ id, name, autostart: true, state: "running" as const, exitCode: null, degraded: false, status: "Up 2 hours" }], truncated: false },
})

const requester = { kind: "owner" as const, friendId: "ari", profileId: "sanctuary-owner", requestId: "request-current", sessionEventId: "evt-current", origin: { friendId: "ari", channel: "telegram", key: "telegram_owner" } }
const routineAuthority = (key: string, expectedPolicyVersion: number, receiptId = "relationship-1", profileVersion = 7): RoutineRestartAuthority => ({
  key,
  expectedPolicyVersion,
  expectedDesiredStateVersion: expectedPolicyVersion - 1,
  expectedGrantVersion: expectedPolicyVersion,
  requester,
  reauthorize: async () => ({ allowed: true as const, receiptId, profileVersion }),
})

describe("A006 S4 approval boundary failures", () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const agentRoot of roots.splice(0)) fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  function fixture() {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a006-final-approval-"))
    roots.push(agentRoot)
    const listContainers = vi.fn<ApprovedUnraidRestartOptions["listContainers"]>(async () => running())
    const loadWriteApiKey = vi.fn(async () => "key")
    const reauthorize = vi.fn<NonNullable<UnraidRestartExecution["approval"]>["reauthorize"]>(async () => ({ allowed: true }))
    const mutate = vi.fn(async () => ({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }))
    const persistAttempt = vi.fn<NonNullable<ApprovedUnraidRestartOptions["persistAttempt"]>>(async () => undefined)
    const options: ApprovedUnraidRestartOptions = {
      endpoint: "https://host/graphql", listContainers, loadWriteApiKey, persistAttempt, createClient: () => ({ mutate }),
      withApprovalPolicyLease: (operation) => policy.withStewardPolicyLease(agentRoot, operation), observationTimeoutMs: 0,
    }
    const execution: UnraidRestartExecution = { approval: { target: { id: "Docker:abc", name: "calibre-web" }, reauthorize } }
    const args = { container: "calibre-web" }
    const restart = createApprovedUnraidRestartExecutor(options)
    return { agentRoot, listContainers, loadWriteApiKey, reauthorize, mutate, persistAttempt, options, execution, args, run: () => restart(args, execution) }
  }

  it.each([
    undefined, null, {}, { target: null },
    { reauthorize: async () => ({ allowed: true }) },
    { target: { id: "", name: "calibre-web" }, reauthorize: async () => ({ allowed: true }) },
    { target: { id: " Docker:abc", name: "calibre-web" }, reauthorize: async () => ({ allowed: true }) },
    { target: { id: "Docker:abc", name: "other" }, reauthorize: async () => ({ allowed: true }) },
  ])("rejects an explicitly invalid approval carrier instead of using legacy authority [%#]: %j", async (approval) => {
    const current = fixture()
    Reflect.set(current.execution, "approval", approval)
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.loadWriteApiKey).not.toHaveBeenCalled()
    expect(current.persistAttempt).not.toHaveBeenCalled()
  })

  it("refuses simultaneous approval and standing authority before an attempt or credential read", async () => {
    const current = fixture()
    current.execution.routine = routineAuthority("unraid.restart:calibre-web", 2)
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.loadWriteApiKey).not.toHaveBeenCalled()
    expect(current.persistAttempt).not.toHaveBeenCalled()
  })

  it.each([undefined, null])("fails closed when the existing policy lease adapter is %j", async (adapter) => {
    const current = fixture()
    Reflect.set(current.options, "withApprovalPolicyLease", adapter)
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: expect.stringContaining("policy lease") } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it.each([undefined, null, {}, { allowed: "yes" }, { allowed: false, reason: "" }, { allowed: false, reason: null }, { allowed: false, reason: 7 }])("rejects an invalid final authorization result without mutation: %j", async (authorization) => {
    const current = fixture()
    Reflect.set(current.execution.approval!, "reauthorize", async () => authorization)
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { code: "stale_target", message: expect.stringMatching(/\S/u) } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it("bounds a final dependency error without claiming an attempt", async () => {
    const current = fixture()
    current.reauthorize.mockRejectedValue(new Error("x".repeat(800)))
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "x".repeat(500) } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it("translates a non-Error lease failure to bounded no-effect data", async () => {
    const current = fixture()
    current.options.withApprovalPolicyLease = async () => { throw "private dependency details" }
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "restart approval authority changed" } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it("returns a final inventory failure before attempting", async () => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      current.listContainers.mockResolvedValue({ ok: false, error: { code: "timeout", message: "live inventory unavailable", degraded: true } })
      return "key"
    })
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "live inventory unavailable" } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it("retains the callback-frozen target when the execution carrier changes during its first read", async () => {
    const current = fixture()
    current.listContainers.mockImplementation(async () => {
      Reflect.set(current.execution.approval!, "target", { id: "Docker:replacement", name: "calibre-web" })
      return running("Docker:replacement")
    })
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { code: "stale_target" } })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
  })

  it("retains the final guard when an execution carrier changes its authorization callback", async () => {
    const current = fixture()
    current.reauthorize.mockResolvedValue({ allowed: false, reason: "owner was revoked" })
    current.loadWriteApiKey.mockImplementation(async () => {
      Reflect.set(current.execution.approval!, "reauthorize", async () => ({ allowed: true }))
      return "key"
    })
    await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "owner was revoked" } })
    expect(current.reauthorize).toHaveBeenCalledOnce()
    expect(current.mutate).not.toHaveBeenCalled()
  })

  it("propagates a crash immediately after durable attempting rather than reporting no-effect", async () => {
    const current = fixture()
    current.persistAttempt.mockImplementation(async (attempt) => {
      if (attempt.state === "attempting") throw new Error("crash after durable attempting")
    })
    await expect(current.run()).rejects.toThrow("crash after durable attempting")
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started", "attempting"])
    expect(current.mutate).not.toHaveBeenCalled()
    expect(currentSessionTurnLease(path.join(current.agentRoot, "state", "policy", "steward.json"))).toBeNull()
  })
})

describe("A-006 final routine mutation boundary", () => {
  const roots: string[] = []
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const agentRoot of roots.splice(0)) fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  function fixture() {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a006-final-routine-"))
    roots.push(agentRoot)
    const update = (mutation: policy.StewardPolicyMutation) => {
      const version = policy.readStewardPolicy(agentRoot).version
      return policy.updateStewardPolicy(agentRoot, {
        expectedVersion: version,
        actor: {
          friendId: "ari", trustLevel: "family", sessionEventId: `evt-policy-${version + 1}`,
          authorization: { profileId: "sanctuary-owner", profileVersion: 7, requestId: "request-current", sessionKey: "telegram_owner", receiptId: "relationship-1" },
        },
        mutation,
      })
    }
    update({ kind: "set_desired_state", key: "container:calibre-web", value: "on", provenance: "stated", source: "current owner" })
    const grant: policy.StewardPolicyMutation & { kind: "grant_routine_action" } = {
      kind: "grant_routine_action", key: "unraid.restart:calibre-web", action: "unraid.container.restart", targets: ["calibre-web"],
      maxCount: 2, windowMs: 1_800_000, verificationRequired: true, exclusions: [], provenance: "stated",
    }
    update(grant)
    const reauthorize = vi.fn<RoutineRestartAuthority["reauthorize"]>(async () => ({ allowed: true, receiptId: "relationship-1", profileVersion: 7 }))
    const listContainers = vi.fn<ApprovedUnraidRestartOptions["listContainers"]>(async () => running())
    const loadWriteApiKey = vi.fn(async () => "key")
    const mutate = vi.fn(async () => ({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }))
    const persistAttempt = vi.fn<NonNullable<ApprovedUnraidRestartOptions["persistAttempt"]>>(async () => undefined)
    const options: ApprovedUnraidRestartOptions = {
      endpoint: "https://host/graphql", listContainers, loadWriteApiKey, persistAttempt,
      createClient: () => ({ mutate }),
      reserveRoutineAction: (input) => policy.consumeRoutineActionGrant(agentRoot, input),
      transitionRoutineAction: (input) => policy.transitionRoutineActionReceipt(agentRoot, input),
      withRoutineActionAttempt: (reservation: policy.RoutineActionReceipt, validate: () => Promise<void>, attempt: () => Promise<void>) =>
        policy.withRoutineActionAttempt(agentRoot, reservation, validate, attempt),
      sleep: async () => undefined, observationTimeoutMs: 0,
    }
    const restart = createApprovedUnraidRestartExecutor(options)
    const args = { container: "calibre-web" }
    const authority = { ...routineAuthority(grant.key, 2), reauthorize }
    const execution: UnraidRestartExecution = { routine: authority }
    return {
      agentRoot, update, grant, args, authority, execution, reauthorize, listContainers, loadWriteApiKey, mutate, persistAttempt, options,
      run: () => restart(args, execution),
      receipt: () => policy.readRoutineActionReceipts(agentRoot)[0]!,
      appendReceipt: (receipt: policy.RoutineActionReceipt) => fs.appendFileSync(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), `${JSON.stringify(receipt)}\n`),
    }
  }

  function eventFixture() {
    const current = fixture()
    const received = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed",
      eventId: "container:Docker:abc:availability", observationRevision: "exited-1", transition: "opened",
    }, { root: path.join(current.agentRoot, "state", "external-events") })
    const claimed = claimExternalEvent(received.recordPath, { owner: "worker-a", expectedVersion: received.version, expectedGeneration: 1 })
    const event = {
      schemaVersion: 1 as const, recordPath: claimed.recordPath, agent: claimed.agent, source: claimed.source, eventId: claimed.eventId,
      generation: claimed.generation, observationRevision: claimed.observationRevision, claimOwner: "worker-a",
    }
    const eventRequester: policy.RoutineActionRequester = {
      kind: "owner_event", friendId: "ari", profileId: "sanctuary-event", event, target: { id: "Docker:abc", name: "calibre-web" },
    }
    current.authority.requester = structuredClone(eventRequester)
    const stopped = () => ({ ...running(), data: { ...running().data, containers: [{ ...running().data.containers[0]!, state: "exited" as const, status: "Exited (0) 1 minute ago" }] } })
    current.listContainers.mockImplementation(async () => current.mutate.mock.calls.length ? running() : stopped())
    const context: ToolContext = {
      signin: async () => undefined, agentRoot: current.agentRoot, currentExternalEvent: event,
      relationshipAuthorization: {
        profileId: "sanctuary-event", authorizedContextScopes: [], advertisedToolNames: ["unraid_restart_container"],
        authorizeTool: async () => ({ allowed: true, receiptId: "relationship-1", profileVersion: 7, profileId: "sanctuary-event", friendId: "ari" }),
      },
      sanctuary: {
        listContainers: current.listContainers, restartContainer: vi.fn(),
        getContainerLogs: vi.fn(), getStorage: vi.fn(), getDisks: vi.fn(), getNotifications: vi.fn(), getSystem: vi.fn(), getInstallState: vi.fn(),
        checkServices: vi.fn(), getDownloadQueue: vi.fn(), getMediaOptimization: vi.fn(), searchMediaCatalog: vi.fn(), resumeDownloadQueue: vi.fn(),
      },
    }
    current.reauthorize.mockImplementation(async () => {
      const authorization = await authorizeRoutineActionRequester(context, current.args, { requester: eventRequester, profileVersion: 7 })
      return authorization.allowed ? { allowed: true, receiptId: authorization.receiptId, profileVersion: authorization.profileVersion } : authorization
    })
    return { ...current, context, event, claimed, stopped, policyPath: path.join(current.agentRoot, "state", "policy", "steward.json") }
  }

  async function expectNoEffect(current: ReturnType<typeof fixture>) {
    await expect(current.run()).resolves.toMatchObject({ ok: false })
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started"])
    expect(current.receipt()).toMatchObject({ state: "failed", effectReceipt: null, verifiedAfterState: null, recoveryState: { state: "completed", compensation: "none" } })
  }

  it("rechecks a current requester after write credentials and completes one real reservation", async () => {
    const current = fixture()
    await expect(current.run()).resolves.toMatchObject({ ok: true })
    expect(current.reauthorize).toHaveBeenCalledTimes(3)
    expect(current.reauthorize.mock.invocationCallOrder[1]).toBeGreaterThan(current.loadWriteApiKey.mock.invocationCallOrder[0]!)
    expect(current.reauthorize.mock.invocationCallOrder[2]).toBeGreaterThan(current.listContainers.mock.invocationCallOrder[2]!)
    expect(current.mutate).toHaveBeenCalledOnce()
    expect(current.receipt()).toMatchObject({ state: "verified", attempt: 1, verifiedAfterState: "running" })
  })

  it.each(["revoked", "changed profile", "unavailable", "unversioned"] as const)("refuses %s relationship authority acquired after reservation", async (change) => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      if (change === "revoked") current.reauthorize.mockResolvedValue({ allowed: false, reason: "owner admission revoked" })
      if (change === "changed profile") current.reauthorize.mockResolvedValue({ allowed: true, receiptId: "relationship-2", profileVersion: 8 })
      if (change === "unavailable") current.reauthorize.mockRejectedValue(new Error("relationship store offline"))
      if (change === "unversioned") current.reauthorize.mockResolvedValue({ allowed: true, receiptId: "", profileVersion: 7 })
      return "key"
    })
    await expectNoEffect(current)
  })

  it.each(["negative desired state", "installed grant", "changed target", "changed rate", "unrelated policy version"] as const)("refuses %s written after reservation", async (change) => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      if (change === "negative desired state") current.update({ kind: "set_desired_state", key: "container:calibre-web", value: "off", provenance: "stated", source: "current owner" })
      if (change === "installed grant") current.update({ ...current.grant, provenance: "installed_explicit_policy" })
      if (change === "changed target") current.update({ ...current.grant, targets: ["jellyfin"] })
      if (change === "changed rate") current.update({ ...current.grant, maxCount: 1 })
      if (change === "unrelated policy version") current.update({ kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "current owner" })
      return "key"
    })
    await expectNoEffect(current)
  })

  const changedReservations: Array<[string, Partial<policy.RoutineActionReceipt>]> = [
    ["key", { key: "other-grant" }],
    ["action", { action: "unraid.container.start" }],
    ["target", { target: "jellyfin" }],
    ["policy version", { policyVersion: 3 }],
    ["desired version", { desiredStateVersion: 3 }],
    ["grant version", { grantVersion: 3 }],
    ["authorization receipt", { authorizationReceiptId: "different-relationship" }],
    ["authorization version", { authorizationVersion: 8 }],
    ["attempt id", { attemptId: "different-attempt" }],
    ["attempt count", { attempt: 2 }],
    ["before state", { expectedBeforeState: "exited" }],
    ["target identity", { resolvedTarget: { id: "Docker:replacement", name: "calibre-web" } }],
    ["effect", { effect: { operation: "restart", targetId: "Docker:replacement" } }],
    ["request", { requester: { ...requester, requestId: "different-request" } }],
    ["reserved time", { reservedAt: "2099-01-01T00:00:00.000Z" }],
    ["updated time", { updatedAt: "2099-01-01T00:00:00.000Z" }],
  ]
  it.each(changedReservations)("refuses a changed reserved %s before the durable attempt", async (_name, change) => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      current.appendReceipt({ ...current.receipt(), ...change })
      return "key"
    })
    await expectNoEffect(current)
  })

  it.each(["unresolved", "rate exhausted"] as const)("refuses a newly %s receipt before the durable attempt", async (change) => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      const receipt = current.receipt()
      current.appendReceipt({ ...receipt, id: "other-action-1", state: change === "unresolved" ? "indeterminate" : "failed" })
      if (change === "rate exhausted") current.appendReceipt({ ...receipt, id: "other-action-2", state: "failed" })
      return "key"
    })
    await expectNoEffect(current)
  })

  it("counts the current reservation once at the exact two-reservation limit", async () => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      current.appendReceipt({ ...current.receipt(), id: "other-completed-action", state: "failed" })
      return "key"
    })
    await expect(current.run()).resolves.toMatchObject({ ok: true })
    expect(current.mutate).toHaveBeenCalledOnce()
    expect(current.receipt().state).toBe("verified")
  })

  it("refuses a reservation after its original rate window closes", async () => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.parse(current.receipt().reservedAt) + 1_800_000)
      return "key"
    })
    await expectNoEffect(current)
  })

  it.each(["identity", "name", "degraded", "truncated", "arguments"] as const)("refuses changed final %s after write credentials", async (change) => {
    const current = fixture()
    current.loadWriteApiKey.mockImplementation(async () => {
      if (change === "identity") current.listContainers.mockResolvedValue(running("Docker:replacement"))
      if (change === "name") current.listContainers.mockResolvedValue(running("Docker:abc", "jellyfin"))
      if (change === "degraded") current.listContainers.mockResolvedValue({ ...running(), data: { ...running().data, containers: [{ ...running().data.containers[0]!, degraded: true }] } })
      if (change === "truncated") current.listContainers.mockResolvedValue({ ...running(), data: { ...running().data, truncated: true } })
      if (change === "arguments") current.args.container = "jellyfin"
      return "key"
    })
    await expectNoEffect(current)
  })

  it("records definite no-effect when write credential loading fails after reservation", async () => {
    const current = fixture()
    current.loadWriteApiKey.mockRejectedValue(new Error("write credential store unavailable"))
    await expect(current.run()).rejects.toThrow("write credential store unavailable")
    expect(current.mutate).not.toHaveBeenCalled()
    expect(current.receipt()).toMatchObject({ state: "failed", recoveryState: { state: "completed", compensation: "none" } })
  })

  describe("A006 S4 routine boundary failures", () => {
    it("rechecks relationship authority after the final inventory await", async () => {
      const current = fixture()
      current.listContainers.mockImplementation(async () => {
        if (current.loadWriteApiKey.mock.calls.length) current.reauthorize.mockResolvedValue({ allowed: false, reason: "owner revoked during inventory" })
        return running()
      })
      await expectNoEffect(current)
    })

    it("records definite no-effect when the write client cannot be constructed", async () => {
      const current = fixture()
      current.options.createClient = () => { throw new Error("write client unavailable") }
      // The executor captures the client factory on construction.
      const restart = createApprovedUnraidRestartExecutor(current.options)
      await expect(restart(current.args, current.execution)).rejects.toThrow("write client unavailable")
      expect(current.mutate).not.toHaveBeenCalled()
      expect(current.receipt()).toMatchObject({ state: "failed", recoveryState: { state: "completed", compensation: "none" } })
    })

    it.each(["requester", "desiredStateVersion"] as const)("refuses an unchanged legacy reservation without %s", async (field) => {
      const current = fixture()
      const reserve = current.options.reserveRoutineAction!
      current.options.reserveRoutineAction = (input) => {
        const receipt = reserve(input)
        delete receipt[field]
        current.appendReceipt(receipt)
        return receipt
      }
      await expectNoEffect(current)
    })

    it("keeps final reauthorization when the execution carrier loses its routine field", async () => {
      const current = fixture()
      current.loadWriteApiKey.mockImplementation(async () => {
        current.reauthorize.mockResolvedValue({ allowed: false, reason: "owner revoked" })
        delete current.execution.routine
        return "key"
      })
      await expectNoEffect(current)
    })

    it("fails no-effect on a final inventory dependency failure", async () => {
      const current = fixture()
      current.loadWriteApiKey.mockImplementation(async () => {
        current.listContainers.mockResolvedValue({ ok: false, error: { code: "timeout", message: "inventory unavailable", degraded: true } })
        return "key"
      })
      await expectNoEffect(current)
    })

    it("translates a non-Error final policy failure without leaking its value", async () => {
      const current = fixture()
      current.options.withRoutineActionAttempt = async () => { throw "private dependency details" }
      await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "routine action authority changed" } })
      expect(current.mutate).not.toHaveBeenCalled()
      expect(current.receipt().state).toBe("failed")
    })

    it("translates a malformed initial relationship result before reservation", async () => {
      const current = fixture()
      Reflect.set(current.authority, "reauthorize", async () => Object.defineProperty({}, "allowed", { get: () => { throw "private dependency details" } }))
      await expect(current.run()).resolves.toMatchObject({ ok: false, error: { message: "routine relationship authorization is unavailable" } })
      expect(current.mutate).not.toHaveBeenCalled()
      expect(policy.readRoutineActionReceipts(current.agentRoot)).toEqual([])
    })

    it.each(["reserved", "attempting"] as const)("recovers a crash at %s through the existing receipt owner without mutation", async (state) => {
      const current = fixture()
      current.persistAttempt.mockImplementation(async (attempt) => {
        if (attempt.state === (state === "reserved" ? "attempt_not_started" : "attempting")) throw new Error(`crash at ${state}`)
      })
      await expect(current.run()).rejects.toThrow(`crash at ${state}`)
      expect(current.receipt().state).toBe(state)
      const observeTarget = vi.fn(async () => ({ id: "Docker:abc", name: "calibre-web", state: "running" }))
      await policy.recoverRoutineActionReceipts(current.agentRoot, { observeTarget })
      expect(current.receipt().state).toBe(state === "reserved" ? "recovered_no_effect" : "indeterminate")
      expect(current.mutate).not.toHaveBeenCalled()
      expect(observeTarget).not.toHaveBeenCalled()
    })
  })

  describe("current event lock and deadline", () => {
    it.each(["owner", "generation", "revision", "recovered", "pending observation", "expired", "missing expiry", "wrong event type", "missing record", "corrupt record"] as const)("A006 S4 rejects event %s drift after reservation", async (change) => {
      const current = eventFixture()
      current.loadWriteApiKey.mockImplementation(async () => {
        const record = readExternalEventRecord(current.event.recordPath)
        if (change === "owner") claimExternalEvent(record.recordPath, {
          owner: "worker-b", expectedVersion: record.version, expectedGeneration: record.generation,
          now: () => new Date(Date.parse(record.claimExpiresAt!) + 1).toISOString(),
        })
        if (change === "generation") fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, generation: record.generation + 1 }))
        if (change === "revision") fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, observationRevision: "exited-2" }))
        if (change === "recovered") fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, transition: "recovered" }))
        if (change === "pending observation") recordExternalEvent({
          agent: record.agent, source: record.source, eventId: record.eventId, eventType: "health.observed", observationRevision: "running-2", transition: "recovered",
        }, { root: path.join(current.agentRoot, "state", "external-events") })
        if (change === "expired") {
          vi.useFakeTimers({ toFake: ["Date"] })
          vi.setSystemTime(Date.parse(record.claimExpiresAt!))
        }
        if (change === "missing expiry") fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, claimExpiresAt: null }))
        if (change === "wrong event type") fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, eventType: "other.observed" }))
        if (change === "missing record") fs.unlinkSync(record.recordPath)
        if (change === "corrupt record") fs.writeFileSync(record.recordPath, "{invalid")
        return "key"
      })
      await expectNoEffect(current)
      expect(fs.existsSync(`${current.event.recordPath}.lock`)).toBe(false)
      if (change === "corrupt record") expect(fs.readFileSync(current.event.recordPath, "utf8")).toBe("{invalid")
    })

    it("holds event then policy ownership through the same-signal final read and exact mutation, but not verification", async () => {
      const current = eventFixture()
      const deadline = new AbortController()
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
      const probes: Array<{ phase: string; eventLocked: boolean; policyLocked: boolean; signal: AbortSignal | undefined; receipt: string }> = []
      const probe = (phase: string, signal?: AbortSignal) => probes.push({
        phase, signal, eventLocked: fs.existsSync(`${current.event.recordPath}.lock`),
        policyLocked: currentSessionTurnLease(current.policyPath) !== null, receipt: current.receipt().state,
      })
      current.listContainers.mockImplementation(async (signal?: AbortSignal) => {
        if (current.loadWriteApiKey.mock.calls.length) probe(current.mutate.mock.calls.length ? "verification" : "final read", signal)
        return current.mutate.mock.calls.length ? running() : current.stopped()
      })
      current.mutate.mockImplementation(async (_document?: string, variables?: Record<string, unknown>, signal?: AbortSignal) => {
        probe("mutation", signal)
        expect(variables).toEqual({ id: "Docker:abc" })
        return { docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }
      })
      await expect(current.run()).resolves.toMatchObject({ ok: true })
      expect(timeout).toHaveBeenCalledExactlyOnceWith(25_000)
      expect(probes).toEqual([
        { phase: "final read", eventLocked: true, policyLocked: true, signal: deadline.signal, receipt: "reserved" },
        { phase: "mutation", eventLocked: true, policyLocked: true, signal: deadline.signal, receipt: "attempting" },
        { phase: "verification", eventLocked: false, policyLocked: false, signal: undefined, receipt: "effect_acknowledged" },
      ])
      expect(current.mutate).toHaveBeenCalledOnce()
    })

    it.each(["running", "restarting", "unknown"] as const)("closes no-effect when the event target is now %s", async (state) => {
      const current = eventFixture()
      current.loadWriteApiKey.mockImplementation(async () => {
        current.listContainers.mockResolvedValue({ ...running(), data: { ...running().data, containers: [{ ...running().data.containers[0]!, state }] } })
        return "key"
      })
      await expectNoEffect(current)
    })

    it("reads the latest target after final relationship reauthorization completes", async () => {
      const current = eventFixture()
      const reauthorize = current.reauthorize.getMockImplementation()!
      current.reauthorize.mockImplementation(async () => {
        const authorization = await reauthorize()
        if (current.loadWriteApiKey.mock.calls.length) current.listContainers.mockResolvedValue(running())
        return authorization
      })
      await expectNoEffect(current)
    })

    it.each(["disposition", "claim reassignment"] as const)("keeps %s busy at the validation-to-mutation seam", async (competitor) => {
      const current = eventFixture()
      let raceResult = "not run"
      current.mutate.mockImplementation(async () => {
        const record = readExternalEventRecord(current.event.recordPath)
        try {
          if (competitor === "disposition") {
            commitExternalEventDisposition(record.recordPath, {
              owner: "worker-a", expectedVersion: record.version, expectedGeneration: record.generation,
              disposition: {
                classifiedRevision: record.observationRevision, classification: "actionable", stewardPolicy: { kind: "none" },
                decision: "silent", reason: "Competing disposition", nextWake: { kind: "on_change" },
                careId: null, awaitId: null, actionRefs: [], verificationRefs: [],
              },
            })
          } else {
            claimExternalEvent(record.recordPath, {
              owner: "worker-b", expectedVersion: record.version, expectedGeneration: record.generation,
              now: () => new Date(Date.parse(record.claimExpiresAt!) + 1).toISOString(),
            })
          }
          raceResult = "changed"
        } catch (error) {
          raceResult = error instanceof Error ? error.message : String(error)
        }
        return { docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }
      })
      await expect(current.run()).resolves.toMatchObject({ ok: true })
      expect(raceResult).toContain("busy")
      expect(readExternalEventRecord(current.event.recordPath)).toMatchObject({ executionState: "running", claimOwner: "worker-a" })
      expect(current.mutate).toHaveBeenCalledOnce()
      expect(renewExternalEventClaim(current.event.recordPath, { owner: "worker-a", expectedGeneration: 1 }).claimOwner).toBe("worker-a")
    })

    it("retains record ownership while waiting for the existing policy lease and lets both contenders finish", async () => {
      const current = eventFixture()
      let releaseCredentials!: () => void
      const credentials = new Promise<void>((resolve) => { releaseCredentials = resolve })
      current.loadWriteApiKey.mockImplementation(async () => { await credentials; return "key" })
      const pending = current.run()
      await vi.waitFor(() => expect(current.loadWriteApiKey).toHaveBeenCalledOnce())
      const lease = await acquireSessionTurnLease(current.policyPath, { timeoutMs: 0 })
      try {
        releaseCredentials()
        await vi.waitFor(() => expect(fs.existsSync(`${current.event.recordPath}.lock`)).toBe(true))
        expect(() => renewExternalEventClaim(current.event.recordPath, { owner: "worker-a", expectedGeneration: 1 })).toThrow("busy")
        expect(current.mutate).not.toHaveBeenCalled()
      } finally {
        releaseCredentials()
        await lease.release()
        await pending
      }
      await expect(pending).resolves.toMatchObject({ ok: true })
      expect(current.mutate).toHaveBeenCalledOnce()
      const successor = await acquireSessionTurnLease(current.policyPath, { timeoutMs: 0 })
      await successor.release()
      expect(renewExternalEventClaim(current.event.recordPath, { owner: "worker-a", expectedGeneration: 1 }).claimOwner).toBe("worker-a")
    })

    it("starts no effect when the shared deadline expires during the final read", async () => {
      const current = eventFixture()
      const deadline = new AbortController()
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
      current.listContainers.mockImplementation(async () => {
        if (current.loadWriteApiKey.mock.calls.length) deadline.abort(new DOMException("event deadline expired", "TimeoutError"))
        return current.stopped()
      })
      await expectNoEffect(current)
      expect(fs.existsSync(`${current.event.recordPath}.lock`)).toBe(false)
    })

    it("keeps a deadline after durable attempting indeterminate with no mutation or replay", async () => {
      const current = eventFixture()
      const deadline = new AbortController()
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
      current.persistAttempt.mockImplementation(async (attempt) => {
        if (attempt.state === "attempting") deadline.abort(new DOMException("event deadline expired", "TimeoutError"))
      })
      await expect(current.run()).resolves.toMatchObject({ ok: false })
      expect(current.mutate).not.toHaveBeenCalled()
      expect(current.receipt()).toMatchObject({ state: "indeterminate", effectReceipt: null })
      expect(current.persistAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ state: "attempted_or_indeterminate" }))
      await expect(current.run()).resolves.toMatchObject({ ok: false })
      expect(current.mutate).not.toHaveBeenCalled()
    })

    it("persists lost-acknowledgement truth before releasing either lock or starting verification", async () => {
      const current = eventFixture()
      const deadline = new AbortController()
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
      const terminalLocks: boolean[] = []
      const observedStates: string[] = []
      current.mutate.mockImplementation(async () => {
        deadline.abort(new DOMException("acknowledgement deadline expired", "TimeoutError"))
        throw new Error("mutation acknowledgement lost")
      })
      current.persistAttempt.mockImplementation(async (attempt) => {
        if (attempt.state === "attempted_or_indeterminate") terminalLocks.push(
          fs.existsSync(`${current.event.recordPath}.lock`) && currentSessionTurnLease(current.policyPath) !== null,
        )
      })
      current.listContainers.mockImplementation(async () => {
        if (current.mutate.mock.calls.length) observedStates.push(current.receipt().state)
        return current.stopped()
      })
      await expect(current.run()).resolves.toMatchObject({ ok: false })
      expect(current.mutate).toHaveBeenCalledOnce()
      expect(observedStates).toEqual(["indeterminate"])
      expect(terminalLocks[0]).toBe(true)
      expect(current.receipt().state).toBe("indeterminate")
      expect(fs.existsSync(`${current.event.recordPath}.lock`)).toBe(false)
    })
  })
})

describe("approved Unraid restart executor", () => {
  const withRoutineActionAttempt = async (_reservation: policy.RoutineActionReceipt, validate: () => Promise<void>, attempt: () => Promise<void>) => {
    await validate()
    await attempt()
  }

  it("binds routine authority after exact double resolution and records every effect boundary", async () => {
    const reserveRoutineAction = vi.fn().mockReturnValue({ id: "receipt-1" })
    const transitionRoutineAction = vi.fn()
    const persistAttempt = vi.fn()
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt,
      reserveRoutineAction,
      transitionRoutineAction,
      withRoutineActionAttempt,
      now: () => new Date("2026-08-29T17:00:00.000Z"),
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: true })
    expect(reserveRoutineAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "unraid.restart:calibre-web", action: "unraid.container.restart", target: "calibre-web", expectedPolicyVersion: 3, expectedDesiredStateVersion: 2, expectedGrantVersion: 3, requester, expectedBeforeState: "running", resolvedTarget: { id: "Docker:abc", name: "calibre-web" }, effect: { operation: "restart", targetId: "Docker:abc" }, attemptId: expect.any(String), authorizationReceiptId: "relationship-1", authorizationVersion: 9 }))
    expect(transitionRoutineAction.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ id: "receipt-1", expectedState: "reserved", state: "attempting" }),
      expect.objectContaining({ id: "receipt-1", expectedState: "attempting", state: "effect_acknowledged", effectReceipt: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      expect.objectContaining({ id: "receipt-1", expectedState: "effect_acknowledged", state: "verified", verifiedAfterState: "running" }),
    ])
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("revalidates the central relationship capability after the second exact resolution and binds only the fresh receipt", async () => {
    const order: string[] = []
    const reserveRoutineAction = vi.fn((input) => { order.push("reserve"); return { id: "receipt-1", input } })
    const mutate = vi.fn(async () => { order.push("mutate"); return { docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } } })
    const reauthorize = vi.fn(async () => {
      order.push("reauthorize")
      return { allowed: true as const, receiptId: "relationship-fresh", profileVersion: 11 }
    })
    const listContainers = vi.fn(async () => { order.push("resolve"); return running() })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt: vi.fn(),
      reserveRoutineAction,
      transitionRoutineAction: vi.fn(),
      withRoutineActionAttempt,
      now: () => new Date("2026-08-29T17:00:00.000Z"),
    })

    await expect(restart({ container: "calibre-web" }, { routine: {
      ...routineAuthority("unraid.restart:calibre-web", 3),
      reauthorize,
    } })).resolves.toMatchObject({ ok: true })

    expect(order.slice(0, 4)).toEqual(["resolve", "resolve", "reauthorize", "reserve"])
    expect(reserveRoutineAction).toHaveBeenCalledWith(expect.objectContaining({ authorizationReceiptId: "relationship-fresh", authorizationVersion: 11 }))
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("does not reserve or mutate when the live relationship capability is lost after exact target resolution", async () => {
    const reserveRoutineAction = vi.fn()
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction,
      transitionRoutineAction: vi.fn(),
    })

    await expect(restart({ container: "calibre-web" }, { routine: {
      ...routineAuthority("unraid.restart:calibre-web", 3),
      reauthorize: async () => ({ allowed: false as const, reason: "relationship capability revoked" }),
    } })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("revoked") } })
    expect(reserveRoutineAction).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    [async () => { throw new Error("relationship store offline") }, "unavailable"],
    [async () => ({ allowed: true as const, receiptId: "", profileVersion: 7 }), "versioned"],
    [async () => ({ allowed: true as const, receiptId: "receipt", profileVersion: 0 }), "versioned"],
  ])("fails closed without reservation or mutation when fresh relationship evidence is invalid", async (reauthorize, reason) => {
    const reserveRoutineAction = vi.fn()
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: async () => "key", createClient: () => ({ mutate }), reserveRoutineAction, transitionRoutineAction: vi.fn() })

    await expect(restart({ container: "calibre-web" }, { routine: { ...routineAuthority("restart", 2), reauthorize } })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining(reason) } })
    expect(reserveRoutineAction).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("never mutates when routine reservation fails after exact resolution", async () => {
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction: vi.fn(() => { throw new Error("routine action policy version changed") }),
      transitionRoutineAction: vi.fn(),
      withRoutineActionAttempt,
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: false, error: { code: "stale_target", message: expect.stringContaining("policy") } })
    expect(mutate).not.toHaveBeenCalled()
  })

  it("does not leak a non-Error routine reservation failure", async () => {
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: vi.fn(), reserveRoutineAction: vi.fn(() => { throw "offline" }), transitionRoutineAction: vi.fn(), withRoutineActionAttempt })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).resolves.toMatchObject({ ok: false, error: { message: "routine action authority changed" } })
  })

  it("freezes indeterminate routine effects without blind retry", async () => {
    const transitionRoutineAction = vi.fn()
    const mutate = vi.fn().mockRejectedValue(new Error("connection reset"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }),
      transitionRoutineAction,
      withRoutineActionAttempt,
      sleep: async () => undefined,
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(mutate).toHaveBeenCalledOnce()
    expect(transitionRoutineAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "receipt-1", state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } }))
  })

  it("propagates a durable-ledger crash without retrying the mutation", async () => {
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const transitionRoutineAction = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error("disk full after effect") })
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: async () => "key", createClient: () => ({ mutate }), reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }), transitionRoutineAction, withRoutineActionAttempt })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).rejects.toThrow("receipt persistence failed")
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("records an observed restarting transition as the external receipt", async () => {
    const transitionRoutineAction = vi.fn()
    const listings = [running(), running(), running(), { ...running(), data: { ...running().data, containers: [{ ...running().data.containers[0], state: "restarting" as const }] } }, running()]
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn(async () => listings.shift()!), loadWriteApiKey: async () => "key", createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }), reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }), transitionRoutineAction, withRoutineActionAttempt, sleep: async () => undefined })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).resolves.toMatchObject({ ok: true })
    expect(transitionRoutineAction.mock.calls.map(([entry]) => [entry.expectedState, entry.state])).toEqual([
      ["reserved", "attempting"], ["attempting", "indeterminate"], ["indeterminate", "effect_acknowledged"], ["effect_acknowledged", "verified"],
    ])
    expect(transitionRoutineAction).toHaveBeenNthCalledWith(3, expect.objectContaining({ state: "effect_acknowledged", effectReceipt: expect.stringMatching(/^[0-9a-f]{64}$/u) }))
  })
  it("loads the write credential only inside execution and sends one exact mutation", async () => {
    const listContainers = vi.fn().mockResolvedValue(running())
    const loadWriteApiKey = vi.fn().mockResolvedValue("secret-write-key")
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"], state: "RUNNING", status: "Up Less than a second" } } })
    const createClient = vi.fn().mockReturnValue({ mutate })
    const persistAttempt = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "http://sanctuary/graphql", listContainers, loadWriteApiKey, createClient, persistAttempt })

    expect(loadWriteApiKey).not.toHaveBeenCalled()
    const result = await restart({ container: "calibre-web" })

    expect(loadWriteApiKey).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledWith({ endpoint: "http://sanctuary/graphql", apiKey: "secret-write-key" })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(SANCTUARY_RESTART_MUTATION, { id: "Docker:abc" })
    expect(listContainers).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ ok: true, data: { container: { id: "Docker:abc", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
    expect(persistAttempt.mock.calls.map(([entry]) => entry.state)).toEqual(["attempt_not_started", "attempting", "succeeded"])
  })

  it("fails closed on exact name-to-id drift without mutation", async () => {
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running("Docker:abc"))
      .mockResolvedValueOnce(running("Docker:def"))
    const mutate = vi.fn()
    const loadWriteApiKey = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "http://sanctuary/graphql",
      listContainers,
      loadWriteApiKey,
      createClient: () => ({ mutate }),
    })

    const result = await restart({ container: "calibre-web" })
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "stale_target" }) }))
    expect(loadWriteApiKey).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("never retries an ambiguous mutation transport failure", async () => {
    const listContainers = vi.fn().mockResolvedValue(running())
    const mutate = vi.fn().mockRejectedValue(Object.assign(new Error("transport failed"), { ambiguous: true }))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "http://sanctuary/graphql",
      listContainers,
      loadWriteApiKey: async () => "secret-write-key",
      createClient: () => ({ mutate }),
      sleep: vi.fn().mockResolvedValue(undefined),
      observationTimeoutMs: 0,
    })

    const result = await restart({ container: "calibre-web" })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "ambiguous" }) }))
  })

  it("terminalizes an attempted mutation when post-mutation observation throws", async () => {
    const persistAttempt = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockRejectedValueOnce(new Error("observation transport failed"))
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt,
    })

    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(mutate).toHaveBeenCalledOnce()
    expect(persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started", "attempting", "attempted_or_indeterminate"])
  })

  it("does not retry or mask ambiguity when terminal receipt persistence fails", async () => {
    const persistAttempt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("disk full")
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValueOnce(running()).mockResolvedValueOnce(running()).mockRejectedValueOnce(new Error("offline")),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(persistAttempt).toHaveBeenCalledTimes(3)
  })

  it("fails closed when a proven restart terminal receipt cannot be persisted", async () => {
    const persistAttempt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })

    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({
      ok: false,
      error: { code: "ambiguous", message: expect.stringContaining("terminal receipt") },
    })
    expect(persistAttempt).toHaveBeenCalledTimes(3)
  })

  it("binds optional acceptance coordinates and rejects changed approved arguments", async () => {
    const argumentDigest = createHash("sha256").update(JSON.stringify({ container: "calibre-web" })).digest("hex")
    const persistAttempt = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      acceptanceScenarioHandleDigest: () => "a".repeat(64),
      acceptanceApproval: () => ({ approvalId: "approval-1", argumentDigest }),
      persistAttempt,
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: true })
    expect(persistAttempt).toHaveBeenCalledWith(expect.objectContaining({ scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1" }))

    const rejected = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: vi.fn(),
      acceptanceApproval: () => ({ approvalId: "approval-2", argumentDigest: "b".repeat(64) }),
    })
    await expect(rejected({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "stale_target" } })
  })

  it.each([
    ["", "invalid_response"],
    ["x".repeat(129), "invalid_response"],
    ["bad\uFFFDname", "invalid_response"],
  ])("rejects invalid exact container argument %j before reading", async (container, code) => {
    const listContainers = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: vi.fn(),
    })
    await expect(restart({ container })).resolves.toMatchObject({ ok: false, error: { code } })
    expect(listContainers).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, error: { code: "transport", message: "offline", degraded: true } }, "invalid_response"],
    [{ ok: true, data: { containers: [], truncated: false } }, "not_found"],
    [{ ok: true, data: { containers: [running().data.containers[0], running("Docker:def").data.containers[0]], truncated: false } }, "ambiguous"],
  ] as const)("fails closed when target resolution is not exact", async (listing, code) => {
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(listing),
      loadWriteApiKey: vi.fn(),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code } })
  })

  it("fails closed when the write credential is blank after persisting the pre-attempt state", async () => {
    const persistAttempt = vi.fn()
    const createClient = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: vi.fn().mockResolvedValue("   "),
      createClient,
      persistAttempt,
      now: () => new Date("2026-08-20T00:00:00Z"),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    expect(createClient).not.toHaveBeenCalled()
    expect(persistAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      container: { id: "Docker:abc", name: "calibre-web" },
      beforeState: "running",
      observedAt: "2026-08-20T00:00:00.000Z",
      state: "attempt_not_started",
      actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      argumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      attemptId: expect.any(String),
      mutationAcknowledged: false,
      afterState: null,
    }))
  })

  it.each([
    [{}, false],
    [{ docker: [] }, false],
    [{ docker: { restart: [] } }, false],
    [{ docker: { restart: { id: "Docker:def", names: ["/calibre-web"] } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: "calibre-web" } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: ["/calibre-web", "/other"] } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: ["/other"] } } }, false],
  ] as const)("treats malformed mutation acknowledgement as indeterminate", async (mutation) => {
    const mutate = vi.fn().mockResolvedValue(mutation)
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      sleep: async () => undefined,
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
    expect(mutate).toHaveBeenCalledExactlyOnceWith(SANCTUARY_RESTART_MUTATION, { id: "Docker:abc" })
  })

  it("requires either acknowledgement or an observed restarting transition", async () => {
    const listings = [running(), running(), running(), {
      ok: true as const,
      data: { containers: [{ ...running().data.containers[0], state: "restarting" as const }], truncated: false },
    }, running()]
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(async () => listings.shift()!),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: (() => {
        let tick = 0
        return () => new Date(tick++ * 1_000)
      })(),
      observationTimeoutMs: 10_000,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: true, data: { observedRestart: true } })
  })

  it("reports post-attempt identity drift and persists the indeterminate state", async () => {
    const persistAttempt = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running("Docker:def"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("identity changed") } })
    expect(persistAttempt.mock.calls.at(-1)?.[0].state).toBe("attempted_or_indeterminate")
  })

  it("returns a fresh-resolution failure before loading credentials", async () => {
    const loadWriteApiKey = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce({ ok: true, data: { containers: [], truncated: false } })
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers, loadWriteApiKey })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(loadWriteApiKey).not.toHaveBeenCalled()
  })

  it("continues polling when an observation cannot resolve the target", async () => {
    const listings = [running(), running(), { ok: true as const, data: { containers: [], truncated: false } }]
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(async () => listings.shift()!),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }),
      sleep: vi.fn(),
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
  })

  it("invokes the default client and polling sleep adapters", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: { "x-api-key": "key", "Content-Type": "application/json" },
        body: JSON.stringify({ query: SANCTUARY_RESTART_MUTATION, variables: { id: "Docker:abc" } }),
      })
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)
    try {
      const restart = createApprovedUnraidRestartExecutor({
        endpoint: "https://host/graphql",
        listContainers: vi.fn().mockResolvedValue(running()),
        loadWriteApiKey: async () => "key",
        observationTimeoutMs: 1_000,
      })
      const pending = restart({ container: "calibre-web" })
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("constructs the executor with its default adapters", () => {
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(),
      loadWriteApiKey: vi.fn(),
    })
    expect(restart).toBeTypeOf("function")
  })

  it("fails closed when routine ledger adapters are incomplete", async () => {
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: vi.fn(), reserveRoutineAction: vi.fn() })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: expect.stringContaining("ledger") } })
  })

  it("terminalizes a reserved routine when the write credential is blank", async () => {
    const transitionRoutineAction = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: async () => " ", reserveRoutineAction: vi.fn(() => ({ id: "receipt" })), transitionRoutineAction, withRoutineActionAttempt })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).resolves.toMatchObject({ ok: false })
    expect(transitionRoutineAction).toHaveBeenCalledWith(expect.objectContaining({ expectedState: "reserved", state: "failed" }))
  })

  it("propagates routine-ledger failure during post-attempt identity drift", async () => {
    const listings = [running(), running(), running(), running("Docker:def")]
    const transitionRoutineAction = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw "ledger offline" })
    const listContainers = vi.fn(async () => listings.shift()!)
    const mutate = vi.fn(async () => ({}))
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers, loadWriteApiKey: async () => "key", createClient: () => ({ mutate }), reserveRoutineAction: vi.fn(() => ({ id: "receipt" })), transitionRoutineAction, withRoutineActionAttempt })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).rejects.toThrow("receipt persistence failed")
    expect(listContainers).toHaveBeenCalledTimes(4)
    expect(mutate).toHaveBeenCalledOnce()
    expect(transitionRoutineAction).toHaveBeenNthCalledWith(3, expect.objectContaining({ expectedState: "indeterminate", state: "indeterminate" }))
  })

  it("terminalizes routine authority when observation itself fails", async () => {
    const transitionRoutineAction = vi.fn()
    const listContainers = vi.fn().mockResolvedValueOnce(running()).mockResolvedValueOnce(running()).mockResolvedValueOnce(running()).mockRejectedValueOnce(new Error("offline"))
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers, loadWriteApiKey: async () => "key", createClient: () => ({ mutate: vi.fn(async () => ({})) }), reserveRoutineAction: vi.fn(() => ({ id: "receipt" })), transitionRoutineAction, withRoutineActionAttempt })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 2) })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
    expect(transitionRoutineAction).toHaveBeenLastCalledWith(expect.objectContaining({ state: "indeterminate" }))
  })
})
