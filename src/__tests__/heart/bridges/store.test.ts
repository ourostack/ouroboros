import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let agentStateRoot = ""

vi.mock("../../../heart/identity", () => ({
  getAgentStateRoot: () => agentStateRoot,
}))

function removeDirSafe(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("bridge store", () => {
  beforeEach(() => {
    agentStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-store-"))
  })

  afterEach(() => {
    removeDirSafe(agentStateRoot)
    agentStateRoot = ""
  })

  it("persists bridge records under bundle state and finds them by canonical session identity", async () => {
    const { createBridgeStore } = await import("../../../heart/bridges/store")

    const store = createBridgeStore()
    const bridge = {
      id: "bridge-1",
      objective: "keep cli and teams aligned",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T16:00:00.000Z",
      updatedAt: "2026-03-13T16:00:00.000Z",
      summary: "relay Ari updates between surfaces",
      attachedSessions: [
        {
          friendId: "friend-1",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
        },
        {
          friendId: "friend-1",
          channel: "teams",
          key: "conv-1",
          sessionPath: "/tmp/state/sessions/friend-1/teams/conv-1.json",
        },
      ],
      task: null,
    }

    store.save(bridge)

    expect(fs.existsSync(path.join(agentStateRoot, "bridges", "bridge-1.json"))).toBe(true)
    expect(store.get("bridge-1")).toEqual(bridge)
    expect(store.list().map((entry) => entry.id)).toEqual(["bridge-1"])
    expect(
      store.findBySession({
        friendId: "friend-1",
        channel: "teams",
        key: "conv-1",
      }).map((entry) => entry.id),
    ).toEqual(["bridge-1"])
  })
})
