import * as crypto from "node:crypto"
import type { ToolDefinition } from "./tools-base"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

const DEFAULT_PASSWORD_LENGTH = 24
const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128
const MAX_ERROR_DETAIL_LENGTH = 500

const PASSWORD_CHARSETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
} as const

function sanitizeCredentialToolError(err: unknown, secrets: Array<string | undefined> = []): string {
  const raw = err instanceof Error ? err.message : String(err)
  const scrubbed = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("Command failed:"))
    .join("\n")
    .trim()

  let sanitized = scrubbed || "command failed"
  const uniqueSecrets = [...new Set(
    secrets.filter((value): value is string => typeof value === "string" && value.length >= 4),
  )]
    .sort((left, right) => right.length - left.length)

  for (const secret of uniqueSecrets) {
    sanitized = sanitized.split(secret).join("[redacted]")
  }

  return sanitized
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]")
    .slice(0, MAX_ERROR_DETAIL_LENGTH)
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
        return `Credential password generation error: ${sanitizeCredentialToolError(err)}`
      }
    },
    summaryKeys: ["domain", "length", "symbols"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "credential_store",
        description:
          "Store credentials the agent acquired or just used successfully during signup. Prefer credential_generate_password for new passwords, then call this tool once the site accepts the exact password. Stored passwords are never returned later — only metadata is visible.",
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
      let domain = ""
      let username = ""
      let password = ""
      let notes: string | undefined

      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.credential_tool_call",
        message: "credential_store invoked",
        meta: { tool: "credential_store", domain: args.domain },
      })

      try {
        domain = requireTrimmedText(args.domain, "domain")
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
        return `Credential store error: ${sanitizeCredentialToolError(err, [password, username, notes])}`
      }
    },
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
    summaryKeys: ["domain"],
  },
]
