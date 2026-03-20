import { describe, it, expect, vi, beforeEach } from "vitest"
import { installOuroCommand, type OuroPathInstallerDeps } from "../../../heart/daemon/ouro-path-installer"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("installOuroCommand", () => {
  let written: Record<string, string>
  let appended: Record<string, string>
  let chmoded: Record<string, number>
  let mkdirCalls: string[]

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
    const correctContent = `#!/bin/sh
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return correctContent
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

  it("updates .bash_profile when shell is bash", () => {
    const deps = makeDeps({ shell: "/bin/bash" })
    const result = installOuroCommand(deps)

    expect(result.shellProfileUpdated).toBe("/home/test/.bash_profile")
    expect(appended["/home/test/.bash_profile"]).toContain("export PATH=")
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
    const correctContent = `#!/bin/sh\nENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"\nif [ ! -e "$ENTRY" ]; then\n  echo "ouro not installed. Run: npx ouro.bot" >&2\n  exit 1\nfi\nexec node "$ENTRY" "$@"\n`
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return correctContent
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
    const correctContent = `#!/bin/sh\nENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"\nif [ ! -e "$ENTRY" ]; then\n  echo "ouro not installed. Run: npx ouro.bot" >&2\n  exit 1\nfi\nexec node "$ENTRY" "$@"\n`
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.ouro-cli/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.ouro-cli/bin/ouro") return correctContent
        throw new Error("ENOENT")
      },
      envPath: "/usr/bin",
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(false)
    expect(result.pathReady).toBe(false)
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
  let unlinkCalls: string[]
  let rmdirCalls: string[]
  let ensureCliLayoutCalls: number

  function makeDeps(overrides: Partial<OuroPathInstallerDeps> = {}): OuroPathInstallerDeps {
    written = {}
    appended = {}
    chmoded = {}
    mkdirCalls = []
    unlinkCalls = []
    rmdirCalls = []
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
      unlinkSync: (p) => { unlinkCalls.push(p) },
      rmdirSync: (p) => { rmdirCalls.push(p) },
      ensureCliLayout: () => { ensureCliLayoutCalls++ },
      envPath: "/usr/bin:/usr/local/bin",
      shell: "/bin/zsh",
      ...overrides,
    }
  }

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

  it("removes old ~/.local/bin/ouro when it exists (migration)", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro",
    })
    const result = installOuroCommand(deps)

    expect(result.installed).toBe(true)
    expect(result.migratedFromOldPath).toBe(true)
    expect(unlinkCalls).toContain("/home/test/.local/bin/ouro")
  })

  it("removes empty ~/.local/bin/ directory after migration", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro" || p === "/home/test/.local/bin",
      rmdirSync: (p) => { rmdirCalls.push(p) },
      readdirSync: (p) => {
        if (p === "/home/test/.local/bin") return []
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.migratedFromOldPath).toBe(true)
    expect(rmdirCalls).toContain("/home/test/.local/bin")
  })

  it("does not remove ~/.local/bin/ when it still has files after migration", () => {
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro" || p === "/home/test/.local/bin",
      readdirSync: (p) => {
        if (p === "/home/test/.local/bin") return ["other-script"]
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.migratedFromOldPath).toBe(true)
    expect(rmdirCalls).not.toContain("/home/test/.local/bin")
  })

  it("removes old PATH entry ~/.local/bin from shell profile content during migration", () => {
    const existingProfile = '# some config\n\n# Added by ouro\nexport PATH="/home/test/.local/bin:$PATH"\n\n# other stuff'
    const deps = makeDeps({
      existsSync: (p) => p === "/home/test/.local/bin/ouro",
      readFileSync: (p) => {
        if (p === "/home/test/.zshrc") return existingProfile
        throw new Error("ENOENT")
      },
    })
    const result = installOuroCommand(deps)

    expect(result.migratedFromOldPath).toBe(true)
    // The profile should be rewritten without the old PATH entry
    expect(written["/home/test/.zshrc"]).toBeDefined()
    expect(written["/home/test/.zshrc"]).not.toContain(".local/bin")
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

  it("sets migratedFromOldPath to false when no old ouro exists", () => {
    const deps = makeDeps()
    const result = installOuroCommand(deps)

    expect(result.migratedFromOldPath).toBe(false)
  })
})
