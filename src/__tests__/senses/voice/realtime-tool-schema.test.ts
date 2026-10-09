import { describe, expect, it, vi } from "vitest"
import { createRealtimeToolAdvertiser, realtimeToolsFromDefinitions, realtimeToolParameters } from "../../../senses/voice/realtime-tool-schema"
import * as nerves from "../../../nerves/runtime"
import { selectToolsForChannel } from "../../../repertoire/tools"
import { continuityToolDefinitions } from "../../../repertoire/tools-continuity"
import { parseToolArguments } from "../../../senses/voice/twilio-phone"
import { getChannelCapabilities } from "@ouro.bot/friends"

const FORBIDDEN = ["oneOf", "anyOf", "allOf", "enum", "const", "not"]

function assertRealtimeValid(parameters: unknown): void {
  expect(parameters).toBeTypeOf("object")
  const schema = parameters as Record<string, unknown>
  expect(schema.type).toBe("object")
  for (const key of FORBIDDEN) expect(schema).not.toHaveProperty(key)
}

describe("realtimeToolParameters", () => {
  it("defaults a missing schema to an empty object schema", () => {
    expect(realtimeToolParameters(undefined)).toEqual({ type: "object", properties: {} })
  })

  it("passes a valid schema through unchanged", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
    expect(realtimeToolParameters(schema)).toBe(schema)
  })

  it("folds a top-level oneOf of objects into one object with optional properties", () => {
    const result = realtimeToolParameters({
      type: "object",
      properties: { shared: { type: "string" } },
      oneOf: [
        { type: "object", properties: { a: { type: "string" }, shared: { type: "number" } }, required: ["a"] },
        { type: "object", properties: { batch: { type: "array" } }, required: ["batch"] },
        { type: "string" },
      ],
      required: ["shared"],
      additionalProperties: false,
    }) as Record<string, unknown>
    assertRealtimeValid(result)
    expect(result.properties).toEqual({ shared: { type: "string" }, a: { type: "string" }, batch: { type: "array" } })
    expect(result.required).toEqual(["shared"])
    expect(result.additionalProperties).toBe(false)
  })

  it("folds anyOf and allOf and strips enum and not", () => {
    const result = realtimeToolParameters({
      type: "object",
      anyOf: [{ properties: { x: { type: "string" } } }],
      allOf: [{ type: "object", properties: { y: { type: "string" } } }],
      enum: [{}],
      const: {},
      not: { required: ["z"] },
    }) as Record<string, unknown>
    assertRealtimeValid(result)
    expect(result.properties).toEqual({ x: { type: "string" }, y: { type: "string" } })
  })

  it("handles combinators without branch properties and schemas lacking type", () => {
    const result = realtimeToolParameters({ oneOf: [null, { type: "object" }] }) as Record<string, unknown>
    assertRealtimeValid(result)
    expect(result.properties).toEqual({})
  })

  it("rejects a schema that is not an object type", () => {
    expect(realtimeToolParameters({ type: "string" })).toBeNull()
    expect(realtimeToolParameters("nope")).toBeNull()
    expect(realtimeToolParameters([])).toBeNull()
  })
})

