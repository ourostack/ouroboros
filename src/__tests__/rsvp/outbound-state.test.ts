import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  acquireHabitLifecycleLock,
  buildHabitEvidenceIdentity,
  buildHabitSendOperation,
  createHabitLifecycleJournal,
  getHabitLifecyclePaths,
  readHabitLifecycleJournal,
  releaseHabitLifecycleLock,
  renderHabitCancellationAcknowledgement,
  transitionHabitLifecycleJournal,
  writeHabitLifecycleJournal,
  type HabitLifecycleDeps,
  type HabitLifecycleLease,
} from "../../heart/habits/habit-lifecycle"
import { buildRsvpSnapshot, type RsvpSnapshot } from "../../rsvp/snapshot"

const emitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => emitNervesEvent(...args),
}))

function snapshot(label: string, guests: Record<string, { first_name?: string; last_name?: string; group_id?: string | number | null; attending_status?: string | null }>): RsvpSnapshot {
  return buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: `2026-07-09T${label}:00.000Z`,
    source: { kind: "aisleplanner", weddingId: "wedding-1", eventId: "event-1", adapter: "aisleplanner-api-v1" },
    guests,
    allGuests: guests,
    provenance: { kind: "live-fetch", fetchedBy: "slugger" },
  })
}

describe("RSVP outbound baseline state", () => {
  let agentRoot: string
  let previous: RsvpSnapshot
  let current: RsvpSnapshot

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-outbound-state-"))
    emitNervesEvent.mockReset()
    previous = snapshot("16:00", {
      "guest-1": { first_name: "Ari", last_name: "Mendelow", attending_status: "attending" },
      "guest-2": { first_name: "Debra", last_name: "Edelson", attending_status: null },
    })
    current = snapshot("17:00", {
      "guest-1": { first_name: "Ari", last_name: "Mendelow", attending_status: "attending" },
      "guest-2": { first_name: "Debra", last_name: "Edelson", attending_status: "declined" },
    })
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("does not advance the RSVP baseline when the BlueBubbles outbound attempt fails", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const decision = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-1",
        status: "failed",
        tempGuid: "temp-1",
        messageGuid: undefined,
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.baseline?.snapshotId).toBe(previous.snapshotId)
    expect(state.pendingReports).toHaveLength(1)
    expect(state.pendingReports[0]).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-1",
      status: "failed",
    })
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      now: "2026-07-09T17:01:00.000Z",
    })).toMatchObject({ action: "send", currentSnapshotId: current.snapshotId })
  })

  it("recovers from malformed persisted RSVP outbound state as an empty state", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
    } = await import("../../rsvp/outbound-state")

    const statePath = path.join(agentRoot, "state", "rsvp", "outbound-state.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{not-json", "utf-8")

    expect(readRsvpOutboundState(agentRoot)).toMatchObject({ pendingReports: [] })
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding",
    })).toMatchObject({ action: "send", currentSnapshotId: current.snapshotId })

    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      policyVersion: "wrong-policy",
      updatedAt: "2026-07-09T17:00:00.000Z",
      pendingReports: [],
    }), "utf-8")
    expect(readRsvpOutboundState(agentRoot)).toMatchObject({ pendingReports: [] })
  })

  it("does not overwrite an existing RSVP outbound state during cold-start initialization", async () => {
    const {
      ensureRsvpOutboundState,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })

    const state = ensureRsvpOutboundState(agentRoot, "2026-07-09T17:00:00.000Z")

    expect(state.baseline).toMatchObject({
      snapshotId: previous.snapshotId,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
  })

  it("advances the baseline only after an accepted-or-better outbound proof", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const decision = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-2",
        status: "accepted",
        tempGuid: "temp-2",
        messageGuid: "sent-guid-2",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.baseline).toMatchObject({
      snapshotId: current.snapshotId,
      contentHash: current.contentHash,
      bluebubblesRecordId: "bb-out-2",
      advancedBy: "accepted",
    })
    expect(state.pendingReports).toEqual([])
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      now: "2026-07-09T17:01:00.000Z",
    })).toMatchObject({ action: "skip", reason: "baseline-current" })
  })

  it("advances the baseline for a local-visible-only outbound proof", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding\n\nNew RSVPs:\n- Debra Edelson -- declined",
      bluebubblesRecord: {
        recordId: "bb-out-local-visible",
        status: "local-visible",
        tempGuid: "temp-local-visible",
        messageGuid: "local-guid-visible",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    expect(readRsvpOutboundState(agentRoot).baseline).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-local-visible",
      advancedBy: "local-visible",
    })
  })

  it("clears an older pending report once a later local-visible proof arrives", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
    } = await import("../../rsvp/outbound-state")
    const reportText = "RSVP Update -- Wedding\n\nNew RSVPs:\n- Debra Edelson -- declined"

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText,
      bluebubblesRecord: {
        recordId: "bb-out-failed-first",
        status: "failed",
        tempGuid: "temp-failed-first",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText,
      bluebubblesRecord: {
        recordId: "bb-out-visible-after-failure",
        status: "local-visible",
        tempGuid: "temp-visible-after-failure",
        messageGuid: "local-guid-after-failure",
      },
      recordedAt: "2026-07-09T17:01:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.pendingReports).toEqual([])
    expect(state.baseline).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-visible-after-failure",
      advancedBy: "local-visible",
    })
  })

  it("records a pending report without a baseline when no prior baseline is available", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
    } = await import("../../rsvp/outbound-state")

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding",
      bluebubblesRecord: {
        recordId: "bb-out-no-baseline",
        status: "reserved",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state).not.toHaveProperty("baseline")
    expect(state.pendingReports).toEqual([
      expect.objectContaining({ bluebubblesRecordId: "bb-out-no-baseline" }),
    ])
  })

  it("removes a pending report for the snapshot that becomes the written baseline", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding",
      bluebubblesRecord: {
        recordId: "bb-out-pending-before-baseline",
        status: "failed",
        tempGuid: "temp-pending-before-baseline",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    writeRsvpBaseline({
      agentRoot,
      snapshot: current,
      recordedAt: "2026-07-09T17:01:00.000Z",
      reason: "manual-baseline-repair",
    })

    expect(readRsvpOutboundState(agentRoot).pendingReports).toEqual([])
  })

  it("keeps an existing pending report idempotent across habit crash recovery", async () => {
    const {
      decideRsvpOutboundReport,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const first = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Wedding\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: first.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-3",
        status: "reserved",
        tempGuid: "temp-3",
        messageGuid: undefined,
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    const recovered = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: first.reportText,
      now: "2026-07-09T17:05:00.000Z",
    })

    expect(first).toMatchObject({ action: "send", idempotencyKey: recovered.idempotencyKey })
    expect(recovered).toMatchObject({
      action: "send",
      existingPending: expect.objectContaining({
        snapshotId: current.snapshotId,
        bluebubblesRecordId: "bb-out-3",
        status: "reserved",
      }),
    })
  })
})

