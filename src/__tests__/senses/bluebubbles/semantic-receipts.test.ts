import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentTestObservedNervesEvent } from "../../helpers/current-test-nerves"

import type {
  BlueBubblesMutationType,
  BlueBubblesNormalizedMutation,
} from "../../../senses/bluebubbles/model"

import {
  buildBlueBubblesReactionCoordinateRecord,
  buildBlueBubblesSemanticCapture,
  buildBlueBubblesSemanticClaimRecord,
  buildBlueBubblesSemanticIdentity,
  classifyBlueBubblesRecoveryRecord,
  compareBlueBubblesSemanticCaptureOrder,
  getBlueBubblesSemanticPaths,
  hashIngressActorIdentity,
  initializeBlueBubblesSemanticCutover,
  normalizeIngressIdentifier,
  normalizeIngressParticipants,
  readBlueBubblesSemanticCutover,
  rotateBlueBubblesSemanticCutover,
  serializeBlueBubblesSemanticJson,
} from "../../../senses/bluebubbles/semantic-receipts"

const PROVIDER_NAMESPACE = "11111111-1111-4111-8111-111111111111"
const ROTATED_PROVIDER_NAMESPACE = "22222222-2222-4222-8222-222222222222"
const CUTOVER_AT = "2026-07-30T18:00:00.000Z"
const CAPTURED_AT = "2026-07-30T18:00:00.001Z"

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

function makeMessageEvent() {
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid: " MESSAGE-ABC ",
    timestamp: Date.parse(CAPTURED_AT),
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: " SENDER@EXAMPLE.COM ",
      rawId: "SENDER@EXAMPLE.COM",
      displayName: "Sender",
      observed: true,
    },
    chat: {
      chatGuid: "any;+;synthetic-group",
      chatIdentifier: "synthetic-group",
      displayName: "Synthetic Group",
      isGroup: true,
      sessionKey: "chat:any;+;synthetic-group",
      sendTarget: { kind: "chat_guid" as const, value: "any;+;synthetic-group" },
      participantHandles: [" ZED@EXAMPLE.COM ", "alpha@example.com"],
    },
    text: "  Keep exact text.  ",
    textForAgent: "Keep exact text.",
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

function makeMutationEvent(
  mutationType: BlueBubblesMutationType,
  overrides: Partial<BlueBubblesNormalizedMutation> = {},
): BlueBubblesNormalizedMutation {
  const message = makeMessageEvent()
  return {
    kind: "mutation",
    eventType: "updated-message",
    mutationType,
    messageGuid: " MUTATION-EVENT ",
    targetMessageGuid: " TARGET-MESSAGE ",
    timestamp: Date.parse(CAPTURED_AT),
    fromMe: false,
    sender: message.sender,
    chat: message.chat,
    shouldNotifyAgent: mutationType === "reaction" || mutationType === "edit" || mutationType === "unsend",
    textForAgent: "synthetic mutation",
    requiresRepair: true,
    ...overrides,
  }
}

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

describe("BlueBubbles semantic identity and cutover", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-semantic-receipts-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    vi.doUnmock("node:fs")
    vi.doUnmock("../../../nerves/runtime")
    vi.resetModules()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("uses the exact semantic root layout and initializes one persistent cutover namespace", () => {
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const expectedRoot = path.join(
      tmpRoot,
      "AgentBundles",
      "synthetic-agent.ouro",
      "state",
      "senses",
      "bluebubbles",
      "semantic-receipts",
    )

    expect(paths).toEqual({
      root: expectedRoot,
      cutover: path.join(expectedRoot, "cutover.json"),
      captures: path.join(expectedRoot, "captures"),
      observationOrders: path.join(expectedRoot, "observation-orders"),
      handled: path.join(expectedRoot, "handled"),
      claims: path.join(expectedRoot, "claims"),
      coordinates: path.join(expectedRoot, "coordinates"),
      quarantine: path.join(expectedRoot, "quarantine"),
      ownership: path.join(expectedRoot, "ownership.sqlite"),
    })

    const first = initializeBlueBubblesSemanticCutover("synthetic-agent", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })
    const firstBytes = fs.readFileSync(paths.cutover, "utf8")
    const repeated = initializeBlueBubblesSemanticCutover("synthetic-agent", {
      now: () => new Date("2026-07-30T19:00:00.000Z"),
      randomUUID: () => ROTATED_PROVIDER_NAMESPACE,
    })

    expect(first).toEqual({
      schemaVersion: 1,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    })
    expect(firstBytes).toBe(
      `${JSON.stringify(first, null, 2)}\n`,
    )
    expect(repeated).toEqual(first)
    expect(readBlueBubblesSemanticCutover("synthetic-agent")).toEqual(first)
    expect(fs.readFileSync(paths.cutover, "utf8")).toBe(firstBytes)
  })

  it("rotates the provider namespace only through an explicit reattachment or migration call", () => {
    initializeBlueBubblesSemanticCutover("synthetic-agent", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })

    const rotated = rotateBlueBubblesSemanticCutover("synthetic-agent", "sense_reattachment", {
      now: () => new Date("2026-07-30T20:00:00.000Z"),
      randomUUID: () => ROTATED_PROVIDER_NAMESPACE,
    })

    expect(rotated).toEqual({
      schemaVersion: 1,
      providerNamespace: ROTATED_PROVIDER_NAMESPACE,
      effectiveAt: "2026-07-30T20:00:00.000Z",
    })
    expect(readBlueBubblesSemanticCutover("synthetic-agent")).toEqual(rotated)
  })

  it("normalizes required identifiers without Unicode normalization and hashes actors exactly", () => {
    expect(normalizeIngressIdentifier("  SENDER@EXAMPLE.COM  ")).toBe("sender@example.com")
    expect(normalizeIngressIdentifier(" Ａ@example.com ")).toBe("ａ@example.com")
    expect(hashIngressActorIdentity(" SENDER@EXAMPLE.COM ")).toBe(
      sha256(JSON.stringify(["imessage-handle", "sender@example.com"])),
    )
    expect(normalizeIngressParticipants([
      { provider: "imessage-handle", externalId: " ZED@EXAMPLE.COM ", displayName: null },
      { provider: "imessage-handle", externalId: "alpha@example.com", displayName: "Alpha" },
    ])).toEqual([
      { provider: "imessage-handle", externalId: "alpha@example.com", displayName: "Alpha" },
      { provider: "imessage-handle", externalId: "zed@example.com", displayName: null },
    ])
  })

  it("keys messages only by namespace and normalized provider GUID", () => {
    const identity = buildBlueBubblesSemanticIdentity({
      providerNamespace: ` ${PROVIDER_NAMESPACE.toUpperCase()} `,
      kind: "message",
      eventGuid: " MESSAGE-ABC ",
    })
    const canonicalKey = JSON.stringify(["bb-sem-v1", PROVIDER_NAMESPACE, "message", "message-abc"])

    expect(identity).toEqual({
      canonicalKey,
      keyHash: sha256(canonicalKey),
      handleable: true,
      discriminator: null,
      coordinateKey: null,
      coordinateHash: null,
    })
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "message",
      eventGuid: "message-abc",
      sessionKey: "repaired-session",
      chatGuid: "repaired-chat",
    })).toEqual(identity)
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "message",
      eventGuid: "   ",
    })).toBeNull()
  })

  it("keys reaction transitions by actor, target, canonical value/action, and ordered generation", () => {
    const actorHash = hashIngressActorIdentity("sender@example.com")
    const coordinateKey = JSON.stringify([
      "bb-sem-v1",
      PROVIDER_NAMESPACE,
      "reaction-coordinate",
      "reaction-event",
      "target-message",
      actorHash,
      "custom",
    ])
    const coordinateHash = sha256(coordinateKey)

    const add = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "reaction",
      eventGuid: "REACTION-EVENT",
      targetGuid: "TARGET-MESSAGE",
      actorExternalId: "SENDER@EXAMPLE.COM",
      canonicalValue: "custom",
      canonicalAction: "add",
      coordinateGeneration: 0,
    })
    const remove = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "reaction",
      eventGuid: "REACTION-EVENT",
      targetGuid: "TARGET-MESSAGE",
      actorExternalId: "SENDER@EXAMPLE.COM",
      canonicalValue: "custom",
      canonicalAction: "remove",
      coordinateGeneration: 1,
    })
    const readd = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "reaction",
      eventGuid: "REACTION-EVENT",
      targetGuid: "TARGET-MESSAGE",
      actorExternalId: "SENDER@EXAMPLE.COM",
      canonicalValue: "custom",
      canonicalAction: "add",
      coordinateGeneration: 2,
    })

    expect(add?.coordinateKey).toBe(coordinateKey)
    expect(add?.coordinateHash).toBe(coordinateHash)
    expect(add?.discriminator).toBe("generation:0")
    expect(remove?.discriminator).toBe("generation:1")
    expect(readd?.discriminator).toBe("generation:2")
    expect(new Set([add?.keyHash, remove?.keyHash, readd?.keyHash]).size).toBe(3)
  })

  it("uses revision before effective time and excludes delivery aliases from reaction identity", () => {
    const base = {
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "reaction" as const,
      eventGuid: "reaction-event",
      targetGuid: "target-message",
      actorExternalId: "sender@example.com",
      canonicalValue: "love" as const,
      canonicalAction: "add" as const,
      revision: " Rev-A ",
      effectiveTimestamp: Date.parse("2026-07-30T18:00:05.000Z"),
    }
    const first = buildBlueBubblesSemanticIdentity({
      ...base,
      sourceEventType: "new-message",
      sessionKey: "session-before-repair",
    })
    const alias = buildBlueBubblesSemanticIdentity({
      ...base,
      sourceEventType: "updated-message",
      sessionKey: "session-after-repair",
    })

    expect(first?.discriminator).toBe("revision:Rev-A")
    expect(alias).toEqual(first)

    const effective = buildBlueBubblesSemanticIdentity({
      ...base,
      revision: " ",
    })
    expect(effective?.discriminator).toBe("effectiveAt:2026-07-30T18:00:05.000Z")
  })

  it("uses edit revision, then effective time, then the exact unnormalized content hash", () => {
    const byRevision = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: "MESSAGE-EDITED",
      revision: " edit-2 ",
      effectiveTimestamp: 100,
      text: "ignored fallback",
    })
    const byTime = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: "MESSAGE-EDITED",
      revision: "",
      effectiveTimestamp: 100,
      text: "ignored fallback",
    })
    const exactText = "  ÉDITED text\n"
    const byContent = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: "MESSAGE-EDITED",
      text: exactText,
    })

    expect(byRevision?.discriminator).toBe("revision:edit-2")
    expect(byTime?.discriminator).toBe("effectiveAt:1970-01-01T00:00:00.100Z")
    expect(byContent?.discriminator).toBe(`content:${sha256(exactText)}`)
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: "MESSAGE-EDITED",
    })).toBeNull()
  })

  it("keys unsends once without provider timing and keeps read/delivery audit-only", () => {
    const unsend = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "unsend",
      targetGuid: "TARGET-MESSAGE",
    })
    const read = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "read",
      eventGuid: "MESSAGE-READ",
      effectiveTimestamp: 100,
    })
    const delivery = buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "delivery",
      eventGuid: "MESSAGE-DELIVERED",
    })

    expect(unsend?.discriminator).toBe("terminal")
    expect(unsend?.canonicalKey).toBe(JSON.stringify([
      "bb-sem-v1",
      PROVIDER_NAMESPACE,
      "unsend",
      "target-message",
      "terminal",
    ]))
    expect(read?.handleable).toBe(false)
    expect(read?.discriminator).toBe("effectiveAt:1970-01-01T00:00:00.100Z")
    expect(delivery?.handleable).toBe(false)
    expect(delivery?.discriminator).toBe("terminal")
  })

  it("projects immutable observed actor, participant, text, and routing roles into the capture", () => {
    const event = makeMessageEvent()
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const capture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event,
      targetAuthorship: null,
    })
    const repaired = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: {
        ...event,
        eventType: "repaired-new-message",
        textForAgent: "enriched presentation text",
        chat: {
          ...event.chat,
          chatGuid: "any;+;repaired-group",
          chatIdentifier: "repaired-group",
          sessionKey: "chat:any;+;repaired-group",
        },
      },
      targetAuthorship: null,
    })

    expect(capture?.canonicalKey).toBe(repaired?.canonicalKey)
    expect(capture?.keyHash).toBe(repaired?.keyHash)
    expect(capture?.event.actor).toEqual({
      provider: "imessage-handle",
      externalId: "sender@example.com",
      displayName: "Sender",
    })
    expect(capture?.event.participants).toEqual([
      { provider: "imessage-handle", externalId: "alpha@example.com", displayName: null },
      { provider: "imessage-handle", externalId: "zed@example.com", displayName: null },
    ])
    expect(capture?.event.text).toBe("  Keep exact text.  ")
    expect(capture?.event.textSha256).toBe(sha256("  Keep exact text.  "))
    expect(capture?.event.chatIdentifier).toBe("synthetic-group")
    expect(capture?.event.targetAuthorship).toBeNull()
  })

  it("never promotes routing coordinates or participants into a missing actor", () => {
    const event = makeMessageEvent()
    event.sender = {
      ...event.sender,
      externalId: "synthetic-group",
      rawId: "synthetic-group",
      displayName: "synthetic-group",
      observed: false,
    }
    event.chat.participantHandles = ["participant@example.com"]

    expect(buildBlueBubblesSemanticCapture({
      cutover: {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: CUTOVER_AT,
      },
      capturedAt: CAPTURED_AT,
      event,
      targetAuthorship: null,
    })).toBeNull()
  })

  it("serializes the exact coordinate and owner schemas with one terminal LF", () => {
    const coordinateKey = JSON.stringify([
      "bb-sem-v1",
      PROVIDER_NAMESPACE,
      "reaction-coordinate",
      "reaction-event",
      "target-message",
      hashIngressActorIdentity("sender@example.com"),
      "love",
    ])
    const coordinateHash = sha256(coordinateKey)
    const coordinate = buildBlueBubblesReactionCoordinateRecord({
      coordinateKey,
      coordinateHash,
      generation: 0,
      lastAction: "add",
      updatedAt: CAPTURED_AT,
    })
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: coordinateKey,
      keyHash: coordinateHash,
      operationId: `semantic-coordinate:${coordinateHash}`,
      pid: 123,
      bootIdentity: "boot-probe",
      processStartedAt: "process-probe",
      acquiredAt: CAPTURED_AT,
    })

    expect(coordinate).toEqual({
      schemaVersion: 1,
      coordinateKey,
      coordinateHash,
      generation: 0,
      lastAction: "add",
      updatedAt: CAPTURED_AT,
    })
    expect(owner).toEqual({
      schemaVersion: 1,
      canonicalKey: coordinateKey,
      keyHash: coordinateHash,
      owner: {
        operationId: `semantic-coordinate:${coordinateHash}`,
        pid: 123,
        bootIdentity: "boot-probe",
        processStartedAt: "process-probe",
        acquiredAt: CAPTURED_AT,
      },
    })
    expect(serializeBlueBubblesSemanticJson(coordinate)).toBe(`${JSON.stringify(coordinate, null, 2)}\n`)
    expect(serializeBlueBubblesSemanticJson(owner)).toBe(`${JSON.stringify(owner, null, 2)}\n`)
  })

  it("classifies every pre-v1, actorless, pre-cutover, and audit event as non-handleable", () => {
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const legacyInbound = {
      recordedAt: CAPTURED_AT,
      messageGuid: "legacy-message",
      chatGuid: "any;+;synthetic-group",
      chatIdentifier: "synthetic-group",
      sessionKey: "chat:any;+;synthetic-group",
      textForAgent: "legacy request",
      source: "webhook",
    }
    const legacyMutation = {
      recordedAt: CAPTURED_AT,
      eventType: "updated-message",
      mutationType: "reaction",
      messageGuid: "legacy-reaction",
      targetMessageGuid: "target-message",
      chatGuid: "any;+;synthetic-group",
      chatIdentifier: "synthetic-group",
      sessionKey: "chat:any;+;synthetic-group",
      shouldNotifyAgent: true,
      textForAgent: "legacy reaction",
      fromMe: false,
    }
    const valid = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMessageEvent(),
      targetAuthorship: null,
    })
    expect(valid).not.toBeNull()

    const outcomes = [
      classifyBlueBubblesRecoveryRecord(legacyInbound, cutover),
      classifyBlueBubblesRecoveryRecord(legacyMutation, cutover),
      classifyBlueBubblesRecoveryRecord({
        ...valid,
        capturedAt: "2026-07-30T17:59:59.999Z",
      }, cutover),
      classifyBlueBubblesRecoveryRecord({
        ...valid,
        event: { ...valid?.event, actor: null },
      }, cutover),
      classifyBlueBubblesRecoveryRecord({
        ...valid,
        event: { ...valid?.event, kind: "read" },
      }, cutover),
    ]

    expect(outcomes).toEqual([
      { disposition: "audit_only", reason: "legacy_or_actorless" },
      { disposition: "audit_only", reason: "legacy_or_actorless" },
      { disposition: "audit_only", reason: "before_cutover" },
      { disposition: "audit_only", reason: "legacy_or_actorless" },
      { disposition: "audit_only", reason: "audit_event" },
    ])
    expect(outcomes.every((outcome) => !("actor" in outcome))).toBe(true)
    expect(classifyBlueBubblesRecoveryRecord(valid, cutover)).toEqual({
      disposition: "handleable",
      keyHash: valid?.keyHash,
    })
  })

  it("rejects malformed cutover bytes, invalid dependencies, and malformed existing markers", async () => {
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.root, { recursive: true })

    const malformedMarkers: unknown[] = [
      null,
      [],
      {
        providerNamespace: PROVIDER_NAMESPACE,
        schemaVersion: 1,
        effectiveAt: CUTOVER_AT,
      },
      {
        schemaVersion: 2,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: CUTOVER_AT,
      },
      {
        schemaVersion: 1,
        providerNamespace: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        effectiveAt: CUTOVER_AT,
      },
      {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: "not-an-instant",
      },
      {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: "2026-99-99T99:99:99.999Z",
      },
      {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: "2026-02-30T18:00:00.000Z",
      },
      {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: CUTOVER_AT,
        extra: true,
      },
    ]

    for (const marker of malformedMarkers) {
      fs.writeFileSync(paths.cutover, serializeBlueBubblesSemanticJson(marker), "utf8")
      expect(readBlueBubblesSemanticCutover("synthetic-agent")).toBeNull()
    }

    fs.writeFileSync(paths.cutover, "{bad json\n", "utf8")
    expect(readBlueBubblesSemanticCutover("synthetic-agent")).toBeNull()

    vi.resetModules()
    const actualFs = await vi.importActual<typeof fs>("node:fs")
    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync: () => {
        throw "synthetic-non-error-read"
      },
    }))
    const mockedSemantic = await import("../../../senses/bluebubbles/semantic-receipts")
    expect(mockedSemantic.readBlueBubblesSemanticCutover("synthetic-agent")).toBeNull()
    vi.doUnmock("node:fs")
    vi.resetModules()

    fs.writeFileSync(paths.cutover, "{}\n", "utf8")
    expect(() => initializeBlueBubblesSemanticCutover("synthetic-agent", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("semantic_cutover_invalid")

    fs.rmSync(paths.cutover)
    expect(() => initializeBlueBubblesSemanticCutover("invalid-namespace", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => "not-a-v4-uuid",
    })).toThrow("semantic_provider_namespace_invalid")
    expect(() => initializeBlueBubblesSemanticCutover("invalid-timestamp", {
      now: () => ({ toISOString: () => "not-an-instant" }) as Date,
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("semantic_cutover_timestamp_invalid")

    const generated = initializeBlueBubblesSemanticCutover("default-dependencies")
    expect(generated.providerNamespace).toMatch(/^[0-9a-f-]{36}$/)
    expect(generated.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("handles cutover publication races and fails closed at every cleanup boundary", async () => {
    const actualFs = await vi.importActual<typeof fs>("node:fs")
    const controls: {
      openSync?: (...args: unknown[]) => number
      closeSync?: (...args: unknown[]) => void
      linkSync?: (...args: unknown[]) => void
      writeFileSync?: (...args: unknown[]) => void
      unlinkSync?: (...args: unknown[]) => void
    } = {}
    vi.resetModules()
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: (...args: unknown[]) => controls.openSync
        ? controls.openSync(...args)
        : Reflect.apply(actualFs.openSync, actualFs, args),
      closeSync: (...args: unknown[]) => controls.closeSync
        ? controls.closeSync(...args)
        : Reflect.apply(actualFs.closeSync, actualFs, args),
      linkSync: (...args: unknown[]) => controls.linkSync
        ? controls.linkSync(...args)
        : Reflect.apply(actualFs.linkSync, actualFs, args),
      writeFileSync: (...args: unknown[]) => controls.writeFileSync
        ? controls.writeFileSync(...args)
        : Reflect.apply(actualFs.writeFileSync, actualFs, args),
      unlinkSync: (...args: unknown[]) => controls.unlinkSync
        ? controls.unlinkSync(...args)
        : Reflect.apply(actualFs.unlinkSync, actualFs, args),
    }))
    const semantic = await import("../../../senses/bluebubbles/semantic-receipts")

    for (const [agentName, operation] of [
      ["initialize-open-collision", "initialize"],
      ["rotate-open-collision", "rotate"],
    ] as const) {
      const paths = semantic.getBlueBubblesSemanticPaths(agentName)
      fs.mkdirSync(paths.root, { recursive: true })
      const tempPath = path.join(
        paths.root,
        `.cutover.json.${process.pid}.${PROVIDER_NAMESPACE}.tmp`,
      )
      fs.writeFileSync(tempPath, "other-owner-sentinel\n", "utf8")
      controls.openSync = () => {
        throw codedError("EEXIST")
      }
      const invoke = operation === "initialize"
        ? () => semantic.initializeBlueBubblesSemanticCutover(agentName, {
            now: () => new Date(CUTOVER_AT),
            randomUUID: () => PROVIDER_NAMESPACE,
          })
        : () => semantic.rotateBlueBubblesSemanticCutover(agentName, "migration", {
            now: () => new Date(CUTOVER_AT),
            randomUUID: () => PROVIDER_NAMESPACE,
          })
      expect(invoke).toThrow("synthetic EEXIST")
      controls.openSync = undefined
      expect(fs.readFileSync(tempPath, "utf8")).toBe("other-owner-sentinel\n")
      fs.unlinkSync(tempPath)
    }

    for (const [agentName, operation] of [
      ["initialize-close-failure", "initialize"],
      ["rotate-close-failure", "rotate"],
    ] as const) {
      const paths = semantic.getBlueBubblesSemanticPaths(agentName)
      const tempPath = path.join(
        paths.root,
        `.cutover.json.${process.pid}.${PROVIDER_NAMESPACE}.tmp`,
      )
      let firstClose = true
      controls.closeSync = (...args: unknown[]) => {
        if (firstClose) {
          firstClose = false
          Reflect.apply(actualFs.closeSync, actualFs, args)
          throw codedError("EIO")
        }
        return Reflect.apply(actualFs.closeSync, actualFs, args)
      }
      const invoke = operation === "initialize"
        ? () => semantic.initializeBlueBubblesSemanticCutover(agentName, {
            now: () => new Date(CUTOVER_AT),
            randomUUID: () => PROVIDER_NAMESPACE,
          })
        : () => semantic.rotateBlueBubblesSemanticCutover(agentName, "migration", {
            now: () => new Date(CUTOVER_AT),
            randomUUID: () => PROVIDER_NAMESPACE,
          })
      expect(invoke).toThrow("synthetic EIO")
      controls.closeSync = undefined
      expect(fs.existsSync(tempPath)).toBe(false)
      expect(fs.existsSync(paths.cutover)).toBe(false)
    }

    const winner = {
      schemaVersion: 1 as const,
      providerNamespace: ROTATED_PROVIDER_NAMESPACE,
      effectiveAt: "2026-07-30T18:00:01.000Z",
    }
    const racePaths = semantic.getBlueBubblesSemanticPaths("race-winner")
    controls.linkSync = (_tempPath, finalPath) => {
      fs.writeFileSync(String(finalPath), serializeBlueBubblesSemanticJson(winner), "utf8")
      throw codedError("EEXIST")
    }
    expect(semantic.initializeBlueBubblesSemanticCutover("race-winner", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toEqual(winner)
    controls.linkSync = undefined
    expect(fs.existsSync(racePaths.cutover)).toBe(true)

    const invalidRacePaths = semantic.getBlueBubblesSemanticPaths("race-invalid")
    controls.linkSync = (_tempPath, finalPath) => {
      fs.writeFileSync(String(finalPath), "{}\n", "utf8")
      throw codedError("EEXIST")
    }
    expect(() => semantic.initializeBlueBubblesSemanticCutover("race-invalid", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("semantic_cutover_invalid")
    controls.linkSync = undefined
    expect(fs.existsSync(invalidRacePaths.cutover)).toBe(true)

    let failureIndex = 0
    for (const thrown of [codedError("EIO"), new Error("plain-link-error"), "string-link-error"]) {
      controls.linkSync = () => {
        throw thrown
      }
      expect(() => semantic.initializeBlueBubblesSemanticCutover(`link-failure-${failureIndex}`, {
        now: () => new Date(CUTOVER_AT),
        randomUUID: () => PROVIDER_NAMESPACE,
      })).toThrow()
      controls.linkSync = undefined
      failureIndex += 1
    }

    controls.writeFileSync = () => {
      throw codedError("EIO")
    }
    expect(() => semantic.initializeBlueBubblesSemanticCutover("write-failure", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("synthetic EIO")
    controls.writeFileSync = undefined

    controls.unlinkSync = () => {
      throw codedError("ENOENT")
    }
    expect(semantic.initializeBlueBubblesSemanticCutover("missing-cleanup", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    }).providerNamespace).toBe(PROVIDER_NAMESPACE)
    controls.unlinkSync = undefined

    controls.unlinkSync = () => {
      throw codedError("EACCES")
    }
    expect(() => semantic.initializeBlueBubblesSemanticCutover("blocked-cleanup", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("synthetic EACCES")
    controls.unlinkSync = undefined

    controls.writeFileSync = () => {
      throw codedError("EIO")
    }
    expect(() => semantic.rotateBlueBubblesSemanticCutover("rotate-write-failure", "migration", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("synthetic EIO")
    controls.writeFileSync = undefined

    controls.unlinkSync = () => {
      throw codedError("EACCES")
    }
    expect(() => semantic.rotateBlueBubblesSemanticCutover("rotate-cleanup-failure", "migration", {
      now: () => new Date(CUTOVER_AT),
      randomUUID: () => PROVIDER_NAMESPACE,
    })).toThrow("synthetic EACCES")
    controls.unlinkSync = undefined
  })

  it("rejects every incomplete identity boundary and preserves discriminator precedence", () => {
    expect(normalizeIngressIdentifier(undefined)).toBe("undefined")
    expect(normalizeIngressParticipants([
      { provider: "imessage-handle", externalId: "   ", displayName: " " },
      { provider: "imessage-handle", externalId: "b@example.com", displayName: 7 as unknown as string },
    ])).toEqual([
      { provider: "imessage-handle", externalId: "b@example.com", displayName: null },
    ])

    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: "invalid",
      kind: "message",
      eventGuid: "message",
    })).toBeNull()
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "message",
      eventGuid: null,
    })).toBeNull()

    const reactionBase = {
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "reaction" as const,
      eventGuid: "reaction-event",
      targetGuid: "target-message",
      actorExternalId: "sender@example.com",
      canonicalValue: "love" as const,
      canonicalAction: "add" as const,
      coordinateGeneration: 0,
    }
    for (const invalid of [
      { ...reactionBase, eventGuid: " " },
      { ...reactionBase, targetGuid: undefined },
      { ...reactionBase, actorExternalId: null },
      { ...reactionBase, canonicalValue: "invented" as "love" },
      { ...reactionBase, canonicalValue: 7 as unknown as "love" },
      { ...reactionBase, canonicalAction: "invented" as "add" },
      { ...reactionBase, canonicalAction: 7 as unknown as "add" },
      { ...reactionBase, coordinateGeneration: -1 },
      { ...reactionBase, coordinateGeneration: 0.5 },
      { ...reactionBase, coordinateGeneration: "0" as unknown as number },
    ]) {
      expect(buildBlueBubblesSemanticIdentity(invalid)).toBeNull()
    }

    expect(buildBlueBubblesSemanticIdentity({
      ...reactionBase,
      revision: 7,
      effectiveTimestamp: 100,
    })?.discriminator).toBe("effectiveAt:1970-01-01T00:00:00.100Z")
    expect(buildBlueBubblesSemanticIdentity({
      ...reactionBase,
      revision: "r1",
      effectiveTimestamp: 100,
    })?.discriminator).toBe("revision:r1")
    expect(buildBlueBubblesSemanticIdentity({
      ...reactionBase,
      coordinateGeneration: undefined,
      effectiveTimestamp: Number.POSITIVE_INFINITY,
    })).toBeNull()
    expect(buildBlueBubblesSemanticIdentity({
      ...reactionBase,
      coordinateGeneration: undefined,
      effectiveTimestamp: 1e100,
    })).toBeNull()

    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: undefined,
      text: "content",
    })).toBeNull()
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "edit",
      eventGuid: "message",
      text: 7,
    })).toBeNull()
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "unsend",
      targetGuid: undefined,
    })).toBeNull()
    expect(buildBlueBubblesSemanticIdentity({
      providerNamespace: PROVIDER_NAMESPACE,
      kind: "read",
      eventGuid: undefined,
    })).toBeNull()
  })

  it("projects every mutation kind without promoting presentation or routing evidence", () => {
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const reaction = makeMutationEvent("reaction", {
      eventType: "new-message",
      reaction: {
        raw: "2006",
        rawTransportValue: "2006",
        canonicalValue: "custom",
        action: "add",
      },
      revision: " reaction-r1 ",
      effectiveTimestamp: 100,
    })
    const reactionCapture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: reaction,
      targetAuthorship: "agent",
      coordinateGeneration: 4,
    })
    expect(reactionCapture?.event).toEqual(expect.objectContaining({
      kind: "reaction",
      eventGuid: "mutation-event",
      targetGuid: "target-message",
      targetAuthorship: "agent",
      canonicalAction: "add",
      canonicalValue: "custom",
      rawTransportValue: "2006",
      effectiveAt: "1970-01-01T00:00:00.100Z",
      revision: "reaction-r1",
      text: null,
      textSha256: null,
      contentSha256: null,
    }))

    const exactEdit = "  Exact edit\n"
    const editCapture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMutationEvent("edit", {
        editedText: exactEdit,
        revision: "edit-r2",
        effectiveTimestamp: 200,
        chat: {
          ...reaction.chat,
          sessionKey: "",
          chatGuid: "",
          chatIdentifier: undefined,
        },
        sender: { ...reaction.sender, displayName: " " },
      }),
      targetAuthorship: "non_agent_unknown",
    })
    expect(editCapture?.event).toEqual(expect.objectContaining({
      kind: "edit",
      text: exactEdit,
      textSha256: sha256(exactEdit),
      contentSha256: sha256(exactEdit),
      sessionKey: null,
      chatGuid: null,
      chatIdentifier: null,
      revision: "edit-r2",
    }))
    expect(editCapture?.event.actor.displayName).toBeNull()

    const emptyEditCapture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMutationEvent("edit", {
        editedText: undefined,
        revision: "edit-r3",
      }),
      targetAuthorship: null,
    })
    expect(emptyEditCapture?.event.text).toBeNull()
    expect(emptyEditCapture?.event.contentSha256).toBeNull()

    const unsendCapture = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMutationEvent("unsend", {
        targetMessageGuid: undefined,
        effectiveTimestamp: undefined,
      }),
      targetAuthorship: null,
    })
    expect(unsendCapture?.event.targetGuid).toBe("mutation-event")
    expect(unsendCapture?.event.effectiveAt).toBeNull()

    for (const mutationType of ["read", "delivery"] as const) {
      const capture = buildBlueBubblesSemanticCapture({
        cutover,
        capturedAt: CAPTURED_AT,
        event: makeMutationEvent(mutationType, {
          targetMessageGuid: undefined,
          effectiveTimestamp: mutationType === "read" ? 300 : undefined,
        }),
        targetAuthorship: null,
      })
      expect(capture?.event.kind).toBe(mutationType)
      expect(capture?.event.targetGuid).toBeNull()
      expect(capture?.canonicalKey).toContain(`"audit","${mutationType}"`)
    }
  })

  it("fails capture closed for malformed provenance, timestamps, and incomplete mutation evidence", () => {
    const validCutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const message = makeMessageEvent()
    const base = {
      cutover: validCutover,
      capturedAt: CAPTURED_AT,
      event: message,
      targetAuthorship: null,
    } as const

    expect(buildBlueBubblesSemanticCapture({
      ...base,
      cutover: { ...validCutover, providerNamespace: "invalid" },
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      capturedAt: "2026-07-30T18:00:00Z",
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: { ...message, sender: { ...message.sender, externalId: " " } },
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: { ...message, messageGuid: " " },
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: { ...message, sender: { ...message.sender, observed: undefined } },
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: { ...message, fromMe: null } as unknown as typeof message,
    })).toBeNull()
    const validObservationEpoch =
      "2026-08-13T09:59:59.000Z/33333333-3333-4333-8333-333333333333"
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      observationEpoch: validObservationEpoch,
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      observationOrdinal: 1,
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      observationEpoch: "not-an-observation-epoch",
      observationOrdinal: 1,
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      observationEpoch: validObservationEpoch,
      observationOrdinal: 0,
    })).toBeNull()

    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: makeMutationEvent("reaction", {
        reaction: undefined,
      }),
      coordinateGeneration: 0,
    })).toBeNull()
    expect(buildBlueBubblesSemanticCapture({
      ...base,
      event: makeMutationEvent("reaction", {
        targetMessageGuid: undefined,
        reaction: {
          raw: "love",
          rawTransportValue: "love",
          canonicalValue: "love",
          action: "add",
        },
      }),
      coordinateGeneration: 0,
    })).toBeNull()
  })

  it("classifies malformed v1 recovery records at each independent trust boundary", () => {
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const valid = buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMessageEvent(),
      targetAuthorship: null,
    })
    expect(valid).not.toBeNull()

    const legacy = { disposition: "audit_only", reason: "legacy_or_actorless" }
    expect(classifyBlueBubblesRecoveryRecord(null, cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord([], cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord({ schemaVersion: 1, event: null }, cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      event: { ...valid?.event, actor: { provider: "other", externalId: "sender@example.com" } },
    }, cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      event: { ...valid?.event, actor: { provider: "imessage-handle", externalId: 7 } },
    }, cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      event: { ...valid?.event, actor: { provider: "imessage-handle", externalId: " " } },
    }, cutover)).toEqual(legacy)

    const beforeCutover = { disposition: "audit_only", reason: "before_cutover" }
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      providerNamespace: ROTATED_PROVIDER_NAMESPACE,
    }, cutover)).toEqual(beforeCutover)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      capturedAt: 7,
    }, cutover)).toEqual(beforeCutover)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      capturedAt: "not-an-instant",
    }, cutover)).toEqual(beforeCutover)

    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      event: { ...valid?.event, kind: "delivery" },
    }, cutover)).toEqual({ disposition: "audit_only", reason: "audit_event" })
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      keyHash: null,
    }, cutover)).toEqual(legacy)
    expect(classifyBlueBubblesRecoveryRecord({
      ...valid,
      keyHash: "",
    }, cutover)).toEqual(legacy)
  })

  it("reports true legacy and invalid-v1 recovery evidence without falsifying schema or actor state", async () => {
    vi.resetModules()
    const nerves = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nerves }))
    const semantic = await import("../../../senses/bluebubbles/semantic-receipts")
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const valid = semantic.buildBlueBubblesSemanticCapture({
      cutover,
      capturedAt: CAPTURED_AT,
      event: makeMessageEvent(),
      targetAuthorship: null,
    })
    expect(valid).not.toBeNull()

    semantic.classifyBlueBubblesRecoveryRecord({
      mutationType: "reaction",
      messageGuid: "legacy",
    }, cutover)
    semantic.classifyBlueBubblesRecoveryRecord({
      ...valid,
      event: { ...valid?.event, actor: null },
    }, cutover)
    semantic.classifyBlueBubblesRecoveryRecord({
      ...valid,
      keyHash: "",
    }, cutover)

    expect(nerves).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({
        schemaVersion: 0,
        actorPresent: false,
        recordKind: "reaction",
        reason: "legacy_or_actorless",
      }),
    }))
    expect(nerves).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_semantic_recovery_invalid",
      meta: expect.objectContaining({
        schemaVersion: 1,
        actorPresent: false,
        reason: "actor_missing",
      }),
    }))
    expect(nerves).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_semantic_recovery_invalid",
      meta: expect.objectContaining({
        schemaVersion: 1,
        actorPresent: true,
        reason: "key_hash_missing",
      }),
    }))
  })
})

