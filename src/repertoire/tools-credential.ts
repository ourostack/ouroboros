import * as crypto from "node:crypto"
import { withCode, type ToolDefinition, type ToolErrorCard } from "./tools-base"
import { getCredentialStore } from "./credential-access"
import { sanitizeCredentialErrorDetail } from "./bitwarden-store"
import { emitNervesEvent } from "../nerves/runtime"

const DEFAULT_PASSWORD_LENGTH = 24
const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128
const PASSWORD_CHARSETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
} as const

function sanitizeCredentialToolError(err: unknown, secrets: Array<string | undefined> = []): string {
  const raw = err instanceof Error ? err.message : String(err)
  return sanitizeCredentialErrorDetail(raw, { secrets })
}

function requireTrimmedText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`)
  }
  return value.trim()
}

function requireNonBlankSecret(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`)
  }
  return value
}

function optionalTrimmedText(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string if provided.`)
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveVaultItemArg(args: Record<string, unknown>, legacyFieldName = "domain"): string {
  if (args.item !== undefined) return requireTrimmedText(args.item, "item")
  return requireTrimmedText(args[legacyFieldName], legacyFieldName)
}

function parsePasswordLength(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_PASSWORD_LENGTH
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < MIN_PASSWORD_LENGTH || parsed > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `length must be an integer between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}.`,
    )
  }
  return parsed
}

function parseSymbolsFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true
  if (typeof value === "boolean") return value
  /* v8 ignore next -- handler tests cover string "true"/"false"; branch mapping is noisy here @preserve */
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true") return true
    if (normalized === "false") return false
  }
  throw new Error("symbols must be true or false.")
}

function randomChar(alphabet: string): string {
  /* v8 ignore next -- crypto.randomInt stays within bounds; fallback is defensive @preserve */
  return alphabet[crypto.randomInt(0, alphabet.length)] ?? alphabet[0]!
}

function secureShuffle(chars: string[]): void {
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1)
    ;[chars[index], chars[swapIndex]] = [chars[swapIndex]!, chars[index]!]
  }
}

function generatePassword(length: number, symbols: boolean): string {
  const charsets = [
    PASSWORD_CHARSETS.lower,
    PASSWORD_CHARSETS.upper,
    PASSWORD_CHARSETS.digits,
    ...(symbols ? [PASSWORD_CHARSETS.symbols] : []),
  ]
  const chars = charsets.map((alphabet) => randomChar(alphabet))
  const combinedAlphabet = charsets.join("")

  while (chars.length < length) {
    chars.push(randomChar(combinedAlphabet))
  }

  secureShuffle(chars)
  return chars.join("")
}

const GUARDRAIL_ERROR: ToolErrorCard = { code: "guardrail-blocked", means: "The trust guardrail stopped the call before it ran, because this person may not touch the vault this way.", fix: "Don't retry here; tell the person this needs someone with more trust, or another conversation." }
const CREDENTIAL_NOT_FOUND_ERROR: ToolErrorCard = { code: "credential-not-found", means: "The vault has no item under that exact name or path.", fix: "Call credential_list with part of the name to find the item's exact path, then use that." }

export const credentialToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "credential_get",
        description:
          "Get credential metadata for a vault item name/path. Returns username, notes, and creation date. Passwords stay inside the credential gateway, which injects them itself.",
        parameters: {
          type: "object",
          properties: {
            item: {
              type: "string",
              description: "Vault item name/path to look up (e.g. 'airbnb.com' or 'ops/porkbun/account')",
            },
            domain: {
              type: "string",
              description: "compatibility alias for item when the vault item name is a service domain",
            },
          },
          required: ["domain"],
        },
      },
    },
    handler: async (args) => {
      const itemName = resolveVaultItemArg(args)
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_get invoked",
        meta: { tool: "credential_get", domain: itemName, item: itemName },
      })

      try {
        const store = getCredentialStore()
        const meta = await store.get(itemName)

        if (!meta) {
          return withCode(`No credential found for "${itemName}".`, "credential-not-found")
        }

        return JSON.stringify(meta, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: store.get wraps errors @preserve */
        return withCode(`Credential error: ${err instanceof Error ? err.message : String(err)}`, "credential-read-failed")
      }
    },
    summaryKeys: ["domain"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads credential metadata; the password is never returned" },
    ax: { id: "tool:credential_get", group: "turn-vault", when: "Pick this to check which username a saved login uses, by its vault path; the password stays hidden.", effect: "read", idempotent: true, errors: [
      GUARDRAIL_ERROR, CREDENTIAL_NOT_FOUND_ERROR,
      { code: "credential-read-failed", means: "The vault couldn't be read; the text gives the reason, often that it is locked.", fix: "If it says locked, tell the person to unlock it with vault_setup's commands; otherwise retry once." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_generate_password",
        description:
          "Generate a strong password for a new account. Use it to complete signup, then immediately call credential_store with the exact accepted password so the vault becomes the source of truth.",
        parameters: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain this password will be used for (e.g. 'airbnb.com')",
            },
            length: {
              type: "integer",
              description: "Optional password length. Defaults to 24. Allowed range: 12 to 128.",
            },
            symbols: {
              type: "boolean",
              description: "Whether to include punctuation symbols. Defaults to true.",
            },
          },
          required: ["domain"],
        },
      },
    },
    handler: async (args) => {
      let domain = ""
      try {
        domain = requireTrimmedText(args.domain, "domain")
        const length = parsePasswordLength((args as Record<string, unknown>).length)
        const symbols = parseSymbolsFlag((args as Record<string, unknown>).symbols)

        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.credential_tool_call",
          message: "credential_generate_password invoked",
          meta: { tool: "credential_generate_password", domain, length, symbols },
        })

        const password = generatePassword(length, symbols)
        return JSON.stringify({
          domain,
          password,
          length,
          symbols,
          nextStep: "Use this password for signup, then call credential_store with the exact accepted password.",
        }, null, 2)
      } catch (err) {
        return withCode(`Credential password generation error: ${sanitizeCredentialToolError(err)}`, "password-generation-failed")
      }
    },
    summaryKeys: ["domain", "length", "symbols"],
    riskProfile: { mutates: "none", risk: "low", reason: "generates a password in memory; nothing is saved" },
    ax: { id: "tool:credential_generate_password", group: "turn-vault", when: "Pick this when signing up somewhere new needs a strong password; save the one the site accepted with credential_store.", effect: "read", errors: [
      GUARDRAIL_ERROR,
      { code: "password-generation-failed", means: "domain is blank, length isn't a whole number from 12 to 128, or symbols isn't true or false.", fix: "Fix the argument the text names; leave length and symbols out to get the defaults." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_store",
        description:
          "Store credentials in a vault item name/path after the agent acquired or just used them successfully. Prefer credential_generate_password for new passwords, then call this tool once the site accepts the exact password. Later reads return only metadata, not the stored password.",
        parameters: {
          type: "object",
          properties: {
            item: {
              type: "string",
              description: "Vault item name/path to store under; domains are examples, not the schema",
            },
            domain: {
              type: "string",
              description: "compatibility alias for item when the vault item name is a service domain",
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
              description: "Optional human/agent orientation notes about this credential; not parsed by code",
            },
          },
          required: ["domain", "username", "password"],
        },
      },
    },
    handler: async (args) => {
      let domain = ""
      let username = ""
      let password = ""
      let notes: string | undefined
      const itemNameForEvent = typeof args.item === "string" && args.item.trim() ? args.item.trim() : args.domain

      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_store invoked",
        meta: { tool: "credential_store", domain: itemNameForEvent, item: itemNameForEvent },
      })

      try {
        domain = resolveVaultItemArg(args)
        username = requireTrimmedText(args.username, "username")
        password = requireNonBlankSecret(args.password, "password")
        notes = optionalTrimmedText(args.notes, "notes")

        const store = getCredentialStore()
        await store.store(domain, {
          username,
          password,
          notes,
        })

        return `Credentials stored and verified for "${domain}".`
      } catch (err) {
        /* v8 ignore next -- defensive: store.store wraps errors @preserve */
        return withCode(`Credential store error: ${sanitizeCredentialToolError(err, [password, username, notes])}`, "credential-store-failed")
      }
    },
    summaryKeys: ["domain"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "stores credential vault item" },
    ax: { id: "tool:credential_store", group: "turn-vault", when: "Pick this right after an account is created or its password changes, to save the exact login the site accepted.", effect: "write", idempotent: true, errors: [
      GUARDRAIL_ERROR,
      { code: "credential-store-failed", means: "An argument is blank or the vault refused the save; the text names which, with secrets redacted.", fix: "Fill in the item, username or password the text names; if the vault refused, check it is unlocked, then save again." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_list",
        description:
          "List stored vault items. Returns metadata only (item/domain name, username, notes, creation date), without passwords.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Optional search filter to match against vault item names/paths",
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
        return withCode(`Credential list error: ${err instanceof Error ? err.message : String(err)}`, "credential-list-failed")
      }
    },
    summaryKeys: ["search"],
    riskProfile: { mutates: "none", risk: "low", reason: "lists credential item names and usernames" },
    ax: { id: "tool:credential_list", group: "turn-vault", when: "Pick this to find the exact vault path of a saved login, by part of its name or username, before credential_get.", effect: "read", idempotent: true, errors: [
      GUARDRAIL_ERROR,
      { code: "credential-list-failed", means: "The vault couldn't be listed; the text gives the reason, often that it is locked.", fix: "If it says locked, tell the person to unlock it with vault_setup's commands; otherwise retry once." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_delete",
        description: "Delete stored credentials for a vault item name/path.",
        parameters: {
          type: "object",
          properties: {
            item: {
              type: "string",
              description: "Vault item name/path whose credentials should be deleted",
            },
            domain: {
              type: "string",
              description: "compatibility alias for item when the vault item name is a service domain",
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
        const itemName = resolveVaultItemArg(args)
        const store = getCredentialStore()
        const deleted = await store.delete(itemName)

        if (deleted) {
          return `Credentials for "${itemName}" deleted.`
        }
        return withCode(`No credential found for "${itemName}".`, "credential-not-found")
      } catch (err) {
        /* v8 ignore next -- defensive: store.delete wraps errors @preserve */
        return withCode(`Credential delete error: ${err instanceof Error ? err.message : String(err)}`, "credential-delete-failed")
      }
    },
    summaryKeys: ["domain"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "deletes credential vault item" },
    ax: { id: "tool:credential_delete", group: "turn-vault", when: "Pick this only when the person asks to forget a saved login, such as a closed account; it can't be undone.", effect: "write", destructive: true, idempotent: true, errors: [
      GUARDRAIL_ERROR,
      { ...CREDENTIAL_NOT_FOUND_ERROR, fix: "Call credential_list to find the exact path; if nothing matches, it is already gone." },
      { code: "credential-delete-failed", means: "The vault refused the delete; the text gives the reason.", fix: "Check the vault is unlocked, then confirm with credential_list whether the item is still there before retrying." },
    ] },
  },
]
