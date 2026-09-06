import { afterEach, describe, expect, it, vi } from "vitest"
import * as os from "node:os"
import * as path from "node:path"

const faults = vi.hoisted(() => ({ lstat: null as string | null, read: null as string | null }))

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    lstatSync: (target: import("node:fs").PathLike) => {
      if (target === faults.lstat) throw Object.assign(new Error("device failed"), { code: "EIO" })
      return actual.lstatSync(target)
    },
    readFileSync: (target: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
      if (target === faults.read) throw Object.assign(new Error("device failed"), { code: "EIO" })
      return actual.readFileSync(target, options as never)
    },
  }
})

import * as fs from "node:fs"
import {
  SANCTUARY_BUNDLE_ROLLBACK_FILE,
  SANCTUARY_PACKAGE_MANAGED_FILES,
  inspectSanctuaryPackageManagedBundle,
} from "../../../heart/daemon/sanctuary-bundle-migration"

const roots: string[] = []

function write(root: string, relative: string, value: string | object): void {
  const destination = path.join(root, relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function makeLayout(): { packageRoot: string; agentRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-inspection-io-"))
  roots.push(root)
  const packageRoot = path.join(root, "package")
  const agentRoot = path.join(root, "live")
  fs.mkdirSync(packageRoot)
  fs.mkdirSync(agentRoot)
  for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
    write(packageRoot, relative, `${relative}\n`)
    write(agentRoot, relative, `${relative}\n`)
    fs.chmodSync(path.join(agentRoot, relative), 0o600)
  }
  const metadata = { runtimeVersion: "v", bundleSchemaVersion: 3, lastUpdated: "2026-09-05T00:00:00.000Z" }
  write(packageRoot, "bundle-meta.json", metadata)
  write(agentRoot, "bundle-meta.json", metadata)
  fs.chmodSync(path.join(agentRoot, "bundle-meta.json"), 0o600)
  write(packageRoot, "state/policy/steward.json", { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null })
  return { packageRoot, agentRoot }
}

afterEach(() => {
  faults.lstat = null
  faults.read = null
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary bundle inspection I/O failures", () => {
  it.each(["root", "nested path", "JSON read", "journal read"])("maps an unexpected %s failure to the bounded unavailable result", (fault) => {
    const { packageRoot, agentRoot } = makeLayout()
    if (fault === "root") faults.lstat = packageRoot
    if (fault === "nested path") faults.lstat = path.join(packageRoot, "habits")
    if (fault === "JSON read") faults.read = path.join(packageRoot, "bundle-meta.json")
    if (fault === "journal read") {
      const journalPath = path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE)
      fs.writeFileSync(journalPath, "{}\n", { mode: 0o600 })
      faults.read = journalPath
    }

    expect(inspectSanctuaryPackageManagedBundle({ packageRoot, agentRoot, runtimePackageVersion: "v" })).toEqual({
      ok: false,
      error: { code: "inspection_unavailable", message: "Sanctuary install state is unavailable", degraded: true, repair: { actor: "human-required", action: "run_verified_update_recovery" } },
    })
  })
})
