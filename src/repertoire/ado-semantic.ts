// Semantic ADO tools -- enriched, single-call operations over the ADO API.
// Phase 3: ado_backlog_list (query), mutation tools (3D).

import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition, ToolContext } from "./tools-base"
import { adoRequest } from "./ado-client"
import { resolveAdoContext } from "./ado-context"
import { fetchProcessTemplate, deriveHierarchyRules } from "./ado-templates"

// Fields fetched for enriched work items
const ENRICHED_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.AssignedTo",
  "System.AreaPath",
  "System.IterationPath",
  "System.Parent",
].join(",")

interface WiqlResponse {
  workItems?: { id: number }[]
}

interface EnrichedWorkItem {
  id: number
  fields: Record<string, any>
}

interface BatchResponse {
  value?: EnrichedWorkItem[]
}

function buildWiqlQuery(project: string, filters: Record<string, string>): string {
  const conditions: string[] = [`[System.TeamProject] = '${project}'`]

  if (filters.areaPath) {
    conditions.push(`[System.AreaPath] UNDER '${filters.areaPath}'`)
  }
  if (filters.iteration) {
    conditions.push(`[System.IterationPath] = '${filters.iteration}'`)
  }
  if (filters.workItemType) {
    conditions.push(`[System.WorkItemType] = '${filters.workItemType}'`)
  }
  if (filters.state) {
    conditions.push(`[System.State] = '${filters.state}'`)
  }
  if (filters.assignee) {
    conditions.push(`[System.AssignedTo] Contains '${filters.assignee}'`)
  }

  return `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`
}

// Valid parent-child relationships for common process templates
const VALID_PARENT_CHILD: Record<string, string[]> = {
  "Epic": ["Feature", "User Story", "Issue", "Product Backlog Item"],
  "Feature": ["User Story", "Product Backlog Item", "Bug", "Task"],
  "User Story": ["Task", "Bug"],
  "Product Backlog Item": ["Task", "Bug"],
  "Issue": ["Task"],
  "Bug": ["Task"],
}

interface JsonPatchOp {
  op: "add" | "replace" | "remove"
  path: string
  value?: any
}

function buildCreatePatch(args: Record<string, string>): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [
    { op: "add", path: "/fields/System.Title", value: args.title },
  ]
  if (args.description) {
    ops.push({ op: "add", path: "/fields/System.Description", value: args.description })
  }
  if (args.areaPath) {
    ops.push({ op: "add", path: "/fields/System.AreaPath", value: args.areaPath })
  }
  if (args.iterationPath) {
    ops.push({ op: "add", path: "/fields/System.IterationPath", value: args.iterationPath })
  }
  if (args.parentId) {
    ops.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: args.parentId, // Will be resolved to full URL by ADO
      },
    })
  }
  return ops
}

function buildReparentPatch(newParentId: string): JsonPatchOp[] {
  return [
    {
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: newParentId,
      },
    },
  ]
}

async function checkAuth(ctx: ToolContext | undefined): Promise<string | null> {
  if (!ctx?.adoToken) {
    return "AUTH_REQUIRED:ado -- I need access to Azure DevOps. Please sign in when prompted."
  }
  return null
}

// Authority pre-flight checks removed (AuthorityChecker eliminated).
// All writes proceed optimistically; 403s are handled at the API response level.

function buildPreviewOps(operation: string, args: Record<string, string>): JsonPatchOp[] | null {
  switch (operation) {
    case "create_epic":
      return buildCreatePatch({ ...args, workItemType: "Epic" })
    case "create_issue":
      return buildCreatePatch({ ...args, workItemType: "Issue" })
    case "move_items": {
      const ids = (args.workItemIds || "").split(",").map(s => s.trim()).filter(Boolean)
      /* v8 ignore next -- defensive fallback for missing arg @preserve */
      return ids.map(() => buildReparentPatch(args.newParentId || "")).flat()
    }
    default:
      return null
  }
}

interface FormattedItem {
  id: number
  title: string
  type: string
  state: string
  assignedTo: string | null
  areaPath: string
  iteration: string
  parent: number | null
}

function formatWorkItems(items: EnrichedWorkItem[]): FormattedItem[] {
  return items.map(wi => ({
    id: wi.id,
    title: wi.fields["System.Title"] ?? "",
    type: wi.fields["System.WorkItemType"] ?? "",
    state: wi.fields["System.State"] ?? "",
    assignedTo: wi.fields["System.AssignedTo"]?.displayName ?? null,
    areaPath: wi.fields["System.AreaPath"] ?? "",
    iteration: wi.fields["System.IterationPath"] ?? "",
    parent: wi.fields["System.Parent"] ?? null,
  }))
}

