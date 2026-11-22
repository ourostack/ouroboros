import { describe, expect, it, vi } from "vitest"

vi.mock("../../heart/identity", () => ({ getAgentRoot: vi.fn(() => "/agent"), getAgentName: vi.fn(() => "slugger") }))
vi.mock("../../heart/external-events/router", () => ({
  commitExternalEventDisposition: vi.fn(),
  getExternalEventRoot: vi.fn(() => "/events"),
  readExternalEventRecord: vi.fn(),
}))

import { continuityToolDefinitions } from "../../repertoire/tools-continuity"

const tool = (name: string) => continuityToolDefinitions.find((d) => d.tool.function.name === name)!

describe("continuity tools' Ouro AX cards", () => {
  it("gives every continuity tool a card named after it, with reads backed by a profile that changes nothing", () => {
    for (const def of continuityToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toMatch(/^turn-(external-events|continuity)$/)
    }
    for (const name of ["query_episodes", "query_presence", "query_cares", "query_relationships"]) {
      expect(tool(name).ax?.effect).toBe("read")
      expect(tool(name).riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
    for (const name of ["external_event_disposition", "capture_episode", "care_manage", "intention_capture", "intention_manage"]) {
      expect(tool(name).ax?.effect).toBe("write")
    }
  })

  it("ends each refusal with the code its card names", () => {
    const dispose = tool("external_event_disposition").handler
    expect(() => dispose({ batch: [], recordPath: "x" } as never)).toThrow(/^External event disposition single and batch forms are mutually exclusive \(code: disposition-invalid\)$/u)
    expect(() => dispose({ batch: [] } as never)).toThrow(/^External event disposition batch must contain 1 to 32 items \(code: disposition-invalid\)$/u)
    expect(() => dispose({ recordPath: "/elsewhere/x.json" } as never)).toThrow(/^External event receipt does not belong to the current agent \(code: receipt-not-this-turn\)$/u)
    expect(() => tool("care_manage").handler({ action: "bind_incident", id: "c-1" })).toThrow(/^bind_incident requires expectedUpdatedAt: .* \(code: expected-updated-at-required\)$/u)
  })
})
