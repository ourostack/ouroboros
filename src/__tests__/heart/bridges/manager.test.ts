import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let agentStateRoot = ""
const mockCreateTask = vi.fn()

vi.mock("../../../heart/identity", () => ({
  getAgentStateRoot: () => agentStateRoot,
}))

vi.mock("../../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    createTask: (...args: any[]) => mockCreateTask(...args),
  }),
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function removeDirSafe(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("bridge manager", () => {
  beforeEach(() => {
    agentStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-manager-"))
    mockCreateTask.mockReset().mockReturnValue("/tmp/tasks/ongoing/2026-03-13-1600-shared-relay.md")
  })

  afterEach(() => {
    removeDirSafe(agentStateRoot)
    agentStateRoot = ""
  })

  it("creates lightweight bridges, attaches existing sessions, and coalesces overlapping bridge turns", async () => {
    const { createBridgeStore } = await import("../../../heart/bridges/store")
    const { createBridgeManager } = await import("../../../heart/bridges/manager")

    const store = createBridgeStore()
    const manager = createBridgeManager({
      store,
      now: () => "2026-03-13T16:00:00.000Z",
      idFactory: () => "bridge-1",
    })

    const bridge = manager.beginBridge({
      objective: "relay Ari between cli and teams",
      summary: "keep one coherent shared work object",
      session: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
    })

    expect(bridge.id).toBe("bridge-1")
    expect(bridge.attachedSessions).toHaveLength(1)
    expect(bridge.lifecycle).toBe("active")
    expect(bridge.runtime).toBe("idle")

    manager.attachSession("bridge-1", {
      friendId: "friend-1",
      channel: "teams",
      key: "conv-1",
      sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
    })

    expect(manager.getBridge("bridge-1")?.attachedSessions).toHaveLength(2)

    const started = deferred()
    const release = deferred()
    let turnCount = 0

    const first = manager.runBridgeTurn("bridge-1", async () => {
      turnCount += 1
      started.resolve()
      await release.promise
    })

    await started.promise

    const second = manager.runBridgeTurn("bridge-1", async () => {
      turnCount += 1
    })
    const third = manager.runBridgeTurn("bridge-1", async () => {
      turnCount += 1
    })

    expect(manager.getBridge("bridge-1")?.runtime).toBe("awaiting-follow-up")

    release.resolve()
    await Promise.all([first, second, third])

    expect(turnCount).toBe(2)
    expect(manager.getBridge("bridge-1")?.runtime).toBe("idle")
  })

  it("promotes bridge work into a task and supports complete/cancel lifecycle moves", async () => {
    const { createBridgeStore } = await import("../../../heart/bridges/store")
    const { createBridgeManager, formatBridgeContext, formatBridgeStatus } = await import("../../../heart/bridges/manager")

    const store = createBridgeStore()
    const manager = createBridgeManager({
      store,
      now: () => "2026-03-13T16:00:00.000Z",
      idFactory: () => "bridge-2",
    })

    manager.beginBridge({
      objective: "relay Ari between cli and teams",
      summary: "keep the two live surfaces aligned",
      session: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      },
    })

    const promoted = manager.promoteBridgeToTask("bridge-2", {
      title: "Shared Relay",
    })
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Shared Relay",
        activeBridge: "bridge-2",
        bridgeSessions: ["friend-1/cli/session"],
      }),
    )
    expect(promoted.task).toEqual({
      taskName: "2026-03-13-1600-shared-relay",
      path: "/tmp/tasks/ongoing/2026-03-13-1600-shared-relay.md",
      mode: "promoted",
      boundAt: "2026-03-13T16:00:00.000Z",
    })
    expect(formatBridgeStatus(promoted)).toContain("summary: keep the two live surfaces aligned")
    expect(formatBridgeContext([promoted])).toContain("bridge-2")
    expect(formatBridgeContext([promoted])).toContain("2026-03-13-1600-shared-relay")

    const completed = manager.completeBridge("bridge-2")
    expect(completed.lifecycle).toBe("completed")

    const second = manager.beginBridge({
      objective: "relay Ari between cli and teams again",
      summary: "new bridge for cancel path",
      session: {
        friendId: "friend-1",
        channel: "teams",
        key: "conv-2",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv-2.json",
      },
    })
    expect(second.id).toBe("bridge-2")

    const cancelled = manager.cancelBridge("bridge-2")
    expect(cancelled.lifecycle).toBe("cancelled")
  })

  it("covers bridge manager edge paths and helper formatting", async () => {
    const { createBridgeManager, formatBridgeStatus, formatBridgeContext } = await import("../../../heart/bridges/manager")
    const { enqueueSharedFollowUp } = await import("../../../heart/turn-coordinator")

    const manager = createBridgeManager()
    const created = manager.beginBridge({
      objective: "edge bridge",
      summary: "",
      session: {
        friendId: "friend-7",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-7/cli/session.json",
      },
    })

    expect(created.id).toMatch(/^bridge-/)
    expect(formatBridgeStatus(created)).not.toContain("summary:")
    expect(formatBridgeContext([])).toBe("")
    expect(formatBridgeContext([created])).toContain("- ")
    expect(formatBridgeContext([created])).not.toContain("(task:")

    expect(manager.attachSession(created.id, created.attachedSessions[0])).toEqual(created)
    expect(manager.listBridges()).toHaveLength(1)
    expect(manager.getBridge("missing")).toBeNull()
    expect(() =>
      manager.detachSession("missing", { friendId: "friend-7", channel: "cli", key: "session" }),
    ).toThrow("bridge not found")

    const detached = manager.detachSession(created.id, { friendId: "friend-7", channel: "cli", key: "session" })
    expect(detached.attachedSessions).toEqual([])
    mockCreateTask.mockReturnValueOnce("/tmp/tasks/ongoing/edge-bridge.md")
    const promotedDefaults = manager.promoteBridgeToTask(created.id)
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "edge bridge",
        category: "coordination",
        body: expect.stringContaining("## bridge\nid:"),
        bridgeSessions: [],
      }),
    )
    expect(String(mockCreateTask.mock.calls.at(-1)?.[0]?.body ?? "")).not.toContain("sessions:")
    expect(promotedDefaults.task?.taskName).toBe("edge-bridge")

    let suspendedCurrent = {
      ...promotedDefaults,
      lifecycle: "suspended" as const,
      runtime: "idle" as const,
    }
    const suspendedStore = {
      save: vi.fn((bridge: any) => {
        suspendedCurrent = bridge
        return bridge
      }),
      get: vi.fn(() => suspendedCurrent),
      list: vi.fn(() => []),
      findBySession: vi.fn(() => []),
    }
    const suspendedManager = createBridgeManager({ store: suspendedStore as any, now: () => "2026-03-13T16:00:00.000Z" })
    await suspendedManager.runBridgeTurn(created.id, async () => undefined)
    expect(suspendedStore.save).toHaveBeenCalled()

    const terminalStore = {
      save: vi.fn((bridge: any) => bridge),
      get: vi.fn(() => ({
        ...created,
        lifecycle: "completed",
        runtime: "idle",
      })),
      list: vi.fn(() => []),
      findBySession: vi.fn(() => []),
    }
    const terminalManager = createBridgeManager({ store: terminalStore as any, now: () => "2026-03-13T16:00:00.000Z" })
    await expect(terminalManager.runBridgeTurn(created.id, async () => undefined)).rejects.toThrow("bridge is terminal")
    expect(() =>
      terminalManager.attachSession(created.id, {
        friendId: "friend-9",
        channel: "teams",
        key: "conv-9",
        sessionPath: "/tmp/state/sessions/friend-9/teams/conv-9.json",
      }),
    ).toThrow("cannot attach session to a terminal bridge")
    expect(() =>
      terminalManager.detachSession(created.id, { friendId: "friend-7", channel: "cli", key: "session" }),
    ).toThrow("cannot detach session from a terminal bridge")
    expect(() => terminalManager.promoteBridgeToTask(created.id)).toThrow("cannot promote a terminal bridge")

    const withTask = {
      ...created,
      task: {
        taskName: "task-1",
        path: "/tmp/task.md",
        mode: "promoted" as const,
        boundAt: "2026-03-13T16:00:00.000Z",
      },
    }
    const taskStore = {
      save: vi.fn((bridge: any) => bridge),
      get: vi.fn(() => withTask),
      list: vi.fn(() => [withTask]),
      findBySession: vi.fn(() => [withTask, { ...withTask, id: "bridge-terminal", lifecycle: "cancelled" }]),
    }
    const taskManager = createBridgeManager({ store: taskStore as any, now: () => "2026-03-13T16:00:00.000Z" })
    expect(taskManager.promoteBridgeToTask(withTask.id)).toEqual(withTask)
    expect(taskManager.findBridgesForSession({ friendId: "friend-7", channel: "cli", key: "session" })).toEqual([withTask])

    const realStoreManager = createBridgeManager({
      store: (await import("../../../heart/bridges/store")).createBridgeStore(),
      now: () => "2026-03-13T16:00:00.000Z",
      idFactory: () => "bridge-follow-up",
    })
    realStoreManager.beginBridge({
      objective: "queued bridge",
      summary: "exercise buffered follow-up branch",
      session: {
        friendId: "friend-8",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-8/cli/session.json",
      },
    })
    let runs = 0
    await realStoreManager.runBridgeTurn("bridge-follow-up", async () => {
      runs += 1
      if (runs === 1) {
        enqueueSharedFollowUp("bridge", "bridge-follow-up", {
          conversationId: "bridge-follow-up",
          text: "follow up",
          receivedAt: 1,
          effect: "none",
        })
      }
    })
    expect(runs).toBe(2)
  })
})
