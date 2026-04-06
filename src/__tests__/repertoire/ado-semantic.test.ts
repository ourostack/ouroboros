import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../repertoire/ado-client", () => ({
  adoRequest: vi.fn(),
  queryWorkItems: vi.fn(),
  discoverOrganizations: vi.fn(),
  discoverProjects: vi.fn(),
}))

vi.mock("../../repertoire/ado-context", () => ({
  resolveAdoContext: vi.fn(),
}))

import { adoRequest } from "../../repertoire/ado-client"
import { resolveAdoContext } from "../../repertoire/ado-context"
import { adoSemanticToolDefinitions } from "../../repertoire/ado-semantic"

function findTool(name: string) {
  return adoSemanticToolDefinitions.find(d => d.tool.function.name === name)
}

function makeCtx(overrides?: any) {
  return {
    adoToken: "test-token",
    signin: vi.fn(),
    context: {
      friend: { id: "uuid-1", name: "Jordan", externalIds: [{ provider: "aad" as const, externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01" }], tenantMemberships: ["t1"], toolPreferences: {}, notes: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1 },
      channel: { channel: "teams" as const, availableIntegrations: ["ado" as const, "graph" as const], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
    },
    ...overrides,
  }
}

describe("ado_backlog_list tool", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("is registered as a ToolDefinition with integration 'ado'", () => {
    const def = findTool("ado_backlog_list")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("returns enriched work items with hierarchy, type, parent, assignee", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    // WIQL returns IDs
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }, { id: 102 }],
    }))
    // Batch fetch returns enriched items
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Epic One", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": { displayName: "Jordan" }, "System.AreaPath": "Platform\\Team A", "System.IterationPath": "Sprint 1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Story One", "System.WorkItemType": "User Story", "System.State": "New", "System.AssignedTo": null, "System.AreaPath": "Platform\\Team A", "System.IterationPath": "Sprint 1", "System.Parent": 100 } },
        { id: 102, fields: { "System.Title": "Task One", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": { displayName: "Sam" }, "System.AreaPath": "Platform\\Team A", "System.IterationPath": "Sprint 1", "System.Parent": 101 } },
      ],
    }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    // makeCtx() provides a Teams channel (supportsMarkdown: true), so output is markdown
    expect(result).toContain("**#100**")
    expect(result).toContain("Epic One")
    expect(result).toContain("[Epic]")
    expect(result).toContain("Jordan")
    expect(result).toContain("**#101**")
    expect(result).toContain("Story One")
    expect(result).toContain("Unassigned")
    expect(result).toContain("(parent: #100)")
    expect(result).toContain("**#102**")
    expect(result).toContain("Task One")
    expect(result).toContain("Sam")
    expect(result).toContain("(parent: #101)")
  })

  it("filters by area path", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ areaPath: "Platform\\Team B" }, makeCtx())

    // Check the WIQL query includes area path filter
    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(wiqlCall[4]!)
    expect(body.query).toContain("System.AreaPath")
    expect(body.query).toContain("Platform\\Team B")
  })

  it("filters by iteration", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ iteration: "Sprint 2" }, makeCtx())

    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(wiqlCall[4]!)
    expect(body.query).toContain("System.IterationPath")
    expect(body.query).toContain("Sprint 2")
  })

  it("filters by work item type", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ workItemType: "Bug" }, makeCtx())

    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(wiqlCall[4]!)
    expect(body.query).toContain("System.WorkItemType")
    expect(body.query).toContain("Bug")
  })

  it("filters by state", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ state: "Active" }, makeCtx())

    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(wiqlCall[4]!)
    expect(body.query).toContain("System.State")
    expect(body.query).toContain("Active")
  })

  it("filters by assignee", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ assignee: "Jordan" }, makeCtx())

    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(wiqlCall[4]!)
    expect(body.query).toContain("System.AssignedTo")
    expect(body.query).toContain("Jordan")
  })

  it("returns empty result with message when no work items found", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("No work items")
  })

  it("returns error when ADO context resolution fails", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: false, error: "Multiple ADO organizations found" })

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("Multiple ADO organizations found")
  })

  it("returns error when no ADO token available", async () => {
    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })

  it("handles API error from batch fetch", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [{ id: 1 }] }))
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Batch fetch failed")

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("handles API error from WIQL query", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Internal Server Error")

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("uses ADO context helper for org/project resolution", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "myorg", project: "myproject" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ organization: "myorg", project: "myproject" }, makeCtx())

    expect(resolveAdoContext).toHaveBeenCalledWith("test-token", makeCtx().context, { organization: "myorg", project: "myproject" })
  })

  it("passes org and project from args to resolveAdoContext", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "explicit-org", project: "explicit-proj" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    await def.handler({ organization: "explicit-org", project: "explicit-proj" }, makeCtx())

    // WIQL query should be sent to the resolved org
    const wiqlCall = vi.mocked(adoRequest).mock.calls[0]
    expect(wiqlCall[2]).toBe("explicit-org") // org parameter
    expect(wiqlCall[3]).toContain("explicit-proj") // path includes project
  })

  it("handles work items with missing fields (null/undefined field values)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }],
    }))
    // Return work item with all fields missing/undefined
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: {} }],
    }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    // Should render without error even though all fields are missing
    expect(result).toContain("#100")
  })

  it("handles AssignedTo object with no displayName property", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }],
    }))
    // AssignedTo exists but has no displayName -- tests ?. chain
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.Title": "Item", "System.WorkItemType": "Task", "System.State": "New", "System.AssignedTo": { uniqueName: "user@contoso.com" }, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } }],
    }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("Unassigned")
  })

  it("handles batch response with undefined value (batchData.value ?? [])", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }],
    }))
    // Batch response has no value field
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({}))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCtx())
    // Should handle gracefully (empty items)
    expect(result).toBeDefined()
  })

  it("CLI channel renders plain text with parent notation", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Parent Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Child Task", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
      ],
    }))

    const def = findTool("ado_backlog_list")!
    const cliCtx = makeCtx({
      context: {
        ...makeCtx().context,
        channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity },
      },
    })
    const result = await def.handler({}, cliCtx)
    // CLI plain text should include parent notation
    expect(result).toContain("parent:#100")
    expect(result).not.toContain("**")
  })
})

