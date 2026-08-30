import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const root = vi.hoisted(() => ({ value: "" }))
const now = "2026-08-29T00:00:00.000Z"
const owner = { id: "ari", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
  externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 }
const legacy = { id: "legacy", name: "Legacy household member", trustLevel: "friend", capabilityProfileId: "sanctuary-household",
  externalIds: [{ provider: "telegram-user", externalId: "888", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 }

vi.mock("@ouro.bot/friends", async (importActual) => {
  const actual = await importActual<typeof import("@ouro.bot/friends")>()
  return {
    ...actual,
    FileFriendStore: class {
      async findByExternalId(provider: string, externalId: string, tenantId: string) {
        return provider === "telegram-user" && externalId === "42" && tenantId === "777" ? structuredClone(owner) : null
      }
      async get(id: string) { return id === "ari" ? structuredClone(owner) : null }
      async listAll() { return [structuredClone(owner), structuredClone(legacy)] }
      async put() { return undefined }
    },
  }
})

import { createProductionTelegramRelationshipComposition } from "../../senses/telegram"

afterEach(() => {
  if (root.value) fs.rmSync(root.value, { recursive: true, force: true })
  root.value = ""
})

describe("Telegram contact legacy defaults", () => {
  it("renders safe policy defaults when a readable legacy Friend predates those optional fields", async () => {
    root.value = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-contact-defaults-"))
    fs.writeFileSync(path.join(root.value, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: {
      "sanctuary-owner": { version: 1, contextScopes: [], toolNames: ["telegram_contact_manage"], effectScopes: [] },
      "sanctuary-household": { version: 1, contextScopes: [], toolNames: [], effectScopes: [] },
    } }))
    const composition = await createProductionTelegramRelationshipComposition("sanctuary", { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" }, root.value)

    await expect(composition.telegramContactManager!.list({ actorFriendId: "ari" })).resolves.toEqual({
      contacts: [{ friendId: "legacy", name: "Legacy household member", userId: "888", admissionState: "unverified", initiativePolicy: "none" }],
      blocked: [],
    })
  })
})
