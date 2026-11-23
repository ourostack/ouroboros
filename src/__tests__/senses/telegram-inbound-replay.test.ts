import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileTelegramUpdateInboxStore, createTelegramLongPoll, type TelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"

const dirs: string[] = []
function inboxPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-inbound-replay-"))
  dirs.push(dir)
  return path.join(dir, "inbox.json")
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const update: TelegramUpdate = { update_id: 21, message: { message_id: 4, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "what's up?" } }

/** The inbox a process left when it died while this update's turn was running. */
function strandedInbox(filePath: string): FileTelegramUpdateInboxStore {
  const store = new FileTelegramUpdateInboxStore(filePath)
  store.capture(update)
  store.claim(update)
  return store
}

function poll(options: { filePath: string; offset: { value: number }; onMessage: () => Promise<void>; replayIndeterminate?: (update: TelegramUpdate) => boolean; settleTransport?: (update: TelegramUpdate, outcome: "completed" | "indeterminate") => Promise<void> }) {
  const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => [update]) as TelegramBotApi["request"] }
  return createTelegramLongPoll({
    api,
    expectedUserId: "10",
    expectedChatId: "10",
    offsetStore: { load: () => options.offset.value, save: (value) => { options.offset.value = value } },
    inboxStore: new FileTelegramUpdateInboxStore(options.filePath),
    onMessage: options.onMessage,
    ...(options.replayIndeterminate ? { replayIndeterminate: options.replayIndeterminate } : {}),
    ...(options.settleTransport ? { settleTransport: options.settleTransport } : {}),
  })
}

describe("Telegram messages whose turn a stopped process left", () => {
  it("runs a redelivered message again when the sense puts it back, then moves the offset past it", async () => {
    const filePath = inboxPath()
    strandedInbox(filePath)
    const offset = { value: 0 }
    const onMessage = vi.fn(async () => undefined)
    const replayIndeterminate = vi.fn(() => true)

    await expect(poll({ filePath, offset, onMessage, replayIndeterminate }).pollOnce()).resolves.toBe(22)
    expect(replayIndeterminate).toHaveBeenCalledWith(update)
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(offset.value).toBe(22)
    expect(new FileTelegramUpdateInboxStore(filePath).loadIndeterminate()).toEqual([])
  })

  it("settles the gateway with the replay's own result", async () => {
    const filePath = inboxPath()
    strandedInbox(filePath)
    const settleTransport = vi.fn(async () => undefined)
    await poll({ filePath, offset: { value: 0 }, onMessage: vi.fn(async () => undefined), replayIndeterminate: () => true, settleTransport }).pollOnce()
    expect(settleTransport).toHaveBeenCalledWith(update, "completed")
  })

  it("leaves a redelivered message alone when the sense does not put it back", async () => {
    const filePath = inboxPath()
    strandedInbox(filePath)
    const onMessage = vi.fn(async () => undefined)
    const offset = { value: 0 }
    await poll({ filePath, offset, onMessage, replayIndeterminate: () => false }).pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
    expect(offset.value).toBe(22)
    expect(new FileTelegramUpdateInboxStore(filePath).loadIndeterminate()).toHaveLength(1)
  })

  it("does not ask about a redelivered message that finished", async () => {
    const filePath = inboxPath()
    const store = strandedInbox(filePath)
    store.complete(update)
    const replayIndeterminate = vi.fn(() => true)
    const onMessage = vi.fn(async () => undefined)
    await poll({ filePath, offset: { value: 0 }, onMessage, replayIndeterminate }).pollOnce()
    expect(replayIndeterminate).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()
  })

  it("does not run a message twice when the inbox cannot take it back", async () => {
    const filePath = inboxPath()
    strandedInbox(filePath)
    const onMessage = vi.fn(async () => undefined)
    const store = new FileTelegramUpdateInboxStore(filePath)
    store.quarantineStranded()
    const withoutReclaim = {
      load: () => store.load(), loadPending: () => store.loadPending(), loadIndeterminate: () => store.loadIndeterminate(),
      quarantineStranded: () => store.quarantineStranded(), acknowledgeIndeterminateWarning: (receipt: Parameters<typeof store.acknowledgeIndeterminateWarning>[0]) => store.acknowledgeIndeterminateWarning(receipt),
      capture: (value: TelegramUpdate) => store.capture(value), claim: (value: TelegramUpdate) => store.claim(value), complete: (value: TelegramUpdate) => store.complete(value),
    }
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => [update]) as TelegramBotApi["request"] }
    await createTelegramLongPoll({
      api, expectedUserId: "10", expectedChatId: "10", offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: withoutReclaim, onMessage, replayIndeterminate: () => true,
    }).pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
  })
})

describe("Telegram inbox reclaim", () => {
  it("takes back only an update whose dispatch outcome is unknown", () => {
    const filePath = inboxPath()
    const store = strandedInbox(filePath)
    expect(store.reclaimIndeterminate(update)).toBe(false)
    store.quarantineStranded()
    expect(store.reclaimIndeterminate(update)).toBe(true)
    expect(store.loadIndeterminate()).toEqual([])
    expect(store.claim(update)).toBe(false)
    store.complete(update)
    expect(store.reclaimIndeterminate(update)).toBe(false)
  })
})
