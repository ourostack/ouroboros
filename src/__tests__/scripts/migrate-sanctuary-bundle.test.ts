import { pathToFileURL } from "node:url"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

type AdapterDependencies = {
  commit: (agentRoot: string) => boolean
  getPackageVersion: () => string
  inspect: (input: { packageRoot: string; agentRoot: string; runtimePackageVersion: string }) => unknown
  migrate: (input: { packageRoot: string; agentRoot: string; retainRollback: boolean; rollbackImageId?: string; targetImageId?: string }) => unknown
  rollback: (agentRoot: string, options?: { retainRecord: boolean }) => boolean
  status: (agentRoot: string) => unknown
}

type AdapterModule = {
  runSanctuaryBundleOperation(args: string[], dependencies: AdapterDependencies): unknown
}

async function load(): Promise<AdapterModule> {
  return import(pathToFileURL(path.resolve("deploy/unraid/migrate-sanctuary-bundle.mjs")).href) as Promise<AdapterModule>
}

function dependencies(overrides: Partial<AdapterDependencies> = {}): AdapterDependencies {
  return {
    commit: vi.fn(() => true),
    getPackageVersion: vi.fn(() => "0.1.0-alpha.test"),
    inspect: vi.fn(() => ({ ok: true, data: { ready: true } })),
    migrate: vi.fn(() => ({ managedFilesUpdated: 8 })),
    rollback: vi.fn(() => true),
    status: vi.fn(() => ({ state: "rollback" })),
    ...overrides,
  }
}

const base = ["--package-root", "/opt/ouro/deploy/unraid/sanctuary.ouro", "--agent-root", "/home/ouro/AgentBundles/sanctuary.ouro"]

describe("Sanctuary bundle migration adapter", () => {
  it("returns the canonical read-only inspection with the runtime package version", async () => {
    const { runSanctuaryBundleOperation } = await load()
    const inspection = { ok: true, data: { runtimePackageVersion: "0.1.0-alpha.test", parity: "exact", journalState: "absent", ready: true } }
    const inspect = vi.fn(() => inspection)
    const getPackageVersion = vi.fn(() => "0.1.0-alpha.test")

    expect(runSanctuaryBundleOperation([...base, "--operation", "inspect"], dependencies({ inspect, getPackageVersion }))).toBe(inspection)
    expect(getPackageVersion).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith({
      packageRoot: "/opt/ouro/deploy/unraid/sanctuary.ouro",
      agentRoot: "/home/ouro/AgentBundles/sanctuary.ouro",
      runtimePackageVersion: "0.1.0-alpha.test",
    })
  })

  it("keeps journal status distinct and rejects arguments outside each closed operation shape", async () => {
    const { runSanctuaryBundleOperation } = await load()
    const status = vi.fn(() => ({ state: "committing" }))
    const inspect = vi.fn()

    expect(runSanctuaryBundleOperation([...base, "--operation", "status"], dependencies({ status, inspect }))).toEqual({ state: "committing" })
    expect(status).toHaveBeenCalledWith("/home/ouro/AgentBundles/sanctuary.ouro")
    expect(inspect).not.toHaveBeenCalled()

    for (const args of [
      [...base, "--operation", "inspect", "--target-image-id", `sha256:${"a".repeat(64)}`],
      [...base, "--operation", "migrate"],
      [...base, "--operation", "other"],
      [...base, "--operation", "inspect", "--operation", "inspect"],
      ["--package-root", "/package", "--agent-root"],
    ]) expect(() => runSanctuaryBundleOperation(args, dependencies())).toThrow(/Usage:/u)
  })

  it("preserves retryable rollback, distinct finalization, migrate, and commit semantics", async () => {
    const { runSanctuaryBundleOperation } = await load()
    const deps = dependencies()
    const rollbackImageId = `sha256:${"1".repeat(64)}`
    const targetImageId = `sha256:${"2".repeat(64)}`

    expect(runSanctuaryBundleOperation([...base, "--operation", "migrate", "--rollback-image-id", rollbackImageId, "--target-image-id", targetImageId], deps)).toEqual({ managedFilesUpdated: 8 })
    expect(deps.migrate).toHaveBeenCalledWith({ packageRoot: base[1], agentRoot: base[3], retainRollback: true, rollbackImageId, targetImageId })
    expect(runSanctuaryBundleOperation([...base, "--operation", "rollback"], deps)).toEqual({ rolledBack: true })
    expect(deps.rollback).toHaveBeenLastCalledWith(base[3], { retainRecord: true })
    expect(runSanctuaryBundleOperation([...base, "--operation", "finalize-rollback"], deps)).toEqual({ rolledBack: true })
    expect(deps.rollback).toHaveBeenLastCalledWith(base[3], { retainRecord: false })
    expect(runSanctuaryBundleOperation([...base, "--operation", "commit"], deps)).toEqual({ committed: true })

    expect(() => runSanctuaryBundleOperation([...base, "--operation", "status"], dependencies({ status: vi.fn(() => null) }))).toThrow("status found no pending Sanctuary bundle transaction")
    expect(() => runSanctuaryBundleOperation([...base, "--operation", "rollback"], dependencies({ rollback: vi.fn(() => false) }))).toThrow("rollback found no pending Sanctuary bundle transaction")
    expect(() => runSanctuaryBundleOperation([...base, "--operation", "finalize-rollback"], dependencies({ rollback: vi.fn(() => false) }))).toThrow("finalize-rollback found no pending Sanctuary bundle transaction")
    expect(() => runSanctuaryBundleOperation([...base, "--operation", "commit"], dependencies({ commit: vi.fn(() => false) }))).toThrow("commit found no pending Sanctuary bundle transaction")
  })
})