describe("ado_create_epic tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado'", () => {
    const def = findTool("ado_create_epic")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("creates an epic with correct JSON Patch operations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 200, fields: { "System.Title": "New Epic" } }))

    const def = findTool("ado_create_epic")!
    const result = await def.handler({ title: "New Epic", areaPath: "Platform\\Team A" }, makeCtx())
    expect(result).toContain("200")
    // Verify the PATCH body sent to ADO
    const call = vi.mocked(adoRequest).mock.calls[0]
    expect(call[1]).toBe("POST")
    const body = JSON.parse(call[4]!)
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "add", path: "/fields/System.Title", value: "New Epic" }),
    ]))
  })

  it("includes iterationPath in JSON Patch when provided", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 201 }))

    const def = findTool("ado_create_epic")!
    await def.handler({ title: "Epic", iterationPath: "Sprint 3" }, makeCtx())
    const call = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(call[4]!)
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/fields/System.IterationPath", value: "Sprint 3" }),
    ]))
  })

  it("returns error when no ADO token", async () => {
    const def = findTool("ado_create_epic")!
    const result = await def.handler({ title: "test" }, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })
})

describe("ado_create_issue tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado'", () => {
    const def = findTool("ado_create_issue")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("creates an issue with title, description, area path, and parent", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 300, fields: { "System.Title": "Story A" } }))

    const def = findTool("ado_create_issue")!
    const result = await def.handler({
      title: "Story A",
      description: "Description here",
      areaPath: "Platform\\Team A",
      parentId: "100",
    }, makeCtx())
    expect(result).toContain("300")
    const call = vi.mocked(adoRequest).mock.calls[0]
    const body = JSON.parse(call[4]!)
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/fields/System.Title", value: "Story A" }),
      expect.objectContaining({ path: "/fields/System.Description", value: "Description here" }),
    ]))
  })

})

