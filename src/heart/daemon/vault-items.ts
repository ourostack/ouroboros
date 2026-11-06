export const PORKBUN_OPS_CREDENTIAL_PREFIX = "ops/registrars/porkbun/accounts"
export const PORKBUN_OPS_COMPATIBILITY_ALIAS = "vault ops porkbun" as const

export type VaultItemTemplate = "porkbun-api"
export type VaultItemCompatibilityAlias = typeof PORKBUN_OPS_COMPATIBILITY_ALIAS

const VAULT_ITEM_NAME_FORBIDDEN = /[\r\n\t]/
const VAULT_ITEM_FIELD_FORBIDDEN = /[\r\n\t=]/
const PORKBUN_OPS_ACCOUNT_FORBIDDEN = /[\/\r\n\t]/

export function isVaultItemTemplate(value: unknown): value is VaultItemTemplate {
  return value === "porkbun-api"
}

export function normalizeVaultItemName(item: string | undefined): string {
  const normalized = item?.trim() ?? ""
  if (!normalized || VAULT_ITEM_NAME_FORBIDDEN.test(normalized) || normalized.startsWith("/") || normalized.endsWith("/")) {
    throw new Error("Vault item name/path must be non-empty, relative, and free of control characters.")
  }
  return normalized
}

export function normalizeVaultItemFieldName(field: string | undefined): string {
  const normalized = field?.trim() ?? ""
  if (!normalized || VAULT_ITEM_FIELD_FORBIDDEN.test(normalized)) {
    throw new Error("Vault item field names must be non-empty and free of control characters or '='.")
  }
  return normalized
}

export function vaultItemTemplateSecretFields(_template: VaultItemTemplate): string[] {
  return ["apiKey", "secretApiKey"]
}

export function normalizePorkbunOpsAccount(account: string | undefined): string {
  const normalized = account?.trim() ?? ""
  if (!normalized || PORKBUN_OPS_ACCOUNT_FORBIDDEN.test(normalized)) {
    throw new Error("Porkbun account must be a non-empty account label without slashes or control characters.")
  }
  return normalized
}

export function porkbunOpsCredentialItemName(account: string): string {
  return `${PORKBUN_OPS_CREDENTIAL_PREFIX}/${normalizePorkbunOpsAccount(account)}`
}

export function porkbunOpsAccountFromItemName(itemName: string): string | undefined {
  const prefix = `${PORKBUN_OPS_CREDENTIAL_PREFIX}/`
  return itemName.startsWith(prefix) ? itemName.slice(prefix.length) : undefined
}

export function requireVaultItemSecret(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be blank`)
  return trimmed
}
