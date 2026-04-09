import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  advancePonderPacket,
  createPonderPacket,
  findHarnessFrictionPacket,
  getPonderPacketArtifactsDir,
  listPonderPackets,
  readPonderPacket,
  revisePonderPacket,
} from "../../arc/packets"

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