describe("realtimeToolsFromDefinitions", () => {
  it("builds function tools, normalizing parameters and keeping descriptions", () => {
    const tools = realtimeToolsFromDefinitions([
      { function: { name: "a", description: "does a", parameters: { type: "object", oneOf: [{ properties: { q: {} } }] } } },
      { function: { name: "b" } },
    ])
    expect(tools).toEqual([
      { type: "function", name: "a", description: "does a", parameters: { type: "object", properties: { q: {} } } },
      { type: "function", name: "b", parameters: { type: "object", properties: {} } },
    ])
  })

  it("drops tools whose schema cannot be made valid and warns", () => {
    const dropped = vi.fn()
    const tools = realtimeToolsFromDefinitions([
      { function: { name: "bad", parameters: { type: "array" } as never } },
      { function: { name: "ok", parameters: { type: "object", properties: {} } } },
    ], { dropped, conflict: vi.fn() })
    expect(tools.map((t) => t.name)).toEqual(["ok"])
    expect(dropped).toHaveBeenCalledWith("bad")
  })

  it("emits a warn nerves event by default when a tool is dropped", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    realtimeToolsFromDefinitions([{ function: { name: "bad", parameters: { type: "array" } as never } }])
    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn", event: "senses.voice_realtime_tool_dropped", meta: { toolName: "bad" },
    }))
    events.mockRestore()
  })

  it("makes every real voice selection valid for Realtime without dropping a tool", () => {
    const sanctuaryAuth = (profileId: string) => ({
      agentName: "sanctuary",
      relationshipAuthorization: { profileId, advertisedToolNames: { includes: () => true } },
    })
    const selections = [
      ["default", selectToolsForChannel(getChannelCapabilities("voice"))],
      ...["sanctuary-owner", "sanctuary-household", "sanctuary-agent-peer"].map((profile) =>
        [profile, selectToolsForChannel(getChannelCapabilities("voice"), undefined, undefined, undefined, undefined, undefined, sanctuaryAuth(profile) as never)] as const),
    ] as const
    for (const [label, selected] of selections) {
      expect(selected.ordinary.length, label).toBeGreaterThan(0)
      const dropped = vi.fn()
      const conflict = vi.fn()
      const tools = realtimeToolsFromDefinitions(selected.ordinary.map(({ tool }) => tool), { dropped, conflict })
      expect(dropped, label).not.toHaveBeenCalled()
      expect(conflict, label).not.toHaveBeenCalled()
      expect(tools, label).toHaveLength(selected.ordinary.length)
      for (const tool of tools) assertRealtimeValid(tool.parameters)
    }
    const owner = selections[1]![1]
    expect(owner.ordinary.some(({ tool }) => tool.function.name === "external_event_disposition")).toBe(true)
  })

  it("explains the oneOf branches of the real external_event_disposition tool in its description", () => {
    const definition = continuityToolDefinitions.find(({ tool }) => tool.function.name === "external_event_disposition")!
    const [tool] = realtimeToolsFromDefinitions([definition.tool])
    expect(tool!.description).toContain("Classify the exact external-event generation")
    expect(tool!.description).toMatch(/Provide exactly one of: \(1\) .*recordPath.*\(all required\); \(2\) batch \(all required\)\./)
  })
})

