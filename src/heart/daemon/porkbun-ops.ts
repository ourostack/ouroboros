export const PORKBUN_OPS_CREDENTIAL_KIND = "ops-credential/porkbun"
export const PORKBUN_OPS_CREDENTIAL_PREFIX = "ops/registrars/porkbun/accounts"

const PORKBUN_OPS_ACCOUNT_FORBIDDEN = /[\/\r\n\t]/

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

export function requirePorkbunOpsSecret(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be blank`)
  return trimmed
}
