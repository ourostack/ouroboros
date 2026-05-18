import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
  renameSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}))

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock("../../../heart/versioning/ouro-version-manager", () => ({
  getOuroCliHome: vi.fn(() => "/mock/home/.ouro-cli"),
}))

import * as fs from "fs"
import { execFileSync } from "child_process"
import {
  executePluginInstall,
  executePluginList,
  executePluginRemove,
  derivePluginIdFromSource,
} from "../../../heart/daemon/plugin-cli"
import type { OuroCliCommand } from "../../../heart/daemon/cli-types"

function makeDeps() {
  return { writeStdout: vi.fn() }
}

describe("plugin-cli — derivePluginIdFromSource", () => {
  it("derives from github: source with subpath", () => {
    expect(
      derivePluginIdFromSource(
        "github:ourostack/ouroboros-skills:plugins/desk",
      ),
    ).toBe("desk")
  })

  it("derives from github: source with nested subpath", () => {
    expect(
      derivePluginIdFromSource(
        "github:ourostack/ouroboros-skills:path/to/work-suite",
      ),
    ).toBe("work-suite")
  })

  it("derives from https://github.com URL with .git", () => {
    expect(
      derivePluginIdFromSource("https://github.com/ourostack/desk.git"),
    ).toBe("desk")
  })

  it("derives from https:// URL without .git", () => {
    expect(
      derivePluginIdFromSource("https://github.com/ourostack/desk"),
    ).toBe("desk")
  })

  it("derives from local: source", () => {
    expect(derivePluginIdFromSource("local:/some/path/desk")).toBe("desk")
  })

  it("derives from bare absolute path", () => {
    expect(derivePluginIdFromSource("/some/path/desk")).toBe("desk")
  })

  it("throws when no usable segments remain", () => {
    expect(() => derivePluginIdFromSource("/")).toThrow(
      /Could not derive plugin id/,
    )
  })

  it("throws on invalid characters", () => {
    expect(() => derivePluginIdFromSource("/path/bad_name!")).toThrow(
      /not a valid name/,
    )
  })
})

describe("plugin-cli — executePluginInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("clones a github: source (with subpath) and renames into place", async () => {
    let renamed = false
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.endsWith("/plugins/desk")) return renamed
      if (s.endsWith(".claude-plugin/plugin.json")) return renamed
      if (s.includes(".clone-")) return true
      return false
    })
    vi.mocked(execFileSync).mockImplementation(() => {
      renamed = true
      return Buffer.from("")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "github:ourostack/ouroboros-skills:plugins/desk",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(execFileSync).toHaveBeenCalled()
    expect(fs.renameSync).toHaveBeenCalled()
    expect(out).toContain("installed")
  })

  it("clones a direct URL (no subpath)", async () => {
    let cloned = false
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.endsWith("/plugins/desk")) return cloned
      if (s.endsWith(".claude-plugin/plugin.json")) return cloned
      return false
    })
    vi.mocked(execFileSync).mockImplementation(() => {
      cloned = true
      return Buffer.from("")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "https://github.com/ourostack/desk.git",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("installed")
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it("clones a local: source", async () => {
    let cloned = false
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.endsWith("/plugins/desk")) return cloned
      if (s.endsWith(".claude-plugin/plugin.json")) return cloned
      return false
    })
    vi.mocked(execFileSync).mockImplementation(() => {
      cloned = true
      return Buffer.from("")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "local:/some/path/desk",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("installed")
  })

  it("refuses to re-install when target dir already exists", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
      String(p).endsWith("/plugins/desk"),
    )
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "github:ourostack/ouroboros-skills:plugins/desk",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("already installed")
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it("rolls back when clone fails", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      // installDir doesn't exist pre-install, but exists after failed clone
      // (so cleanup branch is exercised)
      if (s.endsWith("/plugins/desk")) {
        return vi.mocked(execFileSync).mock.calls.length > 0
      }
      return false
    })
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("fatal: clone refused")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "github:ourostack/ouroboros-skills:plugins/desk",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("Plugin install failed")
    expect(fs.rmSync).toHaveBeenCalled()
  })

  it("rolls back when clone fails (and installDir never materialized)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("network failure")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "https://github.com/ourostack/desk.git",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("Plugin install failed")
  })

  it("rolls back when clone throws a non-Error value (covers String(e) branch)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(execFileSync).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "bare string failure"
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "https://github.com/ourostack/desk.git",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("Plugin install failed")
    expect(out).toContain("bare string failure")
  })

  it("rolls back when subpath is missing in cloned repo", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      // installDir + subpath inside tmp clone both absent
      if (s.endsWith("/plugins/desk") && !s.includes(".clone-")) return false
      return false
    })
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""))
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "github:ourostack/ouroboros-skills:plugins/desk",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("Plugin install failed")
  })

  it("rolls back when .claude-plugin/plugin.json missing after clone", async () => {
    let cloned = false
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.endsWith("/plugins/desk")) return cloned
      if (s.endsWith(".claude-plugin/plugin.json")) return false
      return false
    })
    vi.mocked(execFileSync).mockImplementation(() => {
      cloned = true
      return Buffer.from("")
    })
    const deps = makeDeps()
    const out = await executePluginInstall(
      {
        kind: "plugin.install",
        source: "https://github.com/ourostack/desk.git",
      } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
      deps,
    )
    expect(out).toContain("plugin.json missing")
    expect(fs.rmSync).toHaveBeenCalled()
  })

  it("rejects invalid github: format at derivePluginIdFromSource step", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const deps = makeDeps()
    await expect(
      executePluginInstall(
        {
          kind: "plugin.install",
          source: "github:no-slash",
        } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
        deps,
      ),
    ).rejects.toThrow()
  })

  it("rejects invalid github: format at buildPluginCloneUrl step (line 53)", async () => {
    // github:/repo — derives a valid plugin id ("repo") but
    // buildPluginCloneUrl regex rejects it (org segment is empty).
    // Throws synchronously before the install try/catch — propagates up.
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const deps = makeDeps()
    await expect(
      executePluginInstall(
        {
          kind: "plugin.install",
          source: "github:/repo",
        } as Extract<OuroCliCommand, { kind: "plugin.install" }>,
        deps,
      ),
    ).rejects.toThrow(/Invalid github: source/)
  })
})