const BOUNDARY_NOW = "2026-07-31T21:00:00.000Z"

function boundaryDeps(overrides: HabitLifecycleDeps = {}): HabitLifecycleDeps {
  return {
    now: () => new Date(BOUNDARY_NOW),
    pid: () => 4242,
    bootIdentity: () => "boot-rsvp-boundary",
    processStartedAt: () => "process-rsvp-boundary",
    processLiveness: () => "alive",
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    sleep: async () => undefined,
    ...overrides,
  }
}

function writeBoundaryHabit(agentRoot: string, status: "active" | "paused" | "cancelled" = "active"): void {
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(
    path.join(habitsDir, "rsvp-boundary.md"),
    `---\nstatus: ${status}\ncadence: 1h\n---\n\nBoundary test.\n`,
    "utf8",
  )
}

async function boundaryModule(): Promise<Record<string, any>> {
  return await import("../../rsvp/outbound-state") as Record<string, any>
}

async function executeBoundary(input: Record<string, unknown>, deps = boundaryDeps()): Promise<Record<string, any>> {
  const module = await boundaryModule()
  expect(typeof module.executeRsvpSendBoundary).toBe("function")
  return module.executeRsvpSendBoundary(input, { lifecycle: deps })
}

async function seedPendingCancellation(agentRoot: string, deps = boundaryDeps()): Promise<void> {
  const captureId = "a".repeat(64)
  const evidenceKeyHash = buildHabitEvidenceIdentity({
    habitId: "rsvp-boundary",
    kind: "capture",
    id: captureId,
  }).evidenceKeyHash
  const operationId = `cancel:${evidenceKeyHash}`
  const requestText = "Please end this report."
  const lock = await acquireHabitLifecycleLock({
    agentRoot,
    habitId: "rsvp-boundary",
    operationId,
  }, deps)
  expect(lock.status).toBe("acquired")
  if (lock.status !== "acquired") return
  try {
    let journal = createHabitLifecycleJournal({
      habitId: "rsvp-boundary",
      operationId,
      operationKind: "cancel",
      updatedAt: BOUNDARY_NOW,
    })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
    journal = transitionHabitLifecycleJournal(journal, {
      state: "cancellation_intent",
      at: BOUNDARY_NOW,
      evidenceKeyHash,
      cancellationPreparation: {
        receipt: {
          schemaVersion: 1,
          habitId: "rsvp-boundary",
          operationId,
          evidenceKeyHash,
          evidenceLocator: { kind: "capture", id: captureId },
          actor: { displayName: "Casey", provider: "bluebubbles", externalId: "synthetic-casey" },
          request: {
            text: requestText,
            sha256: createHash("sha256").update(requestText, "utf8").digest("hex"),
            observedAt: BOUNDARY_NOW,
          },
          transition: {
            fromStatus: "active",
            toStatus: "cancelled",
            cancelledAt: BOUNDARY_NOW,
            boundaryState: "not_crossed",
          },
          acknowledgement: renderHabitCancellationAcknowledgement("rsvp-boundary", "Casey", "not_crossed"),
          createdAt: BOUNDARY_NOW,
        },
        definitionBeforeSha256: "c".repeat(64),
        definitionCancelledSha256: "d".repeat(64),
      },
    })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
  } finally {
    expect(releaseHabitLifecycleLock(lock.lease, deps)).toBe(true)
  }
}

