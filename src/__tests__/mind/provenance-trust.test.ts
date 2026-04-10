import { describe, it, expect } from "vitest"
import { classifyProvenanceTrust, type ProvenanceTrust } from "../../mind/provenance-trust"
import type { DiaryEntryProvenance } from "../../mind/diary"

describe("classifyProvenanceTrust", () => {
  it('returns "self" when provenance is undefined', () => {
    expect(classifyProvenanceTrust(undefined)).toBe("self")
  })

  it('returns "self" when provenance has no channel and no friend', () => {
    const prov: DiaryEntryProvenance = { tool: "diary_write" }
    expect(classifyProvenanceTrust(prov)).toBe("self")
  })

  it('returns "self" for inner channel with no friend', () => {
    const prov: DiaryEntryProvenance = { tool: "diary_write", channel: "inner" }
    expect(classifyProvenanceTrust(prov)).toBe("self")
  })

  it('returns "trusted" for family trust level', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "bluebubbles",
      friendId: "f-1",
      friendName: "alice",
      trust: "family",
    }
    expect(classifyProvenanceTrust(prov)).toBe("trusted")
  })

  it('returns "trusted" for friend trust level', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "bluebubbles",
      friendId: "f-2",
      friendName: "bob",
      trust: "friend",
    }
    expect(classifyProvenanceTrust(prov)).toBe("trusted")
  })

  it('returns "external" for acquaintance trust level', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "bluebubbles",
      friendId: "f-3",
      friendName: "carol",
      trust: "acquaintance",
    }
    expect(classifyProvenanceTrust(prov)).toBe("external")
  })

  it('returns "external" for stranger trust level', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "bluebubbles",
      friendId: "f-4",
      friendName: "dave",
      trust: "stranger",
    }
    expect(classifyProvenanceTrust(prov)).toBe("external")
  })

  it('returns "external" for teams channel with no trust', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "teams",
    }
    expect(classifyProvenanceTrust(prov)).toBe("external")
  })

  it('returns "trusted" for teams channel with family trust', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "teams",
      friendId: "f-5",
      friendName: "eve",
      trust: "family",
    }
    expect(classifyProvenanceTrust(prov)).toBe("trusted")
  })

  it('returns "external" for non-inner channel with no friend or trust', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "bluebubbles",
    }
    expect(classifyProvenanceTrust(prov)).toBe("external")
  })

  it('returns "self" for inner channel with friend (classified by trust)', () => {
    const prov: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "inner",
      friendId: "f-6",
      friendName: "frank",
      trust: "family",
    }
    expect(classifyProvenanceTrust(prov)).toBe("trusted")
  })
})
