import { describe, it, expect, vi, beforeEach } from "vitest"
import { installOuroCommand, diagnoseOuroPath, type OuroPathInstallerDeps } from "../../../heart/versioning/ouro-path-installer"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("installOuroCommand", () => {
  let written: Record<string, string>
  let appended: Record<string, string>
  let chmoded: Record<string, number>
  let mkdirCalls: string[]
  const correctContent = '#!/bin/sh\nexec npx --prefer-online --yes @ouro.bot/cli@alpha "$@"\n'

  function makeDeps(overrides: Partial<OuroPathInstallerDeps> = {}): OuroPathInstallerDeps {
    written = {}
    appended = {}
    chmoded = {}
    mkdirCalls = []
    return {
      homeDir: "/home/test",
      platform: "darwin",
      existsSync: () => false,
      mkdirSync: (p) => { mkdirCalls.push(p) },
      writeFileSync: (p, data) => { written[p] = typeof data === "string" ? data : "" },
      readFileSync: () => { throw new Error("ENOENT") },
      appendFileSync: (p, data) => { appended[p] = (appended[p] ?? "") + data },
      chmodSync: (p, mode) => { chmoded[p] = typeof mode === "number" ? mode : 0 },
      envPath: "/usr/bin:/usr/local/bin",
      shell: "/bin/zsh",
      ...overrides,
    }
  }

  const CORRECT_CONTENT = `#!/bin/sh
# Check for dev mode — if dev-config.json exists, dispatch to the dev repo
# Skip dev dispatch for "up" command (explicitly returns to production)
DEV_CONFIG="$HOME/.ouro-cli/dev-config.json"
if [ -f "$DEV_CONFIG" ] && [ "$1" != "up" ]; then
  DEV_REPO=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEV_CONFIG','utf-8')).repoPath)}catch{}" 2>/dev/null)
  DEV_ENTRY="$DEV_REPO/dist/heart/daemon/ouro-entry.js"
  if [ -n "$DEV_REPO" ] && [ -e "$DEV_ENTRY" ]; then
    exec node "$DEV_ENTRY" "$@"
  fi
fi
# Fall back to installed version
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("installs ouro wrapper script to ~/.ouro-cli/bin/ouro", () => {
    const deps = makeDeps()
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.scriptPath).toBe("/home/test/.ouro-cli/bin/ouro")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("#!/bin/sh")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain('exec node "$ENTRY" "$@"')
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("CurrentVersion")
    expect(chmoded["/home/test/.ouro-cli/bin/ouro"]).toBe(0o755)
    expect(mkdirCalls).toContain("/home/test/.ouro-cli/bin")
  })

  it("makes script executable with chmod 755", () => {
    const deps = makeDeps()
    installOuroCommand(deps)
    expect(chmoded["/home/test/.ouro-cli/bin/ouro"]).toBe(0o755)
  })

  it("skips if ouro script already exists with correct content", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.skippedReason).toBe("already-installed")
    expect(Object.keys(written)).toHaveLength(0)
  })

  it("repairs ouro script when content is stale", () => {
    const staleContent = '#!/bin/sh\nexec npx --yes ouro.bot "$@"\n'
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return staleContent
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.scriptPath).toBe("/home/test/.ouro-cli/bin/ouro")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain('exec node "$ENTRY" "$@"')
    expect(result.skippedReason).toBeUndefined()
  })

  it("repairs ouro script when content read fails (treats as stale)", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: () => { throw new Error("EACCES") },
    })
    const result = installOuroCommand(deps)

    // When we can't read existing content, we should overwrite it
    expect(result.installed).toBe(true)
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain('exec node "$ENTRY" "$@"')
  })

  it("skips on Windows", () => {
    const deps = makeDeps({ platform: "win32" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.skippedReason).toBe("windows")
  })

  it("updates .zshrc when ~/.ouro-cli/bin is not in PATH and shell is zsh", () => {
    const deps = makeDeps({ shell: "/bin/zsh" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBe("/home/test/.zshrc")
    expect(appended["/home/test/.zshrc"]).toContain("export PATH=")
    expect(appended["/home/test/.zshrc"]).toContain(".ouro-cli/bin")
    expect(appended["/home/test/.zshrc"]).toContain("# Added by ouro")
  })

  it("updates .bash_profile when shell is bash on macOS", () => {
    const deps = makeDeps({ shell: "/bin/bash", platform: "darwin" })
    const result = installOuroCommand(deps)

    expect(result.shellProfileUpdated).toBe("/home/test/.bash_profile")
    expect(appended["/home/test/.bash_profile"]).toContain("export PATH=")
  })

  it("updates .bashrc when shell is bash on Linux", () => {
    const deps = makeDeps({ shell: "/bin/bash", platform: "linux" })
    const result = installOuroCommand(deps)

    expect(result.shellProfileUpdated).toBe("/home/test/.bashrc")
    expect(appended["/home/test/.bashrc"]).toContain("export PATH=")
  })

  it("updates fish config when shell is fish", () => {
    const deps = makeDeps({ shell: "/usr/bin/fish" })
    const result = installOuroCommand(deps)

    expect(result.shellProfileUpdated).toBe("/home/test/.config/fish/config.fish")
    expect(appended["/home/test/.config/fish/config.fish"]).toContain("set -gx PATH")
  })

  it("does not update shell profile when ~/.ouro-cli/bin is already in PATH", () => {
    const deps = makeDeps({ envPath: "/usr/bin:/home/test/.ouro-cli/bin" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.pathReady).toBe(true)
    expect(result.shellProfileUpdated).toBeNull()
    expect(Object.keys(appended)).toHaveLength(0)
  })

  it("does not duplicate PATH entry if shell profile already contains binDir", () => {
    const deps = makeDeps({
      readFileSync: () => 'export PATH="/home/test/.ouro-cli/bin:$PATH"',
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBeNull()
  })

  it("handles write failure gracefully", () => {
    const deps = makeDeps({
      writeFileSync: () => { throw new Error("EACCES: permission denied") },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.skippedReason).toBe("EACCES: permission denied")
  })

  it("handles shell profile update failure gracefully", () => {
    const deps = makeDeps({
      appendFileSync: () => { throw new Error("profile write failed") },
    })
    const result = installOuroCommand(deps)

    // Script itself should still be installed even if profile update fails
    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBeNull()
  })

  it("does not update shell profile when shell is unrecognized", () => {
    const deps = makeDeps({ shell: "/bin/csh" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBeNull()
  })

  it("does not update shell profile when shell is undefined", () => {
    const deps = makeDeps({ shell: "" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBeNull()
  })

  it("reports pathReady correctly when already-installed and in PATH", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        throw new Error("ENOENT")
      },
      envPath: "/usr/bin:/home/test/.ouro-cli/bin",
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.pathReady).toBe(true)
    expect(result.skippedReason).toBe("already-installed")
  })

  it("reports pathReady false when already-installed but not in PATH", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        throw new Error("ENOENT")
      },
      envPath: "/usr/bin",
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.pathReady).toBe(false)
  })

  it("reports a PATH shadow when another ouro appears before the managed wrapper", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro" || p === "/opt/homebrew/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        if (p === "/opt/homebrew/bin/ouro") return '#!/bin/sh\nexec npx --yes @ouro.bot/cli@0.1.0-alpha.323 "$@"\n'
        throw new Error("ENOENT")
      },
      envPath: "/opt/homebrew/bin:/home/test/.ouro-cli/bin:/usr/bin",
    })

    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.pathResolution).toMatchObject({
      status: "shadowed",
      resolvedPath: "/opt/homebrew/bin/ouro",
      expectedPath: "/home/test/.ouro-cli/bin/ouro",
    })
    expect(result.pathResolution?.remediation).toContain("move /home/test/.ouro-cli/bin before /opt/homebrew/bin")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.ouro_path_shadowed",
      meta: expect.objectContaining({ resolvedPath: "/opt/homebrew/bin/ouro" }),
    }))
  })

  it("reports a PATH shadow after installing the managed wrapper", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/opt/homebrew/bin/ouro",
      readFileSync: (p) => {
        if (p === "/opt/homebrew/bin/ouro") return '#!/bin/sh\nexec npx --yes @ouro.bot/cli@0.1.0-alpha.323 "$@"\n'
        throw new Error("ENOENT")
      },
      envPath: "/opt/homebrew/bin:/home/test/.ouro-cli/bin:/usr/bin",
    })

    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.pathResolution?.status).toBe("shadowed")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("CurrentVersion")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.ouro_path_shadowed",
      meta: expect.objectContaining({ resolvedPath: "/opt/homebrew/bin/ouro" }),
    }))
  })

  it("treats a compatible earlier wrapper as healthy", () => {
    const result = diagnoseOuroPath({
      homeDir: "/home/test",
      envPath: "/opt/homebrew/bin:/home/test/.ouro-cli/bin",
      existsSync: (p) => p === "/opt/homebrew/bin/ouro" || p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/opt/homebrew/bin/ouro") return CORRECT_CONTENT
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        throw new Error("ENOENT")
      },
    })

    expect(result).toMatchObject({
      status: "ok",
      resolvedPath: "/opt/homebrew/bin/ouro",
      expectedPath: "/home/test/.ouro-cli/bin/ouro",
      remediation: null,
    })
  })

  it("returns a concrete remediation when ouro is missing from PATH", () => {
    const result = diagnoseOuroPath({
      homeDir: "/home/test",
      envPath: "/usr/bin:/bin",
      existsSync: () => false,
      readFileSync: () => { throw new Error("ENOENT") },
    })

    expect(result.status).toBe("missing")
    expect(result.detail).toContain("PATH does not resolve ouro")
    expect(result.remediation).toContain("add /home/test/.ouro-cli/bin to PATH")
  })

  it("works on linux platform", () => {
    const deps = makeDeps({ platform: "linux" })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.scriptPath).toBe("/home/test/.ouro-cli/bin/ouro")
  })
})

describe("installOuroCommand — versioned CLI layout", () => {
  let written: Record<string, string>
  let appended: Record<string, string>
  let chmoded: Record<string, number>
  let mkdirCalls: string[]
  let ensureCliLayoutCalls: number

  const CORRECT_CONTENT = `#!/bin/sh
# Check for dev mode — if dev-config.json exists, dispatch to the dev repo
# Skip dev dispatch for "up" command (explicitly returns to production)
DEV_CONFIG="$HOME/.ouro-cli/dev-config.json"
if [ -f "$DEV_CONFIG" ] && [ "$1" != "up" ]; then
  DEV_REPO=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEV_CONFIG','utf-8')).repoPath)}catch{}" 2>/dev/null)
  DEV_ENTRY="$DEV_REPO/dist/heart/daemon/ouro-entry.js"
  if [ -n "$DEV_REPO" ] && [ -e "$DEV_ENTRY" ]; then
    exec node "$DEV_ENTRY" "$@"
  fi
fi
# Fall back to installed version
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`

  function makeDeps(overrides: Partial<OuroPathInstallerDeps> = {}): OuroPathInstallerDeps {
    written = {}
    appended = {}
    chmoded = {}
    mkdirCalls = []
    ensureCliLayoutCalls = 0
    return {
      homeDir: "/home/test",
      platform: "darwin",
      existsSync: () => false,
      mkdirSync: (p) => { mkdirCalls.push(p) },
      writeFileSync: (p, data) => { written[p] = typeof data === "string" ? data : "" },
      readFileSync: () => { throw new Error("ENOENT") },
      appendFileSync: (p, data) => { appended[p] = (appended[p] ?? "") + data },
      chmodSync: (p, mode) => { chmoded[p] = typeof mode === "number" ? mode : 0 },
      ensureCliLayout: () => { ensureCliLayoutCalls++ },
      envPath: "/usr/bin:/usr/local/bin",
      shell: "/bin/zsh",
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("installs wrapper script to ~/.ouro-cli/bin/ouro with exec-from-CurrentVersion content", () => {
    const deps = makeDeps()
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.scriptPath).toBe("/home/test/.ouro-cli/bin/ouro")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("#!/bin/sh")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain('exec node "$ENTRY" "$@"')
    expect(written["/home/test/.ouro-cli/bin/ouro"]).not.toContain("exec npx")
  })

  it("adds ~/.ouro-cli/bin to PATH in shell profile", () => {
    const deps = makeDeps()
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.shellProfileUpdated).toBe("/home/test/.zshrc")
    expect(appended["/home/test/.zshrc"]).toContain(".ouro-cli/bin")
    expect(appended["/home/test/.zshrc"]).toContain("# Added by ouro")
  })

  it("repairs stale ~/.local/bin/ouro when it exists with old content", () => {
    const staleOldContent = '#!/bin/sh\nexec npx --yes @ouro.bot/cli "$@"\n'
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.local/bin/ouro") return staleOldContent
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.repairedOldLauncher).toBe(true)
    // Both modern and old paths get the correct wrapper
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("CurrentVersion")
    expect(written["/home/test/.local/bin/ouro"]).toContain("CurrentVersion")
  })

  it("does not repair old launcher when it already has correct content", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.local/bin/ouro") return CORRECT_CONTENT
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.repairedOldLauncher).toBe(false)
    // Old path should NOT be written to since it's already current
    expect(written["/home/test/.local/bin/ouro"]).toBeUndefined()
  })

  it("continues modern install even if old launcher repair fails", () => {
    let writeCount = 0
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.local/bin/ouro") return "stale"
        throw new Error("ENOENT")
      },
      writeFileSync: (p, data) => {
        // Fail on the old path write, succeed on the modern path write
        if (p === "/home/test/.local/bin/ouro") {
          throw new Error("EACCES")
        }
        writeCount++
        written[p] = typeof data === "string" ? data : ""
      },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.repairedOldLauncher).toBe(false)
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("CurrentVersion")
  })

  it("sets repairedOldLauncher to false when no old launcher exists", () => {
    const deps = makeDeps()
    const result = installOuroCommand(deps)

    expect(result.repairedOldLauncher).toBe(false)
  })

  it("repairs stale npx wrapper with new exec-from-CurrentVersion content", () => {
    const staleContent = '#!/bin/sh\nexec npx --prefer-online --yes @ouro.bot/cli@alpha "$@"\n'
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return staleContent
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toContain("CurrentVersion")
    expect(written["/home/test/.ouro-cli/bin/ouro"]).not.toContain("exec npx")
  })

  it("calls ensureCliLayout to create directory structure", () => {
    const deps = makeDeps()
    installOuroCommand(deps)

    expect(ensureCliLayoutCalls).toBe(1)
  })

  it("repairs old launcher AND skips modern install when modern is already current", () => {
    const staleOldContent = '#!/bin/sh\nexec npx ouro.bot "$@"\n'
    const deps = makeDeps({
      existsSync: (p) =>
        p === "/home/test/.ouro-cli/bin/ouro"
        || p === "/home/test/.local/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return CORRECT_CONTENT
        if (p === "/home/test/.local/bin/ouro") return staleOldContent
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    // Modern was already current → not "installed"
    expect(result.installed).toBe(false)
    expect(result.skippedReason).toBe("already-installed")
    // But old launcher was still repaired
    expect(result.repairedOldLauncher).toBe(true)
    expect(written["/home/test/.local/bin/ouro"]).toContain("CurrentVersion")
    // Modern path was NOT rewritten
    expect(written["/home/test/.ouro-cli/bin/ouro"]).toBeUndefined()
  })
})