type SemanticCapture = NonNullable<ReturnType<typeof buildBlueBubblesSemanticCapture>>

interface SemanticHandledRecord {
  schemaVersion: 1
  canonicalKey: string
  keyHash: string
  handledAt: string
  outcome: string
  detailCode: string | null
}

interface SemanticStoreDepsForTest {
  fs?: unknown
  now?: () => Date
  randomUUID?: () => string
  pid?: () => number
  bootIdentity?: () => string
  processStartedAt?: (pid: number) => string | null
  isProcessAlive?: (pid: number) => boolean
  sleep?: (milliseconds: number) => Promise<void>
  sleepSync?: (milliseconds: number) => void
  platform?: NodeJS.Platform
  execFileSync?: unknown
  kill?: (pid: number, signal: 0) => true
  uptime?: () => number
}

interface SemanticClaimLeaseForTest {
  status: "acquired"
  record: ReturnType<typeof buildBlueBubblesSemanticClaimRecord>
}

interface SemanticStoreApiForTest {
  writeBlueBubblesSemanticCapture: (
    agentName: string,
    capture: SemanticCapture,
    deps?: SemanticStoreDepsForTest,
  ) => "semantic_capture_published" | "semantic_capture_duplicate" | "semantic_identity_collision"
  readBlueBubblesSemanticCapture: (
    agentName: string,
    keyHash: string,
    deps?: SemanticStoreDepsForTest,
  ) => SemanticCapture | null
  listPendingBlueBubblesSemanticCaptures: (
    agentName: string,
    deps?: SemanticStoreDepsForTest,
  ) => SemanticCapture[]
  writeBlueBubblesSemanticHandled: (
    agentName: string,
    record: SemanticHandledRecord,
    deps?: SemanticStoreDepsForTest,
  ) => "semantic_handled_published" | "semantic_handled_duplicate" | "semantic_handled_collision"
  readBlueBubblesSemanticHandled: (
    agentName: string,
    keyHash: string,
    deps?: SemanticStoreDepsForTest,
  ) => SemanticHandledRecord | null
  acquireBlueBubblesSemanticClaim: (
    agentName: string,
    identity: { canonicalKey: string; keyHash: string },
    deps?: SemanticStoreDepsForTest,
  ) => Promise<SemanticClaimLeaseForTest | {
    status: "already_handled"
    record: SemanticHandledRecord
  } | {
    status: "timeout"
    code: "semantic_claim_timeout"
  }>
  releaseBlueBubblesSemanticClaim: (
    agentName: string,
    lease: SemanticClaimLeaseForTest,
    deps?: SemanticStoreDepsForTest,
  ) => boolean
  allocateBlueBubblesReactionCoordinate: (
    agentName: string,
    input: {
      coordinateKey: string
      coordinateHash: string
      canonicalAction: "add" | "remove"
    },
    deps?: SemanticStoreDepsForTest,
  ) => Promise<ReturnType<typeof buildBlueBubblesReactionCoordinateRecord>>
}

async function loadSemanticStore(): Promise<SemanticStoreApiForTest> {
  const semantic = await import("../../../senses/bluebubbles/semantic-receipts")
  return semantic as unknown as SemanticStoreApiForTest
}

function makeSemanticCapture(
  messageGuid = "message-store-a",
  capturedAt = CAPTURED_AT,
  observationClock?: { observationEpoch: string; observationOrdinal: number },
): SemanticCapture {
  const event = makeMessageEvent()
  event.messageGuid = messageGuid
  const capture = buildBlueBubblesSemanticCapture({
    cutover: {
      schemaVersion: 1,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    },
    capturedAt,
    ...observationClock,
    event,
    targetAuthorship: null,
  })
  expect(capture).not.toBeNull()
  return capture!
}

function makeHandled(
  capture: SemanticCapture,
  overrides: Partial<SemanticHandledRecord> = {},
): SemanticHandledRecord {
  return {
    schemaVersion: 1,
    canonicalKey: capture.canonicalKey,
    keyHash: capture.keyHash,
    handledAt: "2026-07-30T18:01:00.000Z",
    outcome: "message_completed",
    detailCode: null,
    ...overrides,
  }
}

