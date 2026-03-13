import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let agentStateRoot = ""

vi.mock("../../../heart/identity", () => ({
  getAgentStateRoot: () => agentStateRoot,
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
})
