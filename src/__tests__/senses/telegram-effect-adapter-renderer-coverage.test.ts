import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const sendTelegramText = vi.hoisted(() => vi.fn())

vi.mock("../../senses/telegram-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../senses/telegram-client")>(),
  sendTelegramText,
}))

import { executeTelegramEffect, FileTelegramEffectJournal, prepareTelegramEffect } from "../../senses/telegram-effect-adapter"

const roots: string[] = []
const target = { kind: "approved_relationship" as const, friendId: "ari", sessionKey: "telegram:ari" }
const authorization = { allowed: true as const, receiptId: "auth-1", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "42" } }

afterEach(() => {
  sendTelegramText.mockReset()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram effect renderer contract", () => {
  it("fails closed if one prepared part unexpectedly renders as multiple messages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effect-renderer-"))
    roots.push(root)
    const store = new FileTelegramEffectJournal(root)
    const artifact = prepareTelegramEffect(store, { idempotencyKey: "renderer:drift", target, authorClass: "butler", effect: { kind: "text", text: "One part" }, authorization })
    sendTelegramText.mockResolvedValue([1, 2])

    await expect(executeTelegramEffect(store, artifact.id, { request: vi.fn() }, () => authorization)).rejects.toThrow("unexpected message count")
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "indeterminate" })
  })
})
