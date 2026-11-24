import { describe, expect, it, vi } from "vitest"

import {
  chooseUpdaterNodePath,
  ensureUpdaterAgent,
  generateUpdaterPlist,
  isHostUserHome,
  restoreUpdaterAgentIfMissing,
  UPDATER_PLIST_LABEL,
  updaterPlistPath,
  type UpdaterAgentDeps,
} from "../../../heart/versioning/updater-launchd"

const HOME = "/Users/ari"
const NODE = "/Users/ari/.nvm/versions/node/v22.23.3/bin/node"

function agentDeps(overrides: Partial<UpdaterAgentDeps> & { loaded?: boolean; existing?: string | null } = {}): UpdaterAgentDeps {
  const { loaded = false, existing = null, ...rest } = overrides
  return {
    homeDir: HOME,
    userUid: 501,
    nodePath: NODE,
    readFile: vi.fn(() => existing),
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    exec: vi.fn((command: string) => {
      if (command.startsWith("launchctl print") && !loaded) throw new Error("Could not find service")
    }),
    runningUnderUpdaterAgent: false,
    updateInProgress: false,
    ...rest,
  }
}

describe("generateUpdaterPlist", () => {
  it("runs the stable launcher hourly and at login with node on PATH", () => {
    const plist = generateUpdaterPlist({ homeDir: HOME, nodePath: NODE })
    expect(plist).toContain(`<string>${UPDATER_PLIST_LABEL}</string>`)
    expect(plist).toContain(`<string>${NODE}</string>\n    <string>/Users/ari/.ouro-cli/bin/ouro-launcher.js</string>\n    <string>self-update</string>\n    <string>--unattended</string>`)
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>3600</integer>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain("<string>/Users/ari/.nvm/versions/node/v22.23.3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>")
    expect(plist).not.toContain("KeepAlive")
  })

  it("escapes XML in paths", () => {
    expect(generateUpdaterPlist({ homeDir: "/Users/a&b", nodePath: "/opt/<node>" })).toContain("<string>/opt/&lt;node&gt;</string>")
  })
})

