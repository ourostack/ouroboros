import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.doUnmock("../../../heart/session-activity")
  vi.doUnmock("../../../arc/obligations")
  vi.doUnmock("../../../repertoire/tasks/scanner")
})

describe("continuity readers defensive fallbacks", () => {
  it("falls back to no sessions when session activity lookup throws", async () => {
    vi.doMock("../../../heart/session-activity", () => ({
      listSessionActivity: () => {
        throw new Error("boom")
      },
    }))

    const { readOrientationView } = await import("../../../heart/mailbox/readers/continuity-readers")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-throw-"))

    try {
      const orientation = readOrientationView(agentRoot, "ouroboros")
      expect(orientation.currentSession).toBeNull()
      expect(orientation.otherActiveSessions).toEqual([])
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("falls back to no obligations when orientation obligation loading throws", async () => {
    vi.doMock("../../../arc/obligations", async () => {
      const actual = await vi.importActual<typeof import("../../../arc/obligations")>("../../../arc/obligations")
      return {
        ...actual,
        readObligations: () => {
          throw new Error("boom")
        },
      }
    })

    const { readOrientationView } = await import("../../../heart/mailbox/readers/continuity-readers")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-oblig-throw-"))

    try {
      const orientation = readOrientationView(agentRoot, "ouroboros")
      expect(orientation.primaryObligation).toBeNull()
      expect(orientation.centerOfGravity).toBe("idle")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("falls back to an empty obligation detail view when obligation loading throws", async () => {
    vi.doMock("../../../arc/obligations", async () => {
      const actual = await vi.importActual<typeof import("../../../arc/obligations")>("../../../arc/obligations")
      return {
        ...actual,
        readObligations: () => {
          throw new Error("boom")
        },
      }
    })

    const { readObligationDetailView } = await import("../../../heart/mailbox/readers/continuity-readers")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-throw-"))

    try {
      const view = readObligationDetailView(agentRoot)
      expect(view).toEqual({
        openCount: 0,
        primaryId: null,
        primarySelectionReason: null,
        items: [],
      })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("falls back to empty current obligations when change detection cannot load obligations", async () => {
    vi.doMock("../../../arc/obligations", async () => {
      const actual = await vi.importActual<typeof import("../../../arc/obligations")>("../../../arc/obligations")
      return {
        ...actual,
        readObligations: () => {
          throw new Error("boom")
        },
      }
    })

    const { readChangesView } = await import("../../../heart/mailbox/readers/continuity-readers")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changes-oblig-throw-"))

    try {
      const view = readChangesView(agentRoot)
      expect(view).toEqual({
        changeCount: 0,
        items: [],
        snapshotAge: null,
        formatted: "",
      })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("falls back to an inactive self-fix view when task scanning throws", async () => {
    vi.doMock("../../../repertoire/tasks/scanner", async () => {
      const actual = await vi.importActual<typeof import("../../../repertoire/tasks/scanner")>("../../../repertoire/tasks/scanner")
      return {
        ...actual,
        scanTasks: () => {
          throw new Error("boom")
        },
      }
    })

    const { readSelfFixView } = await import("../../../heart/mailbox/readers/continuity-readers")
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-throw-"))

    try {
      const view = readSelfFixView(agentRoot)
      expect(view).toEqual({ active: false, currentStep: null, steps: [] })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
