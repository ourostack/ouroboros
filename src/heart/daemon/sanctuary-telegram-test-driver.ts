import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import { isTelegramTestId, type TelegramUpdate } from "../../senses/telegram-client"
import type { SignedAuthorityPayload } from "./sanctuary-authority-codec"
import type { TelegramTransportObservationV1 } from "./sanctuary-telegram-authority-gateway"

/**
 * The owner-turn test driver lets the root on the Sanctuary host play the owner in the live bot chat: it records a
 * synthetic owner update (a message, a reply, an edit, a reaction or a button tap) in the authority's own update
 * records, the resident answers it through its ordinary poll, and the driver returns what the bot really sent.
 *
 * It is off unless invoked: nothing listens, the only entry is a root-run command that needs the authority's
 * root-only config and signing key, and the authority logs outbound traffic only while a driver run has armed the
 * log's window. Every injected update keeps an id in the test range, which is its durable test-injected mark.
 */

export const TEST_TEXT_PREFIX = "[test] "
const DEFAULT_WAIT_SECONDS = 240
const DEFAULT_QUIET_SECONDS = 20
const WINDOW_GRACE_MS = 120_000
const MAX_LOG_TEXT = 4_096

export function sanctuaryTelegramTestLogRoot(agentRoot: string): string {
  return path.join(agentRoot, "authority", "test-driver")
}

export type SanctuaryTelegramTestLogEntry = Record<string, unknown> & { seq: number; at: string; kind: string }

/** The root-only record of injected updates and of what the bot sent while a driver run was watching. */
export class FileSanctuaryTelegramTestLog {
  readonly #root: string
  readonly #now: () => number

  constructor(root: string, now: () => number = Date.now) {
    this.#root = root
    this.#now = now
  }

  get logPath(): string {
    return path.join(this.#root, "log.ndjson")
  }

  get #windowPath(): string {
    return path.join(this.#root, "armed-until.json")
  }

  armed(): boolean {
    try {
      const value = JSON.parse(fs.readFileSync(this.#windowPath, "utf8")) as { until?: unknown }
      return typeof value.until === "string" && Date.parse(value.until) > this.#now()
    } catch {
      return false
    }
  }

  arm(untilMs: number): void {
    this.#ensureRoot()
    fs.writeFileSync(this.#windowPath, `${JSON.stringify({ until: new Date(untilMs).toISOString() })}\n`, { mode: 0o600 })
  }

  append(entry: Record<string, unknown> & { kind: string }): number {
    this.#ensureRoot()
    const seq = this.read().length + 1
    fs.appendFileSync(this.logPath, `${JSON.stringify({ seq, at: new Date(this.#now()).toISOString(), ...entry })}\n`, { mode: 0o600 })
    return seq
  }

  read(): SanctuaryTelegramTestLogEntry[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.logPath, "utf8")
    } catch {
      return []
    }
    return raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as SanctuaryTelegramTestLogEntry)
  }

  #ensureRoot(): void {
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.#root, 0o700)
  }
}

function clip(value: unknown): unknown {
  return typeof value === "string" && value.length > MAX_LOG_TEXT ? `${value.slice(0, MAX_LOG_TEXT)}…` : value
}

/** What the authority writes when the bot sends something while a driver run is watching. */
export function sanctuaryTelegramOutboundEntry(input: {
  method: string
  body: Record<string, unknown>
  result: unknown
  observationUpdateId?: number
  local?: boolean
  replyToDropped?: number
}): Record<string, unknown> & { kind: string } {
  const { body, result } = input
  const resultMessageId = typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as { message_id?: unknown }).message_id
    : undefined
  return {
    kind: "outbound",
    method: input.method,
    ...(body.chat_id !== undefined ? { chatId: String(body.chat_id) } : {}),
    ...(input.observationUpdateId !== undefined ? { observationUpdateId: input.observationUpdateId, testObservation: isTelegramTestId(input.observationUpdateId) } : {}),
    ...(body.text !== undefined ? { text: clip(body.text) } : {}),
    ...(body.caption !== undefined ? { caption: clip(body.caption) } : {}),
    ...(body.reply_markup !== undefined ? { replyMarkup: body.reply_markup } : {}),
    ...(body.message_id !== undefined ? { targetMessageId: body.message_id } : {}),
    ...(body.reaction !== undefined ? { reaction: body.reaction } : {}),
    ...(body.reply_parameters !== undefined ? { replyTo: (body.reply_parameters as { message_id?: unknown }).message_id } : {}),
    ...(input.replyToDropped !== undefined ? { replyTo: input.replyToDropped, replyToDropped: true } : {}),
    ...(body.callback_query_id !== undefined ? { callbackQueryId: body.callback_query_id } : {}),
    ...(Number.isSafeInteger(resultMessageId) ? { messageId: resultMessageId } : {}),
    ...(input.local ? { local: true } : {}),
  }
}

