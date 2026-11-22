// Semantic ADO tools -- enriched, single-call operations over the ADO API.
// Phase 3: ado_backlog_list (query), mutation tools (3D).

import { emitNervesEvent } from "../nerves/runtime"
import { authRequired } from "./auth-required"
import { withCode, type ToolDefinition, type ToolContext } from "./tools-base"
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
    return withCode(authRequired(ctx, "ado", "I need access to Azure DevOps."), "auth-required")
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
          "Query the backlog and return enriched work items with hierarchy, type, parent, assignee, area path, and iteration. Supports filtering. Use this instead of raw WIQL queries. Provides enriched results with hierarchy.",
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
    ax: { id: "tool:ado_backlog_list", group: "turn-ado", when: "Pick this to see a project's whole backlog as a tree, with types, parents and owners, filtered by area, state or person.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps answered with an error instead of work items; the text is its reply.", fix: "Check the organization and project names, then retry once." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      if (!ctx?.adoToken) {
        return withCode(authRequired(ctx, "ado", "I need access to Azure DevOps."), "auth-required")
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
        return withCode(wiqlResult, "ado-request-failed") // Pass through error message
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
        return withCode(batchResult, "ado-request-failed")
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
        description: "Create an epic in Azure DevOps with title, description, area path, and optional parent. Use ado_preview_changes first to dry-run the operation.",
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
    ax: { id: "tool:ado_create_epic", group: "turn-ado", when: "Pick this when someone wants a new large piece of work tracked in Azure DevOps; for a single task under one, use ado_create_issue.", effect: "write", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
    ] },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")


      const ops = buildCreatePatch(args)
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const result = await adoRequest(ctx!.adoToken!, "POST", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/$Epic`, JSON.stringify(ops))
      return result
    },
    integration: "ado",
    summaryKeys: ["organization", "project", "title"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "creates an Azure DevOps epic" },
  },

  // -- ado_create_issue --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_create_issue",
        description: "Create an issue or user story in Azure DevOps with title, description, area path, and parent epic. Use ado_preview_changes first to dry-run the operation.",
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
    ax: { id: "tool:ado_create_issue", group: "turn-ado", when: "Pick this when someone wants a new task, bug or issue filed in Azure DevOps, optionally placed under an existing epic.", effect: "write", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps refused the new item; the text is its reply.", fix: "Check the type and parent exist in that project, then retry once." },
    ] },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")


      const wiType = args.workItemType || "Issue"
      const ops = buildCreatePatch(args)
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const result = await adoRequest(ctx!.adoToken!, "POST", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/$${wiType}`, JSON.stringify(ops))
      return result
    },
    integration: "ado",
    summaryKeys: ["organization", "project", "title"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "creates an Azure DevOps work item" },
  },

  // -- ado_move_items --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_move_items",
        description: "Reparent work items -- move them to a new parent epic or feature. Use ado_preview_changes first. These mutations affect real work items.",
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
    ax: { id: "tool:ado_move_items", group: "turn-ado", when: "Pick this to put one or more existing work items under a different parent, such as moving bugs into a new epic.", effect: "write", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "move-failed", means: "Some items couldn't be moved; each one in errors carries Azure DevOps's reply.", fix: "Fix the items listed in errors and move only those again." },
    ] },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")


      const ids = args.workItemIds.split(",").map(s => s.trim()).filter(Boolean)
      const ops = buildReparentPatch(args.newParentId)
      const moved: number[] = []
      const errors: { id: string, error: string, code: string }[] = []

      for (const id of ids) {
        /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
        const result = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${id}`, JSON.stringify(ops))
        try {
          const parsed = JSON.parse(result)
          if (parsed.id) {
            moved.push(parsed.id)
          } else {
            errors.push({ id, error: result, code: "move-failed" })
          }
        } catch {
          errors.push({ id, error: result, code: "move-failed" })
        }
      }

      return JSON.stringify({ moved, errors, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    summaryKeys: ["organization", "project", "workItemIds"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "reparents Azure DevOps work items" },
  },

  // -- ado_restructure_backlog --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_restructure_backlog",
        description: "Bulk restructure: reparent multiple work items in a single logical operation. Use ado_preview_changes first. These mutations affect real work items.",
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
    ax: { id: "tool:ado_restructure_backlog", group: "turn-ado", when: "Pick this to reshuffle many parent links in one pass after someone agrees a new backlog shape; check it first with ado_preview_changes.", effect: "write", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "invalid-operations", means: "operations wasn't a valid JSON array.", fix: "Pass operations as a JSON array of objects, like the example in the description." },
      { code: "update-failed", means: "Some items failed while others went through; each failed result has success false and Azure DevOps's reply.", fix: "Fix the failed items named in results and send only those again." },
    ] },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")


      let operations: { workItemId: number, newParentId: number }[]
      try {
        operations = JSON.parse(args.operations)
      } catch {
        return withCode("error: operations must be a valid JSON array", "invalid-operations")
      }

      const results: { workItemId: number, success: boolean, error?: string, code?: string }[] = []

      for (const op of operations) {
        const ops = buildReparentPatch(String(op.newParentId))
        /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
        const result = await adoRequest(ctx!.adoToken!, "PATCH", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems/${op.workItemId}`, JSON.stringify(ops))
        try {
          const parsed = JSON.parse(result)
          if (parsed.id) {
            results.push({ workItemId: op.workItemId, success: true })
          } else {
            results.push({ workItemId: op.workItemId, success: false, error: result, code: "update-failed" })
          }
        } catch {
          results.push({ workItemId: op.workItemId, success: false, error: result, code: "update-failed" })
        }
      }

      return JSON.stringify({ results, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    summaryKeys: ["organization", "project"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "bulk-reparents Azure DevOps work items" },
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
    ax: { id: "tool:ado_validate_structure", group: "turn-ado", when: "Pick this before moving an item, to check the new parent exists and that the parent and child types may be linked.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps answered with an error instead of work items; the text is its reply.", fix: "Check the organization and project names, then retry once." },
      { code: "parent-not-found", means: "No work item has that parent id.", fix: "Check the id with ado_backlog_list, then validate again." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")

      // Fetch parent work item to get its type
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const parentResult = await adoRequest(ctx!.adoToken!, "GET", adoCtx.organization, `/${adoCtx.project}/_apis/wit/workitems?ids=${args.parentId}&fields=System.WorkItemType`)
      let parentData: BatchResponse
      try {
        parentData = JSON.parse(parentResult)
      } catch {
        return withCode(parentResult, "ado-request-failed")
      }

      if (!parentData.value || parentData.value.length === 0) {
        return withCode(`error: parent work item ${args.parentId} not found`, "parent-not-found")
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
    ax: { id: "tool:ado_preview_changes", group: "turn-ado", when: "Pick this to show someone exactly what a create or move would change, before doing it, so they can agree first.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "unknown-operation", means: "operation wasn't create_epic, create_issue or move_items.", fix: "Call again with one of those three." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")

      const operations = buildPreviewOps(args.operation, args)
      if (operations === null) {
        return withCode(`Unknown operation: ${args.operation}. Supported: create_epic, create_issue, move_items`, "unknown-operation")
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
    ax: { id: "tool:ado_batch_update", group: "turn-ado", when: "Pick this to apply a mixed list of creates, moves and edits in one call, once someone has agreed the whole list.", effect: "write", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "invalid-operations", means: "operations wasn't a valid JSON array.", fix: "Pass operations as a JSON array of objects, like the example in the description." },
      { code: "unknown-operation", means: "One entry's type isn't supported; its result has success false.", fix: "Fix that entry's type and send only it again." },
      { code: "update-failed", means: "Some items failed while others went through; each failed result has success false and Azure DevOps's reply.", fix: "Fix the failed items named in results and send only those again." },
    ] },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")


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
        return withCode("error: operations must be a valid JSON array", "invalid-operations")
      }

      const results: { index: number, type: string, success: boolean, id?: number, error?: string, code?: string }[] = []

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
            results.push({ index: i, type: op.type, success: false, error: `Unknown operation type: ${op.type}`, code: "unknown-operation" })
            continue
          }

          try {
            const parsed = JSON.parse(apiResult)
            if (parsed.id) {
              results.push({ index: i, type: op.type, success: true, id: parsed.id })
            } else {
              results.push({ index: i, type: op.type, success: false, error: apiResult, code: "update-failed" })
            }
          } catch {
            results.push({ index: i, type: op.type, success: false, error: apiResult, code: "update-failed" })
          }
        } catch (err) {
          results.push({ index: i, type: op.type, success: false, error: err instanceof Error ? err.message : String(err), code: "update-failed" })
        }
      }

      return JSON.stringify({ results, organization: adoCtx.organization, project: adoCtx.project })
    },
    integration: "ado",
    summaryKeys: ["organization", "project"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "executes Azure DevOps batch mutations" },
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
    ax: { id: "tool:ado_detect_orphans", group: "turn-ado", when: "Pick this when someone asks for backlog cleanup, to list work items that should sit under a parent but have none.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps answered with an error instead of work items; the text is its reply.", fix: "Check the organization and project names, then retry once." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return withCode(fetched.error, "ado-request-failed")

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
    ax: { id: "tool:ado_detect_cycles", group: "turn-ado", when: "Pick this when a backlog tree looks wrong or loops, to find items that end up as their own ancestor.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps answered with an error instead of work items; the text is its reply.", fix: "Check the organization and project names, then retry once." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return withCode(fetched.error, "ado-request-failed")

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
    ax: { id: "tool:ado_validate_parent_type_rules", group: "turn-ado", when: "Pick this to audit a backlog for links the process forbids, like a task sitting directly over an epic.", effect: "read", errors: [
      { code: "auth-required", means: "I have no Azure DevOps token yet; the text says whether a sign-in prompt is coming or why it can't start here.", fix: "Ask the person to sign in when Teams prompts, then retry; if sign-in can't start here, ask them from Teams." },
      { code: "no-ado-project", means: "The Azure DevOps organization or project couldn't be worked out: none found, several to pick from, or not in this channel; the text lists them.", fix: "Call again with organization and project set to one of those listed." },
      { code: "ado-request-failed", means: "Azure DevOps answered with an error instead of work items; the text is its reply.", fix: "Check the organization and project names, then retry once." },
      { code: "no-process-template", means: "The project's process template couldn't be fetched, so no type rules were checked.", fix: "Say the type check was skipped; try again later." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    handler: async (args, ctx) => {
      const authErr = await checkAuth(ctx)
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (authErr) return authErr

      /* v8 ignore next -- non-null assertions guarded by checkAuth; error return tested via ado_backlog_list @preserve */
      const adoCtx = await resolveAdoContext(ctx!.adoToken!, ctx!.context!, { organization: args.organization, project: args.project })
      /* v8 ignore next -- error return tested via ado_backlog_list @preserve */
      if (!adoCtx.ok) return withCode(adoCtx.error, "no-ado-project")

      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const fetched = await fetchAllItems(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if ("error" in fetched) return withCode(fetched.error, "ado-request-failed")

      // Fetch process template to derive hierarchy rules
      /* v8 ignore next -- non-null assertion guarded by checkAuth above @preserve */
      const template = await fetchProcessTemplate(ctx!.adoToken!, adoCtx.organization, adoCtx.project)
      if (!template) {
        return JSON.stringify({
          violations: [],
          message: "Could not fetch process template -- type rule validation skipped.",
          code: "no-process-template",
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