describe("ado_move_items tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado'", () => {
    const def = findTool("ado_move_items")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("reparents work items to a new parent", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    // First call: update item 101 parent
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    // Second call: update item 102 parent
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 102 }))

    const def = findTool("ado_move_items")!
    const result = await def.handler({
      workItemIds: "101,102",
      newParentId: "200",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.moved).toHaveLength(2)
  })

  it("handles partial failure", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce("PERMISSION_DENIED: 403")

    const def = findTool("ado_move_items")!
    const result = await def.handler({ workItemIds: "101,102", newParentId: "200" }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.moved.length + parsed.errors.length).toBe(2)
  })

  it("handles response with no id field in JSON", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ error: "unexpected" }))

    const def = findTool("ado_move_items")!
    const result = await def.handler({ workItemIds: "101", newParentId: "200" }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.errors).toHaveLength(1)
  })
})

describe("ado_preview_changes tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado' (no confirmationRequired -- read-only)", () => {
    const def = findTool("ado_preview_changes")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("returns structured preview without executing mutations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_preview_changes")!
    const result = await def.handler({
      operation: "create_epic",
      title: "Preview Epic",
      areaPath: "Platform\\Team A",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.preview).toBe(true)
    expect(parsed.operations).toBeDefined()
    expect(parsed.operations.length).toBeGreaterThan(0)
    // No actual API call should have been made
    expect(adoRequest).not.toHaveBeenCalled()
  })

  it("shows operations for create_issue with parent", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_preview_changes")!
    const result = await def.handler({
      operation: "create_issue",
      title: "Preview Story",
      parentId: "100",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.preview).toBe(true)
    expect(parsed.operations.some((op: any) => op.path === "/fields/System.Title")).toBe(true)
  })

  it("shows operations for move_items", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_preview_changes")!
    const result = await def.handler({
      operation: "move_items",
      workItemIds: "101,102",
      newParentId: "200",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.preview).toBe(true)
    expect(parsed.operations).toHaveLength(2)
  })

  it("preview move_items with undefined workItemIds defaults to empty string", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_preview_changes")!
    const result = await def.handler({
      operation: "move_items",
      newParentId: "200",
      // workItemIds omitted -- should default to "" via || ""
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.preview).toBe(true)
    expect(parsed.operations).toHaveLength(0)
  })

  it("returns error for unknown operation", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_preview_changes")!
    const result = await def.handler({ operation: "unknown_op" }, makeCtx())
    expect(result).toContain("Unknown operation")
  })
})

describe("ado_validate_structure tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado' (no confirmationRequired -- read-only)", () => {
    const def = findTool("ado_validate_structure")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("validates parent/child type rules and returns violations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    // Fetch parent work item
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.WorkItemType": "Task" } }],
    }))

    const def = findTool("ado_validate_structure")!
    const result = await def.handler({
      parentId: "100",
      childType: "Epic",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.valid).toBe(false)
    expect(parsed.violations.length).toBeGreaterThan(0)
  })

  it("returns valid when parent/child relationship is correct", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.WorkItemType": "Epic" } }],
    }))

    const def = findTool("ado_validate_structure")!
    const result = await def.handler({
      parentId: "100",
      childType: "User Story",
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.valid).toBe(true)
  })

  it("returns error when parent not found", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ value: [] }))

    const def = findTool("ado_validate_structure")!
    const result = await def.handler({ parentId: "999", childType: "User Story" }, makeCtx())
    expect(result).toContain("not found")
  })

  it("handles API error when fetching parent", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Server Error")

    const def = findTool("ado_validate_structure")!
    const result = await def.handler({ parentId: "100", childType: "Task" }, makeCtx())
    expect(result).toContain("ERROR")
  })
})