export interface SanctuaryTelegramTestDriverDependencies {
  gateway: {
    injectTestUpdate(update: TelegramUpdate): SignedAuthorityPayload<TelegramTransportObservationV1>
    nextTestUpdateId(): number
    record(updateId: number): { settlement: string } | null
  }
  log: Pick<FileSanctuaryTelegramTestLog, "arm" | "append" | "read">
  botId: string
  ownerUserId: string
  ownerChatId: string
  /** Posts a visible note in the owner's chat so the owner can see what the driver played. */
  echo?: (text: string) => Promise<unknown>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  write?: (text: string) => void
}

interface ParsedArguments {
  command: string
  flags: Map<string, string>
  switches: Set<string>
}

const VALUE_FLAGS = new Set(["--text", "--reply-to", "--reply-to-text", "--message-id", "--emoji", "--data", "--wait", "--quiet", "--since"])
const SWITCHES = new Set(["--no-echo", "--no-wait"])

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = "", ...rest] = argv
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!
    if (SWITCHES.has(flag)) {
      switches.add(flag)
      continue
    }
    const value = rest[index + 1]
    if (!VALUE_FLAGS.has(flag) || value === undefined) throw new Error(`unknown or incomplete option ${flag}`)
    flags.set(flag, value)
    index += 1
  }
  return { command, flags, switches }
}

function positiveInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a positive integer`)
  return Number(value)
}

function testText(value: string | undefined): string {
  if (value === undefined || !value.startsWith(TEST_TEXT_PREFIX) || value.length > 4_096) {
    throw new Error(`--text must start with "${TEST_TEXT_PREFIX}" and fit in one Telegram message`)
  }
  return value
}

export const SANCTUARY_TELEGRAM_TEST_DRIVER_USAGE = `usage: sanctuary-telegram-test-driver --config <active.json> <command> [options]
  send  --text "[test] ..." [--reply-to <message id> [--reply-to-text <its text>]]
  edit  --message-id <id of an earlier injected message> --text "[test] ..."
  react --message-id <bot message id> --emoji <emoji>
  tap   --message-id <bot message id> --data <button callback data>
  log   [--since <seq>]