describe("ensureUpdaterAgent", () => {
  const plistPath = updaterPlistPath(HOME)

  it("installs and loads a missing agent", () => {
    const deps = agentDeps()
    expect(ensureUpdaterAgent(deps)).toBe("installed")
    expect(deps.mkdirp).toHaveBeenCalledWith("/Users/ari/Library/LaunchAgents")
    expect(deps.writeFile).toHaveBeenCalledWith(plistPath, generateUpdaterPlist({ homeDir: HOME, nodePath: NODE }))
    expect(deps.exec).toHaveBeenLastCalledWith(`launchctl bootstrap gui/501 "${plistPath}"`)
    expect(deps.exec).not.toHaveBeenCalledWith(`launchctl bootout gui/501/${UPDATER_PLIST_LABEL}`)
  })

  it("leaves a current, loaded agent alone", () => {
    const deps = agentDeps({ loaded: true, existing: generateUpdaterPlist({ homeDir: HOME, nodePath: NODE }) })
    expect(ensureUpdaterAgent(deps)).toBe("unchanged")
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it("reloads a stale loaded agent, ignoring a failed bootout", () => {
    const deps = agentDeps({ loaded: true, existing: "old plist" })
    vi.mocked(deps.exec).mockImplementation((command: string) => {
      if (command.startsWith("launchctl bootout")) throw new Error("not loaded")
    })
    expect(ensureUpdaterAgent(deps)).toBe("installed")
    expect(deps.exec).toHaveBeenCalledWith(`launchctl bootout gui/501/${UPDATER_PLIST_LABEL}`)
    expect(deps.exec).toHaveBeenLastCalledWith(`launchctl bootstrap gui/501 "${plistPath}"`)
  })

  it("only rewrites the file when the updater agent itself is running", () => {
    const deps = agentDeps({ loaded: true, existing: "old plist", runningUnderUpdaterAgent: true })
    expect(ensureUpdaterAgent(deps)).toBe("written-reload-pending")
    expect(deps.writeFile).toHaveBeenCalled()
    expect(deps.exec).toHaveBeenCalledTimes(1)
  })

  it("does not boot out the agent while another process holds the update lock", () => {
    const deps = agentDeps({ loaded: true, existing: "old plist", updateInProgress: true })
    expect(ensureUpdaterAgent(deps)).toBe("written-reload-pending")
    expect(deps.exec).not.toHaveBeenCalledWith(`launchctl bootout gui/501/${UPDATER_PLIST_LABEL}`)
  })
})

describe("chooseUpdaterNodePath", () => {
  it("prefers a stable node with the running major version", () => {
    const majorOf = vi.fn((nodePath: string) => (nodePath === "/opt/homebrew/bin/node" ? 20 : nodePath === "/usr/local/bin/node" ? 22 : null))
    expect(chooseUpdaterNodePath({ execPath: NODE, runningMajor: 22, majorOf })).toBe("/usr/local/bin/node")
  })

  it("falls back to the running node", () => {
    expect(chooseUpdaterNodePath({ execPath: NODE, runningMajor: 22, majorOf: () => null })).toBe(NODE)
    expect(chooseUpdaterNodePath({ execPath: NODE, runningMajor: 22, majorOf: () => 22, candidates: [] })).toBe(NODE)
  })
})

describe("restoreUpdaterAgentIfMissing", () => {
  function restoreDeps(options: { loaded: boolean; plist?: boolean; updating?: boolean; bootstrapFails?: boolean }) {
    const exec = vi.fn((command: string) => {
      if (command.startsWith("launchctl print") && !options.loaded) throw new Error("Could not find service")
      if (command.startsWith("launchctl bootstrap") && options.bootstrapFails) throw new Error("Bootstrap failed: 5")
    })
    return {
      exec,
      deps: {
        homeDir: HOME,
        userUid: 501,
        fileExists: vi.fn(() => options.plist ?? true),
        exec,
        updateInProgress: vi.fn(() => options.updating ?? false),
      },
    }
  }

  it("leaves a loaded updater alone", () => {
    const { deps, exec } = restoreDeps({ loaded: true })
    expect(restoreUpdaterAgentIfMissing(deps)).toBe("loaded")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(`launchctl print gui/501/${UPDATER_PLIST_LABEL}`)
  })

  it("bootstraps the existing plist, unchanged, when launchd has lost the updater", () => {
    const { deps, exec } = restoreDeps({ loaded: false })
    expect(restoreUpdaterAgentIfMissing(deps)).toBe("restored")
    expect(exec).toHaveBeenLastCalledWith(`launchctl bootstrap gui/501 "${updaterPlistPath(HOME)}"`)
    expect(exec.mock.calls.some(([command]) => String(command).includes("bootout"))).toBe(false)
  })

  it("does nothing when the updater was never installed on this machine", () => {
    const { deps, exec } = restoreDeps({ loaded: false, plist: false })
    expect(restoreUpdaterAgentIfMissing(deps)).toBe("no-plist")
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("waits while an update pass holds the lock", () => {
    const { deps, exec } = restoreDeps({ loaded: false, updating: true })
    expect(restoreUpdaterAgentIfMissing(deps)).toBe("update-in-progress")
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("reports a bootstrap launchd refuses instead of throwing", () => {
    const { deps } = restoreDeps({ loaded: false, bootstrapFails: true })
    expect(restoreUpdaterAgentIfMissing(deps)).toBe("restore-failed")
  })
})

describe("isHostUserHome", () => {
  it("is true only when HOME is the account's own home directory", () => {
    expect(isHostUserHome("/Users/ari", "/Users/ari")).toBe(true)
    expect(isHostUserHome("/Users/ari/", "/Users/ari")).toBe(true)
    expect(isHostUserHome("/var/folders/x/T/ouro-hermetic-runtime-1/home", "/Users/ari")).toBe(false)
    expect(isHostUserHome("/Users/ari", "")).toBe(false)
  })
})