describe("channel-aware formatting", () => {
  beforeEach(() => { vi.resetAllMocks() })

  function makeTeamsCtx() {
    return makeCtx({
      context: {
        ...makeCtx().context,
        channel: { channel: "teams" as const, availableIntegrations: ["ado" as const, "graph" as const], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: Infinity },
      },
    })
  }

  function makeCliCtx() {
    return makeCtx({
      context: {
        ...makeCtx().context,
        channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity },
      },
    })
  }

  it("ado_backlog_list: Teams gets markdown formatted output", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [{ id: 100 }] }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.Title": "Epic One", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": { displayName: "Jordan" }, "System.AreaPath": "Platform", "System.IterationPath": "Sprint 1", "System.Parent": null } }],
    }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeTeamsCtx())
    // Teams should get markdown-formatted output
    expect(result).toContain("**")
    expect(result).toContain("Epic One")
  })

  it("ado_backlog_list: CLI gets plain text tabular output", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [{ id: 100 }] }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.Title": "Epic One", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": { displayName: "Jordan" }, "System.AreaPath": "Platform", "System.IterationPath": "Sprint 1", "System.Parent": null } }],
    }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCliCtx())
    // CLI should get plain text, not markdown
    expect(result).not.toContain("**")
    expect(result).toContain("Epic One")
    expect(result).toContain("#100")
  })

  it("ado_backlog_list: Teams response includes all items (no truncation with Infinity maxMessageLength)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i + 100,
      fields: {
        "System.Title": `Work Item ${i} with a very long title that takes up space`,
        "System.WorkItemType": "User Story",
        "System.State": "Active",
        "System.AssignedTo": { displayName: "Jordan" },
        "System.AreaPath": "Platform\\Team A\\SubTeam B",
        "System.IterationPath": "Sprint 1",
        "System.Parent": 99,
      },
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: items.map(i => ({ id: i.id })) }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ value: items }))

    const ctx = makeTeamsCtx()
    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, ctx)
    // All 50 items included — no maxMessageLength truncation
    expect(result).toContain("#100")
    expect(result).toContain("#149")
    expect(result).not.toContain("...and")
  })

  it("ado_backlog_list: CLI has no truncation", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i + 100,
      fields: {
        "System.Title": `Work Item ${i} with details`,
        "System.WorkItemType": "Task",
        "System.State": "Active",
        "System.AssignedTo": null,
        "System.AreaPath": "Platform",
        "System.IterationPath": "Sprint 1",
        "System.Parent": null,
      },
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: items.map(i => ({ id: i.id })) }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ value: items }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeCliCtx())
    // All 50 items should be present
    expect(result).toContain("Work Item 49")
  })

  it("ado_backlog_list: empty result message adapts to channel", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_backlog_list")!
    const result = await def.handler({}, makeTeamsCtx())
    expect(result).toContain("No work items")
  })

  it("ado_backlog_list: no context (fallback) uses JSON format", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [{ id: 100 }] }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ id: 100, fields: { "System.Title": "Item", "System.WorkItemType": "Task", "System.State": "New", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } }],
    }))

    const def = findTool("ado_backlog_list")!
    // ctx with no context
    const ctx = { ...makeCtx(), context: undefined }
    const result = await def.handler({}, ctx as any)
    // Should fall back to JSON
    const parsed = JSON.parse(result)
    expect(parsed.items).toBeDefined()
  })
})

describe("ado_batch_update tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado'", () => {
    const def = findTool("ado_batch_update")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("batch with all operations succeeding returns all success results", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 201 }))

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "update", workItemId: 101, fields: { "System.State": "Active" } },
        { type: "create", workItemType: "Task", fields: { "System.Title": "New Task" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
    expect(parsed.results.every((r: any) => r.success)).toBe(true)
  })

  it("batch with partial failure returns per-item success/failure", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce("PERMISSION_DENIED: 403")

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "update", workItemId: 101, fields: { "System.State": "Active" } },
        { type: "update", workItemId: 102, fields: { "System.State": "Closed" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
    expect(parsed.results[0].success).toBe(true)
    expect(parsed.results[1].success).toBe(false)
  })

  it("empty batch returns empty results", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(0)
  })

  it("single-item batch works like individual tool", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 300 }))

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "create", workItemType: "Bug", fields: { "System.Title": "Bug report" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].success).toBe(true)
  })

  it("returns error for invalid JSON operations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    const def = findTool("ado_batch_update")!
    const result = await def.handler({ operations: "not json" }, makeCtx())
    expect(result).toContain("error")
  })

  it("returns error when no ADO token", async () => {
    const def = findTool("ado_batch_update")!
    const result = await def.handler({ operations: "[]" }, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })

  it("handles reparent operation type", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "reparent", workItemId: 101, newParentId: 200 },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(true)
  })

  it("handles unknown operation type", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "delete", workItemId: 101 },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(false)
    expect(parsed.results[0].error).toContain("Unknown operation type")
  })

  it("handles API response with no id field", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ error: "something went wrong" }))

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "update", workItemId: 101, fields: { "System.State": "Active" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(false)
  })

  it("handles Error exception thrown during operation", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockRejectedValueOnce(new Error("network failure"))

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "create", workItemType: "Task", fields: { "System.Title": "Test" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(false)
    expect(parsed.results[0].error).toContain("network failure")
  })

  it("handles non-Error exception thrown during operation", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockRejectedValueOnce("string error")

    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "update", workItemId: 101, fields: { "System.State": "Active" } },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(false)
    expect(parsed.results[0].error).toContain("string error")
  })
})