describe("plugin-cli — executePluginList", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reports 'no plugins installed' when root missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const deps = makeDeps()
    const out = await executePluginList(
      { kind: "plugin.list" } as Extract<OuroCliCommand, { kind: "plugin.list" }>,
      deps,
    )
    expect(out).toContain("No plugins installed")
  })

  it("reports 'no plugins installed' when root exists but empty", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as fs.Dirent[])
    const deps = makeDeps()
    const out = await executePluginList(
      { kind: "plugin.list" } as Extract<OuroCliCommand, { kind: "plugin.list" }>,
      deps,
    )
    expect(out).toContain("No plugins installed")
  })

  it("lists installed plugins, sorted, filtering dot-prefixed and non-dir entries", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "work-suite",
      "desk",
      ".tmp-noise",
      "stray-file",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      return {
        isDirectory: () => s.endsWith("/desk") || s.endsWith("/work-suite"),
      } as fs.Stats
    })
    const deps = makeDeps()
    const out = await executePluginList(
      { kind: "plugin.list" } as Extract<OuroCliCommand, { kind: "plugin.list" }>,
      deps,
    )
    expect(out).toContain("Installed plugins (2)")
    expect(out).toContain("desk")
    expect(out).toContain("work-suite")
    expect(out).not.toContain("stray-file")
  })

  it("tolerates statSync throwing on broken entries", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "desk",
      "broken-entry",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith("broken-entry")) {
        throw new Error("EACCES")
      }
      return { isDirectory: () => true } as fs.Stats
    })
    const deps = makeDeps()
    const out = await executePluginList(
      { kind: "plugin.list" } as Extract<OuroCliCommand, { kind: "plugin.list" }>,
      deps,
    )
    expect(out).toContain("desk")
    expect(out).not.toContain("broken-entry")
  })
})

describe("plugin-cli — executePluginRemove", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("removes an installed plugin directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const deps = makeDeps()
    const out = await executePluginRemove(
      {
        kind: "plugin.remove",
        pluginId: "desk",
      } as Extract<OuroCliCommand, { kind: "plugin.remove" }>,
      deps,
    )
    expect(fs.rmSync).toHaveBeenCalled()
    expect(out).toContain("removed")
  })

  it("reports a clear message when the plugin is not installed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const deps = makeDeps()
    const out = await executePluginRemove(
      {
        kind: "plugin.remove",
        pluginId: "desk",
      } as Extract<OuroCliCommand, { kind: "plugin.remove" }>,
      deps,
    )
    expect(fs.rmSync).not.toHaveBeenCalled()
    expect(out).toContain("not installed")
  })
})

describe("plugin-cli — runOuroCli dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRunDeps() {
    return {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValue(false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn().mockReturnValue("/tmp/pending"),
    }
  }

  it("dispatches `plugin install` to executePluginInstall", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
      String(p).endsWith("/plugins/desk"),
    )
    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const out = await runOuroCli(
      ["plugin", "install", "github:ourostack/ouroboros-skills:plugins/desk"],
      makeRunDeps(),
    )
    expect(out).toContain("already installed")
  })

  it("dispatches `plugin list` to executePluginList", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const out = await runOuroCli(["plugin", "list"], makeRunDeps())
    expect(out).toContain("No plugins installed")
  })

  it("dispatches `plugin remove` to executePluginRemove", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { runOuroCli } = await import("../../../heart/daemon/daemon-cli")
    const out = await runOuroCli(["plugin", "remove", "desk"], makeRunDeps())
    expect(out).toContain("not installed")
  })
})
