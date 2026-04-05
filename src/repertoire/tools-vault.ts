import type { ToolDefinition } from "./tools-base"
import { getBitwardenClient } from "./bitwarden-client"
import { emitNervesEvent } from "../nerves/runtime"

export const vaultToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "vault_get",
        description:
          "Retrieve a credential from the Bitwarden vault by ID or name. Returns metadata and fields but never raw passwords.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Vault item ID (preferred)" },
            name: {
              type: "string",
              description: "Search by name (less precise, uses first match)",
            },
          },
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.vault_tool_call",
        message: "vault_get invoked",
        meta: { tool: "vault_get" },
      })

      try {
        const client = getBitwardenClient()

        if (args.id) {
          const item = await client.getItem(args.id)
          return JSON.stringify(item, null, 2)
        }

        if (args.name) {
          const items = await client.listItems(args.name)
          if (items.length === 0) {
            return `No vault item found matching "${args.name}". Try vault_list to see available items.`
          }
          const item = await client.getItem(items[0].id)
          return JSON.stringify(item, null, 2)
        }

        return "Please provide either an id or name to look up a vault item."
      } catch (err) {
        return `Vault error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["id", "name"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "vault_store",
        description:
          "Store a new credential in the Bitwarden vault. Supports login credentials, API keys, and structured fields.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name for the credential" },
            username: { type: "string", description: "Username (optional)" },
            password: { type: "string", description: "Password (optional)" },
            uri: { type: "string", description: "URI/URL (optional)" },
            notes: { type: "string", description: "Notes (optional)" },
            fields: {
              type: "string",
              description:
                'JSON string of custom fields, e.g. {"apiKey": "key123", "region": "us-east"}',
            },
          },
          required: ["name"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.vault_tool_call",
        message: "vault_store invoked",
        meta: { tool: "vault_store", name: args.name },
      })

      try {
        const client = getBitwardenClient()
        const fields: Record<string, string> = {}

        if (args.username) fields.username = args.username
        if (args.password) fields.password = args.password
        if (args.uri) fields.uri = args.uri
        if (args.notes) fields.notes = args.notes
        if (args.fields) {
          const parsed = JSON.parse(args.fields)
          Object.assign(fields, parsed)
        }

        const handle = await client.createItem(args.name, fields)
        return JSON.stringify(handle, null, 2)
      } catch (err) {
        return `Vault error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    confirmationRequired: true,
    summaryKeys: ["name"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "vault_list",
        description:
          "List credentials in the Bitwarden vault. Returns names and IDs only, never secrets.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Optional search filter",
            },
          },
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.vault_tool_call",
        message: "vault_list invoked",
        meta: { tool: "vault_list" },
      })

      try {
        const client = getBitwardenClient()
        const items = await client.listItems(args.search)
        return JSON.stringify(items, null, 2)
      } catch (err) {
        return `Vault error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["search"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "vault_delete",
        description: "Delete a credential from the Bitwarden vault by ID.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "ID of the vault item to delete",
            },
          },
          required: ["id"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.vault_tool_call",
        message: "vault_delete invoked",
        meta: { tool: "vault_delete", id: args.id },
      })

      try {
        const client = getBitwardenClient()
        await client.deleteItem(args.id)
        return `Vault item ${args.id} deleted successfully.`
      } catch (err) {
        return `Vault delete failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    confirmationRequired: true,
    summaryKeys: ["id"],
  },
]