options for send/edit/react/tap: --wait <seconds> (default ${DEFAULT_WAIT_SECONDS}), --quiet <seconds> (default ${DEFAULT_QUIET_SECONDS}), --no-wait, --no-echo`

function isBusyLease(error: unknown): boolean {
  return error instanceof Error && (error as { retryable?: unknown }).retryable === true
}

export async function runSanctuaryTelegramTestDriver(argv: readonly string[], deps: SanctuaryTelegramTestDriverDependencies): Promise<unknown> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const write = deps.write ?? ((text: string) => { process.stdout.write(text) })
  const { command, flags, switches } = parseArguments(argv)
  if (command === "log") {
    const since = flags.has("--since") ? positiveInteger(flags.get("--since"), "--since") : 0
    const entries = deps.log.read().filter((entry) => entry.seq > since)
    write(`${JSON.stringify(entries, null, 2)}\n`)
    return entries
  }
  const owner = Number(deps.ownerUserId)
  const chat = { id: Number(deps.ownerChatId), type: "private" }
  const from = { id: owner, is_bot: false, first_name: "Owner (test)" }
  const date = Math.floor(now() / 1_000)
  const waitSeconds = flags.has("--wait") ? positiveInteger(flags.get("--wait"), "--wait") : DEFAULT_WAIT_SECONDS
  const quietSeconds = flags.has("--quiet") ? positiveInteger(flags.get("--quiet"), "--quiet") : DEFAULT_QUIET_SECONDS
  const startedAt = now()
  const deadline = startedAt + waitSeconds * 1_000
  // The resident holds the authority's state lease while it works a turn; wait for it rather than crash.
  const whenFree = async <T>(operation: () => T): Promise<T> => {
    for (;;) {
      try { return operation() }
      catch (error) {
        if (!isBusyLease(error) || now() >= deadline) throw error
        await sleep(1_000)
      }
    }
  }
  const updateId = await whenFree(() => deps.gateway.nextTestUpdateId())
  let update: TelegramUpdate
  let echo: string
  if (command === "send") {
    const text = testText(flags.get("--text"))
    const replyTo = flags.has("--reply-to") ? positiveInteger(flags.get("--reply-to"), "--reply-to") : undefined
    const replyToText = flags.get("--reply-to-text")
    update = {
      update_id: updateId,
      message: {
        message_id: updateId, from, chat, date, text,
        ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, from: { id: Number(deps.botId), is_bot: true }, ...(replyToText !== undefined ? { text: replyToText } : {}) } } : {}),
      } as TelegramUpdate["message"],
    }
    echo = `🧪 test driver, owner says${replyTo !== undefined ? ` (replying to message ${replyTo})` : ""}: ${text}`
  } else if (command === "edit") {
    const messageId = positiveInteger(flags.get("--message-id"), "--message-id")
    if (!isTelegramTestId(messageId)) throw new Error("--message-id must name an earlier injected message; only those can be edited")
    const text = testText(flags.get("--text"))
    update = { update_id: updateId, edited_message: { message_id: messageId, from, chat, date, edit_date: date, text } as TelegramUpdate["edited_message"] }
    echo = `🧪 test driver, owner edits message ${messageId} to: ${text}`
  } else if (command === "react") {
    const messageId = positiveInteger(flags.get("--message-id"), "--message-id")
    const emoji = flags.get("--emoji")
    if (!emoji || emoji.length > 16) throw new Error("--emoji is required")
    update = { update_id: updateId, message_reaction: { chat, message_id: messageId, user: { id: owner }, date, old_reaction: [], new_reaction: [{ type: "emoji", emoji }] } as TelegramUpdate["message_reaction"] }
    echo = `🧪 test driver, owner reacts ${emoji} to message ${messageId}`
  } else if (command === "tap") {
    const messageId = positiveInteger(flags.get("--message-id"), "--message-id")
    const data = flags.get("--data")
    if (!data || Buffer.byteLength(data) > 256) throw new Error("--data is required")
    update = { update_id: updateId, callback_query: { id: `ouro-test-${updateId}`, from, message: { message_id: messageId, chat, date }, chat_instance: "ouro-test", data } as TelegramUpdate["callback_query"] }
    echo = `🧪 test driver, owner taps a button on message ${messageId}`
  } else {
    throw new Error(SANCTUARY_TELEGRAM_TEST_DRIVER_USAGE)
  }
  deps.log.arm(startedAt + (waitSeconds * 1_000) + WINDOW_GRACE_MS)
  if (!switches.has("--no-echo") && deps.echo) await deps.echo(echo)
  const seq = deps.log.append({ kind: "injected", command, updateId, update })
  await whenFree(() => deps.gateway.injectTestUpdate(update))
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_telegram_test_driver_injected", message: "Sanctuary test driver injected an owner update", meta: { updateId, command } })
  const injected = { updateId, ...(command === "send" ? { messageId: updateId } : {}), seq }
  if (switches.has("--no-wait")) {
    write(`${JSON.stringify(injected, null, 2)}\n`)
    return injected
  }
  // Wait until the resident has settled the update and the bot has been quiet for a while, or the deadline passes.
  let settlement = "pending"
  let settledAt: number | undefined
  let lastReplyAt = startedAt
  let replies: SanctuaryTelegramTestLogEntry[] = []
  let timedOut = false
  for (;;) {
    try { settlement = deps.gateway.record(updateId)?.settlement ?? "missing" }
    catch (error) { if (!isBusyLease(error)) throw error }
    if (settlement !== "pending" && settledAt === undefined) settledAt = now()
    const current = deps.log.read().filter((entry) => entry.seq > seq && entry.kind === "outbound")
    if (current.length !== replies.length) lastReplyAt = now()
    replies = current
    if (settledAt !== undefined && now() - Math.max(settledAt, lastReplyAt) >= quietSeconds * 1_000) break
    if (now() >= deadline) {
      timedOut = true
      break
    }
    await sleep(1_000)
  }
  const transcript = { ...injected, settlement, timedOut, replies }
  write(`${JSON.stringify(transcript, null, 2)}\n`)
  return transcript
}
