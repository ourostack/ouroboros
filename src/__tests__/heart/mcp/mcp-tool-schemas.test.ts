import { describe, it, expect } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { getToolSchemas } from "../../../heart/mcp/mcp-server"

describe("MCP tool schemas", () => {
  it("returns exactly 15 tool schemas", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing tool schema count",
      meta: {},
    })

    const schemas = getToolSchemas()
    expect(schemas).toHaveLength(15)

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "tool schema count test complete",
      meta: {},
    })
  })

  it("includes all expected tool names", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing tool names",
      meta: {},
    })

    const schemas = getToolSchemas()
    const names = schemas.map((s) => s.name)

    const expected = [
      "ask",
      "status",
      "catchup",
      "delegate",
      "get_context",
      "search_notes",
      "get_task",
      "check_scope",
      "request_decision",
      "check_guidance",
      "report_progress",
      "report_blocker",
      "report_complete",
      "send_message",
      "check_response",
    ]

    for (const name of expected) {
      expect(names).toContain(name)
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "tool names test complete",
      meta: {},
    })
  })

  it("each tool has valid inputSchema with type 'object'", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing schema structure",
      meta: {},
    })

    const schemas = getToolSchemas()
    for (const schema of schemas) {
      expect(schema.inputSchema.type).toBe("object")
      expect(schema.inputSchema.properties).toBeDefined()
      expect(typeof schema.inputSchema.properties).toBe("object")
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "schema structure test complete",
      meta: {},
    })
  })

  it("each tool has a non-empty description", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing schema descriptions",
      meta: {},
    })

    const schemas = getToolSchemas()
    for (const schema of schemas) {
      expect(schema.description.length).toBeGreaterThan(10)
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "schema descriptions test complete",
      meta: {},
    })
  })

  it("ask tool requires 'question' parameter", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing ask tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const askSchema = schemas.find((s) => s.name === "ask")
    expect(askSchema).toBeDefined()
    expect(askSchema!.inputSchema.properties.question).toBeDefined()
    expect(askSchema!.inputSchema.required).toContain("question")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "ask tool schema test complete",
      meta: {},
    })
  })

  it("delegate tool requires 'task' parameter", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing delegate tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const delegateSchema = schemas.find((s) => s.name === "delegate")
    expect(delegateSchema).toBeDefined()
    expect(delegateSchema!.inputSchema.properties.task).toBeDefined()
    expect(delegateSchema!.inputSchema.required).toContain("task")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "delegate tool schema test complete",
      meta: {},
    })
  })

  it("search_notes tool requires 'query' parameter", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing search_notes tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const searchSchema = schemas.find((s) => s.name === "search_notes")
    expect(searchSchema).toBeDefined()
    expect(searchSchema!.inputSchema.properties.query).toBeDefined()
    expect(searchSchema!.inputSchema.required).toContain("query")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "search_notes tool schema test complete",
      meta: {},
    })
  })

  it("status tool has no required parameters", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing status tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const statusSchema = schemas.find((s) => s.name === "status")
    expect(statusSchema).toBeDefined()
    expect(statusSchema!.inputSchema.required ?? []).toEqual([])

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "status tool schema test complete",
      meta: {},
    })
  })

  it("report_progress tool requires 'summary' parameter", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing report_progress tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const progressSchema = schemas.find((s) => s.name === "report_progress")
    expect(progressSchema).toBeDefined()
    expect(progressSchema!.inputSchema.properties.summary).toBeDefined()
    expect(progressSchema!.inputSchema.required).toContain("summary")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "report_progress tool schema test complete",
      meta: {},
    })
  })

  it("report_blocker tool requires 'blocker' parameter", () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_start",
      message: "testing report_blocker tool schema",
      meta: {},
    })

    const schemas = getToolSchemas()
    const blockerSchema = schemas.find((s) => s.name === "report_blocker")
    expect(blockerSchema).toBeDefined()
    expect(blockerSchema!.inputSchema.properties.blocker).toBeDefined()
    expect(blockerSchema!.inputSchema.required).toContain("blocker")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_schema_test_end",
      message: "report_blocker tool schema test complete",
      meta: {},
    })
  })
})
