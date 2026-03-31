import type { ToolDefinition } from "./tools-base";
import { getProfile, graphRequest } from "./graph-client";
import { queryWorkItems, adoRequest, discoverOrganizations } from "./ado-client";
import graphEndpoints from "./data/graph-endpoints.json";
import adoEndpoints from "./data/ado-endpoints.json";
import { emitNervesEvent } from "../nerves/runtime";

const MUTATE_METHODS = ["POST", "PATCH", "DELETE"];

const DEFAULT_ADO_QUERY = "SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC";

export const teamsToolDefinitions: ToolDefinition[] = [
  // -- Generic Graph tools --
  {
    tool: {
      type: "function",
      function: {
        name: "graph_query",
        description: "GET any Microsoft Graph API endpoint. Use graph_docs first to look up the correct path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Graph API path after /v1.0, e.g. /me/messages?$top=5" },
          },
          required: ["path"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.graphToken) {
        return "AUTH_REQUIRED:graph -- I need access to Microsoft Graph. Please sign in when prompted.";
      }
      return graphRequest(ctx.graphToken, "GET", args.path);
    },
    integration: "graph",
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "graph_mutate",
        description: "POST/PATCH/DELETE any Microsoft Graph API endpoint. Use graph_docs first to look up the correct path.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["POST", "PATCH", "DELETE"], description: "HTTP method" },
            path: { type: "string", description: "Graph API path after /v1.0" },
            body: { type: "string", description: "JSON request body (optional)" },
          },
          required: ["method", "path"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.graphToken) {
        return "AUTH_REQUIRED:graph -- I need access to Microsoft Graph. Please sign in when prompted.";
      }
      if (!MUTATE_METHODS.includes(args.method)) {
        return `Invalid method "${args.method}". Must be one of: ${MUTATE_METHODS.join(", ")}`;
      }
      return graphRequest(ctx.graphToken, args.method, args.path, args.body);
    },
    integration: "graph",
    confirmationRequired: true,
    summaryKeys: ["method", "path"],
  },
  // -- Generic ADO tools --
  {
    tool: {
      type: "function",
      function: {
        name: "ado_query",
        description: "GET or POST (for WIQL read queries) any Azure DevOps API endpoint. Use ado_docs first to look up the correct path and host.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "Azure DevOps organization name" },
            path: { type: "string", description: "ADO API path after /{org}, e.g. /_apis/wit/wiql" },
            method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (defaults to GET)" },
            body: { type: "string", description: "JSON request body (optional, used with POST for WIQL)" },
            host: { type: "string", description: "API host override for non-standard APIs (e.g. 'vsapm.dev.azure.com' for entitlements, 'vssps.dev.azure.com' for users). Omit for standard dev.azure.com." },
          },
          required: ["organization", "path"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.adoToken) {
        return "AUTH_REQUIRED:ado -- I need access to Azure DevOps. Please sign in when prompted.";
      }
      const method = args.method || "GET";
      return adoRequest(ctx.adoToken, method, args.organization, args.path, args.body, args.host);
    },
    integration: "ado",
    summaryKeys: ["method", "organization", "path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "ado_mutate",
        description: "POST/PATCH/DELETE any Azure DevOps API endpoint for actual mutations. Use ado_docs first to look up the correct path and host.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["POST", "PATCH", "DELETE"], description: "HTTP method" },
            organization: { type: "string", description: "Azure DevOps organization name" },
            path: { type: "string", description: "ADO API path after /{org}" },
            body: { type: "string", description: "JSON request body (optional)" },
            host: { type: "string", description: "API host override for non-standard APIs (e.g. 'vsapm.dev.azure.com' for entitlements, 'vssps.dev.azure.com' for users). Omit for standard dev.azure.com." },
          },
          required: ["method", "organization", "path"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.adoToken) {
        return "AUTH_REQUIRED:ado -- I need access to Azure DevOps. Please sign in when prompted.";
      }
      if (!MUTATE_METHODS.includes(args.method)) {
        return `Invalid method "${args.method}". Must be one of: ${MUTATE_METHODS.join(", ")}`;
      }
      return adoRequest(ctx.adoToken, args.method, args.organization, args.path, args.body, args.host);
    },
    integration: "ado",
    confirmationRequired: true,
    summaryKeys: ["method", "organization", "path"],
  },
  // -- Convenience aliases (backward compat) --
  {
    tool: {
      type: "function",
      function: {
        name: "graph_profile",
        description: "get the current user's Microsoft 365 profile (name, email, job title, department, office location)",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx?.graphToken) {
        return "AUTH_REQUIRED:graph -- I need access to your Microsoft 365 profile. Please sign in when prompted.";
      }
      return getProfile(ctx.graphToken);
    },
    integration: "graph",
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "ado_work_items",
        description: "query or list Azure DevOps work items. provide an organization and optionally a WIQL query. if organization is omitted, discovers available organizations automatically.",
        parameters: {
          type: "object",
          properties: {
            organization: { type: "string", description: "Azure DevOps organization name (optional -- omit to discover)" },
            query: { type: "string", description: "WIQL query (optional, defaults to recent assigned work items)" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      if (!ctx?.adoToken) {
        return "AUTH_REQUIRED:ado -- I need access to your Azure DevOps account. Please sign in when prompted.";
      }
      let org = args.organization;
      if (!org) {
        // Discovery cascade: discover orgs, auto-select if single, disambiguate otherwise
        try {
          const orgs = await discoverOrganizations(ctx.adoToken);
          if (orgs.length === 0) {
            return "No ADO organizations found for your account. Ensure your Azure DevOps account has access to at least one organization.";
          }
          if (orgs.length === 1) {
            org = orgs[0];
          } else {
            return `Multiple ADO organizations found. Please specify which organization to use:\n${orgs.map((o) => `- ${o}`).join("\n")}`;
          }
        } catch (e) {
          return `error discovering ADO organizations: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const query = args.query || DEFAULT_ADO_QUERY;
      return queryWorkItems(ctx.adoToken, org, query);
    },
    integration: "ado",
    summaryKeys: ["organization", "query"],
  },
  // -- Proactive messaging --
  {
    tool: {
      type: "function",
      function: {
        name: "teams_send_message",
        description:
          "send a proactive 1:1 Teams message to a user. requires their AAD object ID (use graph_query /users to find it). the message appears as coming from the bot.",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string", description: "AAD object ID of the user to message" },
            user_name: { type: "string", description: "display name of the user (for logging)" },
            message: { type: "string", description: "message text to send" },
            tenant_id: { type: "string", description: "tenant ID (optional, defaults to current conversation tenant)" },
          },
          required: ["user_id", "message"],
        },
      },
    },
    /* v8 ignore start -- proactive messaging requires live Teams SDK conversation client @preserve */
    handler: async (args, ctx) => {
      if (!ctx?.botApi) {
        return "proactive messaging is not available -- no bot API context (this tool only works in the Teams channel)";
      }
      try {
        const tenantId = args.tenant_id || ctx.tenantId;
        // Cast to the SDK's ConversationClient shape (kept as `unknown` in ToolContext to avoid type coupling)
        const conversations = ctx.botApi.conversations as {
          create(params: Record<string, unknown>): Promise<{ id: string }>;
          activities(conversationId: string): { create(params: Record<string, unknown>): Promise<unknown> };
        };
        const conversation = await conversations.create({
          bot: { id: ctx.botApi.id },
          members: [{ id: args.user_id, role: "user", name: args.user_name || args.user_id }],
          tenantId,
          isGroup: false,
        });
        await conversations.activities(conversation.id).create({
          type: "message",
          text: args.message,
        });
        return `message sent to ${args.user_name || args.user_id}`;
      } catch (e) {
        return `failed to send proactive message: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    /* v8 ignore stop */
    confirmationRequired: true,
    summaryKeys: ["user_name", "user_id"],
  },
  // -- Documentation tools --
  {
    tool: {
      type: "function",
      function: {
        name: "graph_docs",
        description: "Search the Microsoft Graph API endpoint index. Use before calling graph_query or graph_mutate to find the correct path, method, and required scopes.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query, e.g. 'send email' or 'calendar events'" },
          },
          required: ["query"],
        },
      },
    },
    handler: (args) => {
      return searchEndpoints(graphEndpoints as EndpointEntry[], args.query || "");
    },
    integration: "graph",
    summaryKeys: ["query"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "ado_docs",
        description: "Search the Azure DevOps API endpoint index. Use before calling ado_query or ado_mutate to find the correct path, method, and parameters.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query, e.g. 'work items' or 'pull requests'" },
          },
          required: ["query"],
        },
      },
    },
    handler: (args) => {
      return searchEndpoints(adoEndpoints as EndpointEntry[], args.query || "");
    },
    integration: "ado",
    summaryKeys: ["query"],
  },
];

// Search endpoint index by case-insensitive substring match on description + path.
// Returns top 5 matches formatted for the LLM.
interface EndpointEntry {
  path: string;
  method: string;
  description: string;
  params: string;
  scopes?: string;
  host?: string;
}

function searchEndpoints(entries: EndpointEntry[], query: string): string {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.endpoint_search",
    message: "searching endpoint index",
    meta: {},
  });
  const q = query.toLowerCase();
  const matches = entries.filter((e) => {
    const haystack = `${e.description} ${e.path}`.toLowerCase();
    return haystack.includes(q);
  });

  if (matches.length === 0) {
    return `No matching endpoints found for "${query}". Try a broader search term.`;
  }

  return matches.slice(0, 5).map((e) => {
    const lines = [
      `${e.method} ${e.path}`,
      `  ${e.description}`,
      `  Params: ${e.params || "none"}`,
    ];
    if (e.host) lines.push(`  Host: ${e.host}`);
    if (e.scopes) lines.push(`  Scopes: ${e.scopes}`);
    return lines.join("\n");
  }).join("\n\n");
}