function createTracingFs(
  operations: string[],
  fail?: { operation: string; matches?: string; code?: string },
): unknown {
  const adapter = Object.create(fs) as Record<string, unknown>
  const openedPaths = new Map<number, string>()
  const shouldFail = (operation: string, rendered: string): boolean => (
    fail?.operation === operation && (!fail.matches || rendered.includes(fail.matches))
  )
  const maybeFail = (operation: string, rendered: string): void => {
    if (!shouldFail(operation, rendered)) return
    throw codedError(fail?.code ?? "EIO")
  }

  adapter.openSync = (...args: unknown[]) => {
    const renderedPath = String(args[0])
    const rendered = `open:${path.basename(renderedPath)}:${String(args[1])}`
    operations.push(rendered)
    maybeFail("openSync", rendered)
    const fd = Reflect.apply(fs.openSync, fs, args) as number
    openedPaths.set(fd, renderedPath)
    return fd
  }
  adapter.writeFileSync = (...args: unknown[]) => {
    const rendered = `write:${typeof args[0] === "number" ? path.basename(openedPaths.get(args[0]) ?? String(args[0])) : path.basename(String(args[0]))}`
    operations.push(rendered)
    maybeFail("writeFileSync", rendered)
    return Reflect.apply(fs.writeFileSync, fs, args)
  }
  adapter.fsyncSync = (...args: unknown[]) => {
    const rendered = `fsync:${path.basename(openedPaths.get(Number(args[0])) ?? String(args[0]))}`
    operations.push(rendered)
    maybeFail("fsyncSync", rendered)
    return Reflect.apply(fs.fsyncSync, fs, args)
  }
  adapter.closeSync = (...args: unknown[]) => {
    const fd = Number(args[0])
    const rendered = `close:${path.basename(openedPaths.get(fd) ?? String(fd))}`
    operations.push(rendered)
    maybeFail("closeSync", rendered)
    const result = Reflect.apply(fs.closeSync, fs, args)
    openedPaths.delete(fd)
    return result
  }
  adapter.linkSync = (...args: unknown[]) => {
    const rendered = `link:${path.basename(String(args[0]))}->${path.basename(String(args[1]))}`
    operations.push(rendered)
    maybeFail("linkSync", rendered)
    return Reflect.apply(fs.linkSync, fs, args)
  }
  adapter.renameSync = (...args: unknown[]) => {
    const rendered = `rename:${path.basename(String(args[0]))}->${path.basename(String(args[1]))}`
    operations.push(rendered)
    maybeFail("renameSync", rendered)
    return Reflect.apply(fs.renameSync, fs, args)
  }
  adapter.unlinkSync = (...args: unknown[]) => {
    const rendered = `unlink:${path.basename(String(args[0]))}`
    operations.push(rendered)
    maybeFail("unlinkSync", rendered)
    return Reflect.apply(fs.unlinkSync, fs, args)
  }
  return adapter
}

function semanticStoreDeps(overrides: SemanticStoreDepsForTest = {}): SemanticStoreDepsForTest {
  return {
    now: () => new Date("2026-07-30T18:02:00.000Z"),
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
    pid: () => 4242,
    bootIdentity: () => "boot-current",
    processStartedAt: (pid) => `process-${pid}`,
    isProcessAlive: () => true,
    sleep: async () => {},
    ...overrides,
  }
}