describe("folded schema details", () => {
  const fold = (schema: unknown) => realtimeToolsFromDefinitions([{ function: { name: "t", description: "d", parameters: schema as never } }], { dropped: vi.fn(), conflict: vi.fn() })[0]!

  it("says one or more of for anyOf and handles branches without required fields", () => {
    const tool = fold({ anyOf: [{ properties: { a: {} } }, { properties: { b: {} }, required: ["b"] }] })
    expect(tool.description).toBe("d Provide one or more of: (1) no required fields; (2) b (all required).")
  })

  it("uses the note alone when the tool has no description", () => {
    const [tool] = realtimeToolsFromDefinitions([{ function: { name: "t", parameters: { oneOf: [{ properties: { a: {} } }, { properties: { b: {} } }] } } }])
    expect(tool!.description).toBe("Provide exactly one of: (1) no required fields; (2) no required fields.")
  })

  it("merges required from every allOf branch and from a single oneOf/anyOf branch, deduped and existing only", () => {
    const tool = fold({
      type: "object",
      properties: { top: {} },
      required: ["top"],
      allOf: [
        { properties: { a: {} }, required: ["a", "top"] },
        { properties: { b: {} }, required: ["b", "ghost"] },
      ],
      oneOf: [{ properties: { c: {} }, required: ["c"] }],
      anyOf: [{ properties: { d: {} }, required: [7, "d"] }],
    })
    expect((tool.parameters as { required: string[] }).required).toEqual(["top", "c", "d", "a", "b"])
    expect(tool.description).toBe("d")
  })

  it("omits required when nothing is required", () => {
    expect(fold({ allOf: [{ properties: { a: {} } }] }).parameters).toEqual({ type: "object", properties: { a: {} } })
  })

  it("keeps the first conflicting definition, mentions the conflict and warns once per property", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const advertiser = createRealtimeToolAdvertiser({ agentName: "a", callSid: "CA1" })
    const definition = { function: { name: "t", description: "d", parameters: {
      type: "object",
      properties: { x: { type: "string" }, same: { type: "string" } },
      oneOf: [
        { properties: { x: { type: "number" }, same: { type: "string" } } },
        { properties: { x: { enum: [1] } } },
      ],
    } } }
    const [tool] = advertiser.tools([definition])
    advertiser.tools([definition])
    expect((tool!.parameters as { properties: unknown }).properties).toEqual({ x: { type: "string" }, same: { type: "string" } })
    expect(tool!.description).toContain("`x` may also be: number, {\"enum\":[1]}.")
    const conflicts = events.mock.calls.filter(([e]) => e.event === "senses.voice_realtime_tool_schema_conflict")
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]![0]).toMatchObject({ level: "warn", meta: { agentName: "a", callSid: "CA1", toolName: "t", property: "x" } })
    events.mockRestore()
  })

  it("describes array-typed conflicting definitions", () => {
    const tool = fold({ properties: { x: { type: "string" } }, oneOf: [{ properties: { x: { type: ["null", "number"] } } }] })
    expect(tool.description).toContain("`x` may also be: null|number.")
  })

  it("deep-compares arrays and nested objects so identical duplicates do not warn", () => {
    const conflict = vi.fn()
    const nested = () => ({ type: "array", items: { enum: ["a", "b"], properties: { k: { type: "string" } } } })
    realtimeToolsFromDefinitions([{ function: { name: "t", parameters: {
      properties: { x: nested() }, oneOf: [{ properties: { x: nested() } }],
    } as never } }], { dropped: vi.fn(), conflict })
    expect(conflict).not.toHaveBeenCalled()
    realtimeToolsFromDefinitions([{ function: { name: "t", parameters: {
      properties: { x: nested() }, oneOf: [{ properties: { x: { ...nested(), items: { enum: ["a"] } } } }, { properties: { x: { ...nested(), items: { enum: ["a", "c"] } } } }, { properties: { x: [] } }],
    } as never } }], { dropped: vi.fn(), conflict })
    expect(conflict).toHaveBeenCalledTimes(1)
  })

  it("resolves local $ref branches from $defs and definitions", () => {
    const tool = fold({
      $defs: { A: { properties: { a: { type: "string" } }, required: ["a"] } },
      definitions: { B: { $ref: "#/$defs/A" }, "we/ird~": { properties: { w: {} } } },
      oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/definitions/B" }, { $ref: "#/definitions/we~1ird~0" }],
    })
    expect((tool.parameters as { properties: unknown }).properties).toEqual({ a: { type: "string" }, w: {} })
    expect(tool.description).toContain("(1) a (all required); (2) a (all required); (3) no required fields")
  })

  it("drops a tool whose branch $ref cannot be resolved", () => {
    for (const ref of ["#/$defs/Missing", "https://example.com/x.json", "#/$defs/Loop"]) {
      const dropped = vi.fn()
      const tools = realtimeToolsFromDefinitions([{ function: { name: "t", parameters: {
        $defs: { Loop: { $ref: "#/$defs/Loop" } },
        oneOf: [{ $ref: ref }],
      } as never } }], { dropped, conflict: vi.fn() })
      expect(tools, ref).toEqual([])
      expect(dropped, ref).toHaveBeenCalledWith("t")
    }
  })
})

describe("per-call advertising", () => {
  const bad = { function: { name: "bad", parameters: { type: "array" } as never } }
  const good = { function: { name: "good", parameters: { type: "object", properties: {} } } }

  it("warns about a dropped tool once per call with agent and call id", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const advertiser = createRealtimeToolAdvertiser({ agentName: "slugger", callId: "rtc_1" })
    advertiser.tools([bad, good])
    advertiser.tools([bad, good])
    advertiser.isAdvertised([bad, good], "good")
    const drops = events.mock.calls.filter(([e]) => e.event === "senses.voice_realtime_tool_dropped")
    expect(drops).toHaveLength(1)
    expect(drops[0]![0]).toMatchObject({ level: "warn", meta: { agentName: "slugger", callId: "rtc_1", toolName: "bad" } })
    events.mockRestore()
  })

  it("rejects tool calls for dropped or unknown tools before parsing arguments", () => {
    const advertiser = createRealtimeToolAdvertiser()
    const selection = { ordinary: [{ tool: bad }, { tool: good }], engine: [] } as never
    expect(() => parseToolArguments("{}", "bad", selection, advertiser)).toThrow("tool bad is not advertised in this voice session")
    expect(() => parseToolArguments("{}", "ghost", selection, advertiser)).toThrow("tool ghost is not advertised")
    expect(parseToolArguments("{}", "good", selection, advertiser)).toEqual({})
    expect(() => parseToolArguments(5, "good", selection, advertiser)).toThrow("invalid tool arguments")
  })
})
