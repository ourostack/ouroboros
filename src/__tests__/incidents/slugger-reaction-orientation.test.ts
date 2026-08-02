import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { expect, it, vi } from "vitest"

import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import { cancelHabit, renderHabitCancellationAcknowledgement } from "../../heart/habits/habit-cancel"
import { HabitScheduler } from "../../heart/habits/habit-scheduler"
import { parseHabitFile, renderHabitFile } from "../../heart/habits/habit-parser"
import {
  buildOrientationFrame,
  labelPriorWorkSurface,
  renderOrientationFrame,
} from "../../heart/orientation-frame"
import { SettleStreamer } from "../../heart/streaming"
import { executeRsvpSendBoundary } from "../../rsvp/outbound-state"
import { selectCheckpointCurrentAsk } from "../../senses/pipeline"
import {
  __resetBlueBubblesInFlightForTests,
  handleBlueBubblesEvent,
} from "../../senses/bluebubbles"
import { snapshotBlueBubblesActiveTurns } from "../../senses/bluebubbles/active-turns"
import { normalizeBlueBubblesEvent } from "../../senses/bluebubbles/model"
import {
  buildBlueBubblesSemanticCapture,
  buildBlueBubblesSemanticIdentity,
  getBlueBubblesSemanticPaths,
  initializeBlueBubblesSemanticCutover,
  readBlueBubblesSemanticHandled,
  writeBlueBubblesSemanticCapture,
} from "../../senses/bluebubbles/semantic-receipts"

const incidentRuntime = vi.hoisted(() => ({ agentRoot: "" }))

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: () => "synthetic-incident-agent",
    getAgentRoot: () => incidentRuntime.agentRoot,
  }
})

interface IncidentFixture {
  schemaVersion: number
  actor: { displayName: string; handle: string }
  participant: { displayName: string; handle: string }
  chat: { guid: string; identifier: string; displayName: string }
  rsvpTarget: {
    habitId: string
    reportTitle: string
    messageGuid: string
    messageText: string
  }
  staleCheckpoint: string
  cancellation: {
    capturedAt: string
    cancelledAt: string
    payload: unknown
  }
  reactionDeliveries: unknown[]
  stream: {
    argumentChunks: string[]
    completedArguments: string
    expectedAnswer: string
  }
}

