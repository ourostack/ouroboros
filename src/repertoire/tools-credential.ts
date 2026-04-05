import type { ToolDefinition } from "./tools-base"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

export const credentialToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "credential_get",
        description:
          "Get credential metadata for a domain. Returns username, notes, and creation date. Never returns passwords — the credential gateway handles secret injection internally.",
        parameters: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to look up (e.g. 'airbnb.com', 'api.openweathermap.org')",
            },
          },
          required: ["domain"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_get invoked",
        meta: { tool: "credential_get", domain: args.domain },
      })

      try {
        const store = getCredentialStore()
        const meta = await store.get(args.domain)

        if (!meta) {
          return `No credential found for "${args.domain}".`
        }

        return JSON.stringify(meta, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: store.get wraps errors @preserve */
        return `Credential error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["domain"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_store",
        description:
          "Store credentials the agent acquired (e.g. during sign-up). The password is accepted in args because the model generated it. Stored passwords are never returned later — only metadata is visible.",
        parameters: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain these credentials are for (e.g. 'airbnb.com')",
            },
            username: {
              type: "string",
              description: "Username or email for the account",
            },
            password: {
              type: "string",
              description: "Password for the account",
            },
            notes: {
              type: "string",
              description: "Optional notes about this credential",
            },
          },
          required: ["domain", "username", "password"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_store invoked",
        meta: { tool: "credential_store", domain: args.domain },
      })

      try {
        const store = getCredentialStore()
        await store.store(args.domain, {
          username: args.username,
          password: args.password,
          notes: args.notes,
        })

        return `Credentials stored for "${args.domain}".`
      } catch (err) {
        /* v8 ignore next -- defensive: store.store wraps errors @preserve */
        return `Credential store error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    confirmationRequired: true,
    summaryKeys: ["domain"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_list",
        description:
          "List stored credential domains. Returns metadata only (domain, username, notes, creation date). Never returns passwords.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Optional search filter to match against domain names",
            },
          },
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_list invoked",
        meta: { tool: "credential_list" },
      })

      try {
        const store = getCredentialStore()
        let items = await store.list()

        // Client-side search filter
        if (args.search) {
          const term = args.search.toLowerCase()
          items = items.filter(
            (item) =>
              item.domain.toLowerCase().includes(term) ||
              (item.username && item.username.toLowerCase().includes(term)),
          )
        }

        return JSON.stringify(items, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: store.list wraps errors @preserve */
        return `Credential list error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["search"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_delete",
        description: "Delete stored credentials for a domain.",
        parameters: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain whose credentials should be deleted",
            },
          },
          required: ["domain"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_delete invoked",
        meta: { tool: "credential_delete", domain: args.domain },
      })

      try {
        const store = getCredentialStore()
        const deleted = await store.delete(args.domain)

        if (deleted) {
          return `Credentials for "${args.domain}" deleted.`
        }
        return `No credential found for "${args.domain}".`
      } catch (err) {
        /* v8 ignore next -- defensive: store.delete wraps errors @preserve */
        return `Credential delete error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    confirmationRequired: true,
    summaryKeys: ["domain"],
  },
]