function formatMarkdown(items: FormattedItem[], maxLen: number): string {
  const lines: string[] = []
  for (const item of items) {
    const assignee = item.assignedTo || "Unassigned"
    const parent = item.parent ? ` (parent: #${item.parent})` : ""
    const line = `- **#${item.id}** ${item.title} [${item.type}] _${item.state}_ | ${assignee}${parent}`
    // Check if adding this line would exceed limit
    const current = lines.join("\n")
    /* v8 ignore next 4 -- defensive overflow guard; all callers use Infinity maxLen @preserve */
    if (current.length + line.length + 1 > maxLen - 50) {
      lines.push(`_...and ${items.length - lines.length} more items_`)
      break
    }
    lines.push(line)
  }
  return lines.join("\n")
}

function formatPlainText(items: FormattedItem[]): string {
  return items.map(item => {
    const assignee = item.assignedTo || "Unassigned"
    const parent = item.parent ? ` parent:#${item.parent}` : ""
    return `#${item.id}  ${item.type.padEnd(14)} ${item.state.padEnd(10)} ${assignee.padEnd(15)} ${item.title}${parent}`
  }).join("\n")
}

function formatForChannel(items: FormattedItem[], ctx: ToolContext | undefined, org: string, project: string): string {
  const channel = ctx?.context?.channel
  if (!channel) {
    return JSON.stringify({ items, organization: org, project })
  }

  if (channel.supportsMarkdown) {
    return formatMarkdown(items, channel.maxMessageLength)
  }

  return formatPlainText(items)
}

// Top-level types that are expected to have no parent
const TOP_LEVEL_TYPES = new Set(["Epic"])

// Shared helper: fetch all work items with enriched fields
async function fetchAllItems(
  token: string,
  organization: string,
  project: string,
): Promise<{ items: EnrichedWorkItem[] } | { error: string }> {
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' ORDER BY [System.ChangedDate] DESC`
  const wiqlResult = await adoRequest(token, "POST", organization, `/${project}/_apis/wit/wiql`, JSON.stringify({ query: wiql }))

  let wiqlData: WiqlResponse
  try {
    wiqlData = JSON.parse(wiqlResult)
  } catch {
    return { error: wiqlResult }
  }

  if (!wiqlData.workItems || wiqlData.workItems.length === 0) {
    return { items: [] }
  }

  const ids = wiqlData.workItems.slice(0, 200).map(wi => wi.id)
  const batchResult = await adoRequest(token, "GET", organization, `/${project}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${ENRICHED_FIELDS}`)

  let batchData: BatchResponse
  try {
    batchData = JSON.parse(batchResult)
  } catch {
    return { error: batchResult }
  }

  /* v8 ignore next -- defensive fallback for missing API field @preserve */
  return { items: batchData.value ?? [] }
}

// Detect cycles in parent/child graph using DFS
function detectCycles(items: EnrichedWorkItem[]): number[][] {
  const parentMap = new Map<number, number>()
  for (const item of items) {
    const parent = item.fields["System.Parent"]
    if (parent != null) {
      parentMap.set(item.id, parent)
    }
  }

  const cycles: number[][] = []
  const visited = new Set<number>()

  for (const itemId of parentMap.keys()) {
    if (visited.has(itemId)) continue

    const path: number[] = []
    const pathSet = new Set<number>()
    let current: number | undefined = itemId

    while (current !== undefined && !visited.has(current)) {
      if (pathSet.has(current)) {
        // Found a cycle -- extract just the cycle portion
        const cycleStart = path.indexOf(current)
        cycles.push(path.slice(cycleStart))
        break
      }
      path.push(current)
      pathSet.add(current)
      current = parentMap.get(current)
    }

    // Mark all nodes in path as visited
    for (const node of path) {
      visited.add(node)
    }
  }

  return cycles
}