describe("ado_restructure_backlog tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered with integration 'ado'", () => {
    const def = findTool("ado_restructure_backlog")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("performs bulk reparent operations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValue(JSON.stringify({ id: 101 }))

    const def = findTool("ado_restructure_backlog")!
    const result = await def.handler({
      operations: JSON.stringify([
        { workItemId: 101, newParentId: 200 },
        { workItemId: 102, newParentId: 200 },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
  })

  it("handles partial failures and continues", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce("PERMISSION_DENIED: 403")

    const def = findTool("ado_restructure_backlog")!
    const result = await def.handler({
      operations: JSON.stringify([
        { workItemId: 101, newParentId: 200 },
        { workItemId: 102, newParentId: 200 },
      ]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
    // At least one success and one failure
    expect(parsed.results.some((r: any) => r.success)).toBe(true)
    expect(parsed.results.some((r: any) => !r.success)).toBe(true)
  })

  it("returns error for invalid JSON operations", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    const def = findTool("ado_restructure_backlog")!
    const result = await def.handler({ operations: "not valid json" }, makeCtx())
    expect(result).toContain("error")
    expect(result).toContain("valid JSON")
  })

  it("handles response with no id field (API error in JSON)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ error: "something went wrong" }))

    const def = findTool("ado_restructure_backlog")!
    const result = await def.handler({
      operations: JSON.stringify([{ workItemId: 101, newParentId: 200 }]),
    }, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.results[0].success).toBe(false)
  })
})

describe("batch operations without authority checks", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("ado_batch_update: all operations execute (authority removed)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 102 }))

    const ctx = makeCtx()
    const def = findTool("ado_batch_update")!
    const result = await def.handler({
      operations: JSON.stringify([
        { type: "create", workItemType: "Task", fields: { "System.Title": "Task A" } },
        { type: "update", workItemId: 101, fields: { "System.State": "Active" } },
      ]),
    }, ctx)
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
    expect(parsed.results.every((r: any) => r.success)).toBe(true)
  })

  it("ado_restructure_backlog: all operations execute (authority removed)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 101 }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ id: 102 }))

    const ctx = makeCtx()
    const def = findTool("ado_restructure_backlog")!
    const result = await def.handler({
      operations: JSON.stringify([
        { workItemId: 101, newParentId: 200 },
        { workItemId: 102, newParentId: 200 },
      ]),
    }, ctx)
    const parsed = JSON.parse(result)
    expect(parsed.results).toHaveLength(2)
  })
})

describe("ado_detect_orphans tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered as ToolDefinition with integration 'ado' (read-only)", () => {
    const def = findTool("ado_detect_orphans")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("finds items without parents that should have one", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    // Return work items: a Task with no parent, a Task with parent, an Epic (no parent needed)
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }, { id: 102 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Orphan Task", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Parented Task", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 200 } },
        { id: 102, fields: { "System.Title": "Top Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
      ],
    }))

    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.orphans).toBeDefined()
    // Task without parent is an orphan; Epic without parent is NOT (top-level)
    expect(parsed.orphans.some((o: any) => o.id === 100)).toBe(true)
    expect(parsed.orphans.some((o: any) => o.id === 102)).toBe(false)
  })

  it("returns empty when all items are properly parented", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Good Task", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 200 } },
      ],
    }))

    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.orphans).toHaveLength(0)
  })

  it("returns empty orphans when no work items found", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [] }))

    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.orphans).toHaveLength(0)
  })

  it("handles batch fetch error", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ workItems: [{ id: 100 }] }))
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Batch Failed")

    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("handles WIQL API error gracefully", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Server Error")

    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("requires ADO token", async () => {
    const def = findTool("ado_detect_orphans")!
    const result = await def.handler({}, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })
})

