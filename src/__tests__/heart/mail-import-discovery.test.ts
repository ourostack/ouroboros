import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tempRoots: string[] = []
const mockGetAgentRepoWorkspacesRoot = vi.fn()

vi.mock("../../heart/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/identity")>()
  return {
    ...actual,
    getAgentRepoWorkspacesRoot: (...args: any[]) => mockGetAgentRepoWorkspacesRoot(...args),
  }
})

const {
  defaultMailImportDiscoveryDirs,
  discoverMailImportFilePath,
  listDiscoveredMboxCandidates,
  listAmbientMailImportOperations,
  listVisibleBackgroundOperations,
} = await import("../../heart/mail-import-discovery")

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-import-discovery-"))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  mockGetAgentRepoWorkspacesRoot.mockReset()
})

describe("mail import discovery", () => {
  it("includes worktree-local and agent-workspace Playwright sandboxes in default discovery dirs", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const worktreePool = path.join(homeDir, "Projects", "_worktrees")
    const worktreeDir = path.join(worktreePool, "slugger-mail-fullmoon-mail")
    const agentWorkspacesRoot = path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces")
    const workspaceDir = path.join(agentWorkspacesRoot, "workspace-1")
    fs.mkdirSync(path.join(worktreeDir, ".playwright-mcp"), { recursive: true })
    fs.mkdirSync(path.join(workspaceDir, ".playwright-mcp"), { recursive: true })
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(agentWorkspacesRoot)

    const dirs = defaultMailImportDiscoveryDirs({
      agentName: "slugger",
      repoRoot,
      homeDir,
    })

    expect(dirs).toEqual(expect.arrayContaining([
      path.join(repoRoot, ".playwright-mcp"),
      path.join(homeDir, ".playwright-mcp"),
      path.join(homeDir, "Downloads"),
      path.join(worktreeDir, ".playwright-mcp"),
      path.join(workspaceDir, ".playwright-mcp"),
    ]))
  })

  it("skips heavyweight home directories when scanning for nested _worktrees pools", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const allowedWorktreeDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail")
    const skippedWorktreeDir = path.join(homeDir, "Pictures", "_worktrees", "should-not-scan")
    fs.mkdirSync(path.join(allowedWorktreeDir, ".playwright-mcp"), { recursive: true })
    fs.mkdirSync(path.join(skippedWorktreeDir, ".playwright-mcp"), { recursive: true })
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const dirs = defaultMailImportDiscoveryDirs({
      agentName: "slugger",
      repoRoot,
      homeDir,
    })

    expect(dirs).toContain(path.join(allowedWorktreeDir, ".playwright-mcp"))
    expect(dirs).not.toContain(path.join(skippedWorktreeDir, ".playwright-mcp"))
  })

  it("discovers a recent MBOX file inside a nested _worktrees Playwright sandbox", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const worktreeDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail")
    const sandboxDir = path.join(worktreeDir, ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const discoveredPath = discoverMailImportFilePath({
      agentName: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      repoRoot,
      homeDir,
    })

    expect(discoveredPath).toBe(mboxPath)
  })

  it("surfaces ambient import readiness and suppresses it when a live import already exists", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.now(),
      existingOperations: [],
    })

    expect(visible).toEqual([
      expect.objectContaining({
        kind: "mail.import-discovered",
        title: "mail import ready",
        detail: expect.stringContaining("browser sandbox (.playwright-mcp)"),
        spec: expect.objectContaining({
          candidatePaths: [mboxPath],
          newestCandidateOriginKind: "playwright-sandbox",
          newestCandidateOriginLabel: "browser sandbox (.playwright-mcp)",
          candidateDescriptors: [
            expect.objectContaining({
              path: mboxPath,
              originKind: "playwright-sandbox",
              originLabel: "browser sandbox (.playwright-mcp)",
            }),
          ],
        }),
      }),
    ])

    const suppressed = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.now(),
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_1",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "running",
        summary: "importing delegated mail archive",
        createdAt: "2026-04-23T20:08:17.000Z",
        updatedAt: "2026-04-23T20:09:17.000Z",
      }],
    })

    expect(suppressed).toEqual([])
  })

  it("suppresses ambient import readiness once the same archive already succeeded", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    const downloadedAt = new Date("2026-04-24T05:40:00.000Z")
    fs.utimesSync(mboxPath, downloadedAt, downloadedAt)
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.parse("2026-04-24T05:51:10.000Z"),
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_done",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "succeeded",
        summary: "imported delegated mail archive",
        createdAt: "2026-04-24T05:39:00.000Z",
        updatedAt: "2026-04-24T05:51:02.000Z",
        finishedAt: "2026-04-24T05:51:02.000Z",
        spec: {
          filePath: mboxPath,
          fileModifiedAt: downloadedAt.toISOString(),
        },
      }],
    })

    expect(visible).toEqual([])
  })

  it("re-surfaces ambient import readiness when the archive file becomes newer than the last success", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    const previousDownloadAt = new Date("2026-04-24T05:40:00.000Z")
    const newerDownloadAt = new Date("2026-04-24T06:00:00.000Z")
    fs.utimesSync(mboxPath, newerDownloadAt, newerDownloadAt)
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.parse("2026-04-24T06:01:00.000Z"),
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_done",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "succeeded",
        summary: "imported delegated mail archive",
        createdAt: "2026-04-24T05:39:00.000Z",
        updatedAt: "2026-04-24T05:51:02.000Z",
        finishedAt: "2026-04-24T05:51:02.000Z",
        spec: {
          filePath: mboxPath,
          fileModifiedAt: previousDownloadAt.toISOString(),
        },
      }],
    })

    expect(visible).toEqual([
      expect.objectContaining({
        kind: "mail.import-discovered",
        spec: expect.objectContaining({
          candidatePaths: [mboxPath],
        }),
      }),
    ])
  })

  it("still surfaces a candidate when a prior success has no comparable timestamp", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.parse("2026-04-24T06:01:00.000Z"),
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_done",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "succeeded",
        summary: "imported delegated mail archive",
        createdAt: "2026-04-24T05:39:00.000Z",
        updatedAt: "not-a-date",
        spec: {
          filePath: mboxPath,
          fileModifiedAt: "still-not-a-date",
        },
      }],
    })

    expect(visible).toEqual([
      expect.objectContaining({
        kind: "mail.import-discovered",
        spec: expect.objectContaining({
          candidatePaths: [mboxPath],
        }),
      }),
    ])
  })

  it("does not suppress ambient readiness for failed imports of the same archive", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      nowMs: Date.parse("2026-04-24T06:01:00.000Z"),
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_failed",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "failed",
        summary: "delegated mail import failed",
        createdAt: "2026-04-24T05:39:00.000Z",
        updatedAt: "2026-04-24T05:41:00.000Z",
        finishedAt: "2026-04-24T05:41:00.000Z",
        spec: {
          filePath: mboxPath,
          fileModifiedAt: "2026-04-24T05:40:00.000Z",
        },
      }],
    })

    expect(visible).toEqual([
      expect.objectContaining({
        kind: "mail.import-discovered",
        spec: expect.objectContaining({
          candidatePaths: [mboxPath],
        }),
      }),
    ])
  })

  it("ignores non-mail and malformed prior operations, but suppresses when the same archive is already queued", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      existingOperations: [
        {
          schemaVersion: 1,
          id: "op_not_mail",
          agentName: "slugger",
          kind: "mail.backfill-indexes",
          title: "mail backfill",
          status: "running",
          summary: "repairing indexes",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: mboxPath },
        },
        {
          schemaVersion: 1,
          id: "op_bad_spec",
          agentName: "slugger",
          kind: "mail.import-mbox",
          title: "mail import",
          status: "failed",
          summary: "bad spec",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: 123 },
        } as any,
        {
          schemaVersion: 1,
          id: "op_mail_import_queued",
          agentName: "slugger",
          kind: "mail.import-mbox",
          title: "mail import",
          status: "queued",
          summary: "queued delegated mail import",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: mboxPath },
        },
      ],
    })

    expect(visible).toEqual([])
  })

  it("ignores non-mail, mismatched-path, and failed same-path operations when deciding archive coverage", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    const otherPath = path.join(homeDir, "other-export.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      existingOperations: [
        {
          schemaVersion: 1,
          id: "op_not_mail",
          agentName: "slugger",
          kind: "mail.backfill-indexes",
          title: "mail backfill",
          status: "failed",
          summary: "repairing indexes",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: mboxPath },
        },
        {
          schemaVersion: 1,
          id: "op_other_path",
          agentName: "slugger",
          kind: "mail.import-mbox",
          title: "mail import",
          status: "succeeded",
          summary: "imported other delegated mail archive",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          finishedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: otherPath },
        },
        {
          schemaVersion: 1,
          id: "op_failed_same_path",
          agentName: "slugger",
          kind: "mail.import-mbox",
          title: "mail import",
          status: "failed",
          summary: "delegated mail import failed",
          createdAt: "2026-04-24T05:39:00.000Z",
          updatedAt: "2026-04-24T05:40:00.000Z",
          spec: { filePath: mboxPath },
        },
      ],
    })

    expect(visible).toEqual([
      expect.objectContaining({
        kind: "mail.import-discovered",
        spec: expect.objectContaining({
          candidatePaths: [mboxPath],
          newestCandidatePath: mboxPath,
        }),
      }),
    ])
  })

  it("falls back from invalid finishedAt to updatedAt when fileModifiedAt is absent", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(homeDir, "Projects", "_worktrees", "slugger-mail-fullmoon-mail", ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    const downloadedAt = new Date("2026-04-24T05:40:00.000Z")
    fs.utimesSync(mboxPath, downloadedAt, downloadedAt)
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      existingOperations: [{
        schemaVersion: 1,
        id: "op_mail_import_done",
        agentName: "slugger",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "succeeded",
        summary: "imported delegated mail archive",
        createdAt: "2026-04-24T05:39:00.000Z",
        updatedAt: "2026-04-24T05:51:02.000Z",
        finishedAt: "not-a-date",
        spec: { filePath: mboxPath },
      }],
    })

    expect(visible).toEqual([])
  })

  it("returns no discovered candidates when directory reads fail", () => {
    const root = tempDir()
    const dir = path.join(root, "not-a-directory")
    fs.writeFileSync(dir, "plain file", "utf-8")

    expect(listDiscoveredMboxCandidates(dir)).toEqual([])
  })

  it("falls back cleanly when workspace and worktree directory scans throw", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const workspacesRoot = path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces-file")
    fs.mkdirSync(path.dirname(workspacesRoot), { recursive: true })
    fs.writeFileSync(workspacesRoot, "not a directory", "utf-8")
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(workspacesRoot)
    const poolHome = path.join(homeDir, "Projects-file")
    fs.writeFileSync(poolHome, "still not a directory", "utf-8")

    expect(defaultMailImportDiscoveryDirs({
      agentName: "slugger",
      repoRoot,
      homeDir: poolHome,
    })).toEqual(expect.arrayContaining([
      path.join(repoRoot, ".playwright-mcp"),
      path.join(poolHome, ".playwright-mcp"),
      path.join(poolHome, "Downloads"),
    ]))
  })

  it("falls back when the identity module does not expose getAgentRepoWorkspacesRoot", async () => {
    vi.resetModules()
    vi.doMock("../../heart/identity", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../heart/identity")>()
      const { getAgentRepoWorkspacesRoot: _omitted, ...rest } = actual
      return rest
    })

    const imported = await import("../../heart/mail-import-discovery")
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")

    expect(imported.defaultMailImportDiscoveryDirs({
      agentName: "slugger",
      repoRoot,
      homeDir,
    })).toEqual(expect.arrayContaining([
      path.join(repoRoot, ".playwright-mcp"),
      path.join(homeDir, ".playwright-mcp"),
      path.join(homeDir, "Downloads"),
    ]))

    vi.resetModules()
  })

  it("supports default discovery inputs without agent hints", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    fs.mkdirSync(repoRoot, { recursive: true })
    const previousHome = process.env.HOME
    process.env.HOME = homeDir
    const previousCwd = process.cwd()
    try {
      process.chdir(repoRoot)
      const dirs = defaultMailImportDiscoveryDirs()
      expect(dirs).toEqual(expect.arrayContaining([
        path.join(path.resolve(process.cwd()), ".playwright-mcp"),
        path.join(path.resolve(homeDir), ".playwright-mcp"),
        path.join(path.resolve(homeDir), "Downloads"),
      ]))
    } finally {
      process.chdir(previousCwd)
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  it("renders singular and plural hidden-candidate counts when the visible limit is exceeded", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(repoRoot, ".playwright-mcp")
    fs.mkdirSync(sandboxDir, { recursive: true })
    for (const name of [
      "HEY-emails-ari-mendelow-me-1.mbox",
      "HEY-emails-ari-mendelow-me-2.mbox",
      "HEY-emails-ari-mendelow-me-3.mbox",
      "HEY-emails-ari-mendelow-me-4.mbox",
    ]) {
      fs.writeFileSync(path.join(sandboxDir, name), "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    }

    const singular = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      candidateLimit: 3,
      recentWindowMs: 365 * 24 * 60 * 60 * 1000,
    })[0]
    const plural = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      candidateLimit: 2,
      recentWindowMs: 365 * 24 * 60 * 60 * 1000,
    })[0]

    expect(singular?.detail).toContain("...and 1 more recent archive")
    expect(plural?.detail).toContain("...and 2 more recent archives")
  })

  it("allows zero visible ambient candidates and uses default nowMs and existingOperations", () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const sandboxDir = path.join(repoRoot, ".playwright-mcp")
    fs.mkdirSync(sandboxDir, { recursive: true })
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")

    const visible = listAmbientMailImportOperations({
      agentName: "slugger",
      repoRoot,
      homeDir,
      candidateLimit: 0,
      recentWindowMs: 365 * 24 * 60 * 60 * 1000,
    })

    expect(visible).toEqual([
      expect.objectContaining({
        summary: "0 recent MBOX archives ready for import",
        spec: expect.objectContaining({
          candidatePaths: [],
          newestCandidatePath: null,
          newestCandidateMtime: null,
        }),
      }),
    ])
  })

  it("sorts visible background operations newest-first across persisted and ambient items", async () => {
    const homeDir = tempDir()
    const repoRoot = path.join(homeDir, "repo")
    const agentRoot = path.join(homeDir, "AgentBundles", "slugger.ouro")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    const sandboxDir = path.join(repoRoot, ".playwright-mcp")
    const mboxPath = path.join(sandboxDir, "HEY-emails-ari-mendelow-me.mbox")
    fs.mkdirSync(operationsDir, { recursive: true })
    fs.mkdirSync(sandboxDir, { recursive: true })
    fs.writeFileSync(mboxPath, "From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n", "utf-8")
    fs.utimesSync(mboxPath, new Date("2026-04-24T06:00:00.000Z"), new Date("2026-04-24T06:00:00.000Z"))
    mockGetAgentRepoWorkspacesRoot.mockReturnValue(path.join(homeDir, "AgentBundles", "slugger.ouro", "state", "workspaces"))

    fs.writeFileSync(path.join(operationsDir, "older.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "older",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "succeeded",
      summary: "older background op",
      createdAt: "2026-04-24T05:00:00.000Z",
      updatedAt: "2026-04-24T05:00:00.000Z",
    }, null, 2)}\n`, "utf-8")
    fs.writeFileSync(path.join(operationsDir, "newer.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "newer",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "running",
      summary: "newer background op",
      createdAt: "2026-04-24T05:30:00.000Z",
      updatedAt: "2026-04-24T05:30:00.000Z",
    }, null, 2)}\n`, "utf-8")

    expect(listVisibleBackgroundOperations({
      agentName: "slugger",
      agentRoot,
      repoRoot,
      homeDir,
      nowMs: Date.parse("2026-04-24T06:01:00.000Z"),
    }).map((operation) => operation.id)).toEqual([
      "newer",
      "older",
    ])
  })
})
