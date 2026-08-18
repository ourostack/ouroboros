import { describe, expect, it, vi } from "vitest"

async function subject(): Promise<any> {
  return import("../../heart/approval-continuation")
}

function gate() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  return { entered, release }
}

function terminal(state: string) {
  return {
    approvalId: "11111111-1111-4111-8111-111111111111",
    state,
    sessionPath: "/tmp/disposable/session.json",
    suspendedSessionRevision: "f".repeat(64),
  }
}

describe("approval continuation race contract", () => {
  it("returns retryable busy before claim when another process owns the session turn", async () => {
    const { coordinateApprovalDecision, SessionTurnBusyError } = await subject()
    const decideAndExecute = vi.fn()
    const resume = vi.fn()

    await expect(coordinateApprovalDecision({
      withSessionLease: vi.fn(async () => { throw new SessionTurnBusyError("busy") }),
      decideAndExecute,
      resume,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError", retryable: true })
    expect(decideAndExecute).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it("new inbound persistence winning before claim makes approval head-changed with zero handler calls", async () => {
    const { coordinateApprovalDecision } = await subject()
    const handler = vi.fn()
    const resume = vi.fn()
    const notices: string[] = []

    const result = await coordinateApprovalDecision({
      withSessionLease: async (work: any) => work({ ownerId: "approval-owner", ownerToken: "token" }),
      readCurrentRevision: vi.fn(() => "0".repeat(64)),
      suspendedSessionRevision: "f".repeat(64),
      decideAndExecute: vi.fn(async ({ currentSessionRevision }: any) => {
        expect(currentSessionRevision).toBe("0".repeat(64))
        return terminal("session_head_changed")
      }),
      execute: handler,
      resume,
      directNotice: (notice: string) => { notices.push(notice) },
    })

    expect(result.record.state).toBe("session_head_changed")
    expect(handler).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(notices.join(" ")).toContain("session changed")
  })

  it("approval winning the lease holds inbound load/provider/persist until continuation delivery completes", async () => {
    const { coordinateApprovalDecision } = await subject()
    const approval = gate()
    const order: string[] = []
    let locked = false

    const withSessionLease = async (work: any) => {
      while (locked) await new Promise((resolve) => setImmediate(resolve))
      locked = true
      try { return await work({ ownerId: "owner", ownerToken: "token" }) } finally { locked = false }
    }

    const approving = coordinateApprovalDecision({
      withSessionLease,
      readCurrentRevision: vi.fn(() => "f".repeat(64)),
      suspendedSessionRevision: "f".repeat(64),
      decideAndExecute: vi.fn(async () => terminal("succeeded")),
      resume: vi.fn(async () => {
        order.push("approval:resume")
        approval.entered.resolve()
        await approval.release.promise
        order.push("approval:deliver")
      }),
      directNotice: vi.fn(),
    })
    await approval.entered.promise

    const inbound = withSessionLease(async () => {
      order.push("inbound:load")
      order.push("inbound:provider")
      order.push("inbound:persist")
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(["approval:resume"])

    approval.release.resolve()
    await Promise.all([approving, inbound])
    expect(order).toEqual([
      "approval:resume",
      "approval:deliver",
      "inbound:load",
      "inbound:provider",
      "inbound:persist",
    ])
  })

  it("head drift discovered after a bound decision but before attempted terminalizes without execution", async () => {
    const { coordinateApprovalDecision } = await subject()
    const handler = vi.fn()
    const resume = vi.fn()
    const decideAndExecute = vi.fn(async ({ hooks }: any) => {
      await hooks.afterClaim()
      return terminal("session_head_changed")
    })

    const result = await coordinateApprovalDecision({
      withSessionLease: async (work: any) => work({ ownerId: "approval-owner", ownerToken: "token" }),
      readCurrentRevision: vi.fn()
        .mockReturnValueOnce("f".repeat(64))
        .mockReturnValueOnce("0".repeat(64)),
      suspendedSessionRevision: "f".repeat(64),
      decideAndExecute,
      execute: handler,
      resume,
      directNotice: vi.fn(),
    })

    expect(result.record.state).toBe("session_head_changed")
    expect(handler).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it.each(["denied", "expired", "drifted", "attempted_indeterminate", "session_head_changed"])(
    "never invokes a protected handler while projecting terminal %s",
    async (state) => {
      const { coordinateApprovalDecision } = await subject()
      const handler = vi.fn()
      const resume = vi.fn()
      const directNotice = vi.fn()

      await coordinateApprovalDecision({
        withSessionLease: async (work: any) => work({ ownerId: "approval-owner", ownerToken: "token" }),
        readCurrentRevision: vi.fn(() => state === "session_head_changed" ? "0".repeat(64) : "f".repeat(64)),
        suspendedSessionRevision: "f".repeat(64),
        decideAndExecute: vi.fn(async () => terminal(state)),
        execute: handler,
        resume,
        directNotice,
      })

      expect(handler).not.toHaveBeenCalled()
      if (state === "denied") expect(resume).toHaveBeenCalledTimes(1)
      else expect(resume).not.toHaveBeenCalled()
      if (state !== "denied") expect(directNotice).toHaveBeenCalledTimes(1)
    },
  )
})
