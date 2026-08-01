import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import type { HabitStatus } from "../../../heart/habits/habit-parser"
import type { BlueBubblesSemanticCaptureV1 } from "../../../senses/ingress-evidence"
import {
  buildBlueBubblesSemanticIdentity,
  serializeBlueBubblesSemanticJson,
} from "../../../senses/bluebubbles/semantic-receipts"

export const SYNTHETIC_HABIT_ID = "rsvp-synthetic"
export const SYNTHETIC_BRIDGE_ID = "pre-v1-bluebubbles-11111111-2222-4333-8444-555555555555"
export const SYNTHETIC_EVENT_GUID = "11111111-2222-4333-8444-555555555555"
export const SYNTHETIC_ACTOR = "Casey"
export const SYNTHETIC_PARTICIPANT = "Morgan"
export const SYNTHETIC_REQUEST = "The ceremony is complete; please end this RSVP report."
export const SYNTHETIC_CAPTURED_AT = "2026-07-01T12:00:00.000Z"
export const SYNTHETIC_CANCELLED_AT = "2026-07-01T12:05:00.000Z"
export const SYNTHETIC_CANCELLATION_REASON =
  "Confirmed requester Casey asked to end the RSVP report after the wedding."

const PROVIDER_NAMESPACE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const SESSION_EVENT_ID = "evt-synthetic-request"

export interface SyntheticHabitDefinition {
  path: string
  bytes: string
}

export interface SyntheticCaptureEvidence {
  capture: BlueBubblesSemanticCaptureV1
  path: string
  locator: string
}

export interface SyntheticBridgeEvidence {
  bridgeId: string
  bridgePath: string
  bridgeSha256: string
  locator: string
  cancellationReason: string
  requestText: string
  actorDisplayName: string
  participantDisplayName: string
}

