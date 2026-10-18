import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { DaemonSenseManager } from "../../../heart/daemon/sense-manager"

describe("maintenance lifecycle proof", () => {
  it("requires a stop service for live workers and accepts only a truly stopped null-PID census", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-no-stop-service-"))
    const root = path.join(bundlesRoot, "ouro.ouro")
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: false } } }))
    const snapshot = { name: "ouro:shepherd", status: "stopped", pid: 42 as number | null }
    const manager = new DaemonSenseManager({
      agents: ["ouro"], bundlesRoot,
      processManager: { startAutoStartAgents: async () => {}, stopAll: async () => {}, listAgentSnapshots: () => [snapshot] },
    })
    await expect(manager.quiesceShepherd("ouro")).rejects.toThrow("managed Shepherd stop is unavailable")
    snapshot.pid = null
    expect(await manager.quiesceShepherd("ouro")).toMatchObject({ processState: "stopped" })
  })

  it("quiesces only after explicit disabling and waits for actual worker termination", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-quiesce-"))
    const root = path.join(bundlesRoot, "ouro.ouro")
    fs.mkdirSync(root)
    const write = (enabled: boolean) => fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled } } }))
    write(true)
    const snapshot = { name: "ouro:shepherd", status: "running", pid: 42 as number | null }
    let stopped = false
    const manager = new DaemonSenseManager({
      agents: ["ouro"], bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => {}, stopAll: async () => {}, listAgentSnapshots: () => [snapshot],
        stopAgent: async () => { stopped = true; snapshot.status = "stopped"; snapshot.pid = null },
      },
    })
    await expect(manager.quiesceShepherd("ouro")).rejects.toThrow(/disabled/i)
    expect(stopped).toBe(false)
    write(false)
    expect(await manager.quiesceShepherd("ouro")).toMatchObject({ processState: "stopped" })
    expect(stopped).toBe(true)
    await expect(manager.restartSense("ouro:shepherd")).rejects.toThrow(/quiesced/i)
    expect(await manager.reviveSense("ouro", "shepherd")).toBeNull()
  })

  it("proves an explicitly disabled-at-startup sense from a complete empty management census", () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-never-started-"))
    const root = path.join(bundlesRoot, "ouro.ouro")
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: false } } }))
    const manager = new DaemonSenseManager({
      agents: ["ouro"], bundlesRoot,
      processManager: { startAutoStartAgents: async () => {}, stopAll: async () => {}, listAgentSnapshots: () => [] },
    })
    expect(manager.shepherdStoppedProof("ouro")).toMatchObject({ enabled: false, processState: "stopped" })
  })

  it("requires fresh explicit disabling plus a positive managed process census", () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-lifecycle-"))
    const root = path.join(bundlesRoot, "ouro.ouro")
    fs.mkdirSync(root)
    const config = (enabled: boolean) => fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled } } }))
    config(true)
    let snapshots = [{ name: "ouro:shepherd", status: "running", pid: 42 as number | null }]
    const manager = new DaemonSenseManager({
      agents: ["ouro"], bundlesRoot,
      processManager: { startAutoStartAgents: async () => {}, stopAll: async () => {}, listAgentSnapshots: () => snapshots },
    })
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/disabled/i)
    config(false)
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/stopped/i)
    snapshots = [{ name: "ouro:shepherd", status: "stopped", pid: 42 }]
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/stopped/i)
    snapshots = [{ name: "ouro:shepherd", status: "starting", pid: null }]
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/stopped/i)
    snapshots = [{ name: "ouro:shepherd", status: "stopped", pid: null }]
    expect(manager.shepherdStoppedProof("ouro")).toMatchObject({ kind: "daemon_lifecycle", enabled: false, processState: "stopped" })
    fs.writeFileSync(path.join(root, "agent.json"), "{}")
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/disabled/i)
    fs.writeFileSync(path.join(root, "agent.json"), "{")
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow()
    expect(() => manager.shepherdStoppedProof("../ouro")).toThrow()
    config(false)
    snapshots = []
    expect(() => manager.shepherdStoppedProof("ouro")).toThrow(/snapshot|inventory/i)
  })
})
