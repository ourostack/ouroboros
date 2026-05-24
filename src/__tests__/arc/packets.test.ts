import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  closeEvolutionCase,
  listEvolutionCases,
  readEvolutionCase,
  readEvolutionTrace,
} from "../../arc/evolution"
import {
  advancePonderPacket,
  completePonderPacket,
  createPonderPacket,
  findHarnessFrictionPacket,
  getPonderPacketArtifactsDir,
  listPonderPackets,
  readPonderPacket,
  revisePonderPacket,
} from "../../arc/packets"
import { expectCappedAgentContent, makeOversizedAgentContent } from "../helpers/content-cap"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packets-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("ponder packets", () => {
  it("keeps packets decoupled from repertoire imports", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../arc/packets.ts"), "utf-8")

    expect(source).not.toContain("../repertoire/")
  })

  it("creates drafting packets with SOP and linked relationship fields", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Make screenshot interrogation bulletproof",
      summary: "Large TIFF image friction should become a harness fix candidate",
      successCriteria: [
        "All inbound images remain reachable",
        "The original task gets replayed after the fix lands",
      ],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      relatedObligationId: "obl-1",
      relatedReturnObligationId: "ret-1",
      payload: {
        frictionSignature: "describe_image:image/tiff:oversize",
        userObjective: "Read the booking screenshot correctly",
      },
    })

    expect(packet.id).toMatch(/^pkt-/)
    expect(packet.status).toBe("drafting")
    expect(packet.sop).toBe("harness_friction_v1")
    expect(packet.relatedObligationId).toBe("obl-1")
    expect(packet.relatedReturnObligationId).toBe("ret-1")
    expect(readPonderPacket(agentRoot, packet.id)).toMatchObject({
      id: packet.id,
      kind: "harness_friction",
      objective: "Make screenshot interrogation bulletproof",
    })
  })

  it("creates an evolution case for harness-friction packets with a friction signature", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Make screenshot interrogation bulletproof",
      summary: "Large TIFF image friction should become a harness fix candidate",
      successCriteria: [
        "All inbound images remain reachable",
        "The original task gets replayed after the fix lands",
      ],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      payload: {
        frictionSignature: "describe_image:image/tiff:oversize",
        userObjective: "Read the booking screenshot correctly",
      },
    })

    expect(packet.payload.evolutionCaseId).toMatch(/^evo-/)
    const evolutionCaseId = packet.payload.evolutionCaseId as string
    const storedPacket = readPonderPacket(agentRoot, packet.id)
    const evolutionCase = readEvolutionCase(agentRoot, evolutionCaseId)

    expect(storedPacket?.payload.evolutionCaseId).toBe(evolutionCaseId)
    expect(evolutionCase).toMatchObject({
      id: evolutionCaseId,
      title: "Make screenshot interrogation bulletproof",
      problemStatement: "Large TIFF image friction should become a harness fix candidate",
      desiredBehavior: "All inbound images remain reachable; The original task gets replayed after the fix lands",
      packetId: packet.id,
      frictionSignature: "describe_image:image/tiff:oversize",
      origin: {
        kind: "session",
        label: "ari/bluebubbles/chat",
        locator: `arc/packets/${packet.id}.json`,
      },
    })
    expect(evolutionCase?.evidenceRefs).toEqual([
      {
        kind: "ponder_packet",
        locator: `arc/packets/${packet.id}.json`,
        capturedAt: new Date(packet.createdAt).toISOString(),
        redaction: "summary",
        reason: "Harness-friction ponder packet created this evolution case",
      },
    ])
    expect(readEvolutionTrace(agentRoot, evolutionCaseId).map((event) => ({
      type: event.type,
      evidenceRefs: event.evidenceRefs,
    }))).toContainEqual({
      type: "evidence_added",
      evidenceRefs: [`arc/packets/${packet.id}.json`],
    })
  })

  it("reuses an open evolution case for later harness-friction packets with the same signature", () => {
    const agentRoot = makeAgentRoot()
    const first = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix image retry behavior",
      summary: "First friction packet",
      successCriteria: ["No more raw TIFF dead-ends"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
    })
    const second = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix image retry behavior again",
      summary: "Second friction packet",
      successCriteria: ["Still no raw TIFF dead-ends"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
    })

    expect(second.payload.evolutionCaseId).toBe(first.payload.evolutionCaseId)
    expect(listEvolutionCases(agentRoot)).toHaveLength(1)
    expect(readEvolutionCase(agentRoot, first.payload.evolutionCaseId as string)?.evidenceRefs.map((ref) => ref.locator)).toEqual([
      `arc/packets/${first.id}.json`,
      `arc/packets/${second.id}.json`,
    ])
    expect(readEvolutionTrace(agentRoot, first.payload.evolutionCaseId as string).map((event) => event.evidenceRefs?.[0]).filter(Boolean)).toEqual([
      `arc/packets/${first.id}.json`,
      `arc/packets/${second.id}.json`,
    ])
  })

  it("does not attach evolution state to non-harness-friction packets", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Map attachment ingress",
      summary: "Research packet",
      successCriteria: ["Collect ingress points"],
      payload: { frictionSignature: "research:attachment-map" },
    })

    expect(packet.payload.evolutionCaseId).toBeUndefined()
    expect(readPonderPacket(agentRoot, packet.id)?.payload.evolutionCaseId).toBeUndefined()
    expect(listEvolutionCases(agentRoot)).toEqual([])
  })

  it("leaves unsigned harness-friction packets unbound", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Notice vague harness friction",
      summary: "The agent felt friction but did not produce a stable signature",
      successCriteria: ["Capture the raw packet without pretending it is reusable"],
      payload: { frictionSignature: "   " },
    })

    expect(packet.payload.evolutionCaseId).toBeUndefined()
    expect(listEvolutionCases(agentRoot)).toEqual([])
  })

  it("uses runtime origin and fallback desired behavior when a signed harness-friction packet is sparse", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Capture sparse harness friction",
      summary: "A packet can be material even before success criteria are crisp",
      successCriteria: [],
      payload: { frictionSignature: "harness:sparse-friction" },
    })

    const evolutionCase = readEvolutionCase(agentRoot, packet.payload.evolutionCaseId as string)

    expect(evolutionCase).toMatchObject({
      origin: {
        kind: "runtime",
        label: "ponder packet",
        locator: `arc/packets/${packet.id}.json`,
      },
      desiredBehavior: "Resolve the captured harness friction.",
    })
  })

  it("does not reuse terminal evolution cases for matching harness-friction signatures", () => {
    const agentRoot = makeAgentRoot()
    const first = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix closed friction",
      summary: "First packet will close",
      successCriteria: ["Close cleanly"],
      payload: { frictionSignature: "harness:closed-friction" },
    })
    closeEvolutionCase(agentRoot, first.payload.evolutionCaseId as string, {
      reason: "Synthetic case closed",
      ratification: {
        destination: "none_needed",
        locator: "case://none",
        landedAt: "2026-05-23T21:20:00.000Z",
        reason: "No durable lesson for this packet fixture",
      },
    })
    const second = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix closed friction again",
      summary: "Terminal cases must not absorb fresh evidence",
      successCriteria: ["Create a fresh case"],
      payload: { frictionSignature: "harness:closed-friction" },
    })

    expect(second.payload.evolutionCaseId).not.toBe(first.payload.evolutionCaseId)
    expect(listEvolutionCases(agentRoot)).toHaveLength(2)
  })

  it("caps oversized agent-authored packet fields before writing JSON", () => {
    const agentRoot = makeAgentRoot()
    const oversized = makeOversizedAgentContent("packet field ")
    const packet = createPonderPacket(agentRoot, {
      kind: "research",
      objective: oversized,
      summary: oversized,
      successCriteria: [oversized],
      payload: { details: oversized, nested: { note: oversized } },
    })

    const stored = readPonderPacket(agentRoot, packet.id)
    expect(stored).not.toBeNull()
    expectCappedAgentContent(stored!.objective, oversized)
    expectCappedAgentContent(stored!.summary, oversized)
    expectCappedAgentContent(stored!.successCriteria[0], oversized)
    expectCappedAgentContent((stored!.payload as any).details, oversized)
    expectCappedAgentContent((stored!.payload as any).nested.note, oversized)
  })

  it("revises drafting packets in place without changing identity", () => {
    const agentRoot = makeAgentRoot()
    const created = createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Understand attachment drop behavior",
      summary: "Trace attachment visibility across senses",
      successCriteria: ["Map every attachment ingress point"],
      payload: { source: "initial" },
    })

    const revised = revisePonderPacket(agentRoot, created.id, {
      kind: "research",
      objective: "Understand attachment and packet behavior",
      summary: "Trace attachment visibility and ponder semantics together",
      successCriteria: [
        "Map every attachment ingress point",
        "Document packet return semantics",
      ],
      payload: { source: "revised" },
    })

    expect(revised.id).toBe(created.id)
    expect(revised.objective).toBe("Understand attachment and packet behavior")
    expect(revised.summary).toContain("ponder semantics")
    expect(revised.successCriteria).toHaveLength(2)
    expect(revised.payload).toEqual({ source: "revised" })
  })

  it("preserves follow-up linkage and reads invalid packet files as null", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "reflection",
      objective: "Refine the active packet without duplicating it",
      summary: "This packet follows an earlier packet",
      successCriteria: ["Keep a single packet identity"],
      followsPacketId: "pkt-parent",
      payload: {},
    })

    const packetsPath = path.join(agentRoot, "arc", "packets")
    fs.writeFileSync(path.join(packetsPath, "pkt-bad.json"), JSON.stringify({ nope: true }), "utf-8")

    expect(packet.followsPacketId).toBe("pkt-parent")
    expect(readPonderPacket(agentRoot, "pkt-bad")).toBeNull()
  })

  it("filters packets whose status is not part of the shared task lifecycle", () => {
    const agentRoot = makeAgentRoot()
    const packetsPath = path.join(agentRoot, "arc", "packets")
    fs.mkdirSync(packetsPath, { recursive: true })
    fs.writeFileSync(
      path.join(packetsPath, "pkt-invalid-status.json"),
      JSON.stringify({
        id: "pkt-invalid-status",
        kind: "research",
        sop: "research_v1",
        status: "mystery",
        objective: "bad",
        summary: "bad",
        successCriteria: [],
        payload: {},
        createdAt: 1,
        updatedAt: 1,
      }),
      "utf-8",
    )

    expect(listPonderPackets(agentRoot)).toEqual([])
    expect(readPonderPacket(agentRoot, "pkt-invalid-status")).toBeNull()
  })

  it("rejects revise when the packet is no longer drafting", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "reflection",
      objective: "Think through queue semantics",
      summary: "Lightweight reflection packet",
      successCriteria: ["Capture one coherent design"],
      payload: {},
    })

    advancePonderPacket(agentRoot, packet.id, { status: "processing" })

    expect(() =>
      revisePonderPacket(agentRoot, packet.id, {
        kind: "reflection",
        objective: "Changed objective",
        summary: "Changed summary",
        successCriteria: ["Changed criterion"],
        payload: {},
      }),
    ).toThrow(/follow-up packet/i)
  })

  it("finds harness friction packets by origin plus friction signature", () => {
    const agentRoot = makeAgentRoot()
    const first = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix image retry behavior",
      summary: "First friction packet",
      successCriteria: ["No more raw TIFF dead-ends"],
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
    })
    createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Different origin",
      summary: "Should not match",
      successCriteria: ["No-op"],
      origin: { friendId: "sam", channel: "mcp", key: "session" },
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
    })

    const found = findHarnessFrictionPacket(
      agentRoot,
      { friendId: "ari", channel: "bluebubbles", key: "chat" },
      "describe_image:image/tiff:oversize",
    )

    expect(found?.id).toBe(first.id)
  })

  it("filters invalid packet records and preserves valid packets in creation order", () => {
    const agentRoot = makeAgentRoot()
    const packetsPath = path.join(agentRoot, "arc", "packets")
    fs.mkdirSync(packetsPath, { recursive: true })
    fs.writeFileSync(
      path.join(packetsPath, "invalid.json"),
      JSON.stringify({ id: "pkt-invalid", kind: "mystery", status: "drafting" }),
      "utf-8",
    )

    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(1_700_000_000_001)

    const research = createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Map attachment ingress",
      summary: "Research packet",
      successCriteria: ["Collect ingress points"],
      payload: {},
    })
    const reflection = createPonderPacket(agentRoot, {
      kind: "reflection",
      objective: "Think through return discipline",
      summary: "Reflection packet",
      successCriteria: ["Capture a single rule"],
      payload: {},
    })
    nowSpy.mockRestore()

    expect(listPonderPackets(agentRoot).map((packet) => packet.id)).toEqual([research.id, reflection.id])
  })

  it("can advance linkage metadata without changing status and ignores non-matching friction packets", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Fix one image edge case",
      summary: "Track the same packet across returns",
      successCriteria: ["Return once before picking up the next packet"],
      payload: { frictionSignature: "describe_image:image/tiff:oversize" },
    })
    createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Map attachment paths",
      summary: "Different packet kind",
      successCriteria: ["List ingress points"],
      payload: {},
    })

    const advanced = advancePonderPacket(agentRoot, packet.id, {
      relatedObligationId: "obl-2",
      relatedReturnObligationId: "ret-2",
    })

    expect(advanced.status).toBe("drafting")
    expect(advanced.relatedObligationId).toBe("obl-2")
    expect(advanced.relatedReturnObligationId).toBe("ret-2")
    expect(
      findHarnessFrictionPacket(
        agentRoot,
        { friendId: "ari", channel: "bluebubbles", key: "chat" },
        "describe_image:image/tiff:oversize",
      ),
    ).toBeNull()
  })

  it("throws clear errors for missing packets and invalid transitions", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Probe packet transitions",
      summary: "Transition packet",
      successCriteria: ["Exercise invalid edges"],
      payload: {},
    })

    expect(() =>
      revisePonderPacket(agentRoot, "pkt-missing", {
        kind: "research",
        objective: "Missing packet",
        summary: "Missing",
        successCriteria: ["Missing"],
        payload: {},
      }),
    ).toThrow("packet not found: pkt-missing")

    expect(() => advancePonderPacket(agentRoot, "pkt-missing", { status: "processing" })).toThrow(
      "packet not found: pkt-missing",
    )

    advancePonderPacket(agentRoot, packet.id, { status: "processing" })
    expect(() => advancePonderPacket(agentRoot, packet.id, { status: "drafting" })).toThrow(/transition/i)
  })

  it("completes a packet through the valid lifecycle path", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "reflection",
      objective: "Return a private thought",
      summary: "The result was surfaced",
      successCriteria: ["Surface the held answer"],
      payload: {},
    })

    const completed = completePonderPacket(agentRoot, packet.id)

    expect(completed.status).toBe("done")
    expect(readPonderPacket(agentRoot, packet.id)?.status).toBe("done")
  })

  it("leaves already terminal packets unchanged when completing", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "reflection",
      objective: "Already done",
      summary: "Terminal packet",
      successCriteria: ["No-op"],
      payload: {},
    })
    advancePonderPacket(agentRoot, packet.id, { status: "processing" })
    advancePonderPacket(agentRoot, packet.id, { status: "validating" })
    advancePonderPacket(agentRoot, packet.id, { status: "done" })

    const completed = completePonderPacket(agentRoot, packet.id)

    expect(completed.status).toBe("done")
  })

  it("throws when completing a missing packet", () => {
    const agentRoot = makeAgentRoot()

    expect(() => completePonderPacket(agentRoot, "pkt-missing")).toThrow("packet not found: pkt-missing")
  })

  it("exposes a durable state-artifacts directory for packet repro evidence", () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "harness_friction",
      objective: "Capture fragile image repro",
      summary: "Need a place to snapshot normalized artifacts",
      successCriteria: ["Packet has a stable artifacts path"],
      payload: { attachmentId: "attachment:bluebubbles:GUID-1" },
    })

    const artifactsDir = getPonderPacketArtifactsDir(agentRoot, packet.id)
    expect(artifactsDir).toBe(path.join(agentRoot, "state", "packets", packet.id))
  })
})