function runSemanticStoreChild(env: Record<string, string>): Promise<void> {
  const repoRoot = process.cwd()
  const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs")
  const helperPath = path.join(
    repoRoot,
    "src",
    "__tests__",
    "senses",
    "bluebubbles",
    "semantic-receipts-child-process.test.ts",
  )
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestBin,
      "run",
      helperPath,
      "--config",
      path.join(repoRoot, "vitest.config.ts"),
      "--pool",
      "forks",
    ], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`semantic child Vitest exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    })
  })
}

async function waitForSemanticChildFiles(filePaths: string[], timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!filePaths.every((filePath) => fs.existsSync(filePath))) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`semantic child barrier timed out: ${filePaths.join(", ")}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("BlueBubbles durable semantic store", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-semantic-store-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    vi.doUnmock("node:fs")
    vi.resetModules()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("publishes captures and handled receipts at the exact semantic paths with immutable no-clobber ordering", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture()
    const handled = makeHandled(capture)
    const operations: string[] = []
    const deps = semanticStoreDeps({ fs: createTracingFs(operations) })
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")

    const captureStart = operations.length
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, deps))
      .toBe("semantic_capture_published")
    const captureOperations = operations.slice(captureStart)
    const handledStart = operations.length
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", handled, deps))
      .toBe("semantic_handled_published")
    const handledOperations = operations.slice(handledStart)

    const capturePath = path.join(paths.captures, `${capture.keyHash}.json`)
    const handledPath = path.join(paths.handled, `${capture.keyHash}.json`)
    expect(fs.readFileSync(capturePath, "utf8")).toBe(serializeBlueBubblesSemanticJson(capture))
    expect(fs.readFileSync(handledPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(handled))
    for (const [directory, finalName, actualOperations] of [
      ["captures", `${capture.keyHash}.json`, captureOperations],
      ["handled", `${capture.keyHash}.json`, handledOperations],
    ] as const) {
      const tempName = `.${finalName}.4242.33333333-3333-4333-8333-333333333333.tmp`
      const ordered = [
        `open:${tempName}:wx`,
        `write:${tempName}`,
        `fsync:${tempName}`,
        `close:${tempName}`,
        `link:${tempName}->${finalName}`,
        `open:${directory}:r`,
        `fsync:${directory}`,
        `close:${directory}`,
        `unlink:${tempName}`,
      ]
      expect(actualOperations).toEqual(ordered)
      expect(actualOperations.some((entry) => (
        entry === `write:${finalName}` || entry.startsWith(`rename:`)
      ))).toBe(false)
    }
  })

  it("treats excluded capture aliases as equivalent duplicates and included evidence mismatches as collisions", async () => {
    const store = await loadSemanticStore()
    const original = makeSemanticCapture()
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const finalPath = path.join(paths.captures, `${original.keyHash}.json`)

    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", original, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    const equivalent = structuredClone(original)
    equivalent.capturedAt = "2026-07-30T18:02:01.000Z"
    equivalent.event.sourceEventType = "updated-message"
    equivalent.event.sessionKey = "repaired-session"
    equivalent.event.chatGuid = "repaired-chat"
    equivalent.event.chatIdentifier = "repaired-identifier"
    equivalent.event.rawTransportValue = "transport-alias"
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", equivalent, semanticStoreDeps()))
      .toBe("semantic_capture_duplicate")

    const collision = structuredClone(equivalent)
    collision.event.text = "different authoritative text"
    collision.event.textSha256 = sha256(collision.event.text)
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", collision, semanticStoreDeps()))
      .toBe("semantic_identity_collision")
    expect(fs.readFileSync(finalPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(original))
    expect(fs.readdirSync(paths.captures).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it.each([
    ["schemaVersion", (capture: SemanticCapture) => { (capture as unknown as { schemaVersion: number }).schemaVersion = 2 }],
    ["canonicalKey", (capture: SemanticCapture) => { capture.canonicalKey = JSON.stringify(["other-key"]) }],
    ["providerNamespace", (capture: SemanticCapture) => { capture.providerNamespace = ROTATED_PROVIDER_NAMESPACE }],
    ["provider", (capture: SemanticCapture) => { capture.event.provider = "other" as "bluebubbles" }],
    ["kind", (capture: SemanticCapture) => { capture.event.kind = "edit" }],
    ["eventGuid", (capture: SemanticCapture) => { capture.event.eventGuid = "different-guid" }],
    ["fromMe", (capture: SemanticCapture) => { capture.event.fromMe = true }],
    ["actor", (capture: SemanticCapture) => { capture.event.actor = { ...capture.event.actor, externalId: "other@example.com" } }],
    ["participants", (capture: SemanticCapture) => { capture.event.participants = [] }],
    ["text", (capture: SemanticCapture) => { capture.event.text = "different text" }],
    ["textSha256", (capture: SemanticCapture) => { capture.event.textSha256 = sha256("different digest") }],
    ["targetGuid", (capture: SemanticCapture) => { capture.event.targetGuid = "different-target" }],
    ["targetAuthorship", (capture: SemanticCapture) => { capture.event.targetAuthorship = "agent" }],
    ["canonicalAction", (capture: SemanticCapture) => { capture.event.canonicalAction = "add" }],
    ["canonicalValue", (capture: SemanticCapture) => { capture.event.canonicalValue = "love" }],
    ["effectiveAt", (capture: SemanticCapture) => { capture.event.effectiveAt = "2026-07-30T18:00:01.000Z" }],
    ["revision", (capture: SemanticCapture) => { capture.event.revision = "revision-two" }],
    ["contentSha256", (capture: SemanticCapture) => { capture.event.contentSha256 = sha256("other content") }],
  ])("treats an included %s mismatch as a semantic identity collision", async (field, mutate) => {
    const store = await loadSemanticStore()
    const original = makeSemanticCapture(`collision-${field}`)
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", original, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    const collision = structuredClone(original)
    mutate(collision)

    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", collision, semanticStoreDeps()))
      .toBe("semantic_identity_collision")
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", original.keyHash)).toEqual(original)
  })

  it("quarantines an existing capture whose internal keyHash disagrees with its authoritative path", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("capture-key-hash-mismatch")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.captures, { recursive: true })
    fs.writeFileSync(
      path.join(paths.captures, `${capture.keyHash}.json`),
      serializeBlueBubblesSemanticJson({ ...capture, keyHash: "f".repeat(64) }),
      "utf8",
    )

    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", capture.keyHash)).toEqual(capture)
    expect(fs.readdirSync(path.join(paths.quarantine, "capture"))).toHaveLength(1)
  })

  it("dedupes handled timestamps but fails closed on outcome collisions without overwriting authority", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture()
    const original = makeHandled(capture)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const finalPath = path.join(paths.handled, `${capture.keyHash}.json`)

    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", original, semanticStoreDeps()))
      .toBe("semantic_handled_published")
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", {
      ...original,
      handledAt: "2026-07-30T18:03:00.000Z",
    }, semanticStoreDeps())).toBe("semantic_handled_duplicate")
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", {
      ...original,
      handledAt: "2026-07-30T18:04:00.000Z",
      outcome: "message_failed",
      detailCode: "provider_error",
    }, semanticStoreDeps())).toBe("semantic_handled_collision")
    expect(fs.readFileSync(finalPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(original))
  })

  it.each([
    ["schemaVersion", { schemaVersion: 2 }],
    ["canonicalKey", { canonicalKey: JSON.stringify(["other-key"]) }],
    ["outcome", { outcome: "message_failed" }],
    ["detailCode", { detailCode: "provider_error" }],
  ])("treats handled %s independently as authoritative", async (_field, override) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`handled-collision-${_field}`)
    const original = makeHandled(capture)
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", original, semanticStoreDeps()))
      .toBe("semantic_handled_published")

    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", {
      ...original,
      ...override,
      handledAt: "2026-07-30T18:09:00.000Z",
    }, semanticStoreDeps())).toBe("semantic_handled_collision")
    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash)).toEqual(original)
  })

  it("quarantines an existing handled receipt whose internal keyHash disagrees with its authoritative path", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("handled-key-hash-mismatch")
    const handled = makeHandled(capture)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.handled, { recursive: true })
    fs.writeFileSync(
      path.join(paths.handled, `${capture.keyHash}.json`),
      serializeBlueBubblesSemanticJson({ ...handled, keyHash: "f".repeat(64) }),
      "utf8",
    )

    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", handled, semanticStoreDeps()))
      .toBe("semantic_handled_published")
    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash)).toEqual(handled)
    expect(fs.readdirSync(path.join(paths.quarantine, "handled"))).toHaveLength(1)
  })

  it("cleans unpublished temps and reports capture failure before publication", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture()
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const operations: string[] = []
    const deps = semanticStoreDeps({
      fs: createTracingFs(operations, { operation: "linkSync", code: "EIO" }),
    })

    expect(() => store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, deps))
      .toThrow("semantic_capture_failed")
    expect(fs.existsSync(path.join(paths.captures, `${capture.keyHash}.json`))).toBe(false)
    expect(fs.existsSync(paths.captures) ? fs.readdirSync(paths.captures) : []).toEqual([])
    expect(operations.some((entry) => entry.startsWith("unlink:"))).toBe(true)
  })

  it("reports a durability error after publication while leaving the visible capture recoverable", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture()
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const operations: string[] = []
    const deps = semanticStoreDeps({
      fs: createTracingFs(operations, {
        operation: "fsyncSync",
        matches: "fsync:captures",
        code: "EIO",
      }),
    })

    expect(() => store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, deps))
      .toThrow("semantic_capture_failed")
    expect(fs.existsSync(path.join(paths.captures, `${capture.keyHash}.json`))).toBe(true)
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", capture.keyHash)).toEqual(capture)
    expect(fs.readdirSync(paths.captures).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("reconciles a visible capture after durability was previously unknown", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("capture-durability-retry")
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        fs: createTracingFs([], {
          operation: "fsyncSync",
          matches: "fsync:captures",
          code: "EIO",
        }),
      }),
    )).toThrow("semantic_capture_failed")

    const retryOperations: string[] = []
    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ fs: createTracingFs(retryOperations) }),
    )).toBe("semantic_capture_duplicate")
    expect(retryOperations).toContain("open:captures:r")
    expect(retryOperations).toContain("fsync:captures")
    expect(retryOperations).toContain("close:captures")
  })

  it("keeps a capture pending when handled publication fails", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture()
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
      .toBe("semantic_capture_published")

    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      makeHandled(capture),
      semanticStoreDeps({
        fs: createTracingFs([], { operation: "linkSync", code: "ENOSPC" }),
      }),
    )).toThrow("semantic_handled_failed")
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", capture.keyHash)).toEqual(capture)
    expect(fs.existsSync(path.join(paths.handled, `${capture.keyHash}.json`))).toBe(false)
  })

  it("reports handled durability failure after publication while leaving the receipt recoverable", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("handled-post-publication")
    const handled = makeHandled(capture)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const operations: string[] = []

    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      handled,
      semanticStoreDeps({
        fs: createTracingFs(operations, {
          operation: "fsyncSync",
          matches: "fsync:handled",
          code: "EIO",
        }),
      }),
    )).toThrow("semantic_handled_failed")
    expect(fs.existsSync(path.join(paths.handled, `${capture.keyHash}.json`))).toBe(true)
    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash)).toEqual(handled)
    expect(fs.readdirSync(paths.handled).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("reconciles a visible handled receipt after durability was previously unknown", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("handled-durability-retry")
    const handled = makeHandled(capture)
    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      handled,
      semanticStoreDeps({
        fs: createTracingFs([], {
          operation: "fsyncSync",
          matches: "fsync:handled",
          code: "EIO",
        }),
      }),
    )).toThrow("semantic_handled_failed")

    const retryOperations: string[] = []
    expect(store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      handled,
      semanticStoreDeps({ fs: createTracingFs(retryOperations) }),
    )).toBe("semantic_handled_duplicate")
    expect(retryOperations).toContain("open:handled:r")
    expect(retryOperations).toContain("fsync:handled")
    expect(retryOperations).toContain("close:handled")
  })

  it("quarantines only a corrupt capture and still reads valid records before and after it", async () => {
    const store = await loadSemanticStore()
    const before = makeSemanticCapture("message-store-before", "2026-07-30T18:00:00.001Z")
    const corrupt = makeSemanticCapture("message-store-corrupt", "2026-07-30T18:00:00.002Z")
    const after = makeSemanticCapture("message-store-after", "2026-07-30T18:00:00.003Z")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    for (const capture of [before, corrupt, after]) {
      expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
        .toBe("semantic_capture_published")
    }
    fs.writeFileSync(path.join(paths.captures, `${corrupt.keyHash}.json`), "{torn", "utf8")

    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent", semanticStoreDeps()))
      .toEqual([before, after])
    expect(fs.existsSync(path.join(paths.captures, `${corrupt.keyHash}.json`))).toBe(false)
    const quarantineDir = path.join(paths.quarantine, "capture")
    expect(fs.readdirSync(quarantineDir)).toEqual([
      `${corrupt.keyHash}.json.${Date.parse("2026-07-30T18:02:00.000Z")}.33333333-3333-4333-8333-333333333333.json`,
    ])
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", before.keyHash)).toEqual(before)
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", after.keyHash)).toEqual(after)
  })

  it.each(["capture", "handled"] as const)(
    "revalidates a corrupt %s before quarantine so a valid replacement is never removed",
    async (recordKind) => {
      const store = await loadSemanticStore()
      const capture = makeSemanticCapture(`quarantine-replacement-${recordKind}`)
      const replacement = recordKind === "capture" ? capture : makeHandled(capture)
      const paths = getBlueBubblesSemanticPaths("synthetic-agent")
      const recordDirectory = recordKind === "capture" ? paths.captures : paths.handled
      const finalPath = path.join(recordDirectory, `${capture.keyHash}.json`)
      writeRawSemanticRecord(finalPath, "{torn")
      const tornBytes = fs.readFileSync(finalPath, "utf8")
      let replacementPublished = false
      const adapter = semanticFsAdapter({
        readFileSync: (...args: unknown[]) => {
          if (!replacementPublished && String(args[0]) === finalPath) {
            replacementPublished = true
            const writerDeps = semanticStoreDeps({
              randomUUID: () => "11111111-1111-4111-8111-111111111111",
            })
            if (recordKind === "capture") {
              expect(store.writeBlueBubblesSemanticCapture(
                "synthetic-agent",
                capture,
                writerDeps,
              )).toBe("semantic_capture_published")
            } else {
              expect(store.writeBlueBubblesSemanticHandled(
                "synthetic-agent",
                replacement,
                writerDeps,
              )).toBe("semantic_handled_published")
            }
            return tornBytes
          }
          return Reflect.apply(fs.readFileSync, fs, args)
        },
      })
      const readerDeps = semanticStoreDeps({
        fs: adapter,
        randomUUID: () => "22222222-2222-4222-8222-222222222222",
      })

      const observed = recordKind === "capture"
        ? store.readBlueBubblesSemanticCapture("synthetic-agent", capture.keyHash, readerDeps)
        : store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash, readerDeps)

      expect(observed).toEqual(replacement)
      expect(fs.readFileSync(finalPath, "utf8"))
        .toBe(serializeBlueBubblesSemanticJson(replacement))
      const quarantineDirectory = path.join(paths.quarantine, recordKind)
      const quarantineFiles = fs.readdirSync(quarantineDirectory)
      expect(quarantineFiles).toHaveLength(1)
      expect(fs.readFileSync(path.join(quarantineDirectory, quarantineFiles[0]!), "utf8"))
        .toBe(tornBytes)
    },
  )

  it("returns missing when another reader quarantines the invalid record before revalidation", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("quarantine-revalidation-missing")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const finalPath = path.join(paths.captures, `${capture.keyHash}.json`)
    writeRawSemanticRecord(finalPath, "{torn")
    const tornBytes = fs.readFileSync(finalPath, "utf8")
    let raced = false
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        if (!raced && String(args[0]) === finalPath) {
          raced = true
          expect(store.readBlueBubblesSemanticCapture(
            "synthetic-agent",
            capture.keyHash,
            semanticStoreDeps({
              randomUUID: () => "11111111-1111-4111-8111-111111111111",
            }),
          )).toBeNull()
          return tornBytes
        }
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })

    expect(store.readBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture.keyHash,
      semanticStoreDeps({ fs: adapter }),
    )).toBeNull()
    expect(fs.existsSync(finalPath)).toBe(false)
    const quarantineDirectory = path.join(paths.quarantine, "capture")
    const quarantineFiles = fs.readdirSync(quarantineDirectory)
    expect(quarantineFiles).toHaveLength(1)
    expect(fs.readFileSync(path.join(quarantineDirectory, quarantineFiles[0]!), "utf8"))
      .toBe(tornBytes)
  })

  it("reports degraded quarantine failure without deleting adjacent valid records", async () => {
    const store = await loadSemanticStore()
    const valid = makeSemanticCapture("message-store-valid")
    const corrupt = makeSemanticCapture("message-store-quarantine-failure")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    for (const capture of [valid, corrupt]) {
      store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps())
    }
    fs.writeFileSync(path.join(paths.captures, `${corrupt.keyHash}.json`), "{torn", "utf8")

    expect(() => store.readBlueBubblesSemanticCapture(
      "synthetic-agent",
      corrupt.keyHash,
      semanticStoreDeps({ fs: createTracingFs([], { operation: "linkSync", code: "EACCES" }) }),
    )).toThrow("semantic_quarantine_failed")
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", valid.keyHash)).toEqual(valid)
    expect(fs.existsSync(path.join(paths.captures, `${corrupt.keyHash}.json`))).toBe(true)
  })

  it("fails closed when corrupt capture racers repeatedly win after quarantine", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("capture-repeated-corrupt-race")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const finalPath = path.join(paths.captures, `${capture.keyHash}.json`)
    writeRawSemanticRecord(finalPath, "{initial-torn")
    let finalRaces = 0
    let uuidCounter = 0
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        if (String(args[1]) === finalPath && finalRaces++ < 2) {
          fs.writeFileSync(finalPath, `{raced-torn-${finalRaces}`, "utf8")
          throw codedError("EEXIST")
        }
        return Reflect.apply(fs.linkSync, fs, args)
      },
    })

    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        fs: adapter,
        randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
      }),
    )).toThrow("semantic_capture_failed")
    expect(fs.existsSync(finalPath)).toBe(false)
    expect(fs.readdirSync(path.join(paths.quarantine, "capture"))).toHaveLength(3)
  })

  it("serializes mutable coordinates through temp fsync, atomic rename, and directory fsync", async () => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["bb-sem-v1", PROVIDER_NAMESPACE, "reaction-coordinate", "event", "target", sha256("actor"), "custom"])
    const coordinateHash = sha256(coordinateKey)
    const operations: string[] = []
    const record = await store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      semanticStoreDeps({ fs: createTracingFs(operations) }),
    )
    const finalName = `${coordinateHash}.json`
    const tempName = `.${finalName}.4242.33333333-3333-4333-8333-333333333333.tmp`
    const mutableOrder = [
      `open:${tempName}:wx`,
      `write:${tempName}`,
      `fsync:${tempName}`,
      `close:${tempName}`,
      `rename:${tempName}->${finalName}`,
      "open:coordinates:r",
      "fsync:coordinates",
      "close:coordinates",
    ]

    expect(record).toEqual({
      schemaVersion: 1,
      coordinateKey,
      coordinateHash,
      generation: 0,
      lastAction: "add",
      updatedAt: "2026-07-30T18:02:00.000Z",
    })
    const mutableStart = operations.indexOf(`open:${tempName}:wx`)
    expect(operations.slice(mutableStart, mutableStart + mutableOrder.length)).toEqual(mutableOrder)
    expect(operations.some((entry) => entry === `link:${tempName}->${finalName}`)).toBe(false)
  })

  it("retains a coordinate generation for same-action duplicates and increments ordered changes", async () => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["coordinate", "ordered-action"])
    const coordinateHash = sha256(coordinateKey)
    let nowIndex = 0
    const instants = [
      "2026-07-30T18:02:00.000Z",
      "2026-07-30T18:02:01.000Z",
      "2026-07-30T18:02:02.000Z",
      "2026-07-30T18:02:03.000Z",
    ]
    const deps = semanticStoreDeps({ now: () => new Date(instants[nowIndex++] ?? instants.at(-1)!) })

    const add = await store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      deps,
    )
    const duplicate = await store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      deps,
    )
    const remove = await store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "remove" },
      deps,
    )
    const readd = await store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      deps,
    )

    expect(add.generation).toBe(0)
    expect(duplicate).toEqual(add)
    expect(remove.generation).toBe(1)
    expect(readd.generation).toBe(2)
  })

  it("quarantines corrupt or mismatched coordinates and never silently resets their generation", async () => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["coordinate", "invalid-state"])
    const coordinateHash = sha256(coordinateKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.coordinates, { recursive: true })
    fs.writeFileSync(path.join(paths.coordinates, `${coordinateHash}.json`), serializeBlueBubblesSemanticJson({
      schemaVersion: 1,
      coordinateKey: "different-key",
      coordinateHash,
      generation: 44,
      lastAction: "add",
      updatedAt: "2026-07-30T18:00:00.000Z",
    }), "utf8")

    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "remove" },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_coordinate_invalid")
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "remove" },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_coordinate_invalid")
    expect(fs.readdirSync(path.join(paths.quarantine, "coordinate"))).toHaveLength(1)
  })

  it("serializes same and opposite coordinate races across independent child processes", async () => {
    fs.mkdirSync(path.join(tmpRoot, "AgentBundles", "synthetic-agent.ouro"), { recursive: true })
    const sameKey = JSON.stringify(["coordinate", "cross-process-same"])
    const sameHash = sha256(sameKey)
    const sameResults = [path.join(tmpRoot, "same-a.json"), path.join(tmpRoot, "same-b.json")]
    const sameReady = [path.join(tmpRoot, "same-a.ready"), path.join(tmpRoot, "same-b.ready")]
    const samePrecommit = [path.join(tmpRoot, "same-a.precommit"), path.join(tmpRoot, "same-b.precommit")]
    const sameStart = path.join(tmpRoot, "same.start")
    const sameChildren = sameResults.map((resultPath, index) => runSemanticStoreChild({
      HOME: tmpRoot,
      BB_SEMANTIC_CHILD_MODE: "coordinate",
      BB_SEMANTIC_CHILD_AGENT: "synthetic-agent",
      BB_SEMANTIC_CHILD_COORDINATE_KEY: sameKey,
      BB_SEMANTIC_CHILD_COORDINATE_HASH: sameHash,
      BB_SEMANTIC_CHILD_ACTION: "add",
      BB_SEMANTIC_CHILD_RESULT: resultPath,
      BB_SEMANTIC_CHILD_READY: sameReady[index]!,
      BB_SEMANTIC_CHILD_START: sameStart,
      BB_SEMANTIC_CHILD_PRECOMMIT: samePrecommit[index]!,
      BB_SEMANTIC_CHILD_PEER_PRECOMMIT: samePrecommit[index === 0 ? 1 : 0]!,
    }))
    await waitForSemanticChildFiles(sameReady)
    fs.writeFileSync(sameStart, "go", "utf8")
    await Promise.all(sameChildren)
    const sameRecords = sameResults.map((resultPath) => JSON.parse(fs.readFileSync(resultPath, "utf8")))
    expect(sameRecords.map((record) => record.generation))
      .toEqual([0, 0])
    for (const record of sameRecords) {
      expect(record.ownerSnapshot).toEqual({
        schemaVersion: 1,
        canonicalKey: sameKey,
        keyHash: sameHash,
        owner: {
          operationId: `semantic-coordinate:${sameHash}`,
          pid: expect.any(Number),
          bootIdentity: expect.any(String),
          processStartedAt: expect.any(String),
          acquiredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        },
      })
      expect(record.ownerPath).toBe(`${sameHash}.owner.lock`)
    }
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").coordinates,
      `${sameHash}.owner.lock`,
    ))).toBe(false)

    const oppositeKey = JSON.stringify(["coordinate", "cross-process-opposite"])
    const oppositeHash = sha256(oppositeKey)
    const opposite = [
      { action: "add", resultPath: path.join(tmpRoot, "opposite-add.json") },
      { action: "remove", resultPath: path.join(tmpRoot, "opposite-remove.json") },
    ]
    const oppositeReady = opposite.map(({ action }) => path.join(tmpRoot, `opposite-${action}.ready`))
    const oppositePrecommit = opposite.map(({ action }) => path.join(tmpRoot, `opposite-${action}.precommit`))
    const oppositeStart = path.join(tmpRoot, "opposite.start")
    const oppositeChildren = opposite.map(({ action, resultPath }, index) => runSemanticStoreChild({
      HOME: tmpRoot,
      BB_SEMANTIC_CHILD_MODE: "coordinate",
      BB_SEMANTIC_CHILD_AGENT: "synthetic-agent",
      BB_SEMANTIC_CHILD_COORDINATE_KEY: oppositeKey,
      BB_SEMANTIC_CHILD_COORDINATE_HASH: oppositeHash,
      BB_SEMANTIC_CHILD_ACTION: action,
      BB_SEMANTIC_CHILD_RESULT: resultPath,
      BB_SEMANTIC_CHILD_READY: oppositeReady[index]!,
      BB_SEMANTIC_CHILD_START: oppositeStart,
      BB_SEMANTIC_CHILD_PRECOMMIT: oppositePrecommit[index]!,
      BB_SEMANTIC_CHILD_PEER_PRECOMMIT: oppositePrecommit[index === 0 ? 1 : 0]!,
    }))
    await waitForSemanticChildFiles(oppositeReady)
    fs.writeFileSync(oppositeStart, "go", "utf8")
    await Promise.all(oppositeChildren)
    const raced = opposite.map(({ resultPath }) => JSON.parse(fs.readFileSync(resultPath, "utf8")))
    expect(raced.map((record) => record.generation).sort()).toEqual([0, 1])
    const finalRecord = JSON.parse(fs.readFileSync(
      path.join(getBlueBubblesSemanticPaths("synthetic-agent").coordinates, `${oppositeHash}.json`),
      "utf8",
    ))
    expect(finalRecord.generation).toBe(1)
    expect(finalRecord.lastAction).toBe(raced.find((record) => record.generation === 1)?.lastAction)
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").coordinates,
      `${oppositeHash}.owner.lock`,
    ))).toBe(false)
  }, 30_000)

  it("refuses a live coordinate owner under the same 50 ms and 5,000 ms liveness contract", async () => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["coordinate", "live-owner"])
    const coordinateHash = sha256(coordinateKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.coordinates, { recursive: true })
    const ownerPath = path.join(paths.coordinates, `${coordinateHash}.owner.lock`)
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: coordinateKey,
      keyHash: coordinateHash,
      operationId: `semantic-coordinate:${coordinateHash}`,
      pid: 9101,
      bootIdentity: "boot-current",
      processStartedAt: "coordinate-owner-start",
      acquiredAt: "2026-07-30T18:00:00.000Z",
    })
    fs.writeFileSync(ownerPath, serializeBlueBubblesSemanticJson(owner), "utf8")
    let elapsed = 0
    const sleeps: number[] = []

    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      semanticStoreDeps({
        pid: () => 9102,
        now: () => new Date(Date.parse("2026-07-30T18:02:00.000Z") + elapsed),
        isProcessAlive: (pid) => pid === 9101,
        processStartedAt: (pid) => pid === 9101 ? "coordinate-owner-start" : "contender-start",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          elapsed += milliseconds
        },
      }),
    )).rejects.toThrow("semantic_coordinate_lock_timeout")
    expect(sleeps).toHaveLength(100)
    expect(new Set(sleeps)).toEqual(new Set([50]))
    expect(fs.readFileSync(ownerPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(owner))
  })

  it.each([
    ["different boot", { bootIdentity: "boot-old", alive: true, startedAt: "same-start" }],
    ["dead pid", { bootIdentity: "boot-current", alive: false, startedAt: "same-start" }],
    ["recycled pid", { bootIdentity: "boot-current", alive: true, startedAt: "old-start" }],
  ])("recovers a coordinate owner with %s identity", async (_label, stale) => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["coordinate", `recover-${_label}`])
    const coordinateHash = sha256(coordinateKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.coordinates, { recursive: true })
    const ownerPath = path.join(paths.coordinates, `${coordinateHash}.owner.lock`)
    fs.writeFileSync(ownerPath, serializeBlueBubblesSemanticJson(
      buildBlueBubblesSemanticClaimRecord({
        canonicalKey: coordinateKey,
        keyHash: coordinateHash,
        operationId: `semantic-coordinate:${coordinateHash}`,
        pid: 9201,
        bootIdentity: stale.bootIdentity,
        processStartedAt: stale.startedAt,
        acquiredAt: "2026-07-30T18:00:00.000Z",
      }),
    ), "utf8")

    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      semanticStoreDeps({
        pid: () => 9202,
        isProcessAlive: (pid) => pid === 9201 ? stale.alive : true,
        processStartedAt: (pid) => pid === 9201 ? "same-start" : "new-start",
      }),
    )).resolves.toMatchObject({ generation: 0, lastAction: "add" })
    expect(fs.existsSync(ownerPath)).toBe(false)
  })

  it("fails closed when coordinate-owner liveness cannot be probed", async () => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["coordinate", "probe-failure"])
    const coordinateHash = sha256(coordinateKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.coordinates, { recursive: true })
    const ownerPath = path.join(paths.coordinates, `${coordinateHash}.owner.lock`)
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: coordinateKey,
      keyHash: coordinateHash,
      operationId: `semantic-coordinate:${coordinateHash}`,
      pid: 9301,
      bootIdentity: "boot-current",
      processStartedAt: "coordinate-owner-start",
      acquiredAt: "2026-07-30T18:00:00.000Z",
    })
    fs.writeFileSync(ownerPath, serializeBlueBubblesSemanticJson(owner), "utf8")

    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "add" },
      semanticStoreDeps({ isProcessAlive: () => { throw new Error("probe unavailable") } }),
    )).rejects.toThrow("semantic_coordinate_liveness_failed")
    expect(fs.readFileSync(ownerPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(owner))
  })

  it("serializes simultaneous same-key claims across processes while allowing different keys to overlap", async () => {
    fs.mkdirSync(path.join(tmpRoot, "AgentBundles", "synthetic-agent.ouro"), { recursive: true })
    const runClaimRace = async (
      label: string,
      identities: Array<{ canonicalKey: string; keyHash: string }>,
    ) => {
      const startPath = path.join(tmpRoot, `${label}.start`)
      const readyPaths = identities.map((_, index) => path.join(tmpRoot, `${label}-${index}.ready`))
      const resultPaths = identities.map((_, index) => path.join(tmpRoot, `${label}-${index}.json`))
      const children = identities.map((identity, index) => runSemanticStoreChild({
        HOME: tmpRoot,
        BB_SEMANTIC_CHILD_MODE: "claim",
        BB_SEMANTIC_CHILD_AGENT: "synthetic-agent",
        BB_SEMANTIC_CHILD_CANONICAL_KEY: identity.canonicalKey,
        BB_SEMANTIC_CHILD_KEY_HASH: identity.keyHash,
        BB_SEMANTIC_CHILD_READY: readyPaths[index]!,
        BB_SEMANTIC_CHILD_START: startPath,
        BB_SEMANTIC_CHILD_RESULT: resultPaths[index]!,
        BB_SEMANTIC_CHILD_HOLD_MS: "250",
      }))
      await waitForSemanticChildFiles(readyPaths)
      fs.writeFileSync(startPath, "go", "utf8")
      await Promise.all(children)
      return resultPaths.map((resultPath) => JSON.parse(fs.readFileSync(resultPath, "utf8")))
    }

    const sharedKey = JSON.stringify(["claim", "shared"])
    const sharedHash = sha256(sharedKey)
    const sameKey = await runClaimRace("same-claim", [
      { canonicalKey: sharedKey, keyHash: sharedHash },
      { canonicalKey: sharedKey, keyHash: sharedHash },
    ])
    const orderedSame = [...sameKey].sort((left, right) => left.acquiredAtMs - right.acquiredAtMs)
    expect(orderedSame[1].acquiredAtMs).toBeGreaterThanOrEqual(orderedSame[0].releasedAtMs)
    for (const result of sameKey) {
      expect(result.ownerSnapshot.owner.operationId).toBe(`semantic-handle:${sharedHash}`)
      expect(result.ownerSnapshot.owner.pid).toEqual(expect.any(Number))
    }
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${sharedHash}.owner.json`,
    ))).toBe(false)

    const firstKey = JSON.stringify(["claim", "independent-a"])
    const secondKey = JSON.stringify(["claim", "independent-b"])
    const differentKeys = await runClaimRace("different-claim", [
      { canonicalKey: firstKey, keyHash: sha256(firstKey) },
      { canonicalKey: secondKey, keyHash: sha256(secondKey) },
    ])
    expect(Math.max(...differentKeys.map((result) => result.acquiredAtMs)))
      .toBeLessThan(Math.min(...differentKeys.map((result) => result.releasedAtMs)))
  }, 30_000)

  it("creates a versioned SQLite ownership authority while retaining canonical JSON evidence", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("sqlite-ownership-authority")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const ownershipPath = path.join(paths.root, "ownership.sqlite")
    const lease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )

    expect(lease.status).toBe("acquired")
    expect(fs.readFileSync(ownershipPath).subarray(0, 16).toString("binary"))
      .toBe("SQLite format 3\u0000")
    const ownership = new Database(ownershipPath, { readonly: true })
    try {
      expect(ownership.pragma("user_version", { simple: true })).toBe(1)
      expect(ownership.pragma("journal_mode", { simple: true })).toBe("delete")
      expect(ownership.pragma("synchronous", { simple: true })).toBe(2)
      expect(ownership.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_leases'",
      ).pluck().get()).toBe(
        "CREATE TABLE owner_leases (\n"
        + "      resource_key TEXT PRIMARY KEY,\n"
        + "      lease_id TEXT NOT NULL,\n"
        + "      owner_json TEXT NOT NULL\n"
        + "    ) STRICT, WITHOUT ROWID",
      )
      expect(ownership.prepare(
        "SELECT resource_key, lease_id, owner_json FROM owner_leases",
      ).get()).toEqual({
        resource_key: `claim:${capture.keyHash}`,
        lease_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        owner_json: serializeBlueBubblesSemanticJson(
          (lease as SemanticClaimLeaseForTest).record,
        ),
      })
    } finally {
      ownership.close()
    }
    expect(fs.readFileSync(
      path.join(paths.claims, `${capture.keyHash}.owner.json`),
      "utf8",
    )).toBe(serializeBlueBubblesSemanticJson(
      (lease as SemanticClaimLeaseForTest).record,
    ))
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      lease as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)
    expect(fs.existsSync(ownershipPath)).toBe(true)
    const releasedOwnership = new Database(ownershipPath, { readonly: true })
    try {
      expect(releasedOwnership.prepare("SELECT count(*) FROM owner_leases").pluck().get()).toBe(0)
    } finally {
      releasedOwnership.close()
    }
  })

  it("rolls back ownership when the coordinator directory durability barrier fails", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("sqlite-directory-fsync-failure")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const operations: string[] = []

    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        fs: createTracingFs(operations, {
          operation: "fsyncSync",
          matches: "fsync:semantic-receipts",
          code: "EIO",
        }),
      }),
    )).rejects.toThrow("synthetic EIO")

    const ownership = new Database(paths.ownership, { readonly: true })
    try {
      const tableCount = ownership.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'owner_leases'",
      ).pluck().get()
      if (tableCount === 1) {
        expect(ownership.prepare("SELECT count(*) FROM owner_leases").pluck().get()).toBe(0)
      }
    } finally {
      ownership.close()
    }
    expect(fs.existsSync(path.join(paths.claims, `${capture.keyHash}.owner.json`))).toBe(false)
    expect(operations).toContain("fsync:semantic-receipts")

    const retry = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )
    expect(retry.status).toBe("acquired")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      retry as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)
  })

  it("polls SQLite write contention in exact 50 ms steps outside SQLite", async () => {
    const store = await loadSemanticStore()
    const seed = makeSemanticCapture("sqlite-busy-seed")
    const seedLease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      seed,
      semanticStoreDeps(),
    )
    expect(seedLease.status).toBe("acquired")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      seedLease as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)

    const ownershipPath = path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").root,
      "ownership.sqlite",
    )
    const blocker = new Database(ownershipPath)
    blocker.pragma("busy_timeout = 0")
    blocker.exec("BEGIN IMMEDIATE")
    const capture = makeSemanticCapture("sqlite-busy-retry")
    const sleeps: number[] = []
    try {
      const lease = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds)
            blocker.exec("COMMIT")
          },
        }),
      )
      expect(lease.status).toBe("acquired")
      expect(sleeps).toEqual([50])
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        lease as SemanticClaimLeaseForTest,
        semanticStoreDeps(),
      )).toBe(true)
    } finally {
      if (blocker.inTransaction) blocker.exec("ROLLBACK")
      blocker.close()
    }
  })

  it("polls corrupt-record quarantine contention and fails closed at exactly 5,000 ms", async () => {
    const store = await loadSemanticStore()
    const seed = makeSemanticCapture("quarantine-authority-busy-seed")
    const seedLease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      seed,
      semanticStoreDeps(),
    )
    expect(seedLease.status).toBe("acquired")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      seedLease as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)

    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const retried = makeSemanticCapture("quarantine-authority-busy-retry")
    const retriedPath = path.join(paths.captures, `${retried.keyHash}.json`)
    writeRawSemanticRecord(retriedPath, "{torn")
    const retryBlocker = new Database(paths.ownership)
    retryBlocker.pragma("busy_timeout = 0")
    retryBlocker.exec("BEGIN")
    retryBlocker.prepare("SELECT count(*) FROM owner_leases").pluck().get()
    const sleeps: number[] = []
    try {
      expect(store.readBlueBubblesSemanticCapture(
        "synthetic-agent",
        retried.keyHash,
        semanticStoreDeps({
          sleepSync: (milliseconds) => {
            sleeps.push(milliseconds)
            retryBlocker.exec("COMMIT")
          },
        }),
      )).toBeNull()
      expect(sleeps).toEqual([50])
      expect(fs.existsSync(retriedPath)).toBe(false)
    } finally {
      if (retryBlocker.inTransaction) retryBlocker.exec("ROLLBACK")
      retryBlocker.close()
    }

    const timedOut = makeSemanticCapture("quarantine-authority-busy-timeout")
    const timedOutPath = path.join(paths.captures, `${timedOut.keyHash}.json`)
    writeRawSemanticRecord(timedOutPath, "{still-torn")
    const timeoutBlocker = new Database(paths.ownership)
    timeoutBlocker.pragma("busy_timeout = 0")
    timeoutBlocker.exec("BEGIN")
    timeoutBlocker.prepare("SELECT count(*) FROM owner_leases").pluck().get()
    let clockCalls = 0
    const sleepSync = vi.fn()
    try {
      expect(() => store.readBlueBubblesSemanticCapture(
        "synthetic-agent",
        timedOut.keyHash,
        semanticStoreDeps({
          now: () => new Date(Date.parse(CAPTURED_AT) + (clockCalls++ === 0 ? 0 : 5_000)),
          sleepSync,
        }),
      )).toThrow("semantic_ownership_busy")
      expect(sleepSync).not.toHaveBeenCalled()
      expect(fs.readFileSync(timedOutPath, "utf8")).toBe("{still-torn")
    } finally {
      timeoutBlocker.exec("ROLLBACK")
      timeoutBlocker.close()
    }
  })

  it("acquires SQLite exclusion before publishing owner evidence that must survive commit", async () => {
    const store = await loadSemanticStore()
    const seed = makeSemanticCapture("sqlite-reader-contention-seed")
    const seedLease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      seed,
      semanticStoreDeps(),
    )
    expect(seedLease.status).toBe("acquired")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      seedLease as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)

    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const reader = new Database(paths.ownership)
    reader.pragma("busy_timeout = 0")
    reader.exec("BEGIN")
    reader.prepare("SELECT count(*) FROM owner_leases").pluck().get()
    const capture = makeSemanticCapture("sqlite-reader-contention-acquire")
    const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    const evidenceObservedDuringSleep: boolean[] = []
    let clockOffsetMs = 0
    try {
      const lease = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({
          now: () => new Date(Date.parse(CAPTURED_AT) + clockOffsetMs),
          sleep: async () => {
            evidenceObservedDuringSleep.push(fs.existsSync(ownerPath))
            reader.exec("COMMIT")
            clockOffsetMs += 5_000
          },
        }),
      )

      expect(evidenceObservedDuringSleep).toEqual([false])
      expect(lease.status).toBe("acquired")
      const ownership = new Database(paths.ownership, { readonly: true })
      try {
        expect(ownership.prepare(
          "SELECT resource_key, owner_json FROM owner_leases WHERE resource_key = ?",
        ).get(`claim:${capture.keyHash}`)).toEqual({
          resource_key: `claim:${capture.keyHash}`,
          owner_json: serializeBlueBubblesSemanticJson(
            (lease as SemanticClaimLeaseForTest).record,
          ),
        })
      } finally {
        ownership.close()
      }
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        lease as SemanticClaimLeaseForTest,
        semanticStoreDeps(),
      )).toBe(true)
    } finally {
      if (reader.inTransaction) reader.exec("ROLLBACK")
      reader.close()
    }
  })

  it("polls release contention outside SQLite and fails closed at exactly 5,000 ms", async () => {
    const store = await loadSemanticStore()
    const acquire = async (label: string) => {
      const capture = makeSemanticCapture(label)
      const lease = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps(),
      )
      expect(lease.status).toBe("acquired")
      return lease as SemanticClaimLeaseForTest
    }
    const ownershipPath = path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").root,
      "ownership.sqlite",
    )

    const retried = await acquire("sqlite-release-busy-retry")
    const retryBlocker = new Database(ownershipPath)
    retryBlocker.pragma("busy_timeout = 0")
    retryBlocker.exec("BEGIN IMMEDIATE")
    const sleeps: number[] = []
    try {
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        retried,
        semanticStoreDeps({
          sleepSync: (milliseconds) => {
            sleeps.push(milliseconds)
            retryBlocker.exec("COMMIT")
          },
        }),
      )).toBe(true)
      expect(sleeps).toEqual([50])
    } finally {
      if (retryBlocker.inTransaction) retryBlocker.exec("ROLLBACK")
      retryBlocker.close()
    }

    const timedOut = await acquire("sqlite-release-busy-timeout")
    const timeoutBlocker = new Database(ownershipPath)
    timeoutBlocker.pragma("busy_timeout = 0")
    timeoutBlocker.exec("BEGIN IMMEDIATE")
    let clockCalls = 0
    const sleepSync = vi.fn()
    try {
      expect(() => store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        timedOut,
        semanticStoreDeps({
          now: () => new Date(Date.parse(CAPTURED_AT) + (clockCalls++ === 0 ? 0 : 5_000)),
          sleepSync,
        }),
      )).toThrow("semantic_ownership_busy")
      expect(sleepSync).not.toHaveBeenCalled()
    } finally {
      timeoutBlocker.exec("ROLLBACK")
      timeoutBlocker.close()
    }
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      timedOut,
      semanticStoreDeps(),
    )).toBe(true)
  })

  it("uses the blocking 50 ms fallback while another process owns the SQLite writer", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("sqlite-release-cross-process-busy")
    const lease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
    )
    expect(lease.status).toBe("acquired")
    const readyPath = path.join(tmpRoot, "ownership-lock.ready")
    const child = runSemanticStoreChild({
      HOME: tmpRoot,
      BB_SEMANTIC_CHILD_MODE: "ownership-lock",
      BB_SEMANTIC_CHILD_AGENT: "synthetic-agent",
      BB_SEMANTIC_CHILD_READY: readyPath,
      BB_SEMANTIC_CHILD_HOLD_MS: "125",
    })
    await waitForSemanticChildFiles([readyPath])

    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      lease as SemanticClaimLeaseForTest,
    )).toBe(true)
    await child
  }, 30_000)

  it.each([
    ["version", (ownership: Database.Database) => {
      ownership.pragma("user_version = 2")
    }],
    ["shape", (ownership: Database.Database) => {
      ownership.exec(
        "CREATE TABLE owner_leases (resource_key TEXT PRIMARY KEY, lease_id TEXT, owner_json TEXT) STRICT, WITHOUT ROWID",
      )
      ownership.pragma("user_version = 1")
    }],
  ])("fails closed on an invalid ownership schema %s", async (label, corrupt) => {
    const store = await loadSemanticStore()
    const agentName = `invalid-ownership-schema-${label}`
    const paths = getBlueBubblesSemanticPaths(agentName)
    fs.mkdirSync(paths.root, { recursive: true })
    const ownership = new Database(path.join(paths.root, "ownership.sqlite"))
    corrupt(ownership)
    ownership.close()

    await expect(store.acquireBlueBubblesSemanticClaim(
      agentName,
      makeSemanticCapture(`invalid-ownership-schema-${label}`),
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_ownership_invalid")
  })

  it("fails closed on corrupt SQLite database bytes", async () => {
    const store = await loadSemanticStore()
    const agentName = "corrupt-ownership-database"
    const paths = getBlueBubblesSemanticPaths(agentName)
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(path.join(paths.root, "ownership.sqlite"), "not a sqlite database", "utf8")

    await expect(store.acquireBlueBubblesSemanticClaim(
      agentName,
      makeSemanticCapture("corrupt-ownership-database"),
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_ownership_invalid")
  })

  it.each([
    ["lease id", (row: { lease_id: string; owner_json: string }) => ({
      lease_id: "invalid",
      owner_json: row.owner_json,
    })],
    ["JSON", (row: { lease_id: string; owner_json: string }) => ({
      lease_id: row.lease_id,
      owner_json: "{torn",
    })],
    ["canonical bytes", (row: { lease_id: string; owner_json: string }) => ({
      lease_id: row.lease_id,
      owner_json: `${row.owner_json} `,
    })],
  ])("fails closed on corrupt ownership-row %s", async (label, corrupt) => {
    const store = await loadSemanticStore()
    const agentName = `corrupt-ownership-row-${label.replace(" ", "-")}`
    const capture = makeSemanticCapture(`corrupt-ownership-row-${label}`)
    const acquired = await store.acquireBlueBubblesSemanticClaim(
      agentName,
      capture,
      semanticStoreDeps(),
    )
    expect(acquired.status).toBe("acquired")
    const ownership = new Database(path.join(
      getBlueBubblesSemanticPaths(agentName).root,
      "ownership.sqlite",
    ))
    const row = ownership.prepare(
      "SELECT lease_id, owner_json FROM owner_leases WHERE resource_key = ?",
    ).get(`claim:${capture.keyHash}`) as { lease_id: string; owner_json: string }
    const corrupted = corrupt(row)
    ownership.prepare(
      "UPDATE owner_leases SET lease_id = ?, owner_json = ? WHERE resource_key = ?",
    ).run(corrupted.lease_id, corrupted.owner_json, `claim:${capture.keyHash}`)
    ownership.close()

    await expect(store.acquireBlueBubblesSemanticClaim(
      agentName,
      capture,
      semanticStoreDeps({ pid: () => 4343 }),
    )).rejects.toThrow("semantic_ownership_invalid")
  })

  it("recovers an abandoned cross-process claim through the durable coordinator", async () => {
    const store = await loadSemanticStore()
    fs.mkdirSync(path.join(tmpRoot, "AgentBundles", "synthetic-agent.ouro"), { recursive: true })
    const canonicalKey = JSON.stringify(["claim", "abandoned-cross-process"])
    const keyHash = sha256(canonicalKey)
    const readyPath = path.join(tmpRoot, "abandoned.ready")
    const startPath = path.join(tmpRoot, "abandoned.start")
    const resultPath = path.join(tmpRoot, "abandoned.json")
    const child = runSemanticStoreChild({
      HOME: tmpRoot,
      BB_SEMANTIC_CHILD_MODE: "claim-abandon",
      BB_SEMANTIC_CHILD_AGENT: "synthetic-agent",
      BB_SEMANTIC_CHILD_CANONICAL_KEY: canonicalKey,
      BB_SEMANTIC_CHILD_KEY_HASH: keyHash,
      BB_SEMANTIC_CHILD_READY: readyPath,
      BB_SEMANTIC_CHILD_START: startPath,
      BB_SEMANTIC_CHILD_RESULT: resultPath,
    })
    await waitForSemanticChildFiles([readyPath])
    fs.writeFileSync(startPath, "go", "utf8")
    await child

    const abandoned = JSON.parse(fs.readFileSync(resultPath, "utf8"))
    expect(abandoned.pid).toEqual(expect.any(Number))
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${keyHash}.owner.json`,
    ))).toBe(true)

    const replacement = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      { canonicalKey, keyHash },
    )
    expect(replacement.status).toBe("acquired")
    expect(replacement.status === "acquired" && replacement.record.owner.pid)
      .not.toBe(abandoned.pid)
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      replacement as SemanticClaimLeaseForTest,
    )).toBe(true)
    expect(fs.readFileSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").root,
      "ownership.sqlite",
    )).subarray(0, 16).toString("binary")).toBe("SQLite format 3\u0000")
  }, 30_000)

  it("allows one claimant per key, waits in 50 ms steps, and lets different keys proceed independently", async () => {
    const store = await loadSemanticStore()
    const firstCapture = makeSemanticCapture("claim-key-one")
    const secondCapture = makeSemanticCapture("claim-key-two")
    const firstDeps = semanticStoreDeps({
      pid: () => 1001,
      processStartedAt: (pid) => pid === 1001 ? "process-a" : "process-b",
    })
    const first = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      firstCapture,
      firstDeps,
    )
    expect(first.status).toBe("acquired")

    const sleeps: number[] = []
    let released = false
    const waiting = store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      firstCapture,
      semanticStoreDeps({
        pid: () => 1002,
        processStartedAt: (pid) => pid === 1001 ? "process-a" : "process-b",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          if (!released) {
            released = true
            expect(store.releaseBlueBubblesSemanticClaim(
              "synthetic-agent",
              first as SemanticClaimLeaseForTest,
              firstDeps,
            )).toBe(true)
          }
        },
      }),
    )
    const independent = store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      secondCapture,
      semanticStoreDeps({ pid: () => 1003 }),
    )
    const [next, other] = await Promise.all([waiting, independent])
    expect(next.status).toBe("acquired")
    expect(other.status).toBe("acquired")
    expect(sleeps).toEqual([50])
    expect((next as SemanticClaimLeaseForTest).record.owner.pid).toBe(1002)
    expect((other as SemanticClaimLeaseForTest).record.owner.pid).toBe(1003)
  })

  it("never breaks a demonstrably live owner and times out after exactly 5,000 ms", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("claim-live-owner")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.claims, { recursive: true })
    const live = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 9001,
      bootIdentity: "boot-current",
      processStartedAt: "live-start",
      acquiredAt: "2026-07-30T18:00:00.000Z",
    })
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    fs.writeFileSync(claimPath, serializeBlueBubblesSemanticJson(live), "utf8")
    let elapsed = 0
    const sleeps: number[] = []

    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        pid: () => 9002,
        now: () => new Date(Date.parse("2026-07-30T18:02:00.000Z") + elapsed),
        isProcessAlive: (pid) => pid === 9001,
        processStartedAt: (pid) => pid === 9001 ? "live-start" : "contender-start",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          elapsed += milliseconds
        },
      }),
    )).resolves.toEqual({ status: "timeout", code: "semantic_claim_timeout" })
    expect(sleeps).toHaveLength(100)
    expect(new Set(sleeps)).toEqual(new Set([50]))
    expect(elapsed).toBe(5_000)
    expect(fs.readFileSync(claimPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(live))
  })

  it.each([
    ["different boot", { bootIdentity: "boot-old", alive: true, startedAt: "same-start" }],
    ["dead pid", { bootIdentity: "boot-current", alive: false, startedAt: "same-start" }],
    ["recycled pid", { bootIdentity: "boot-current", alive: true, startedAt: "old-start" }],
  ])("recovers an owner with %s identity", async (_label, stale) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`recover-${_label}`)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.claims, { recursive: true })
    fs.writeFileSync(path.join(paths.claims, `${capture.keyHash}.owner.json`), serializeBlueBubblesSemanticJson(
      buildBlueBubblesSemanticClaimRecord({
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        operationId: `semantic-handle:${capture.keyHash}`,
        pid: 7001,
        bootIdentity: stale.bootIdentity,
        processStartedAt: stale.startedAt,
        acquiredAt: "2026-07-30T18:00:00.000Z",
      }),
    ), "utf8")

    const result = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        pid: () => 7002,
        isProcessAlive: (pid) => pid === 7001 ? stale.alive : true,
        processStartedAt: (pid) => pid === 7001 ? "same-start" : "new-start",
      }),
    )
    expect(result.status).toBe("acquired")
    expect((result as SemanticClaimLeaseForTest).record.owner.pid).toBe(7002)
  })

  it("fails closed when owner liveness cannot be probed", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("claim-probe-failure")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.claims, { recursive: true })
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 8001,
      bootIdentity: "boot-current",
      processStartedAt: "owner-start",
      acquiredAt: "2026-07-30T18:00:00.000Z",
    })
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    fs.writeFileSync(claimPath, serializeBlueBubblesSemanticJson(owner), "utf8")

    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ isProcessAlive: () => { throw new Error("probe unavailable") } }),
    )).rejects.toThrow("semantic_claim_liveness_failed")
    expect(fs.readFileSync(claimPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(owner))
  })

  it("does not let a stale lease release a replacement owner", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("stale-release")
    const first = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ pid: () => 6001 }),
    )
    expect(first.status).toBe("acquired")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    const replacement = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 6002,
      bootIdentity: "boot-current",
      processStartedAt: "replacement-start",
      acquiredAt: "2026-07-30T18:03:00.000Z",
    })
    fs.unlinkSync(claimPath)
    fs.writeFileSync(claimPath, serializeBlueBubblesSemanticJson(replacement), "utf8")

    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      first as SemanticClaimLeaseForTest,
      semanticStoreDeps({ pid: () => 6001 }),
    )).toBe(false)
    expect(fs.readFileSync(claimPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(replacement))
  })

  it("does not unlink a replacement owner inserted after release reads the stale lease", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("release-read-unlink-race")
    const first = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ pid: () => 6101 }),
    )
    expect(first.status).toBe("acquired")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    const replacement = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 6102,
      bootIdentity: "boot-current",
      processStartedAt: "replacement-start",
      acquiredAt: "2026-07-30T18:03:00.000Z",
    })
    let replaced = false
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        const bytes = Reflect.apply(fs.readFileSync, fs, args)
        if (!replaced && String(args[0]) === claimPath) {
          replaced = true
          fs.unlinkSync(claimPath)
          fs.writeFileSync(claimPath, serializeBlueBubblesSemanticJson(replacement), "utf8")
        }
        return bytes
      },
    })

    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      first as SemanticClaimLeaseForTest,
      semanticStoreDeps({ fs: adapter, pid: () => 6101 }),
    )).toBe(false)
    expect(fs.readFileSync(claimPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(replacement))
  })

  it.each(["missing", "invalid", "mismatch"] as const)(
    "reconciles %s JSON evidence from a live transactional owner before waiting",
    async (state) => {
      const store = await loadSemanticStore()
      const capture = makeSemanticCapture(`live-owner-evidence-${state}`)
      const firstDeps = semanticStoreDeps({ pid: () => 6201 })
      const first = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        firstDeps,
      )
      expect(first.status).toBe("acquired")
      const paths = getBlueBubblesSemanticPaths("synthetic-agent")
      const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
      const firstBytes = serializeBlueBubblesSemanticJson(
        (first as SemanticClaimLeaseForTest).record,
      )
      if (state === "missing") {
        fs.unlinkSync(claimPath)
      } else if (state === "invalid") {
        fs.writeFileSync(claimPath, "{torn", "utf8")
      } else {
        fs.writeFileSync(claimPath, serializeBlueBubblesSemanticJson(
          buildBlueBubblesSemanticClaimRecord({
            canonicalKey: capture.canonicalKey,
            keyHash: capture.keyHash,
            operationId: `semantic-handle:${capture.keyHash}`,
            pid: 6202,
            bootIdentity: "boot-current",
            processStartedAt: "replacement-start",
            acquiredAt: "2026-07-30T18:03:00.000Z",
          }),
        ), "utf8")
      }

      await expect(store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({
          pid: () => 6203,
          processStartedAt: (pid) => pid === 6201 ? "process-6201" : "process-6203",
          sleep: async () => { throw new Error("reconciliation-observed") },
        }),
      )).rejects.toThrow("reconciliation-observed")
      expect(fs.readFileSync(claimPath, "utf8")).toBe(firstBytes)
      if (state === "missing") {
        expect(fs.existsSync(path.join(paths.quarantine, "claim"))).toBe(false)
      } else {
        expect(fs.readdirSync(path.join(paths.quarantine, "claim"))).toHaveLength(1)
      }
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        first as SemanticClaimLeaseForTest,
        firstDeps,
      )).toBe(true)
    },
  )

  it.each(["exact", "mismatch", "invalid"] as const)(
    "resolves an uncoordinated %s owner-evidence race before publishing a lease",
    async (state) => {
      const store = await loadSemanticStore()
      const capture = makeSemanticCapture(`owner-evidence-race-${state}`)
      const paths = getBlueBubblesSemanticPaths("synthetic-agent")
      const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
      const candidate = buildBlueBubblesSemanticClaimRecord({
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        operationId: `semantic-handle:${capture.keyHash}`,
        pid: 4242,
        bootIdentity: "boot-current",
        processStartedAt: "process-4242",
        acquiredAt: "2026-07-30T18:02:00.000Z",
      })
      const raced = state === "exact" ? candidate : buildBlueBubblesSemanticClaimRecord({
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        operationId: `semantic-handle:${capture.keyHash}`,
        pid: 6252,
        bootIdentity: "boot-current",
        processStartedAt: "raced-start",
        acquiredAt: "2026-07-30T18:03:00.000Z",
      })
      let ownerLstatCalls = 0
      const adapter = semanticFsAdapter({
        lstatSync: (...args: unknown[]) => {
          if (String(args[0]) === claimPath && ++ownerLstatCalls === 2) {
            if (state === "invalid") writeRawSemanticRecord(claimPath, "{torn")
            else writeRawSemanticRecord(claimPath, raced)
          }
          return Reflect.apply(fs.lstatSync, fs, args)
        },
      })

      const acquired = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({ fs: adapter }),
      )
      expect(acquired.status).toBe("acquired")
      expect(fs.readFileSync(claimPath, "utf8")).toBe(serializeBlueBubblesSemanticJson(candidate))
      expect(fs.existsSync(path.join(paths.quarantine, "claim"))).toBe(state !== "exact")
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        acquired as SemanticClaimLeaseForTest,
        semanticStoreDeps(),
      )).toBe(true)
    },
  )

  it.each(["missing", "invalid"] as const)(
    "recovers a stale transactional row whose JSON evidence is %s",
    async (state) => {
      const store = await loadSemanticStore()
      const capture = makeSemanticCapture(`stale-row-evidence-${state}`)
      const first = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({ pid: () => 6261 }),
      )
      expect(first.status).toBe("acquired")
      const paths = getBlueBubblesSemanticPaths("synthetic-agent")
      const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
      if (state === "missing") fs.unlinkSync(ownerPath)
      else fs.writeFileSync(ownerPath, "{torn", "utf8")

      const replacement = await store.acquireBlueBubblesSemanticClaim(
        "synthetic-agent",
        capture,
        semanticStoreDeps({
          pid: () => 6262,
          isProcessAlive: (pid) => pid !== 6261,
          processStartedAt: (pid) => `process-${pid}`,
        }),
      )
      expect(replacement.status).toBe("acquired")
      expect((replacement as SemanticClaimLeaseForTest).record.owner.pid).toBe(6262)
      expect(fs.existsSync(path.join(paths.quarantine, "claim"))).toBe(state === "invalid")
      expect(store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        replacement as SemanticClaimLeaseForTest,
        semanticStoreDeps({ pid: () => 6262 }),
      )).toBe(true)
    },
  )

  it("fails a no-clobber owner-evidence publication collision transactionally", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("owner-evidence-publication-collision")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    let injected = false
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        if (String(args[1]) === ownerPath && !injected) {
          injected = true
          fs.writeFileSync(ownerPath, "raced-owner", "utf8")
          throw codedError("EEXIST")
        }
        return Reflect.apply(fs.linkSync, fs, args)
      },
    })

    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ fs: adapter }),
    )).rejects.toThrow("semantic_owner_evidence_collision")
    const ownership = new Database(path.join(paths.root, "ownership.sqlite"), { readonly: true })
    try {
      expect(ownership.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'owner_leases'",
      ).pluck().get()).toBe(0)
    } finally {
      ownership.close()
    }
    expect(fs.readFileSync(ownerPath, "utf8")).toBe("raced-owner")
  })

  it("surfaces owner lstat failures and quarantines owner read failures", async () => {
    const store = await loadSemanticStore()
    const lstatCapture = makeSemanticCapture("owner-inspection-lstat-failure")
    const lstatPath = path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${lstatCapture.keyHash}.owner.json`,
    )
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      lstatCapture,
      semanticStoreDeps({
        fs: semanticFsAdapter({
          lstatSync: (...args: unknown[]) => {
            if (String(args[0]) === lstatPath) throw codedError("EIO")
            return Reflect.apply(fs.lstatSync, fs, args)
          },
        }),
      }),
    )).rejects.toThrow("synthetic EIO")

    const readCapture = makeSemanticCapture("owner-inspection-read-failure")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const readPath = path.join(paths.claims, `${readCapture.keyHash}.owner.json`)
    fs.mkdirSync(paths.claims, { recursive: true })
    fs.writeFileSync(readPath, "unreadable-owner", "utf8")
    const acquired = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      readCapture,
      semanticStoreDeps({
        fs: semanticFsAdapter({
          readFileSync: (...args: unknown[]) => {
            if (String(args[0]) === readPath) throw codedError("EIO")
            return Reflect.apply(fs.readFileSync, fs, args)
          },
        }),
      }),
    )
    expect(acquired.status).toBe("acquired")
    expect(fs.readdirSync(path.join(paths.quarantine, "claim"))).toHaveLength(1)
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      acquired as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)
  })

  it("releases missing evidence, rejects invalid evidence, and rejects mutated lease records", async () => {
    const store = await loadSemanticStore()
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")

    const missingCapture = makeSemanticCapture("release-missing-evidence")
    const missing = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      missingCapture,
      semanticStoreDeps(),
    ) as SemanticClaimLeaseForTest
    fs.unlinkSync(path.join(paths.claims, `${missingCapture.keyHash}.owner.json`))
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      missing,
      semanticStoreDeps(),
    )).toBe(true)

    const invalidCapture = makeSemanticCapture("release-invalid-evidence")
    const invalid = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      invalidCapture,
      semanticStoreDeps(),
    ) as SemanticClaimLeaseForTest
    const invalidPath = path.join(paths.claims, `${invalidCapture.keyHash}.owner.json`)
    const invalidBytes = serializeBlueBubblesSemanticJson(invalid.record)
    fs.writeFileSync(invalidPath, "{torn", "utf8")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      invalid,
      semanticStoreDeps(),
    )).toBe(false)
    fs.writeFileSync(invalidPath, invalidBytes, "utf8")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      invalid,
      semanticStoreDeps(),
    )).toBe(true)

    const mutatedCapture = makeSemanticCapture("release-mutated-record")
    const mutated = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      mutatedCapture,
      semanticStoreDeps(),
    ) as SemanticClaimLeaseForTest
    const acquiredAt = mutated.record.owner.acquiredAt
    mutated.record.owner.acquiredAt = "2026-07-30T18:04:00.000Z"
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      mutated,
      semanticStoreDeps(),
    )).toBe(false)
    mutated.record.owner.acquiredAt = acquiredAt
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      mutated,
      semanticStoreDeps(),
    )).toBe(true)
  })

  it.each([
    ["lstat", "ENOENT", false],
    ["lstat", "EIO", true],
    ["read", "ENOENT", false],
    ["read", "EIO", true],
  ] as const)("handles release %s race %s without deleting authority", async (stage, code, throws) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`release-${stage}-${code}`)
    const lease = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    ) as SemanticClaimLeaseForTest
    const ownerPath = path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${capture.keyHash}.owner.json`,
    )
    let lstatCalls = 0
    let readCalls = 0
    const adapter = semanticFsAdapter({
      lstatSync: (...args: unknown[]) => {
        if (String(args[0]) === ownerPath && ++lstatCalls === 2 && stage === "lstat") {
          throw codedError(code)
        }
        return Reflect.apply(fs.lstatSync, fs, args)
      },
      readFileSync: (...args: unknown[]) => {
        if (String(args[0]) === ownerPath && ++readCalls === 2 && stage === "read") {
          throw codedError(code)
        }
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })

    const release = () => store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      lease,
      semanticStoreDeps({ fs: adapter }),
    )
    if (throws) expect(release).toThrow(`synthetic ${code}`)
    else expect(release()).toBe(false)
    expect(fs.existsSync(ownerPath)).toBe(true)
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      lease,
      semanticStoreDeps(),
    )).toBe(true)
  })

  it("makes handled lookup idempotent and turns later claims into no-ops", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("already-handled")
    const handled = makeHandled(capture)
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", handled, semanticStoreDeps()))
      .toBe("semantic_handled_published")
    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash)).toEqual(handled)
    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash)).toEqual(handled)
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )).resolves.toEqual({ status: "already_handled", record: handled })
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${capture.keyHash}.owner.json`,
    ))).toBe(false)
  })
})

function semanticFsAdapter(overrides: Record<string, (...args: unknown[]) => unknown>): unknown {
  return Object.assign(Object.create(fs), overrides)
}

function writeRawSemanticRecord(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    typeof value === "string" ? value : serializeBlueBubblesSemanticJson(value),
    "utf8",
  )
}

describe("BlueBubbles semantic store exhaustive boundaries", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-semantic-store-errors-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    vi.doUnmock("node:fs")
    vi.resetModules()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("returns an empty pending list before capture storage exists and filters handled ties", async () => {
    const store = await loadSemanticStore()
    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent")).toEqual([])
    const left = makeSemanticCapture("pending-tie-left", CAPTURED_AT)
    const right = makeSemanticCapture("pending-tie-right", CAPTURED_AT)
    for (const capture of [left, right]) {
      store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps())
    }
    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent")).toEqual(
      [left, right].sort((first, second) => first.keyHash.localeCompare(second.keyHash)),
    )
    store.writeBlueBubblesSemanticHandled("synthetic-agent", makeHandled(left), semanticStoreDeps())

    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent"))
      .toEqual([right])
  })

  it("persists and orders one process epoch by its pre-await observation ordinal", async () => {
    const store = await loadSemanticStore()
    const observationEpoch = "2026-08-13T09:59:59.000Z/33333333-3333-4333-8333-333333333333"
    const older = makeSemanticCapture(
      "same-process-older",
      "2026-08-13T10:00:00.900Z",
      {
        observationEpoch,
        observationOrdinal: 41,
      },
    )
    const newer = makeSemanticCapture(
      "same-process-newer",
      "2026-08-13T10:00:00.100Z",
      {
        observationEpoch,
        observationOrdinal: 42,
      },
    )

    store.writeBlueBubblesSemanticCapture("synthetic-agent", newer, semanticStoreDeps())
    store.writeBlueBubblesSemanticCapture("synthetic-agent", older, semanticStoreDeps())

    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent"))
      .toEqual([older, newer])
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const persistedCapture = JSON.parse(fs.readFileSync(
      path.join(paths.captures, `${older.keyHash}.json`),
      "utf8",
    ))
    expect(Object.keys(persistedCapture)).toEqual([
      "schemaVersion",
      "canonicalKey",
      "keyHash",
      "providerNamespace",
      "capturedAt",
      "event",
    ])
    expect(persistedCapture).not.toHaveProperty("observationEpoch")
    expect(persistedCapture).not.toHaveProperty("observationOrdinal")
    const observationOrder = fs.readdirSync(paths.observationOrders)
      .map((name) => JSON.parse(fs.readFileSync(path.join(paths.observationOrders, name), "utf8")))
      .find((record) => record.keyHash === older.keyHash)
    expect(observationOrder).toEqual({
      schemaVersion: 1,
      keyHash: older.keyHash,
      captureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedAt: older.capturedAt,
      observationEpoch,
      observationOrdinal: 41,
    })
  })

  it("converges a same-key duplicate to its earliest durable observation", async () => {
    const store = await loadSemanticStore()
    const earlierEpoch = "2026-08-13T09:59:58.000Z/11111111-1111-4111-8111-111111111111"
    const laterEpoch = "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222"
    const lateDuplicate = makeSemanticCapture(
      "duplicate-earliest-observation",
      "2026-08-13T10:00:00.900Z",
      { observationEpoch: laterEpoch, observationOrdinal: 9 },
    )
    const earlyDuplicate = makeSemanticCapture(
      "duplicate-earliest-observation",
      "2026-08-13T10:00:00.100Z",
      { observationEpoch: earlierEpoch, observationOrdinal: 3 },
    )
    const intervening = makeSemanticCapture(
      "duplicate-intervening-observation",
      "2026-08-13T10:00:00.500Z",
      { observationEpoch: laterEpoch, observationOrdinal: 5 },
    )

    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      lateDuplicate,
      semanticStoreDeps(),
    )).toBe("semantic_capture_published")
    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      earlyDuplicate,
      semanticStoreDeps(),
    )).toBe("semantic_capture_duplicate")
    store.writeBlueBubblesSemanticCapture("synthetic-agent", intervening, semanticStoreDeps())

    const pending = store.listPendingBlueBubblesSemanticCaptures("synthetic-agent")
    expect(pending.map((capture) => capture.keyHash)).toEqual([
      earlyDuplicate.keyHash,
      intervening.keyHash,
    ])
    expect(pending[0]).toMatchObject({
      observationEpoch: earlierEpoch,
      observationOrdinal: 3,
    })
  })

  it("does not let a same-key content collision alter the winner's durable order", async () => {
    const store = await loadSemanticStore()
    const observationEpoch = "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222"
    const winner = makeSemanticCapture(
      "collision-order-winner",
      "2026-08-13T10:00:00.900Z",
      { observationEpoch, observationOrdinal: 9 },
    )
    const collision = makeSemanticCapture(
      "collision-order-winner",
      "2026-08-13T10:00:00.100Z",
      { observationEpoch, observationOrdinal: 1 },
    )
    collision.event.text = "different authoritative text"
    collision.event.textSha256 = sha256(collision.event.text)
    const intervening = makeSemanticCapture(
      "collision-order-intervening",
      "2026-08-13T10:00:00.500Z",
      { observationEpoch, observationOrdinal: 5 },
    )

    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      winner,
      semanticStoreDeps(),
    )).toBe("semantic_capture_published")
    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      collision,
      semanticStoreDeps(),
    )).toBe("semantic_identity_collision")
    store.writeBlueBubblesSemanticCapture("synthetic-agent", intervening, semanticStoreDeps())

    expect(store.listPendingBlueBubblesSemanticCaptures("synthetic-agent").map(
      (capture) => capture.keyHash,
    )).toEqual([intervening.keyHash, winner.keyHash])
  })

  it("breaks equal-time duplicate order by epoch and treats an identical clock as stable", async () => {
    const store = await loadSemanticStore()
    const earlierEpoch = "2026-08-13T09:59:58.000Z/11111111-1111-4111-8111-111111111111"
    const laterEpoch = "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222"
    const capturedAt = "2026-08-13T10:00:00.500Z"
    const later = makeSemanticCapture(
      "equal-time-duplicate-order",
      capturedAt,
      { observationEpoch: laterEpoch, observationOrdinal: 2 },
    )
    const earlier = makeSemanticCapture(
      "equal-time-duplicate-order",
      capturedAt,
      { observationEpoch: earlierEpoch, observationOrdinal: 7 },
    )
    const exactDuplicate = makeSemanticCapture(
      "equal-time-duplicate-order",
      capturedAt,
      { observationEpoch: earlierEpoch, observationOrdinal: 7 },
    )

    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", later, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", earlier, semanticStoreDeps()))
      .toBe("semantic_capture_duplicate")
    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      exactDuplicate,
      semanticStoreDeps(),
    )).toBe("semantic_capture_duplicate")
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", later.keyHash))
      .toMatchObject({ observationEpoch: earlierEpoch, observationOrdinal: 7 })
  })

  it("quarantines a corrupt fingerprinted order sidecar before publishing its capture", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(
      "corrupt-observation-order",
      "2026-08-13T10:00:00.500Z",
      {
        observationEpoch: "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222",
        observationOrdinal: 4,
      },
    )
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const [orderName] = fs.readdirSync(paths.observationOrders)
    fs.unlinkSync(path.join(paths.captures, `${capture.keyHash}.json`))
    fs.writeFileSync(path.join(paths.observationOrders, orderName), "{torn", "utf8")

    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
      .toBe("semantic_capture_published")
    expect(fs.readdirSync(path.join(paths.quarantine, "observation-order")).some((name) => (
      name.startsWith(`${orderName}.`)
    ))).toBe(true)
    expect(store.readBlueBubblesSemanticCapture("synthetic-agent", capture.keyHash))
      .toMatchObject({ observationOrdinal: 4 })
  })

  it("polls fingerprinted-order SQLite contention and fails closed at its exact deadline", async () => {
    const store = await loadSemanticStore()
    const seed = makeSemanticCapture(
      "observation-order-busy-seed",
      CAPTURED_AT,
      {
        observationEpoch: "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222",
        observationOrdinal: 1,
      },
    )
    store.writeBlueBubblesSemanticCapture("synthetic-agent", seed, semanticStoreDeps())
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")

    const retryBlocker = new Database(paths.ownership)
    retryBlocker.pragma("busy_timeout = 0")
    retryBlocker.exec("BEGIN IMMEDIATE")
    const retried = makeSemanticCapture(
      "observation-order-busy-retry",
      CAPTURED_AT,
      {
        observationEpoch: "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222",
        observationOrdinal: 2,
      },
    )
    const sleeps: number[] = []
    try {
      expect(store.writeBlueBubblesSemanticCapture(
        "synthetic-agent",
        retried,
        semanticStoreDeps({
          sleepSync: (milliseconds) => {
            sleeps.push(milliseconds)
            retryBlocker.exec("COMMIT")
          },
        }),
      )).toBe("semantic_capture_published")
      expect(sleeps).toEqual([50])
    } finally {
      if (retryBlocker.inTransaction) retryBlocker.exec("ROLLBACK")
      retryBlocker.close()
    }

    const timeoutBlocker = new Database(paths.ownership)
    timeoutBlocker.pragma("busy_timeout = 0")
    timeoutBlocker.exec("BEGIN IMMEDIATE")
    const timedOut = makeSemanticCapture(
      "observation-order-busy-timeout",
      CAPTURED_AT,
      {
        observationEpoch: "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222",
        observationOrdinal: 3,
      },
    )
    let clockCalls = 0
    const sleepSync = vi.fn()
    try {
      expect(() => store.writeBlueBubblesSemanticCapture(
        "synthetic-agent",
        timedOut,
        semanticStoreDeps({
          now: () => new Date(Date.parse(CAPTURED_AT) + (clockCalls++ === 0 ? 0 : 5_000)),
          sleepSync,
        }),
      )).toThrow("semantic_capture_failed")
      expect(sleepSync).not.toHaveBeenCalled()
    } finally {
      timeoutBlocker.exec("ROLLBACK")
      timeoutBlocker.close()
    }
  })

  it("keeps .727 capture and handled bytes readable by the strict .726 contracts", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(
      "rollback-readable-capture",
      CAPTURED_AT,
      {
        observationEpoch: "2026-08-13T09:59:59.000Z/33333333-3333-4333-8333-333333333333",
        observationOrdinal: 41,
      },
    )
    store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps())
    const handled = makeHandled(capture, {
      outcome: "capture_only_unknown",
      detailCode: "capture_only_question",
    })
    store.writeBlueBubblesSemanticHandled("synthetic-agent", handled, semanticStoreDeps())
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const captureBytes = JSON.parse(fs.readFileSync(
      path.join(paths.captures, `${capture.keyHash}.json`),
      "utf8",
    )) as Record<string, unknown>
    const handledBytes = JSON.parse(fs.readFileSync(
      path.join(paths.handled, `${capture.keyHash}.json`),
      "utf8",
    )) as Record<string, unknown>
    const legacyCaptureKeys = [
      "schemaVersion",
      "canonicalKey",
      "keyHash",
      "providerNamespace",
      "capturedAt",
      "event",
    ]
    const legacyHandledOutcomes = new Set([
      "ignored_self",
      "capture_only_removal",
      "capture_only_positive",
      "capture_only_custom",
      "capture_only_unknown",
      "capture_only_target_not_agent",
      "capture_only_untrusted_actor",
      "restricted_feedback_settled",
      "restricted_feedback_observed",
      "restricted_feedback_failed",
      "message_completed",
      "message_observed",
      "message_failed",
      "edit_capture_only",
      "unsend_capture_only",
      "read_audit_only",
      "delivery_audit_only",
    ])

    expect(Object.keys(captureBytes)).toEqual(legacyCaptureKeys)
    expect(Object.keys(handledBytes)).toEqual([
      "schemaVersion",
      "canonicalKey",
      "keyHash",
      "handledAt",
      "outcome",
      "detailCode",
    ])
    expect(legacyHandledOutcomes.has(String(handledBytes.outcome))).toBe(true)
  })

  it("orders different observation epochs by pre-await capture time with deterministic ties", () => {
    const earlierEpoch = "2026-08-13T09:59:58.000Z/11111111-1111-4111-8111-111111111111"
    const laterEpoch = "2026-08-13T09:59:59.000Z/22222222-2222-4222-8222-222222222222"
    const earlyCapture = makeSemanticCapture("cross-process-earlier", "2026-08-13T10:00:00.100Z", {
      observationEpoch: laterEpoch,
      observationOrdinal: 99,
    })
    const lateCapture = makeSemanticCapture("cross-process-later", "2026-08-13T10:00:00.900Z", {
      observationEpoch: earlierEpoch,
      observationOrdinal: 41,
    })
    const sameTimeEarlierEpoch = makeSemanticCapture("same-time-earlier-epoch", CAPTURED_AT, {
      observationEpoch: earlierEpoch,
      observationOrdinal: 99,
    })
    const sameTimeLaterEpoch = makeSemanticCapture("same-time-later-epoch", CAPTURED_AT, {
      observationEpoch: laterEpoch,
      observationOrdinal: 1,
    })
    const legacyLeft = makeSemanticCapture("legacy-left", CAPTURED_AT)
    const legacyRight = makeSemanticCapture("legacy-right", CAPTURED_AT)
    const repeatedOrdinalLeft = makeSemanticCapture("repeated-ordinal-left", CAPTURED_AT, {
      observationEpoch: earlierEpoch,
      observationOrdinal: 7,
    })
    const repeatedOrdinalRight = makeSemanticCapture("repeated-ordinal-right", CAPTURED_AT, {
      observationEpoch: earlierEpoch,
      observationOrdinal: 7,
    })

    expect(compareBlueBubblesSemanticCaptureOrder(earlyCapture, lateCapture)).toBeLessThan(0)
    expect(compareBlueBubblesSemanticCaptureOrder(sameTimeEarlierEpoch, sameTimeLaterEpoch))
      .toBeLessThan(0)
    expect(compareBlueBubblesSemanticCaptureOrder(legacyLeft, legacyRight)).toBe(0)
    expect(compareBlueBubblesSemanticCaptureOrder(legacyLeft, sameTimeEarlierEpoch)).toBeLessThan(0)
    expect(compareBlueBubblesSemanticCaptureOrder(sameTimeEarlierEpoch, legacyLeft)).toBeGreaterThan(0)
    expect(compareBlueBubblesSemanticCaptureOrder(repeatedOrdinalLeft, repeatedOrdinalRight))
      .toBe(repeatedOrdinalLeft.keyHash.localeCompare(repeatedOrdinalRight.keyHash))
  })

  it("rejects invalid new capture and handled inputs before publication", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("invalid-new-record")
    const invalidCapture = { ...capture, unexpected: true } as unknown as SemanticCapture
    const invalidHandled = { ...makeHandled(capture), unexpected: true } as unknown as SemanticHandledRecord

    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      invalidCapture,
      semanticStoreDeps(),
    )).toThrow("semantic_capture_failed")
    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      invalidHandled,
      semanticStoreDeps(),
    )).toThrow("semantic_handled_failed")
  })

  it("rejects unsafe hashes, invalid coordinates, UUIDs, and PIDs", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("invalid-primitives")
    expect(() => store.readBlueBubblesSemanticCapture("synthetic-agent", "../escape"))
      .toThrow("semantic_key_hash_invalid")
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ pid: () => 0 }),
    )).rejects.toThrow("semantic_pid_invalid")
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ randomUUID: () => "not-a-uuid" }),
    )).toThrow("semantic_capture_failed")
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey: "coordinate", coordinateHash: "0".repeat(64), canonicalAction: "add" },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_coordinate_invalid")
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      {
        coordinateKey: "coordinate",
        coordinateHash: sha256("coordinate"),
        canonicalAction: "other" as "add",
      },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_coordinate_invalid")
  })

  it("rejects a claim whose canonical key does not hash to the requested key before publication", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("claim-candidate-key-mismatch")
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      {
        canonicalKey: JSON.stringify(["different-canonical-key"]),
        keyHash: capture.keyHash,
      },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_claim_invalid")
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").claims,
      `${capture.keyHash}.owner.json`,
    ))).toBe(false)
  })

  it.each([
    ["event GUID", (capture: SemanticCapture) => {
      capture.event.eventGuid = "different-guid"
    }],
    ["provider namespace", (capture: SemanticCapture) => {
      capture.providerNamespace = ROTATED_PROVIDER_NAMESPACE
    }],
    ["event kind", (capture: SemanticCapture) => {
      capture.event.kind = "edit"
    }],
  ])("rejects a capture whose canonical identity disagrees with its %s", async (_label, mutate) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`canonical-event-mismatch-${_label}`)
    mutate(capture)
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )).toThrow("semantic_capture_failed")
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").captures,
      `${capture.keyHash}.json`,
    ))).toBe(false)
  })

  it.each([
    ["malformed JSON", "{"],
    ["tuple shape", JSON.stringify(["bb-sem-v1", PROVIDER_NAMESPACE, "reaction"])],
    ["discriminator grammar", JSON.stringify([
      "bb-sem-v1",
      PROVIDER_NAMESPACE,
      "reaction",
      "mutation-event",
      "target-message",
      hashIngressActorIdentity("sender@example.com"),
      "love",
      "add",
      "generation:01",
    ])],
    ["finite generation", JSON.stringify([
      "bb-sem-v1",
      PROVIDER_NAMESPACE,
      "reaction",
      "mutation-event",
      "target-message",
      hashIngressActorIdentity("sender@example.com"),
      "love",
      "add",
      `generation:${"9".repeat(400)}`,
    ])],
  ])("rejects a generation reaction with invalid canonical %s", async (_label, canonicalKey) => {
    const store = await loadSemanticStore()
    const capture = buildBlueBubblesSemanticCapture({
      cutover: {
        schemaVersion: 1,
        providerNamespace: PROVIDER_NAMESPACE,
        effectiveAt: CUTOVER_AT,
      },
      capturedAt: CAPTURED_AT,
      event: makeMutationEvent("reaction", {
        reaction: {
          raw: "2000",
          rawTransportValue: "2000",
          canonicalValue: "love",
          action: "add",
        },
      }),
      targetAuthorship: "agent",
      coordinateGeneration: 0,
    })!
    capture.canonicalKey = canonicalKey
    capture.keyHash = sha256(canonicalKey)

    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )).toThrow("semantic_capture_failed")
  })

  it("preserves both the source and prior evidence when a quarantine path collides", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("quarantine-destination-collision")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const sourcePath = path.join(paths.captures, `${capture.keyHash}.json`)
    const quarantineDirectory = path.join(paths.quarantine, "capture")
    const quarantinePath = path.join(
      quarantineDirectory,
      `${capture.keyHash}.json.${Date.parse("2026-07-30T18:02:00.000Z")}.33333333-3333-4333-8333-333333333333.json`,
    )
    writeRawSemanticRecord(sourcePath, "{torn")
    fs.mkdirSync(quarantineDirectory, { recursive: true })
    fs.writeFileSync(quarantinePath, "prior-evidence", "utf8")

    expect(() => store.readBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture.keyHash,
      semanticStoreDeps(),
    )).toThrow("semantic_quarantine_failed")
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("{torn")
    expect(fs.readFileSync(quarantinePath, "utf8")).toBe("prior-evidence")
  })

  it("quarantines a dangling owner symlink instead of retrying without a bound", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("dangling-owner-symlink")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    fs.mkdirSync(paths.claims, { recursive: true })
    const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    fs.symlinkSync(path.join(tmpRoot, "missing-owner-target"), ownerPath)
    let ownerPublicationAttempts = 0
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        if (String(args[1]) === ownerPath && ++ownerPublicationAttempts > 6) {
          throw new Error("unbounded-owner-collision")
        }
        return Reflect.apply(fs.linkSync, fs, args)
      },
    })

    const result = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ fs: adapter }),
    )
    expect(result.status).toBe("acquired")
    expect(ownerPublicationAttempts).toBeLessThanOrEqual(2)
    expect(fs.readdirSync(path.join(paths.quarantine, "claim"))).toHaveLength(1)
  })

  it("quarantines noncanonical owner bytes instead of retrying without a bound", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("noncanonical-owner-bytes")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    const stale = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 7171,
      bootIdentity: "boot-old",
      processStartedAt: "old-start",
      acquiredAt: CUTOVER_AT,
    })
    fs.mkdirSync(paths.claims, { recursive: true })
    fs.writeFileSync(ownerPath, JSON.stringify(stale), "utf8")
    let ownerPublicationAttempts = 0
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        if (String(args[1]) === ownerPath && ++ownerPublicationAttempts > 6) {
          throw new Error("unbounded-owner-collision")
        }
        return Reflect.apply(fs.linkSync, fs, args)
      },
    })

    const result = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ fs: adapter }),
    )
    expect(result.status).toBe("acquired")
    expect(ownerPublicationAttempts).toBeLessThanOrEqual(2)
    expect(fs.readdirSync(path.join(paths.quarantine, "claim"))).toHaveLength(1)
  })

  it.each([
    ["open", "openSync", "wx"],
    ["write", "writeFileSync", ".tmp"],
    ["temp fsync", "fsyncSync", ".tmp"],
    ["temp close", "closeSync", ".tmp"],
    ["temp cleanup", "unlinkSync", ".tmp"],
  ])("fails capture publication safely at %s", async (_label, operation, matches) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`capture-failure-${_label}`)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        fs: createTracingFs([], { operation, matches, code: "EIO" }),
      }),
    )).toThrow("semantic_capture_failed")
    expect(currentTestObservedNervesEvent("senses", "bluebubbles_semantic_capture_error")).toBe(true)
    if (_label !== "temp cleanup") {
      expect(fs.existsSync(path.join(paths.captures, `${capture.keyHash}.json`))).toBe(false)
    }
  })

  it("ignores an already-absent temp and preserves a primary error over cleanup failures", async () => {
    const store = await loadSemanticStore()
    const absentCapture = makeSemanticCapture("cleanup-absent")
    const absentAdapter = semanticFsAdapter({
      unlinkSync: (...args: unknown[]) => {
        Reflect.apply(fs.unlinkSync, fs, args)
        throw codedError("ENOENT")
      },
    })
    expect(store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      absentCapture,
      semanticStoreDeps({ fs: absentAdapter }),
    )).toBe("semantic_capture_published")

    const failedCapture = makeSemanticCapture("primary-over-cleanup")
    const opened = new Map<number, string>()
    const failingAdapter = semanticFsAdapter({
      openSync: (...args: unknown[]) => {
        const fd = Reflect.apply(fs.openSync, fs, args) as number
        opened.set(fd, String(args[0]))
        return fd
      },
      writeFileSync: () => { throw codedError("ENOSPC") },
      closeSync: () => { throw codedError("EIO") },
      unlinkSync: () => { throw codedError("EACCES") },
    })
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      failedCapture,
      semanticStoreDeps({ fs: failingAdapter }),
    )).toThrow("semantic_capture_failed")
    expect(opened.size).toBe(1)
  })

  it("preserves already-classified capture and handled failures", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("classified-write-failure")
    expect(() => store.writeBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        fs: createTracingFs([], { operation: "linkSync", code: "semantic_capture_failed" }),
      }),
    )).toThrow("semantic_capture_failed")
    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      makeHandled(capture),
      semanticStoreDeps({
        fs: semanticFsAdapter({
          linkSync: () => { throw new Error("semantic_handled_failed") },
        }),
      }),
    )).toThrow("semantic_handled_failed")

    expect(() => store.writeBlueBubblesSemanticHandled(
      "synthetic-agent",
      makeHandled(makeSemanticCapture("primitive-handled-failure")),
      semanticStoreDeps({
        fs: semanticFsAdapter({
          linkSync: () => { throw "primitive-store-failure" },
        }),
      }),
    )).toThrow("semantic_handled_failed")
  })

  it("resolves equivalent, corrupt, and repeatedly corrupt capture publication races", async () => {
    const store = await loadSemanticStore()
    const runRace = (
      capture: SemanticCapture,
      winners: Array<unknown>,
    ): ReturnType<SemanticStoreApiForTest["writeBlueBubblesSemanticCapture"]> => {
      let raceIndex = 0
      const adapter = semanticFsAdapter({
        linkSync: (...args: unknown[]) => {
          const destination = String(args[1])
          if (destination.endsWith(`${capture.keyHash}.json`) && raceIndex < winners.length) {
            writeRawSemanticRecord(destination, winners[raceIndex++]!)
            throw codedError("EEXIST")
          }
          return Reflect.apply(fs.linkSync, fs, args)
        },
      })
      return store.writeBlueBubblesSemanticCapture(
        "synthetic-agent",
        capture,
        semanticStoreDeps({ fs: adapter }),
      )
    }

    const equivalent = makeSemanticCapture("race-equivalent")
    expect(runRace(equivalent, [equivalent])).toBe("semantic_capture_duplicate")
    const corruptThenPublish = makeSemanticCapture("race-corrupt-publish")
    expect(runRace(corruptThenPublish, ["{torn"])).toBe("semantic_capture_published")
    const corruptThenEquivalent = makeSemanticCapture("race-corrupt-equivalent")
    expect(runRace(corruptThenEquivalent, ["{torn", corruptThenEquivalent]))
      .toBe("semantic_capture_duplicate")
    const twiceCorrupt = makeSemanticCapture("race-twice-corrupt")
    expect(() => runRace(twiceCorrupt, ["{torn", "{torn-again"]))
      .toThrow("semantic_capture_failed")
  })

  it("resolves equivalent and corrupt handled publication races", async () => {
    const store = await loadSemanticStore()
    const runRace = (record: SemanticHandledRecord, winner: unknown) => {
      let injected = false
      const adapter = semanticFsAdapter({
        linkSync: (...args: unknown[]) => {
          const destination = String(args[1])
          if (destination.endsWith(`${record.keyHash}.json`) && !injected) {
            injected = true
            writeRawSemanticRecord(destination, winner)
            throw codedError("EEXIST")
          }
          return Reflect.apply(fs.linkSync, fs, args)
        },
      })
      return store.writeBlueBubblesSemanticHandled(
        "synthetic-agent",
        record,
        semanticStoreDeps({ fs: adapter }),
      )
    }
    const capture = makeSemanticCapture("handled-races")
    const equivalent = makeHandled(capture)
    expect(runRace(equivalent, equivalent)).toBe("semantic_handled_duplicate")

    const corruptCapture = makeSemanticCapture("handled-corrupt-race")
    const afterCorrupt = makeHandled(corruptCapture)
    expect(runRace(afterCorrupt, "{torn")).toBe("semantic_handled_published")
  })

  it("surfaces record read failures and leaves the authority in place", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("read-failure")
    store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps())
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        if (String(args[0]).endsWith(`${capture.keyHash}.json`)) throw codedError("EIO")
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })
    expect(() => store.readBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture.keyHash,
      semanticStoreDeps({ fs: adapter }),
    )).toThrow("semantic_record_read_failed")
    expect(fs.existsSync(path.join(
      getBlueBubblesSemanticPaths("synthetic-agent").captures,
      `${capture.keyHash}.json`,
    ))).toBe(true)
  })

  it("claims after quarantining corrupt ownership and releases missing owners idempotently", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("corrupt-owner")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    writeRawSemanticRecord(claimPath, "{torn")
    const acquired = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps(),
    )
    expect(acquired.status).toBe("acquired")
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      acquired as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(true)
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      acquired as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )).toBe(false)
  })

  it("rechecks handled state after claim publication and releases without starting recovery", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("handled-after-claim")
    const handled = makeHandled(capture)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        const result = Reflect.apply(fs.linkSync, fs, args)
        if (String(args[1]).endsWith(`${capture.keyHash}.owner.json`)) {
          writeRawSemanticRecord(path.join(paths.handled, `${capture.keyHash}.json`), handled)
        }
        return result
      },
    })

    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ fs: adapter }),
    )).resolves.toEqual({ status: "already_handled", record: handled })
    expect(fs.existsSync(path.join(paths.claims, `${capture.keyHash}.owner.json`))).toBe(false)
  })

  it("fails closed on null process-start identity and unexpected acquisition errors", async () => {
    const store = await loadSemanticStore()
    const nullStart = makeSemanticCapture("null-process-start")
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      nullStart,
      semanticStoreDeps({ processStartedAt: () => null }),
    )).rejects.toThrow("semantic_claim_liveness_failed")

    const invalidUuid = makeSemanticCapture("claim-invalid-uuid")
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      invalidUuid,
      semanticStoreDeps({ randomUUID: () => "invalid" }),
    )).rejects.toThrow("semantic_uuid_invalid")

    const observedNull = makeSemanticCapture("observed-null-process-start")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    writeRawSemanticRecord(
      path.join(paths.claims, `${observedNull.keyHash}.owner.json`),
      buildBlueBubblesSemanticClaimRecord({
        canonicalKey: observedNull.canonicalKey,
        keyHash: observedNull.keyHash,
        operationId: `semantic-handle:${observedNull.keyHash}`,
        pid: 8181,
        bootIdentity: "boot-current",
        processStartedAt: "owner-start",
        acquiredAt: CUTOVER_AT,
      }),
    )
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      observedNull,
      semanticStoreDeps({
        pid: () => 8282,
        processStartedAt: (pid) => pid === 8282 ? "contender-start" : null,
      }),
    )).rejects.toThrow("semantic_claim_liveness_failed")
  })

  it("uses the default timer and rejects a lease without its private coordinator token", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("default-timer")
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 5001,
      bootIdentity: "boot-current",
      processStartedAt: "owner-start",
      acquiredAt: "2026-07-30T18:00:00.000Z",
    })
    const claimPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    writeRawSemanticRecord(claimPath, owner)
    let clockCalls = 0
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({
        now: () => new Date(Date.parse(CAPTURED_AT) + (clockCalls++ < 3 ? 0 : 5_000)),
        isProcessAlive: () => true,
        processStartedAt: () => "owner-start",
        sleep: undefined,
      }),
    )).resolves.toEqual({ status: "timeout", code: "semantic_claim_timeout" })

    const fakeLease = { status: "acquired" as const, record: owner }
    const readFileSync = vi.fn(() => { throw codedError("EIO") })
    const adapter = semanticFsAdapter({
      readFileSync,
    })
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      fakeLease,
      semanticStoreDeps({ fs: adapter }),
    )).toBe(false)
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it("acquires and probes an existing lease with production dependency defaults", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("production-default-probes")
    const acquired = await store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture)
    expect(acquired.status).toBe("acquired")

    let clockCalls = 0
    const observedAt = Date.now()
    await expect(store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      {
        now: () => new Date(observedAt + (clockCalls++ < 2 ? 0 : 5_000)),
        randomUUID: () => "44444444-4444-4444-8444-444444444444",
        sleep: async () => {},
      },
    )).resolves.toEqual({ status: "timeout", code: "semantic_claim_timeout" })

    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      acquired as SemanticClaimLeaseForTest,
    )).toBe(true)
  })

  it.each([
    "linux",
    "darwin",
    "freebsd",
    "win32",
    "aix",
  ] as const)("derives durable default boot and process identities on %s", async (platform) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`platform-probe-${platform}`)
    const fixedNow = new Date("2026-07-30T18:02:03.000Z")
    const linuxStat = `4242 (semantic worker) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")}`
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-marker\n"
        if (filePath === "/proc/4242/stat") return linuxStat
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })
    const run = vi.fn((file: string, args: readonly string[]) => {
      const command = args.join(" ")
      if (file === "/usr/sbin/sysctl" || command.includes("Win32_OperatingSystem")) {
        return "boot-marker\n"
      }
      return "process-marker\n"
    })
    const deps: SemanticStoreDepsForTest = {
      fs: adapter,
      now: () => fixedNow,
      randomUUID: () => "55555555-5555-4555-8555-555555555555",
      pid: () => 4242,
      sleep: async () => {},
      platform,
      execFileSync: run,
      kill: () => true,
      uptime: () => 123,
    }

    const result = await store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture, deps)
    expect(result.status).toBe("acquired")
    const owner = (result as SemanticClaimLeaseForTest).record.owner
    const fallbackBootEpoch = Math.round((fixedNow.getTime() - 123_000) / 1_000)
    expect(owner.bootIdentity).toBe(platform === "linux"
      ? "linux:boot-marker"
      : platform === "darwin" || platform === "freebsd"
        ? `${platform}:boot-marker`
        : platform === "win32"
          ? "win32:boot-marker"
          : `aix:${fallbackBootEpoch}`)
    expect(owner.processStartedAt).toBe(platform === "linux"
      ? "linux:19"
      : `${platform}:process-marker`)
    expect(store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      result as SemanticClaimLeaseForTest,
      deps,
    )).toBe(true)
  })

  it("uses the default uptime source for an otherwise unsupported platform", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("platform-default-uptime")
    const result = await store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture, {
      fs: semanticFsAdapter({}),
      randomUUID: () => "66666666-6666-4666-8666-666666666666",
      pid: () => 4242,
      platform: "aix",
      execFileSync: () => "process-marker\n",
    })
    expect(result.status).toBe("acquired")
    expect((result as SemanticClaimLeaseForTest).record.owner.bootIdentity).toMatch(/^aix:\d+$/)
    store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      result as SemanticClaimLeaseForTest,
      { fs: semanticFsAdapter({}) },
    )
  })

  it.each([
    ["missing close parenthesis", "malformed", null],
    ["missing start field", "4242 (worker) S", null],
    ["missing proc entry", codedError("ENOENT"), null],
    ["vanished proc entry", codedError("ESRCH"), null],
    ["unexpected proc failure", codedError("EIO"), "synthetic EIO"],
  ])("handles Linux process-start probe failure: %s", async (_label, procResult, expectedError) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`linux-probe-failure-${_label}`)
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-marker\n"
        if (filePath === "/proc/4242/stat") {
          if (procResult instanceof Error) throw procResult
          return procResult
        }
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })
    const claim = store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture, {
      fs: adapter,
      randomUUID: () => "77777777-7777-4777-8777-777777777777",
      pid: () => 4242,
      platform: "linux",
    })
    await expect(claim).rejects.toThrow(expectedError ?? "semantic_claim_liveness_failed")
  })

  it.each([
    ["win32", "empty", false],
    ["win32", "failure", true],
    ["darwin", "empty", false],
    ["darwin", "failure", true],
  ] as const)("returns null for %s process probe %s", async (platform, _label, shouldThrow) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`${platform}-probe-${_label}`)
    const run = (file: string, args: readonly string[]): string => {
      const command = args.join(" ")
      const bootProbe = file === "/usr/sbin/sysctl" || command.includes("Win32_OperatingSystem")
      if (bootProbe) return "boot-marker\n"
      if (shouldThrow) throw codedError("EIO")
      return "   "
    }
    await expect(store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture, {
      fs: semanticFsAdapter({}),
      randomUUID: () => "88888888-8888-4888-8888-888888888888",
      pid: () => 4242,
      platform,
      execFileSync: run,
    })).rejects.toThrow("semantic_claim_liveness_failed")
  })

  it.each([
    ["live", null, "timeout"],
    ["permission denied", "EPERM", "timeout"],
    ["vanished", "ESRCH", "acquired"],
    ["unexpected failure", "EIO", "error"],
  ] as const)("interprets default process-liveness probe: %s", async (_label, killCode, outcome) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`default-liveness-${_label}`)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    writeRawSemanticRecord(
      path.join(paths.claims, `${capture.keyHash}.owner.json`),
      buildBlueBubblesSemanticClaimRecord({
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        operationId: `semantic-handle:${capture.keyHash}`,
        pid: 3131,
        bootIdentity: "linux:boot-marker",
        processStartedAt: "linux:19",
        acquiredAt: CUTOVER_AT,
      }),
    )
    const linuxStat = `4242 (semantic worker) S ${Array.from({ length: 19 }, (_, index) => index + 1).join(" ")}`
    const adapter = semanticFsAdapter({
      readFileSync: (...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-marker\n"
        if (filePath.startsWith("/proc/") && filePath.endsWith("/stat")) return linuxStat
        return Reflect.apply(fs.readFileSync, fs, args)
      },
    })
    let clockCalls = 0
    const deps: SemanticStoreDepsForTest = {
      fs: adapter,
      now: () => new Date(Date.parse(CAPTURED_AT) + (clockCalls++ < 2 ? 0 : 5_000)),
      randomUUID: () => "99999999-9999-4999-8999-999999999999",
      pid: () => 4242,
      platform: "linux",
      kill: () => {
        if (killCode) throw codedError(killCode)
        return true
      },
      sleep: async () => {},
    }

    const pending = store.acquireBlueBubblesSemanticClaim("synthetic-agent", capture, deps)
    if (outcome === "error") {
      await expect(pending).rejects.toThrow("semantic_claim_liveness_failed")
      return
    }
    const result = await pending
    expect(result.status).toBe(outcome)
    if (result.status === "acquired") {
      store.releaseBlueBubblesSemanticClaim(
        "synthetic-agent",
        result as SemanticClaimLeaseForTest,
        deps,
      )
    }
  })

  it("fails coordinates at each mutable publication and cleanup boundary", async () => {
    const store = await loadSemanticStore()
    const runFailure = async (
      label: string,
      adapter: unknown,
      expected: string,
    ): Promise<void> => {
      const coordinateKey = JSON.stringify(["coordinate-mutable-failure", label])
      const coordinateHash = sha256(coordinateKey)
      await expect(store.allocateBlueBubblesReactionCoordinate(
        "synthetic-agent",
        { coordinateKey, coordinateHash, canonicalAction: "add" },
        semanticStoreDeps({ fs: adapter }),
      )).rejects.toThrow(expected)
      expect(fs.existsSync(path.join(
        getBlueBubblesSemanticPaths("synthetic-agent").coordinates,
        `${coordinateHash}.owner.lock`,
      ))).toBe(false)
    }

    const openKey = JSON.stringify(["coordinate-mutable-failure", "open"])
    await runFailure(
      "open",
      createTracingFs([], {
        operation: "openSync",
        matches: `.${sha256(openKey)}.json.`,
        code: "EIO",
      }),
      "synthetic EIO",
    )

    const writeKey = JSON.stringify(["coordinate-mutable-failure", "write"])
    await runFailure(
      "write",
      createTracingFs([], {
        operation: "writeFileSync",
        matches: `.${sha256(writeKey)}.json.`,
        code: "ENOSPC",
      }),
      "synthetic ENOSPC",
    )

    const cleanupKey = JSON.stringify(["coordinate-mutable-failure", "cleanup"])
    const cleanupHash = sha256(cleanupKey)
    await runFailure(
      "cleanup",
      semanticFsAdapter({
        unlinkSync: (...args: unknown[]) => {
          if (String(args[0]).includes(`.${cleanupHash}.json.`)) throw codedError("EACCES")
          return Reflect.apply(fs.unlinkSync, fs, args)
        },
      }),
      "synthetic EACCES",
    )

    const precedenceKey = JSON.stringify(["coordinate-mutable-failure", "precedence"])
    const precedenceHash = sha256(precedenceKey)
    const openedPaths = new Map<number, string>()
    await runFailure(
      "precedence",
      semanticFsAdapter({
        openSync: (...args: unknown[]) => {
          const fd = Reflect.apply(fs.openSync, fs, args) as number
          openedPaths.set(fd, String(args[0]))
          return fd
        },
        writeFileSync: (...args: unknown[]) => {
          if (typeof args[0] === "number"
            && openedPaths.get(args[0])?.includes(`.${precedenceHash}.json.`)) {
            throw codedError("ENOSPC")
          }
          return Reflect.apply(fs.writeFileSync, fs, args)
        },
        closeSync: (...args: unknown[]) => {
          const fd = Number(args[0])
          const openedPath = openedPaths.get(fd)
          const result = Reflect.apply(fs.closeSync, fs, args)
          openedPaths.delete(fd)
          if (openedPath?.includes(`.${precedenceHash}.json.`)) throw codedError("EIO")
          return result
        },
        unlinkSync: (...args: unknown[]) => {
          if (String(args[0]).includes(`.${precedenceHash}.json.`)) {
            Reflect.apply(fs.unlinkSync, fs, args)
            throw codedError("EACCES")
          }
          return Reflect.apply(fs.unlinkSync, fs, args)
        },
      }),
      "synthetic ENOSPC",
    )
  })

  it("keeps coordinate owner errors unwrapped and observes quarantine created after locking", async () => {
    const store = await loadSemanticStore()
    const invalidUuidKey = JSON.stringify(["coordinate-owner", "invalid-uuid"])
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      {
        coordinateKey: invalidUuidKey,
        coordinateHash: sha256(invalidUuidKey),
        canonicalAction: "add",
      },
      semanticStoreDeps({ randomUUID: () => "invalid" }),
    )).rejects.toThrow("semantic_uuid_invalid")

    const primitiveKey = JSON.stringify(["coordinate-owner", "primitive"])
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      {
        coordinateKey: primitiveKey,
        coordinateHash: sha256(primitiveKey),
        canonicalAction: "add",
      },
      semanticStoreDeps({
        fs: semanticFsAdapter({
          openSync: (...args: unknown[]) => {
            if (args[1] === "wx") throw "primitive-coordinate-owner"
            return Reflect.apply(fs.openSync, fs, args)
          },
        }),
      }),
    )).rejects.toBe("primitive-coordinate-owner")

    const quarantinedKey = JSON.stringify(["coordinate-owner", "quarantine-race"])
    const quarantinedHash = sha256(quarantinedKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const adapter = semanticFsAdapter({
      linkSync: (...args: unknown[]) => {
        const result = Reflect.apply(fs.linkSync, fs, args)
        if (String(args[1]).endsWith(`${quarantinedHash}.owner.lock`)) {
          const directory = path.join(paths.quarantine, "coordinate")
          fs.mkdirSync(directory, { recursive: true })
          fs.writeFileSync(path.join(directory, `${quarantinedHash}.json.race`), "", "utf8")
        }
        return result
      },
    })
    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      {
        coordinateKey: quarantinedKey,
        coordinateHash: quarantinedHash,
        canonicalAction: "add",
      },
      semanticStoreDeps({ fs: adapter }),
    )).rejects.toThrow("semantic_coordinate_invalid")
    expect(fs.existsSync(path.join(paths.coordinates, `${quarantinedHash}.owner.lock`))).toBe(false)
  })

  it.each([
    ["non-record", () => null],
    ["extra top-level key", (record: Record<string, unknown>) => ({ ...record, extra: true })],
    ["schema version", (record: Record<string, unknown>) => ({ ...record, schemaVersion: 2 })],
    ["canonical key type", (record: Record<string, unknown>) => ({ ...record, canonicalKey: 7 })],
    ["provider namespace", (record: Record<string, unknown>) => ({ ...record, providerNamespace: "invalid" })],
    ["captured timestamp", (record: Record<string, unknown>) => ({ ...record, capturedAt: "invalid" })],
    ["event record", (record: Record<string, unknown>) => ({ ...record, event: null })],
    ["extra event key", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), extra: true },
    })],
    ["provider", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), provider: "other" },
    })],
    ["kind type", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), kind: 7 },
    })],
    ["kind literal", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), kind: "other" },
    })],
    ["event guid", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), eventGuid: 7 },
    })],
    ["from-me", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), fromMe: "false" },
    })],
    ["missing from-me", (record: Record<string, unknown>) => {
      const event = { ...(record.event as Record<string, unknown>) }
      delete event.fromMe
      return { ...record, event }
    }],
    ["null from-me", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), fromMe: null },
    })],
    ["actor record", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), actor: null },
    })],
    ["actor extra key", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), extra: true },
      },
    })],
    ["actor provider", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), provider: "other" },
      },
    })],
    ["actor external type", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), externalId: 7 },
      },
    })],
    ["actor external empty", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), externalId: "" },
      },
    })],
    ["actor external normalization", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), externalId: "UPPER@EXAMPLE.COM" },
      },
    })],
    ["actor display name", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        actor: { ...((record.event as Record<string, unknown>).actor as Record<string, unknown>), displayName: 7 },
      },
    })],
    ["participants array", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), participants: null },
    })],
    ["participant identity", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), participants: [null] },
    })],
    ["participant ordering", (record: Record<string, unknown>) => ({
      ...record,
      event: {
        ...(record.event as Record<string, unknown>),
        participants: [...((record.event as Record<string, unknown>).participants as unknown[])].reverse(),
      },
    })],
    ["source event type", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), sourceEventType: 7 },
    })],
    ...[
      "sessionKey",
      "chatGuid",
      "chatIdentifier",
      "text",
      "textSha256",
      "targetGuid",
      "rawTransportValue",
      "revision",
      "contentSha256",
    ].map((field) => [field, (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), [field]: 7 },
    })] as const),
    ["target authorship", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), targetAuthorship: "other" },
    })],
    ["canonical action", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), canonicalAction: "other" },
    })],
    ["canonical value type", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), canonicalValue: 7 },
    })],
    ["canonical value literal", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), canonicalValue: "other" },
    })],
    ["effective timestamp", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), effectiveAt: "invalid" },
    })],
    ["null text digest", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), text: null, textSha256: "digest" },
    })],
    ["text digest mismatch", (record: Record<string, unknown>) => ({
      ...record,
      event: { ...(record.event as Record<string, unknown>), textSha256: "0".repeat(64) },
    })],
  ])("quarantines a capture with invalid %s", async (_label, mutate) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`invalid-capture-${_label}`)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const filePath = path.join(paths.captures, `${capture.keyHash}.json`)
    const invalid = mutate(capture as unknown as Record<string, unknown>)
    writeRawSemanticRecord(filePath, invalid)

    expect(store.readBlueBubblesSemanticCapture(
      "synthetic-agent",
      capture.keyHash,
      semanticStoreDeps(),
    )).toBeNull()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("accepts every valid capture union branch and nullable text projection", async () => {
    const store = await loadSemanticStore()
    const cutover = {
      schemaVersion: 1 as const,
      providerNamespace: PROVIDER_NAMESPACE,
      effectiveAt: CUTOVER_AT,
    }
    const variants = [
      buildBlueBubblesSemanticCapture({
        cutover,
        capturedAt: CAPTURED_AT,
        event: makeMutationEvent("reaction", {
          reaction: {
            raw: "2000",
            rawTransportValue: "2000",
            canonicalValue: "love",
            action: "add",
          },
        }),
        targetAuthorship: "agent",
        coordinateGeneration: 0,
      }),
      buildBlueBubblesSemanticCapture({
        cutover,
        capturedAt: CAPTURED_AT,
        event: makeMutationEvent("edit", {
          editedText: "valid edited text",
          revision: "valid-r1",
        }),
        targetAuthorship: "non_agent_unknown",
      }),
      buildBlueBubblesSemanticCapture({
        cutover,
        capturedAt: CAPTURED_AT,
        event: makeMutationEvent("reaction", {
          reaction: {
            raw: "2001",
            rawTransportValue: "2001",
            canonicalValue: "like",
            action: "add",
          },
          effectiveTimestamp: 100,
        }),
        targetAuthorship: "agent",
      }),
    ]
    for (const capture of variants) {
      expect(capture).not.toBeNull()
      expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", capture, semanticStoreDeps()))
        .toBe("semantic_capture_published")
    }
    const nullable = makeSemanticCapture("valid-null-text")
    nullable.event.text = null
    nullable.event.textSha256 = null
    nullable.event.actor.displayName = null
    expect(store.writeBlueBubblesSemanticCapture("synthetic-agent", nullable, semanticStoreDeps()))
      .toBe("semantic_capture_published")
  })

  it.each([
    ["non-record", () => null],
    ["extra key", (record: Record<string, unknown>) => ({ ...record, extra: true })],
    ["schema", (record: Record<string, unknown>) => ({ ...record, schemaVersion: 2 })],
    ["canonical key", (record: Record<string, unknown>) => ({ ...record, canonicalKey: 7 })],
    ["key hash", (record: Record<string, unknown>) => ({ ...record, keyHash: "f".repeat(64) })],
    ["handled timestamp", (record: Record<string, unknown>) => ({ ...record, handledAt: "invalid" })],
    ["outcome type", (record: Record<string, unknown>) => ({ ...record, outcome: 7 })],
    ["outcome literal", (record: Record<string, unknown>) => ({ ...record, outcome: "other" })],
    ["detail code", (record: Record<string, unknown>) => ({ ...record, detailCode: 7 })],
  ])("quarantines a handled receipt with invalid %s", async (_label, mutate) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`invalid-handled-${_label}`)
    const handled = makeHandled(capture)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const filePath = path.join(paths.handled, `${capture.keyHash}.json`)
    writeRawSemanticRecord(filePath, mutate(handled as unknown as Record<string, unknown>))

    expect(store.readBlueBubblesSemanticHandled("synthetic-agent", capture.keyHash, semanticStoreDeps()))
      .toBeNull()
  })

  it("accepts a non-null handled detail code", async () => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture("handled-detail")
    const handled = makeHandled(capture, { detailCode: "provider_error" })
    expect(store.writeBlueBubblesSemanticHandled("synthetic-agent", handled, semanticStoreDeps()))
      .toBe("semantic_handled_published")
  })

  it.each([
    ["non-record", () => null],
    ["extra key", (record: Record<string, unknown>) => ({ ...record, extra: true })],
    ["schema", (record: Record<string, unknown>) => ({ ...record, schemaVersion: 2 })],
    ["canonical key", (record: Record<string, unknown>) => ({ ...record, canonicalKey: "other" })],
    ["key hash", (record: Record<string, unknown>) => ({ ...record, keyHash: "f".repeat(64) })],
    ["owner record", (record: Record<string, unknown>) => ({ ...record, owner: null })],
    ["owner extra", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), extra: true },
    })],
    ["operation id", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), operationId: "other" },
    })],
    ["pid type", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), pid: "1" },
    })],
    ["pid integer", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), pid: 1.5 },
    })],
    ["pid positive", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), pid: 0 },
    })],
    ["boot type", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), bootIdentity: 7 },
    })],
    ["boot empty", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), bootIdentity: "" },
    })],
    ["process start type", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), processStartedAt: 7 },
    })],
    ["process start empty", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), processStartedAt: "" },
    })],
    ["acquired timestamp", (record: Record<string, unknown>) => ({
      ...record,
      owner: { ...(record.owner as Record<string, unknown>), acquiredAt: "invalid" },
    })],
  ])("quarantines invalid %s claim ownership before acquiring", async (_label, mutate) => {
    const store = await loadSemanticStore()
    const capture = makeSemanticCapture(`invalid-claim-${_label}`)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const ownerPath = path.join(paths.claims, `${capture.keyHash}.owner.json`)
    const owner = buildBlueBubblesSemanticClaimRecord({
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      operationId: `semantic-handle:${capture.keyHash}`,
      pid: 1001,
      bootIdentity: "boot-current",
      processStartedAt: "process-1001",
      acquiredAt: CUTOVER_AT,
    })
    writeRawSemanticRecord(ownerPath, mutate(owner as unknown as Record<string, unknown>))

    const result = await store.acquireBlueBubblesSemanticClaim(
      "synthetic-agent",
      capture,
      semanticStoreDeps({ pid: () => 1002 }),
    )
    expect(result.status).toBe("acquired")
    store.releaseBlueBubblesSemanticClaim(
      "synthetic-agent",
      result as SemanticClaimLeaseForTest,
      semanticStoreDeps(),
    )
  })

  it.each([
    ["non-record", () => null],
    ["extra key", (record: Record<string, unknown>) => ({ ...record, extra: true })],
    ["schema", (record: Record<string, unknown>) => ({ ...record, schemaVersion: 2 })],
    ["coordinate key", (record: Record<string, unknown>) => ({ ...record, coordinateKey: "other" })],
    ["coordinate hash", (record: Record<string, unknown>) => ({ ...record, coordinateHash: "f".repeat(64) })],
    ["generation type", (record: Record<string, unknown>) => ({ ...record, generation: "0" })],
    ["generation integer", (record: Record<string, unknown>) => ({ ...record, generation: 1.5 })],
    ["generation positive", (record: Record<string, unknown>) => ({ ...record, generation: -1 })],
    ["action", (record: Record<string, unknown>) => ({ ...record, lastAction: "other" })],
    ["updated timestamp", (record: Record<string, unknown>) => ({ ...record, updatedAt: "invalid" })],
  ])("quarantines an invalid coordinate %s and refuses reset", async (_label, mutate) => {
    const store = await loadSemanticStore()
    const coordinateKey = JSON.stringify(["invalid-coordinate", _label])
    const coordinateHash = sha256(coordinateKey)
    const paths = getBlueBubblesSemanticPaths("synthetic-agent")
    const finalPath = path.join(paths.coordinates, `${coordinateHash}.json`)
    const valid = buildBlueBubblesReactionCoordinateRecord({
      coordinateKey,
      coordinateHash,
      generation: 0,
      lastAction: "add",
      updatedAt: CUTOVER_AT,
    })
    writeRawSemanticRecord(finalPath, mutate(valid as unknown as Record<string, unknown>))

    await expect(store.allocateBlueBubblesReactionCoordinate(
      "synthetic-agent",
      { coordinateKey, coordinateHash, canonicalAction: "remove" },
      semanticStoreDeps(),
    )).rejects.toThrow("semantic_coordinate_invalid")
  })
})
