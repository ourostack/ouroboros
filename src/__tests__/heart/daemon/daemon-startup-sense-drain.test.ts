import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { OuroDaemon } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function make(socketPath: string, bundlesRoot?: string) {
  const processManager = {
    listAgentSnapshots: vi.fn(() => []),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    sendToAgent: vi.fn(),
  }

  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
    reconcile: vi.fn(async () => undefined),
  }

  const healthMonitor = {
    runChecks: vi.fn(async () => []),
  }

  const router = {
    send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-10T00:00:00.000Z" })),
    pollInbox: vi.fn(() => []),
  }

  const senseManager = {
    startAutoStartSenses: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    listSenseRows: vi.fn(() => []),
  }

  const daemon = new OuroDaemon({
    socketPath,
    processManager,
    scheduler,
    healthMonitor,
    router,
    bundlesRoot,
    senseManager,
  } as any)
  return { daemon, processManager, scheduler, healthMonitor, router, senseManager }
}

/**
 * Helper: create a pending message file in the per-sense pending dir structure.
 * Path: {bundlesRoot}/{agent}.ouro/state/pending/{friendId}/{channel}/{key}/{filename}.json
 */
function writePendingMessage(
  bundlesRoot: string,
  agent: string,
  friendId: string,
  channel: string,
  key: string,
  message: { from: string; content: string; timestamp: number },
): void {
  const dir = path.join(bundlesRoot, `${agent}.ouro`, "state", "pending", friendId, channel, key)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${message.timestamp}-${Math.random().toString(16).slice(2)}.json`
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(message), "utf-8")
}

describe("daemon startup sense pending drain", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("drains pending dirs for bluebubbles sense on daemon start", async () => {
    const socketPath = tmpSocketPath("startup-bb-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    writePendingMessage(bundlesRoot, "slugger", "friend-1", "bluebubbles", "chat-abc", {
      from: "alice",
      content: "hey, are you there?",
      timestamp: 1710000000000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // The drained message should be routed through the daemon router
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "alice",
      to: "slugger",
      content: "hey, are you there?",
    }))

    // Pending dir should be empty after drain
    const pendingDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "friend-1", "bluebubbles", "chat-abc")
    const remaining = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(f => f.endsWith(".json")) : []
    expect(remaining).toHaveLength(0)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("drains pending dirs for teams sense on daemon start", async () => {
    const socketPath = tmpSocketPath("startup-teams-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    writePendingMessage(bundlesRoot, "slugger", "friend-2", "teams", "conv-xyz", {
      from: "bob",
      content: "urgent: need approval",
      timestamp: 1710000001000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "bob",
      to: "slugger",
      content: "urgent: need approval",
    }))

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("does NOT drain CLI pending dirs at daemon start", async () => {
    const socketPath = tmpSocketPath("startup-no-cli-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    writePendingMessage(bundlesRoot, "slugger", "friend-3", "cli", "session", {
      from: "local-user",
      content: "cli message should remain",
      timestamp: 1710000002000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // CLI pending should NOT be routed
    expect(router.send).not.toHaveBeenCalled()

    // CLI pending file should still exist
    const cliPendingDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "friend-3", "cli", "session")
    const files = fs.readdirSync(cliPendingDir).filter(f => f.endsWith(".json"))
    expect(files).toHaveLength(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("drains multiple pending messages across multiple agents and senses", async () => {
    const socketPath = tmpSocketPath("startup-multi-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Agent 1: slugger, BB sense
    writePendingMessage(bundlesRoot, "slugger", "friend-a", "bluebubbles", "chat-1", {
      from: "alice",
      content: "msg-1",
      timestamp: 1710000010000,
    })
    writePendingMessage(bundlesRoot, "slugger", "friend-a", "bluebubbles", "chat-1", {
      from: "alice",
      content: "msg-2",
      timestamp: 1710000011000,
    })

    // Agent 2: ouroboros, Teams sense
    writePendingMessage(bundlesRoot, "ouroboros", "friend-b", "teams", "conv-2", {
      from: "bob",
      content: "msg-3",
      timestamp: 1710000012000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // All 3 messages should be routed
    expect(router.send).toHaveBeenCalledTimes(3)
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({ to: "slugger", content: "msg-1" }))
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({ to: "slugger", content: "msg-2" }))
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({ to: "ouroboros", content: "msg-3" }))

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("proceeds normally when no pending messages exist", async () => {
    const socketPath = tmpSocketPath("startup-no-pending")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create a bundle dir with state/pending but no messages
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "state", "pending"), { recursive: true })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("skips inner channel pending dirs (not an always-on sense)", async () => {
    const socketPath = tmpSocketPath("startup-no-inner-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    writePendingMessage(bundlesRoot, "slugger", "self", "inner", "dialog", {
      from: "system",
      content: "inner notice should remain",
      timestamp: 1710000003000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // Inner channel pending should NOT be routed
    expect(router.send).not.toHaveBeenCalled()

    // Inner pending file should still exist
    const innerPendingDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "self", "inner", "dialog")
    const files = fs.readdirSync(innerPendingDir).filter(f => f.endsWith(".json"))
    expect(files).toHaveLength(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates missing state/pending directory", async () => {
    const socketPath = tmpSocketPath("startup-no-state-dir")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create bundle dir without state/pending
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"), { recursive: true })

    const { daemon } = make(socketPath, bundlesRoot)
    await expect(daemon.start()).resolves.toBeUndefined()
    await daemon.stop()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates unreadable pending directory entries", async () => {
    const socketPath = tmpSocketPath("startup-unreadable-pending")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create a pending dir with an unparseable JSON file
    const dir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "friend-x", "bluebubbles", "chat-bad")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "1710000000000-bad.json"), "{invalid-json", "utf-8")

    // Also create a valid one to ensure partial success
    writePendingMessage(bundlesRoot, "slugger", "friend-y", "teams", "conv-good", {
      from: "carol",
      content: "valid message",
      timestamp: 1710000004000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // The valid message should still be routed
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "carol",
      to: "slugger",
      content: "valid message",
    }))

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates unreadable pending root directory", async () => {
    const socketPath = tmpSocketPath("startup-unreadable-root")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create the pending root as a file (not a directory) so readdirSync fails
    const pendingRoot = path.join(bundlesRoot, "slugger.ouro", "state", "pending")
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "state"), { recursive: true })
    fs.writeFileSync(pendingRoot, "not-a-dir", "utf-8")

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates unreadable friend directory", async () => {
    const socketPath = tmpSocketPath("startup-unreadable-friend")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create pending root as directory, but make a friend entry be a file
    const pendingRoot = path.join(bundlesRoot, "slugger.ouro", "state", "pending")
    fs.mkdirSync(pendingRoot, { recursive: true })
    // Create a real friend dir that is unreadable by making it a symlink to nowhere
    const friendDir = path.join(pendingRoot, "friend-broken")
    fs.mkdirSync(friendDir, { recursive: true })
    // Put a file where the channel dir listing would look
    fs.writeFileSync(path.join(friendDir, "bluebubbles"), "not-a-dir", "utf-8")

    // Also create a valid one
    writePendingMessage(bundlesRoot, "slugger", "friend-ok", "bluebubbles", "chat-1", {
      from: "dave",
      content: "still works",
      timestamp: 1710000005000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // The broken friend dir should be skipped, valid one still routed
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "dave",
      content: "still works",
    }))

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates unreadable friend directory (chmod 000)", async () => {
    const socketPath = tmpSocketPath("startup-unreadable-friend-chmod")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create a friend dir and make it unreadable
    const friendDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "friend-locked")
    fs.mkdirSync(friendDir, { recursive: true })
    fs.chmodSync(friendDir, 0o000)

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    // Restore permissions for cleanup
    fs.chmodSync(friendDir, 0o755)
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates unreadable channel key directory (chmod 000)", async () => {
    const socketPath = tmpSocketPath("startup-unreadable-channel-chmod")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Create a BB channel dir and make it unreadable
    const channelDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "friend-z", "bluebubbles")
    fs.mkdirSync(channelDir, { recursive: true })
    fs.chmodSync(channelDir, 0o000)

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    // Restore permissions for cleanup
    fs.chmodSync(channelDir, 0o755)
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("tolerates router.send failure during sense drain", async () => {
    const socketPath = tmpSocketPath("startup-router-failure")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    writePendingMessage(bundlesRoot, "slugger", "friend-fail", "teams", "conv-fail", {
      from: "eve",
      content: "will fail to route",
      timestamp: 1710000006000,
    })
    writePendingMessage(bundlesRoot, "slugger", "friend-ok", "bluebubbles", "chat-ok", {
      from: "frank",
      content: "will succeed",
      timestamp: 1710000007000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    // Make router.send fail on first call, succeed on second
    router.send
      .mockRejectedValueOnce(new Error("router down"))
      .mockResolvedValueOnce({ id: "msg-2", queuedAt: "2026-03-10T00:00:00.000Z" })

    await daemon.start()
    await daemon.stop()

    // Both messages should have been attempted
    expect(router.send).toHaveBeenCalledTimes(2)
    // Second one should still succeed despite first failing
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "frank",
      content: "will succeed",
    }))

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("skips non-directory entries at each level of the pending tree", async () => {
    const socketPath = tmpSocketPath("startup-skip-files")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "startup-drain-"))

    // Put a file at the friendId level (should be skipped)
    const pendingRoot = path.join(bundlesRoot, "slugger.ouro", "state", "pending")
    fs.mkdirSync(pendingRoot, { recursive: true })
    fs.writeFileSync(path.join(pendingRoot, "stray-file.txt"), "not a dir", "utf-8")

    // Put a file at the key level inside a channel dir (should be skipped)
    const channelDir = path.join(pendingRoot, "friend-q", "bluebubbles")
    fs.mkdirSync(channelDir, { recursive: true })
    fs.writeFileSync(path.join(channelDir, "stray-key-file.txt"), "not a dir", "utf-8")

    // Also add a valid message to confirm the skip doesn't break processing
    writePendingMessage(bundlesRoot, "slugger", "friend-q", "bluebubbles", "chat-valid", {
      from: "grace",
      content: "valid msg",
      timestamp: 1710000008000,
    })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    // Only the valid message should be routed
    expect(router.send).toHaveBeenCalledTimes(1)
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "grace",
      content: "valid msg",
    }))

    // Stray files should still exist (not deleted)
    expect(fs.existsSync(path.join(pendingRoot, "stray-file.txt"))).toBe(true)
    expect(fs.existsSync(path.join(channelDir, "stray-key-file.txt"))).toBe(true)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