describe("ado_detect_cycles tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered as ToolDefinition with integration 'ado' (read-only)", () => {
    const def = findTool("ado_detect_cycles")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("detects A->B->C->A cycle", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }, { id: 102 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "A", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 102 } },
        { id: 101, fields: { "System.Title": "B", "System.WorkItemType": "Feature", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
        { id: 102, fields: { "System.Title": "C", "System.WorkItemType": "User Story", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 101 } },
      ],
    }))

    const def = findTool("ado_detect_cycles")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.cycles).toBeDefined()
    expect(parsed.cycles.length).toBeGreaterThan(0)
  })

  it("returns empty when no cycles exist", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Story", "System.WorkItemType": "User Story", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
      ],
    }))

    const def = findTool("ado_detect_cycles")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.cycles).toHaveLength(0)
  })

  it("handles API error gracefully", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Server Error")

    const def = findTool("ado_detect_cycles")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("requires ADO token", async () => {
    const def = findTool("ado_detect_cycles")!
    const result = await def.handler({}, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })
})

describe("ado_validate_parent_type_rules tool", () => {
  beforeEach(() => { vi.resetAllMocks() })

  it("is registered as ToolDefinition with integration 'ado' (read-only)", () => {
    const def = findTool("ado_validate_parent_type_rules")
    expect(def).toBeDefined()
    expect(def!.integration).toBe("ado")
  })

  it("finds type violations (Task parented to Epic in Scrum)", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    // Fetch work items
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Bad Parent Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Misplaced Task", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
      ],
    }))
    // Process template fetch: project properties
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ name: "System.ProcessTemplateType", value: "scrum-guid" }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ name: "Scrum", typeId: "scrum-guid" }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { name: "Epic" }, { name: "Feature" }, { name: "Product Backlog Item" }, { name: "Task" }, { name: "Bug" },
      ],
    }))

    const def = findTool("ado_validate_parent_type_rules")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.violations).toBeDefined()
    expect(parsed.violations.length).toBeGreaterThan(0)
    // Task #101 is parented to Epic #100 -- in Scrum, Task should be under PBI, not Epic
    expect(parsed.violations.some((v: any) => v.childId === 101)).toBe(true)
  })

  it("returns empty when all valid", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Feature", "System.WorkItemType": "Feature", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
      ],
    }))
    // Process template: Agile
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [{ name: "System.ProcessTemplateType", value: "agile-guid" }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({ name: "Agile", typeId: "agile-guid" }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { name: "Epic" }, { name: "Feature" }, { name: "User Story" }, { name: "Task" }, { name: "Bug" },
      ],
    }))

    const def = findTool("ado_validate_parent_type_rules")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    expect(parsed.violations).toHaveLength(0)
  })

  it("handles API error gracefully", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Server Error")

    const def = findTool("ado_validate_parent_type_rules")!
    const result = await def.handler({}, makeCtx())
    expect(result).toContain("ERROR")
  })

  it("proceeds without validation when process template fetch fails", async () => {
    vi.mocked(resolveAdoContext).mockResolvedValue({ ok: true, organization: "contoso", project: "Platform" })
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      workItems: [{ id: 100 }, { id: 101 }],
    }))
    vi.mocked(adoRequest).mockResolvedValueOnce(JSON.stringify({
      value: [
        { id: 100, fields: { "System.Title": "Epic", "System.WorkItemType": "Epic", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": null } },
        { id: 101, fields: { "System.Title": "Task under Epic", "System.WorkItemType": "Task", "System.State": "Active", "System.AssignedTo": null, "System.AreaPath": "P", "System.IterationPath": "S1", "System.Parent": 100 } },
      ],
    }))
    // Process template fetch fails
    vi.mocked(adoRequest).mockResolvedValueOnce("ERROR: 500 Server Error")

    const def = findTool("ado_validate_parent_type_rules")!
    const result = await def.handler({}, makeCtx())
    const parsed = JSON.parse(result)
    // When process template fails, should return empty violations (can't validate)
    expect(parsed.violations).toHaveLength(0)
    expect(parsed.message).toContain("template")
  })

  it("requires ADO token", async () => {
    const def = findTool("ado_validate_parent_type_rules")!
    const result = await def.handler({}, { ...makeCtx(), adoToken: undefined })
    expect(result).toContain("AUTH_REQUIRED")
  })
})