export function sha256Utf8(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function writeSyntheticHabitDefinition(
  agentRoot: string,
  status: HabitStatus = "active",
): SyntheticHabitDefinition {
  const definitionPath = path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
  const bytes = [
    "---",
    "title: Synthetic RSVP report",
    "cadence: 24h",
    `status: ${status}`,
    "created: 2026-06-01T00:00:00.000Z",
    "---",
    "",
    "Read the synthetic RSVP source and report only when active.",
    "",
  ].join("\n")
  fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
  fs.writeFileSync(definitionPath, bytes, "utf8")
  return { path: definitionPath, bytes }
}

export function writeSyntheticCaptureEvidence(
  agentRoot: string,
  overrides: Partial<BlueBubblesSemanticCaptureV1["event"]> = {},
): SyntheticCaptureEvidence {
  const event = {
    provider: "bluebubbles" as const,
    kind: "message" as const,
    eventGuid: SYNTHETIC_EVENT_GUID,
    fromMe: false,
    actor: {
      provider: "imessage-handle" as const,
      externalId: "casey@example.invalid",
      displayName: SYNTHETIC_ACTOR,
    },
    participants: [{
      provider: "imessage-handle" as const,
      externalId: "morgan@example.invalid",
      displayName: SYNTHETIC_PARTICIPANT,
    }],
    sourceEventType: "new-message",
    sessionKey: "synthetic-session",
    chatGuid: "synthetic-chat",
    chatIdentifier: "synthetic-group",
    text: SYNTHETIC_REQUEST,
    textSha256: sha256Utf8(SYNTHETIC_REQUEST),
    targetGuid: null,
    targetAuthorship: null,
    canonicalAction: null,
    canonicalValue: null,
    rawTransportValue: null,
    effectiveAt: null,
    revision: null,
    contentSha256: null,
    ...overrides,
  }
  const identity = buildBlueBubblesSemanticIdentity({
    providerNamespace: PROVIDER_NAMESPACE,
    kind: event.kind,
    eventGuid: event.eventGuid,
    text: event.text ?? undefined,
  })
  const capture: BlueBubblesSemanticCaptureV1 = {
    schemaVersion: 1,
    canonicalKey: identity.canonicalKey,
    keyHash: identity.keyHash,
    providerNamespace: PROVIDER_NAMESPACE,
    capturedAt: SYNTHETIC_CAPTURED_AT,
    event,
  }
  const capturePath = path.join(
    agentRoot,
    "state",
    "senses",
    "bluebubbles",
    "semantic-receipts",
    "captures",
    `${capture.keyHash}.json`,
  )
  const cutoverPath = path.join(
    agentRoot,
    "state",
    "senses",
    "bluebubbles",
    "semantic-receipts",
    "cutover.json",
  )
  fs.mkdirSync(path.dirname(capturePath), { recursive: true })
  fs.writeFileSync(cutoverPath, serializeBlueBubblesSemanticJson({
    schemaVersion: 1,
    providerNamespace: PROVIDER_NAMESPACE,
    effectiveAt: "2026-07-01T11:59:00.000Z",
  }), "utf8")
  fs.writeFileSync(capturePath, serializeBlueBubblesSemanticJson(capture), "utf8")
  return {
    capture,
    path: capturePath,
    locator: `capture:${capture.keyHash}`,
  }
}

export function writeSyntheticBridgeEvidence(agentRoot: string): SyntheticBridgeEvidence {
  const sourceRoot = path.join(agentRoot, "fixture-sources")
  const bridgeRoot = path.join(agentRoot, "state", "senses", "bluebubbles", "evidence-bridges")
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(bridgeRoot, { recursive: true })

  const sourceImagePaths = [
    path.join(sourceRoot, "source-confirmation-1.jpg"),
    path.join(sourceRoot, "source-confirmation-2.jpg"),
  ]
  const imageBytes = [Buffer.from("synthetic-image-one\n"), Buffer.from("synthetic-image-two\n")]
  sourceImagePaths.forEach((sourcePath, index) => fs.writeFileSync(sourcePath, imageBytes[index]))

  const artifactImagePaths = [
    path.join(bridgeRoot, "operator-confirmation-1.jpg"),
    path.join(bridgeRoot, "operator-confirmation-2.jpg"),
  ]
  artifactImagePaths.forEach((artifactPath, index) => fs.writeFileSync(artifactPath, imageBytes[index]))

  const confirmationBytes = [
    "# Operator Confirmation",
    "",
    `Recorded-At: ${SYNTHETIC_CAPTURED_AT}`,
    "Source: synthetic owner statement",
    "Screenshot-1: operator-confirmation-1.jpg",
    "Screenshot-2: operator-confirmation-2.jpg",
    "",
    "## Statement",
    "",
    SYNTHETIC_REQUEST,
    "",
  ].join("\n")
  const confirmationPath = path.join(bridgeRoot, "operator-confirmation.md")
  fs.writeFileSync(confirmationPath, confirmationBytes, "utf8")

  const inboundPath = path.join(sourceRoot, "inbound.ndjson")
  const inboundBytes = `${JSON.stringify({
    messageGuid: SYNTHETIC_EVENT_GUID,
    textForAgent: SYNTHETIC_REQUEST,
  })}\n`
  fs.writeFileSync(inboundPath, inboundBytes, "utf8")

  const sessionPath = path.join(sourceRoot, "session.json")
  const sessionBytes = `${JSON.stringify({
    events: [{ id: SESSION_EVENT_ID, content: `${SYNTHETIC_ACTOR}: ${SYNTHETIC_REQUEST}` }],
  }, null, 2)}\n`
  fs.writeFileSync(sessionPath, sessionBytes, "utf8")

  const contextPath = path.join(sourceRoot, "context.json")
  const contextBytes = `${JSON.stringify({
    chronology: [{ eventGuid: SYNTHETIC_EVENT_GUID }],
  }, null, 2)}\n`
  fs.writeFileSync(contextPath, contextBytes, "utf8")

  const requestSha256 = sha256Utf8(SYNTHETIC_REQUEST)
  const bridge = {
    schemaVersion: 1,
    bridgeId: SYNTHETIC_BRIDGE_ID,
    sourceKind: "operator_confirmation",
    createdAt: SYNTHETIC_CAPTURED_AT,
    confirmedAt: SYNTHETIC_CAPTURED_AT,
    actor: {
      displayName: SYNTHETIC_ACTOR,
      provider: null,
      externalId: null,
    },
    participants: [{
      displayName: SYNTHETIC_PARTICIPANT,
      provider: null,
      externalId: null,
      role: "group_participant_only",
    }],
    request: {
      eventGuid: SYNTHETIC_EVENT_GUID,
      text: SYNTHETIC_REQUEST,
      sha256: requestSha256,
    },
    evidence: {
      operatorConfirmation: {
        path: path.basename(confirmationPath),
        sha256: sha256Utf8(confirmationBytes),
      },
      screenshots: sourceImagePaths.map((sourcePath, index) => ({
        index: index + 1,
        sourcePath,
        artifactPath: path.basename(artifactImagePaths[index]),
        sha256: sha256Utf8(imageBytes[index]),
      })),
      sources: [
        {
          role: "inbound_request",
          path: inboundPath,
          fileSha256: sha256Utf8(inboundBytes),
          eventGuid: SYNTHETIC_EVENT_GUID,
          requestSha256,
        },
        {
          role: "session_rendering",
          path: sessionPath,
          fileSha256: sha256Utf8(sessionBytes),
          eventId: SESSION_EVENT_ID,
          normalizedRequestSha256: requestSha256,
        },
        {
          role: "context_chronology",
          path: contextPath,
          fileSha256: sha256Utf8(contextBytes),
          eventGuid: SYNTHETIC_EVENT_GUID,
        },
      ],
    },
  }
  const bridgeBytes = `${JSON.stringify(bridge, null, 2)}\n`
  const bridgePath = path.join(bridgeRoot, `${SYNTHETIC_BRIDGE_ID}.json`)
  fs.writeFileSync(bridgePath, bridgeBytes, "utf8")

  return {
    bridgeId: SYNTHETIC_BRIDGE_ID,
    bridgePath,
    bridgeSha256: sha256Utf8(bridgeBytes),
    locator: SYNTHETIC_BRIDGE_ID,
    cancellationReason: SYNTHETIC_CANCELLATION_REASON,
    requestText: SYNTHETIC_REQUEST,
    actorDisplayName: SYNTHETIC_ACTOR,
    participantDisplayName: SYNTHETIC_PARTICIPANT,
  }
}