function readFixture(): IncidentFixture {
  const fixturePath = path.join(
    process.cwd(),
    "src",
    "__tests__",
    "fixtures",
    "incidents",
    "slugger-reaction-orientation.json",
  )
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as IncidentFixture
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

it("replays the minimized reaction/orientation incident without duplicate work or invented roles", async () => {
  const fixture = readFixture()
  const fixtureText = JSON.stringify(fixture)
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slugger-orientation-incident-"))
  incidentRuntime.agentRoot = agentRoot
  __resetBlueBubblesInFlightForTests()

  const nerves: LogEvent[] = []
  const unregister = registerGlobalLogSink((entry) => nerves.push(entry))
  try {
    expect.soft(fixture.schemaVersion, "fixture schema").toBe(1)
    expect.soft(fixtureText, "fixture contains only synthetic GUIDs").not.toMatch(
      /(?:^|[^A-Z])(?!(?:SYNTHETIC-))[A-F0-9]{8}-[A-F0-9-]{27,}/,
    )
    expect.soft(fixture.actor.handle.endsWith(".test"), "synthetic actor handle").toBe(true)
    expect.soft(fixture.participant.handle.endsWith(".test"), "synthetic participant handle").toBe(true)
    expect.soft(fixtureText, "fixture has no local absolute paths").not.toContain("/Users/")

    const habitPath = path.join(agentRoot, "habits", `${fixture.rsvpTarget.habitId}.md`)
    fs.mkdirSync(path.dirname(habitPath), { recursive: true })
    fs.writeFileSync(habitPath, renderHabitFile({
      title: fixture.rsvpTarget.reportTitle,
      cadence: "24h",
      status: "active",
      created: "2026-06-01T00:00:00.000Z",
    }, "Produce the synthetic RSVP report only while this habit is active."), "utf8")

    const cutover = initializeBlueBubblesSemanticCutover("synthetic-incident-agent", {
      now: () => new Date("2026-07-01T11:59:00.000Z"),
      randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    })
    const normalizedRequest = normalizeBlueBubblesEvent(fixture.cancellation.payload)
    expect.soft(normalizedRequest.kind, "request normalization").toBe("message")
    if (normalizedRequest.kind !== "message") throw new Error("synthetic cancellation did not normalize as a message")

    const requestCapture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: fixture.cancellation.capturedAt,
      event: normalizedRequest,
      targetAuthorship: null,
    })
    expect.soft(requestCapture, "request semantic capture").not.toBeNull()
    if (!requestCapture) throw new Error("synthetic cancellation capture was invalid")
    expect.soft(
      writeBlueBubblesSemanticCapture("synthetic-incident-agent", requestCapture),
      "capture persisted before cancellation",
    ).toBe("semantic_capture_published")

    const orientation = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [{ role: "user", content: normalizedRequest.textForAgent }],
      currentUserMessages: [{ role: "user", content: normalizedRequest.textForAgent }],
      source: {
        kind: "bluebubbles",
        authority: "presentation_only",
        conversationKind: "group",
        event: {
          provider: "bluebubbles",
          kind: "message",
          sourceEventType: normalizedRequest.eventType,
          fromMe: normalizedRequest.fromMe,
        },
        actor: {
          role: "observed_actor",
          provider: normalizedRequest.sender.provider,
          externalId: normalizedRequest.sender.externalId,
          displayName: fixture.actor.displayName,
        },
        participants: requestCapture.event.participants
          .filter((participant) => participant.externalId !== normalizedRequest.sender.externalId)
          .map((participant) => ({
            role: "group_participant_only" as const,
            provider: participant.provider,
            externalId: participant.externalId,
            displayName: fixture.participant.displayName,
          })),
      },
    })
    const renderedOrientation = renderOrientationFrame(orientation)
    const checkpointAsk = selectCheckpointCurrentAsk({
      currentUserMessage: normalizedRequest.textForAgent,
      orientationFrame: orientation,
    })
    const staleSurface = labelPriorWorkSurface(fixture.staleCheckpoint, false)

    expect.soft(checkpointAsk, "current request wins checkpoint selection").toBe(normalizedRequest.textForAgent)
    expect.soft(checkpointAsk, "stale checkpoint is not the current request").not.toBe(fixture.staleCheckpoint)
    expect.soft(staleSurface, "stale work is non-authoritative").toContain("Background only; do not execute.")
    expect.soft(orientation.source?.actor?.externalId, "observed actor is requester").toBe(fixture.actor.handle)
    expect.soft(orientation.source?.participants, "participant remains membership-only").toEqual([{
      role: "group_participant_only",
      provider: "imessage-handle",
      externalId: fixture.participant.handle,
      displayName: fixture.participant.displayName,
    }])
    expect.soft(renderedOrientation, "orientation does not attribute participant speech").not.toContain(
      `${fixture.participant.displayName} spoke`,
    )
    expect.soft(renderedOrientation, "orientation does not attribute participant reading").not.toContain(
      `${fixture.participant.displayName} read`,
    )
    expect.soft(renderedOrientation, "orientation does not attribute participant request").not.toContain(
      `${fixture.participant.displayName} requested`,
    )

    const receipt = await cancelHabit({
      agentRoot,
      habitId: fixture.rsvpTarget.habitId,
      evidenceLocator: `capture:${requestCapture.keyHash}`,
      authority: {
        kind: "current_ingress",
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash: requestCapture.keyHash,
        },
      },
    }, {
      now: () => new Date(fixture.cancellation.cancelledAt),
      pid: () => process.pid,
      bootIdentity: () => "synthetic-boot",
      processStartedAt: () => "synthetic-process-start",
      processLiveness: () => "alive",
    })
    const expectedAcknowledgement = renderHabitCancellationAcknowledgement(
      fixture.rsvpTarget.habitId,
      fixture.actor.handle,
      "not_crossed",
    )
    const cancelledDefinition = fs.readFileSync(habitPath, "utf8")
    const parsedHabit = parseHabitFile(cancelledDefinition, habitPath)

    expect.soft(receipt.actor, "receipt is grounded in the observed actor").toEqual({
      displayName: fixture.actor.handle,
      provider: "imessage-handle",
      externalId: fixture.actor.handle,
    })
    expect.soft(receipt.request.text, "receipt preserves the exact request").toBe(normalizedRequest.text)
    expect.soft(receipt.request.sha256, "receipt preserves the exact request hash").toBe(sha256(normalizedRequest.text))
    expect.soft(receipt.transition, "one grounded cancellation reaches cancelled without a crossed send").toMatchObject({
      fromStatus: "active",
      toStatus: "cancelled",
      cancelledAt: fixture.cancellation.cancelledAt,
      boundaryState: "not_crossed",
    })
    expect.soft(receipt.acknowledgement, "acknowledgement is deterministic").toBe(expectedAcknowledgement)
    expect.soft(receipt.acknowledgement, "acknowledgement names only the requester").not.toContain(
      fixture.participant.displayName,
    )
    expect.soft(receipt.acknowledgement, "acknowledgement omits the participant handle").not.toContain(
      fixture.participant.handle,
    )
    expect.soft(parsedHabit.status, "cancelled lifecycle state parses exactly").toBe("cancelled")
    expect.soft(
      nerves.filter((entry) => entry.event === "habit_cancel_end"),
      "exactly one grounded cancellation completes",
    ).toHaveLength(1)
    expect.soft(
      nerves.filter((entry) => entry.event === "habit_cancel_error"),
      "grounded cancellation has no error path",
    ).toHaveLength(0)

    const scheduler = new HabitScheduler({
      agent: "synthetic-incident-agent",
      habitsDir: path.dirname(habitPath),
      osCronManager: {
        sync: vi.fn(),
        removeAll: vi.fn(),
        list: vi.fn(() => []),
      },
      onHabitFire: vi.fn(),
      deps: {
        readdir: (directory) => fs.readdirSync(directory),
        readFile: (filePath, encoding) => fs.readFileSync(filePath, encoding as BufferEncoding),
        writeFile: (filePath, content, encoding) => fs.writeFileSync(filePath, content, encoding as BufferEncoding),
        existsSync: fs.existsSync,
        now: () => Date.parse(fixture.cancellation.cancelledAt),
        ouroPath: "/synthetic/bin/ouro",
      },
    })
    expect.soft(scheduler.listJobs(), "cancelled habit has no scheduled job").toEqual([])

    const invokeTransport = vi.fn()
    const fencedSend = await executeRsvpSendBoundary({
      agentRoot,
      habitId: fixture.rsvpTarget.habitId,
      outboundIdempotencyKey: "synthetic-post-cancel-attempt",
      noSend: false,
      invokeTransport,
    }, {
      lifecycle: {
        now: () => new Date("2026-07-01T12:06:00.000Z"),
        pid: () => process.pid,
        bootIdentity: () => "synthetic-boot",
        processStartedAt: () => "synthetic-process-start",
        processLiveness: () => "alive",
      },
    })
    expect.soft(fencedSend, "post-cancellation send is fenced before transport").toMatchObject({
      ok: false,
      boundaryState: "not_crossed",
      transportInvoked: false,
      errorCode: "habit_status_cancelled",
    })
    expect.soft(invokeTransport, "transport is never called after cancellation").not.toHaveBeenCalled()

    const runAgent = vi.fn()
    const loadSession = vi.fn()
    const sessionPath = vi.fn()
    const deferPostTurnPersist = vi.fn()
    const repairEvent = vi.fn(async (event: unknown) => event)
    const sendText = vi.fn()
    const setTyping = vi.fn()
    const markChatRead = vi.fn()
    const getMessageDetails = vi.fn(async () => ({
      text: fixture.rsvpTarget.messageText,
      fromMe: false,
    }))
    const client = {
      getMessageDetails,
      getMessageText: vi.fn(async () => fixture.rsvpTarget.messageText),
      repairEvent,
      sendText,
      setTyping,
      markChatRead,
    }
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
    let reactionResults: Awaited<ReturnType<typeof handleBlueBubblesEvent>>[]
    try {
      reactionResults = []
      for (const payload of fixture.reactionDeliveries) {
        reactionResults.push(await handleBlueBubblesEvent(payload, {
          getAgentName: () => "synthetic-incident-agent",
          createClient: () => client as never,
          recordMutation: vi.fn(),
          runAgent,
          loadSession,
          sessionPath,
          deferPostTurnPersist,
        }))
      }
      expect.soft(timeoutSpy, "capture-only reaction creates no watchdog timer").not.toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
    }

    const normalizedReaction = normalizeBlueBubblesEvent(fixture.reactionDeliveries[0])
    expect.soft(normalizedReaction.kind, "reaction normalization").toBe("mutation")
    if (
      normalizedReaction.kind !== "mutation"
      || normalizedReaction.mutationType !== "reaction"
      || !normalizedReaction.reaction
    ) throw new Error("synthetic reaction did not normalize as a reaction")
    const reactionIdentity = buildBlueBubblesSemanticIdentity({
      providerNamespace: cutover.providerNamespace,
      kind: "reaction",
      eventGuid: normalizedReaction.messageGuid,
      targetGuid: normalizedReaction.targetMessageGuid,
      actorExternalId: normalizedReaction.sender.externalId,
      canonicalValue: normalizedReaction.reaction.canonicalValue,
      canonicalAction: normalizedReaction.reaction.action,
      effectiveTimestamp: normalizedReaction.effectiveTimestamp,
    })
    const handled = readBlueBubblesSemanticHandled(
      "synthetic-incident-agent",
      reactionIdentity!.keyHash,
    )
    const semanticPaths = getBlueBubblesSemanticPaths("synthetic-incident-agent")
    const handledFiles = fs.readdirSync(semanticPaths.handled).filter((name) => name.endsWith(".json"))

    expect.soft(new Set(fixture.reactionDeliveries.map((payload) => {
      const event = normalizeBlueBubblesEvent(payload)
      if (event.kind !== "mutation" || !event.reaction) return "invalid"
      return buildBlueBubblesSemanticIdentity({
        providerNamespace: cutover.providerNamespace,
        kind: "reaction",
        eventGuid: event.messageGuid,
        targetGuid: event.targetMessageGuid,
        actorExternalId: event.sender.externalId,
        canonicalValue: event.reaction.canonicalValue,
        canonicalAction: event.reaction.action,
        effectiveTimestamp: event.effectiveTimestamp,
      })?.keyHash
    })).size, "new/new/updated aliases share one semantic identity").toBe(1)
    expect.soft(reactionResults.map((result) => result.reason), "duplicates do not re-enter work").toEqual([
      "mutation_state_only",
      "already_processed",
      "already_processed",
    ])
    expect.soft(handledFiles, "one custom reaction handled receipt exists").toHaveLength(1)
    expect.soft(handled, "custom reaction is capture-only").toMatchObject({
      schemaVersion: 1,
      canonicalKey: reactionIdentity?.canonicalKey,
      keyHash: reactionIdentity?.keyHash,
      outcome: "capture_only_custom",
      detailCode: null,
    })
    expect.soft(runAgent, "reaction starts no model or tool loop").not.toHaveBeenCalled()
    expect.soft(loadSession, "reaction loads no session").not.toHaveBeenCalled()
    expect.soft(sessionPath, "reaction creates no session path").not.toHaveBeenCalled()
    expect.soft(deferPostTurnPersist, "reaction persists no session").not.toHaveBeenCalled()
    expect.soft(repairEvent, "capture-only reaction does not enter repair/runtime work").not.toHaveBeenCalled()
    expect.soft(sendText, "reaction sends no response").not.toHaveBeenCalled()
    expect.soft(setTyping, "reaction emits no watchdog/status activity").not.toHaveBeenCalled()
    expect.soft(markChatRead, "reaction emits no read-status activity").not.toHaveBeenCalled()
    expect.soft(
      snapshotBlueBubblesActiveTurns("synthetic-incident-agent"),
      "reaction leaves no active turn",
    ).toMatchObject({ activeTurnCount: 0, stalledTurnCount: 0 })

    let visibleAnswer = ""
    const commitAcceptedAnswer = (text: string): void => { visibleAnswer += text }
    const settle = new SettleStreamer({
      onModelStreamStart: vi.fn(),
      onTextChunk: commitAcceptedAnswer,
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      settleOutputMode: "final_only",
    })
    settle.activate()
    for (const chunk of fixture.stream.argumentChunks) settle.processDelta(chunk)
    expect.soft(visibleAnswer, "final-only output stays hidden before finalization").toBe("")
    const finalization = settle.finish(fixture.stream.completedArguments)
    expect.soft(finalization, "Unicode settle finalization").toEqual({
      ok: true,
      answer: fixture.stream.expectedAnswer,
    })
    expect.soft(visibleAnswer, "final-only parser does not own semantic commit").toBe("")
    if (finalization.ok) commitAcceptedAnswer(finalization.answer)
    expect.soft(visibleAnswer, "accepted Unicode answer is committed exactly once and intact").toBe(
      fixture.stream.expectedAnswer,
    )
  } finally {
    unregister()
    __resetBlueBubblesInFlightForTests()
    incidentRuntime.agentRoot = ""
    fs.rmSync(agentRoot, { recursive: true, force: true })
  }
})