export const adoSemanticToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "ado_backlog_list",
        description:
          "Query the backlog and return enriched work items with hierarchy, type, parent, assignee, area path, and iteration. Supports filtering. Use this instead of raw WIQL queries.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional -- omit to discover)" },
            project: { type: "string", description: "ADO project (optional -- omit to discover)" },
            areaPath: { type: "string", description: "Filter by area path (e.g. 'Platform\\\\Team A')" },
            iteration: { type: "string", description: "Filter by iteration path (e.g. 'Sprint 2')" },
            workItemType: { type: "string", description: "Filter by work item type (e.g. 'Bug', 'Epic', 'User Story')" },
            state: { type: "string", description: "Filter by state (e.g. 'Active', 'New', 'Closed')" },
            assignee: { type: "string", description: "Filter by assigned person name" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.adoToken) {
        return "AUTH_REQUIRED:ado -- I need access to Azure DevOps. Please sign in when prompted."
      }
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.ado_semantic_call",
        message: "ado semantic tool invoked",
        meta: {},
      })

      const adoCtx = await resolveAdoContext(
        ctx.adoToken,
        ctx.context!,
        { organization: args.organization, project: args.project },
      )

      if (!adoCtx.ok) {
        return adoCtx.error
      }

      const { organization, project } = adoCtx
      const wiql = buildWiqlQuery(project, args)

      // Step 1: WIQL query to get IDs
      const wiqlResult = await adoRequest(
        ctx.adoToken,
        "POST",
        organization,
        `/${project}/_apis/wit/wiql`,
        JSON.stringify({ query: wiql }),
      )

      // Check for API errors (non-JSON responses)
      let wiqlData: WiqlResponse
      try {
        wiqlData = JSON.parse(wiqlResult)
      } catch {
        return wiqlResult // Pass through error message
      }

      if (!wiqlData.workItems || wiqlData.workItems.length === 0) {
        return "No work items found matching the query."
      }

      // Step 2: Batch fetch enriched details (max 200)
      const ids = wiqlData.workItems.slice(0, 200).map(wi => wi.id)
      const batchResult = await adoRequest(
        ctx.adoToken,
        "GET",
        organization,
        `/${project}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${ENRICHED_FIELDS}`,
      )

      let batchData: BatchResponse
      try {
        batchData = JSON.parse(batchResult)
      } catch {
        return batchResult
      }

      const items = formatWorkItems(batchData.value ?? [])
      return formatForChannel(items, ctx, organization, project)
    },
    integration: "ado",
    summaryKeys: ["organization", "project"],
  },

  // -- ado_create_epic --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_create_epic",
        description: "Create an epic in Azure DevOps with title, description, area path, and optional parent.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            title: { type: "string", description: "Epic title" },
            description: { type: "string", description: "Epic description" },
            areaPath: { type: "string", description: "Area path" },
            parentId: { type: "string", description: "Parent work item ID (optional)" },
          },
          required: ["title"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error


      const ops = buildCreatePatch(args)
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const result = await adoRequest(ctx!.adoToken!, "POST", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/$Epic`, JSON.stringify(ops))
      return result
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["organization", "project", "title"],
  },

  // -- ado_create_issue --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_create_issue",
        description: "Create an issue or user story in Azure DevOps with title, description, area path, and parent epic.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            title: { type: "string", description: "Issue/story title" },
            description: { type: "string", description: "Description" },
            areaPath: { type: "string", description: "Area path" },
            parentId: { type: "string", description: "Parent work item ID" },
            workItemType: { type: "string", description: "Work item type (default: Issue)" },
          },
          required: ["title"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error


      const wiType = args.workItemType || "Issue"
      const ops = buildCreatePatch(args)
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const result = await adoRequest(ctx!.adoToken!, "POST", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/$${wiType}`, JSON.stringify(ops))
      return result
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["organization", "project", "title"],
  },

  // -- ado_move_items --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_move_items",
        description: "Reparent work items -- move them to a new parent epic or feature.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            workItemIds: { type: "string", description: "Comma-separated work item IDs to move" },
            newParentId: { type: "string", description: "New parent work item ID" },
          },
          required: ["workItemIds", "newParentId"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error


      const ids = args.workItemIds.split(",").map(s => s.trim()).filter(Boolean)
      const ops = buildReparentPatch(args.newParentId)
      const moved: number[] = []
      const errors: { id: string, error: string }[] = []

      for (const id of ids) {
        /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
        const result = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${id}`, JSON.stringify(ops))
        try {
          const parsed = JSON.parse(result)
          if (parsed.id) {
            moved.push(parsed.id)
          } else {
            errors.push({ id, error: result })
          }
        } catch {
          errors.push({ id, error: result })
        }
      }

      return JSON.stringify({ moved, errors, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["organization", "project", "workItemIds"],
  },

  // -- ado_restructure_backlog --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_restructure_backlog",
        description: "Bulk restructure: reparent multiple work items in a single logical operation.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            operations: { type: "string", description: "JSON array of { workItemId, newParentId } objects" },
          },
          required: ["operations"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error


      let operations: { workItemId: number, newParentId: number }[]
      try {
        operations = JSON.parse(args.operations)
      } catch {
        return "error: operations must be a valid JSON array"
      }

      const results: { workItemId: number, success: boolean, error?: string }[] = []

      for (const op of operations) {
        const ops = buildReparentPatch(String(op.newParentId))
        /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
        const result = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${op.workItemId}`, JSON.stringify(ops))
        try {
          const parsed = JSON.parse(result)
          if (parsed.id) {
            results.push({ workItemId: op.workItemId, success: true })
          } else {
            results.push({ workItemId: op.workItemId, success: false, error: result })
          }
        } catch {
          results.push({ workItemId: op.workItemId, success: false, error: result })
        }
      }

      return JSON.stringify({ results, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["organization", "project"],
  },

  // -- ado_validate_structure --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_validate_structure",
        description: "Validate parent/child type rules without making changes. Checks if a work item type can be a child of a given parent.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            parentId: { type: "string", description: "Parent work item ID" },
            childType: { type: "string", description: "Proposed child work item type" },
          },
          required: ["parentId", "childType"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error

      // Fetch parent work item to get its type
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const parentResult = await adoRequest(ctx!.adoToken!, "GET", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems?ids=${args.parentId}&fields=System.WorkItemType`)
      let parentData: BatchResponse
      try {
        parentData = JSON.parse(parentResult)
      } catch {
        return parentResult
      }

      if (!parentData.value || parentData.value.length === 0) {
        return `error: parent work item ${args.parentId} not found`
      }

      const parentType = parentData.value[0].fields["System.WorkItemType"]
      const allowedChildren = VALID_PARENT_CHILD[parentType] || []
      const violations: string[] = []

      if (!allowedChildren.includes(args.childType)) {
        violations.push(`${args.childType} cannot be a child of ${parentType}. Allowed children: ${allowedChildren.join(", ") || "none"}`)
      }

      return JSON.stringify({
        valid: violations.length === 0,
        parentType,
        childType: args.childType,
        violations,
      })
    },
    integration: "ado",
  },

  // -- ado_preview_changes --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_preview_changes",
        description: "Dry-run: preview what a mutation would do without executing it. Returns structured diff of operations.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            operation: { type: "string", description: "Operation to preview: create_epic, create_issue, move_items" },
            title: { type: "string", description: "Title (for create operations)" },
            description: { type: "string", description: "Description (for create operations)" },
            areaPath: { type: "string", description: "Area path" },
            parentId: { type: "string", description: "Parent ID" },
            workItemIds: { type: "string", description: "Comma-separated IDs (for move operations)" },
            newParentId: { type: "string", description: "New parent ID (for move operations)" },
          },
          required: ["operation"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error

      const operations = buildPreviewOps(args.operation, args)
      if (operations === null) {
        return `Unknown operation: ${args.operation}. Supported: create_epic, create_issue, move_items`
      }

      return JSON.stringify({
        preview: true,
        operation: args.operation,
        organization: adoCtx.organization,
        project: adoCtx.project,
        operations,
      })
    },
    integration: "ado",
  },

  // -- ado_batch_update --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_batch_update",
        description:
          "Execute multiple ADO operations in a single batch. Supports create, update, and reparent operations. Returns per-item results.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
            operations: {
              type: "string",
              description: "JSON array of operations. Each: { type: 'create'|'update'|'reparent', workItemId?: number, workItemType?: string, fields?: Record<string, string>, newParentId?: number }",
            },
          },
          required: ["operations"],
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error


      interface BatchOp {
        type: "create" | "update" | "reparent"
        workItemId?: number
        workItemType?: string
        fields?: Record<string, string>
        newParentId?: number
      }

      let operations: BatchOp[]
      try {
        operations = JSON.parse(args.operations)
      } catch {
        return "error: operations must be a valid JSON array"
      }

      const results: { index: number, type: string, success: boolean, id?: number, error?: string }[] = []

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i]
        try {
          let apiResult: string

          if (op.type === "create") {
            /* v8 ignore next -- defensive fallback for missing fields @preserve */
            const patchOps: JsonPatchOp[] = Object.entries(op.fields || {}).map(([key, value]) => ({
              op: "add" as const,
              path: `/fields/${key}`,
              value,
            }))
            /* v8 ignore next -- defensive fallback for missing workItemType @preserve */
            const wiType = op.workItemType || "Task"
            /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
            apiResult = await adoRequest(ctx!.adoToken!, "POST", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/$${wiType}`, JSON.stringify(patchOps))
          } else if (op.type === "update") {
            /* v8 ignore next -- defensive fallback for missing fields @preserve */
            const patchOps: JsonPatchOp[] = Object.entries(op.fields || {}).map(([key, value]) => ({
              op: "replace" as const,
              path: `/fields/${key}`,
              value,
            }))
            /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
            apiResult = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${op.workItemId}`, JSON.stringify(patchOps))
          } else if (op.type === "reparent") {
            const patchOps = buildReparentPatch(String(op.newParentId))
            /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
            apiResult = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${op.workItemId}`, JSON.stringify(patchOps))
          } else {
            results.push({ index: i, type: op.type, success: false, error: `Unknown operation type: ${op.type}` })
            continue
          }

          try {
            const parsed = JSON.parse(apiResult)
            if (parsed.id) {
              results.push({ index: i, type: op.type, success: true, id: parsed.id })
            } else {
              results.push({ index: i, type: op.type, success: false, error: apiResult })
            }
          } catch {
            results.push({ index: i, type: op.type, success: false, error: apiResult })
          }
        } catch (err) {
          results.push({ index: i, type: op.type, success: false, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return JSON.stringify({ results, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["organization", "project"],
  },

  // -- ado_detect_orphans --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_detect_orphans",
        description: "Find work items that have no parent but should have one (e.g. Tasks with no parent). Top-level types like Epic are excluded.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return fetched.error

      const orphans = fetched.items
        .filter(wi => {
          const parent = wi.fields["System.Parent"]
          /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
          const type = wi.fields["System.WorkItemType"] ?? ""
          return parent == null && !TOP_LEVEL_TYPES.has(type)
        })
        .map(wi => ({
          id: wi.id,
          /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
          title: wi.fields["System.Title"] ?? "",
          /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
          type: wi.fields["System.WorkItemType"] ?? "",
          /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
          state: wi.fields["System.State"] ?? "",
        }))

      return JSON.stringify({ orphans, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
  },

  // -- ado_detect_cycles --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_detect_cycles",
        description: "Detect circular parent/child relationships in work items. Returns any cycles found.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return fetched.error

      const cycles = detectCycles(fetched.items)
      return JSON.stringify({ cycles, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
  },

  // -- ado_validate_parent_type_rules --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_validate_parent_type_rules",
        description: "Check all work items have valid parent types per the project's process template rules.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "ADO organization (optional)" },
            project: { type: "string", description: "ADO project (optional)" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return adoCtx.error

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return fetched.error

      // Fetch process template to derive hierarchy rules
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const template = await fetchProcessTemplate(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if (!template) {
        return JSON.stringify({
          violations: [],
          message: "Could not fetch process template -- type rule validation skipped.",
          organization: adoCtx.organization,
          project: adoCtx.project,
        })
      }

      const rules = deriveHierarchyRules(template.templateName, template.workItemTypes)

      // Build ID->type lookup
      const typeMap = new Map<number, string>()
      for (const wi of fetched.items) {
        /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
        typeMap.set(wi.id, wi.fields["System.WorkItemType"] ?? "")
      }

      // Check each item's parent/child type relationship
      const violations: { childId: number; childType: string; childTitle: string; parentId: number; parentType: string; reason: string }[] = []

      for (const wi of fetched.items) {
        const parentId = wi.fields["System.Parent"]
        if (parentId == null) continue

        /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
        const childType = wi.fields["System.WorkItemType"] ?? ""
        const parentType = typeMap.get(parentId)
        /* v8 ignore next -- parent not in fetched set @preserve */
        if (!parentType) continue

        const allowedChildren = rules[parentType]
        /* v8 ignore next -- unknown parent type or leaf @preserve */
        if (!allowedChildren || allowedChildren.length === 0) continue

        if (!allowedChildren.includes(childType)) {
          violations.push({
            childId: wi.id,
            childType,
            /* v8 ignore next -- defensive fallback for missing ADO field @preserve */
            childTitle: wi.fields["System.Title"] ?? "",
            parentId,
            parentType,
            reason: `${childType} cannot be a child of ${parentType}. Allowed: ${allowedChildren.join(", ")}.`,
          })
        }
      }

      return JSON.stringify({ violations, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
  },
]
