import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
      handled: path.join(expectedRoot, "handled"),
      claims: path.join(expectedRoot, "claims"),
      coordinates: path.join(expectedRoot, "coordinates"),
      quarantine: path.join(expectedRoot, "quarantine"),
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
      linkSync?: (...args: unknown[]) => void
      writeFileSync?: (...args: unknown[]) => void
      unlinkSync?: (...args: unknown[]) => void
    } = {}
    vi.resetModules()
    vi.doMock("node:fs", () => ({
      ...actualFs,
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
})
