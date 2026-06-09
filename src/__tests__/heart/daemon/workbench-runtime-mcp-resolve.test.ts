import { describe, it, expect } from "vitest"
import path from "path"
import { resolveWorkbenchRuntimeMcp } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

/**
 * resolveWorkbenchRuntimeMcp turns the parsed --workbench-mcp flag into the
 * concrete { ouro_workbench: { command, args } } override that the mcp-serve
 * bridge forwards on every senseTurn. Covers all flag/discovery branches.
 */

const HOME = "/home/tester"
const DEFAULT_USER_CANDIDATE = path.join(
  HOME,
  "Applications",
  "Ouro Workbench.app",
  "Contents",
  "MacOS",
  "OuroWorkbenchMCP",
)

function deps(existing: Set<string>): OuroCliDeps {
  return {
    socketPath: "/tmp/test.sock",
    homeDir: HOME,
    existsSync: (p: string) => existing.has(p),
  } as unknown as OuroCliDeps
}

describe("resolveWorkbenchRuntimeMcp", () => {
  it("returns null when the flag is absent (undefined)", () => {
    expect(resolveWorkbenchRuntimeMcp(undefined, deps(new Set()))).toBeNull()
  })

  it("self-discovers the installed MCP when the flag is a bare boolean opt-in", () => {
    const result = resolveWorkbenchRuntimeMcp(true, deps(new Set([DEFAULT_USER_CANDIDATE])))
    expect(result).toEqual({
      ouro_workbench: { command: DEFAULT_USER_CANDIDATE, args: [] },
    })
  })

  it("uses an explicit string path when it exists", () => {
    const explicit = "/custom/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP"
    const result = resolveWorkbenchRuntimeMcp(explicit, deps(new Set([explicit])))
    expect(result).toEqual({ ouro_workbench: { command: explicit, args: [] } })
  })

  it("falls back to discovery when the explicit path does not exist", () => {
    const missing = "/nope/OuroWorkbenchMCP"
    const result = resolveWorkbenchRuntimeMcp(
      missing,
      deps(new Set([DEFAULT_USER_CANDIDATE])),
    )
    expect(result).toEqual({
      ouro_workbench: { command: DEFAULT_USER_CANDIDATE, args: [] },
    })
  })

  it("returns null when the opt-in finds no installed MCP anywhere", () => {
    expect(resolveWorkbenchRuntimeMcp(true, deps(new Set()))).toBeNull()
  })
})