function failBoundaryJournalWrite(state: string, afterRename: boolean): typeof fs {
  let failNextDirectorySync = false
  let failed = false
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "renameSync") {
        return (from: fs.PathLike, to: fs.PathLike): void => {
          const raw = fs.readFileSync(from, "utf8")
          const matches = (JSON.parse(raw) as { state?: unknown }).state === state
          if (matches && !afterRename && !failed) {
            failed = true
            throw new Error(`synthetic ${state} rename failure`)
          }
          fs.renameSync(from, to)
          if (matches && afterRename && !failed) failNextDirectorySync = true
        }
      }
      if (property === "fsyncSync") {
        return (descriptor: number): void => {
          if (failNextDirectorySync && !failed) {
            failed = true
            failNextDirectorySync = false
            throw new Error(`synthetic ${state} directory fsync failure`)
          }
          fs.fsyncSync(descriptor)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as typeof fs
}

describe("RSVP locked send boundary", () => {
  it.each([
    ["validation before fetch", { transportInvoked: false, httpStatus: null, messageGuid: null, errorCode: "validation" }, "not_crossed"],
    ["200 with guid", { transportInvoked: true, httpStatus: 200, messageGuid: "message-guid", errorCode: null }, "crossed"],
    ["299 with guid", { transportInvoked: true, httpStatus: 299, messageGuid: "message-guid", errorCode: null }, "crossed"],
    ["200 without guid", { transportInvoked: true, httpStatus: 200, messageGuid: null, errorCode: "missing_message_guid" }, "crossing_unknown"],
    ["200 malformed payload", { transportInvoked: true, httpStatus: 200, messageGuid: null, errorCode: "malformed_response" }, "crossing_unknown"],
    ["300", { transportInvoked: true, httpStatus: 300, messageGuid: null, errorCode: "http_300" }, "crossing_unknown"],
    ["399", { transportInvoked: true, httpStatus: 399, messageGuid: null, errorCode: "http_399" }, "crossing_unknown"],
    ["400", { transportInvoked: true, httpStatus: 400, messageGuid: null, errorCode: "http_400" }, "not_crossed"],
    ["407", { transportInvoked: true, httpStatus: 407, messageGuid: null, errorCode: "http_407" }, "not_crossed"],
    ["408", { transportInvoked: true, httpStatus: 408, messageGuid: null, errorCode: "http_408" }, "crossing_unknown"],
    ["409", { transportInvoked: true, httpStatus: 409, messageGuid: null, errorCode: "http_409" }, "crossing_unknown"],
    ["425", { transportInvoked: true, httpStatus: 425, messageGuid: null, errorCode: "http_425" }, "crossing_unknown"],
    ["429", { transportInvoked: true, httpStatus: 429, messageGuid: null, errorCode: "http_429" }, "crossing_unknown"],
    ["499", { transportInvoked: true, httpStatus: 499, messageGuid: null, errorCode: "http_499" }, "not_crossed"],
    ["500", { transportInvoked: true, httpStatus: 500, messageGuid: null, errorCode: "http_500" }, "crossing_unknown"],
    ["timeout", { transportInvoked: true, httpStatus: null, messageGuid: null, errorCode: "timeout" }, "crossing_unknown"],
    ["abort", { transportInvoked: true, httpStatus: null, messageGuid: null, errorCode: "abort" }, "crossing_unknown"],
    ["socket throw", { transportInvoked: true, httpStatus: null, messageGuid: null, errorCode: "socket" }, "crossing_unknown"],
  ] as const)("classifies %s exactly", async (_label, observation, expected) => {
    const module = await boundaryModule()
    expect(typeof module.classifyRsvpSendBoundary).toBe("function")
    expect(module.classifyRsvpSendBoundary(observation)).toBe(expected)
  })

  it("writes durable intent before transport and classifies an accepted GUID as crossed", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-crossed-"))
    writeBoundaryHabit(agentRoot)
    const operation = buildHabitSendOperation({
      habitId: "rsvp-boundary",
      outboundIdempotencyKey: "outbound-crossed",
    })
    try {
      const invokeTransport = vi.fn(async (markTransportInvoked: () => void) => {
        expect(readHabitLifecycleJournal({
          agentRoot,
          habitId: "rsvp-boundary",
          operationId: operation.operationId,
        })?.state).toBe("send_intent")
        markTransportInvoked()
        return { messageGuid: "message-guid" }
      })
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-crossed",
        noSend: false,
        invokeTransport,
      })

      expect(result).toMatchObject({
        ok: true,
        operationId: operation.operationId,
        boundaryState: "crossed",
        transportInvoked: true,
        replayed: false,
        transportResult: { httpStatus: 200, messageGuid: "message-guid", errorCode: null },
      })
      expect(invokeTransport).toHaveBeenCalledTimes(1)
      expect(readHabitLifecycleJournal({
        agentRoot,
        habitId: "rsvp-boundary",
        operationId: operation.operationId,
      })).toMatchObject({ state: "crossed", generation: 2, boundaryState: "crossed" })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("never creates send intent or invokes transport under immutable no-send", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-no-send-"))
    writeBoundaryHabit(agentRoot)
    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-no-send",
        noSend: true,
        invokeTransport,
      })
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: "immutable_no_send",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
      const journalDirectory = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-boundary" }).journalDirectory
      expect(fs.existsSync(journalDirectory) ? fs.readdirSync(journalDirectory) : []).toEqual([])
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("fences an active definition when a durable cancellation intent already exists", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-cancel-pending-"))
    writeBoundaryHabit(agentRoot)
    const deps = boundaryDeps()
    const invokeTransport = vi.fn()
    try {
      await seedPendingCancellation(agentRoot, deps)
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-after-cancel-intent",
        noSend: false,
        invokeTransport,
      }, deps)
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: "cancellation_pending",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it.each(["paused", "cancelled"] as const)("revalidates current %s definition after lock acquisition", async (status) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rsvp-send-boundary-${status}-`))
    writeBoundaryHabit(agentRoot, status)
    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: `outbound-${status}`,
        noSend: false,
        invokeTransport,
      })
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: `habit_status_${status}`,
      })
      expect(invokeTransport).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("replays a terminal journal without invoking transport twice", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-duplicate-"))
    writeBoundaryHabit(agentRoot)
    try {
      const firstInvoke = vi.fn(async (markTransportInvoked: () => void) => {
        markTransportInvoked()
        return { messageGuid: "message-guid" }
      })
      const first = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-duplicate",
        noSend: false,
        invokeTransport: firstInvoke,
      })
      const duplicateInvoke = vi.fn()
      const duplicate = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-duplicate",
        noSend: false,
        invokeTransport: duplicateInvoke,
      })

      expect(first).toMatchObject({ boundaryState: "crossed", replayed: false })
      expect(duplicate).toMatchObject({ boundaryState: "crossed", replayed: true })
      expect(firstInvoke).toHaveBeenCalledTimes(1)
      expect(duplicateInvoke).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("recovers a dead owner after durable send intent as crossing unknown without retry", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-recovery-"))
    writeBoundaryHabit(agentRoot)
    const deps = boundaryDeps()
    const operation = buildHabitSendOperation({
      habitId: "rsvp-boundary",
      outboundIdempotencyKey: "outbound-recovery",
    })
    const lock = await acquireHabitLifecycleLock({
      agentRoot,
      habitId: "rsvp-boundary",
      operationId: operation.operationId,
    }, deps)
    expect(lock.status).toBe("acquired")
    if (lock.status !== "acquired") return
    let journal = createHabitLifecycleJournal({
      habitId: "rsvp-boundary",
      operationId: operation.operationId,
      operationKind: "send",
      updatedAt: BOUNDARY_NOW,
    })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
    journal = transitionHabitLifecycleJournal(journal, { state: "send_intent", at: BOUNDARY_NOW })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
    expect(releaseHabitLifecycleLock(lock.lease, deps)).toBe(true)

    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-recovery",
        noSend: false,
        invokeTransport,
      }, deps)
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "crossing_unknown",
        transportInvoked: true,
        replayed: true,
        errorCode: "recovered_unclassified_send_intent",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
      expect(readHabitLifecycleJournal({
        agentRoot,
        habitId: "rsvp-boundary",
        operationId: operation.operationId,
      })).toMatchObject({ state: "crossing_unknown", generation: 2 })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("times out behind a live cancellation owner without invoking transport", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-lock-timeout-"))
    writeBoundaryHabit(agentRoot)
    let tick = Date.parse(BOUNDARY_NOW)
    const deps = boundaryDeps({ now: () => new Date((tick += 6_000)) })
    const held = await acquireHabitLifecycleLock({
      agentRoot,
      habitId: "rsvp-boundary",
      operationId: `cancel:${"e".repeat(64)}`,
    }, deps)
    expect(held.status).toBe("acquired")
    if (held.status !== "acquired") return
    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-lock-timeout",
        noSend: false,
        invokeTransport,
      }, deps)
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: "lifecycle_lock_timeout",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
    } finally {
      expect(releaseHabitLifecycleLock(held.lease, deps)).toBe(true)
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("revalidates a generation change after a cancellation owner releases the lock", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-generation-change-"))
    writeBoundaryHabit(agentRoot)
    let tick = Date.parse(BOUNDARY_NOW)
    let heldLease!: HabitLifecycleLease
    let released = false
    const deps = boundaryDeps({
      now: () => new Date((tick += 50)),
      sleep: async () => {
        if (released) return
        released = true
        writeBoundaryHabit(agentRoot, "cancelled")
        expect(releaseHabitLifecycleLock(heldLease, deps)).toBe(true)
      },
    })
    const held = await acquireHabitLifecycleLock({
      agentRoot,
      habitId: "rsvp-boundary",
      operationId: `cancel:${"f".repeat(64)}`,
    }, deps)
    expect(held.status).toBe("acquired")
    if (held.status !== "acquired") return
    heldLease = held.lease
    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-generation-change",
        noSend: false,
        invokeTransport,
      }, deps)
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: "habit_status_cancelled",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
      expect(released).toBe(true)
    } finally {
      if (!released) releaseHabitLifecycleLock(held.lease, deps)
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("records not-crossed truth when durable send-intent publication fails before transport", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-intent-failure-"))
    writeBoundaryHabit(agentRoot)
    const invokeTransport = vi.fn()
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-intent-failure",
        noSend: false,
        invokeTransport,
      }, boundaryDeps({ fs: failBoundaryJournalWrite("send_intent", false) }))
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "not_crossed",
        transportInvoked: false,
        errorCode: "lifecycle_write_failed",
      })
      expect(invokeTransport).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("downgrades an invoked classification durability failure to crossing unknown", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-send-boundary-classification-failure-"))
    writeBoundaryHabit(agentRoot)
    const invokeTransport = vi.fn(async (markTransportInvoked: () => void) => {
      markTransportInvoked()
      return { messageGuid: "message-guid" }
    })
    const operation = buildHabitSendOperation({
      habitId: "rsvp-boundary",
      outboundIdempotencyKey: "outbound-classification-failure",
    })
    try {
      const result = await executeBoundary({
        agentRoot,
        habitId: "rsvp-boundary",
        outboundIdempotencyKey: "outbound-classification-failure",
        noSend: false,
        invokeTransport,
      }, boundaryDeps({ fs: failBoundaryJournalWrite("crossed", true) }))
      expect(result).toMatchObject({
        ok: false,
        boundaryState: "crossing_unknown",
        transportInvoked: true,
        errorCode: "classification_durability_unknown",
      })
      expect(invokeTransport).toHaveBeenCalledTimes(1)
      expect(readHabitLifecycleJournal({
        agentRoot,
        habitId: "rsvp-boundary",
        operationId: operation.operationId,
      }, { fs })).toMatchObject({ state: "crossing_unknown", generation: 2 })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
