import { describe, expect, it } from "vitest"
import {
  isVaultItemTemplate,
  normalizePorkbunOpsAccount,
  normalizeVaultItemFieldName,
  normalizeVaultItemName,
  porkbunOpsAccountFromItemName,
  porkbunOpsCredentialItemName,
  requireVaultItemSecret,
  vaultItemTemplateSecretFields,
} from "../../../heart/daemon/vault-items"

describe("vault item helpers", () => {
  it("normalizes ordinary vault item names and field names", () => {
    expect(normalizeVaultItemName(" ops/custom/service ")).toBe("ops/custom/service")
    expect(normalizeVaultItemFieldName(" apiKey ")).toBe("apiKey")
    expect(() => normalizeVaultItemName(undefined)).toThrow("Vault item name/path")
    expect(() => normalizeVaultItemName("/ops/custom/service")).toThrow("Vault item name/path")
    expect(() => normalizeVaultItemName("ops/custom/service/")).toThrow("Vault item name/path")
    expect(() => normalizeVaultItemName("ops/custom\nservice")).toThrow("Vault item name/path")
    expect(() => normalizeVaultItemFieldName(undefined)).toThrow("Vault item field names")
    expect(() => normalizeVaultItemFieldName("bad=field")).toThrow("Vault item field names")
  })

  it("recognizes the Porkbun API template and compatibility item naming", () => {
    expect(isVaultItemTemplate("porkbun-api")).toBe(true)
    expect(isVaultItemTemplate("aws")).toBe(false)
    expect(vaultItemTemplateSecretFields("porkbun-api")).toEqual(["apiKey", "secretApiKey"])
    expect(normalizePorkbunOpsAccount(" ari@mendelow.me ")).toBe("ari@mendelow.me")
    expect(() => normalizePorkbunOpsAccount(undefined)).toThrow("Porkbun account")
    expect(() => normalizePorkbunOpsAccount("ari/mendelow.me")).toThrow("Porkbun account")
    expect(porkbunOpsCredentialItemName("ari@mendelow.me")).toBe("ops/registrars/porkbun/accounts/ari@mendelow.me")
    expect(porkbunOpsAccountFromItemName("ops/registrars/porkbun/accounts/ari@mendelow.me")).toBe("ari@mendelow.me")
    expect(porkbunOpsAccountFromItemName("ops/custom/service")).toBeUndefined()
  })

  it("requires nonblank hidden values without trimming stored secrets", () => {
    expect(requireVaultItemSecret(" secret value ", "API key")).toBe("secret value")
    expect(() => requireVaultItemSecret("   ", "API key")).toThrow("API key cannot be blank")
  })
})
