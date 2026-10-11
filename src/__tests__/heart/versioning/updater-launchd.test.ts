import { describe, expect, it, vi } from "vitest"

import {
  ensureUpdaterAgent,
  generateUpdaterPlist,
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
})
