// The letters' single writer (design §3.2): the daemon holds one of these, and every door (CLI, MCP, in-turn tools)
// reaches it over the daemon's socket with a `letters.action` command. Each agent's letters live in its own bundle,
// under state/letters, and every write to them goes through that agent's one queue, so two sends never race.
import * as fs from "fs"
import * as path from "path"
import { machineOwnerUsername, type FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../../nerves/runtime"
import { checkLetterInput, checkWithdrawReason, newLetterId, type Letter, type LetterEvent, type LetterKind } from "./letter"
import { ownerFriendIds, readAnsweringHandles } from "./answering"
import { renderLetter } from "./render"

export { ownerFriendIds }
import { LetterIndex, type IndexedLetter } from "./letter-index"
import { LetterStore } from "./store"

/** A refusal the door answers with its card's code. */
export class LetterRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "LetterRefusal"
  }
}

export interface WriterDeps {
  /** The folder holding the agent bundles (`<agent>.ouro`). */
  bundlesRoot: string
  now?: () => Date
  newId?: (now: number) => `ltr_${string}`
  /** The friend ids of the bundle's family records that name this machine's owner. */
  listFriends?: (bundleRoot: string) => Promise<FriendRecord[]>
  ownerUsername?: () => string | null
  /** How long one second of a wait's timeout lasts; tests shorten it. */
  waitUnitMs?: number
  /** Sends a rendered letter to the person's chat as the agent; missing when this daemon has no chat to send through. */
  deliverChat?: (request: ChatDelivery) => Promise<ChatReceipt>
}

/** One letter to send: the agent it goes out as, the handle whose chat it goes to, and the text Ouro rendered. */
export interface ChatDelivery {
  agent: string
  handle: string
  text: string
}

/** Where a delivered letter landed: the channel, its chat's key and the sent message's id. */
export interface ChatReceipt {
  channel: string
  key: string
  messageId: string
}

/** The socket command every mailbox door sends the daemon. */
export interface LettersCommand {
  kind: "letters.action"
  agent: string
  action: string
  input: Record<string, unknown>
  dryRun?: boolean
}

export type LetterResult = Record<string, unknown> & { outcome: string }

/** Closed letters move to closed/YYYY-MM/ this long after they close (design §3.2); they are never deleted. */
export const ROLL_AFTER_MS = 90 * 24 * 60 * 60 * 1000
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const WAIT_DEFAULT_S = 60
const WAIT_MAX_S = 300

interface AgentLetters {
  agent: string
  store: LetterStore
  index: LetterIndex
  queue: Promise<unknown>
  waiters: Map<string, Set<() => void>>
}

function ageOf(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function optionText(letter: Letter, option: string): string {
  const label = letter.options.find((candidate) => candidate.id === option)?.label
  return label ? `${option} (${label})` : option
}

function eventLine(letter: Letter, event: LetterEvent): string {
  switch (event.t) {
    case "delivered": return `${event.at} delivered to ${event.channel}`
    case "seen": return `${event.at} seen on ${event.via}`
    case "answered": return `${event.at} answered ${optionText(letter, event.option)}`
    case "refiled": return `${event.at} refiled by ${event.by}`
    case "withdrawn": return `${event.at} withdrawn: ${event.reason}`
    case "expired": return `${event.at} expired`
    case "returned": return `${event.at} returned to ${event.to}${event.ok ? "" : ", failed"}`
  }
}

/** When a letter closed: its first answered, withdrawn or expired event. */
function closedAt(entry: IndexedLetter): number | null {
  const closing = entry.events.find((event) => event.t === "answered" || event.t === "withdrawn" || event.t === "expired")
  return closing ? Date.parse(closing.at) : null
}

export class LettersWriter {
  private readonly agents = new Map<string, AgentLetters>()

  constructor(private readonly deps: WriterDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Runs one action for an agent; a refusal throws LetterRefusal with its card's code. */
  async run(agent: string, action: string, input: Record<string, unknown>, options: { dryRun?: boolean } = {}): Promise<LetterResult> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new LetterRefusal("bad-input", "The action's input must be an object.")
    const letters = this.open(agent, options.dryRun === true)
    const result = await this.dispatch(letters, action, input, options.dryRun === true)
    emitNervesEvent({ component: "daemon", event: "letters.action_done", message: "letters action done", meta: { action, outcome: result.outcome } })
    return result
  }

  private dispatch(letters: AgentLetters, action: string, input: Record<string, unknown>, dryRun: boolean): Promise<LetterResult> {
    switch (action) {
      case "mailbox_send": return this.serial(letters, () => {
        // Each send first rolls the letters closed long enough, so a daemon that runs for months still rolls them; a
        // dry run writes nothing, so it doesn't roll.
        if (!dryRun) this.rollClosed(letters)
        return this.send(letters, input, dryRun)
      })
      case "mailbox_list": return Promise.resolve(this.list(letters, input))
      case "mailbox_read": return Promise.resolve(this.read(letters, input))
      case "mailbox_wait": return this.wait(letters, input)
      case "mailbox_withdraw": return this.serial(letters, () => this.withdraw(letters, input, dryRun))
      case "mailbox_deliver": return this.serial(letters, () => this.deliver(letters, input, dryRun))
      default: return Promise.reject(new LetterRefusal("unknown-door", `The mailbox has no action ${action}.`))
    }
  }

  /** The agent's letters, read from its bundle the first time; letters closed long enough are rolled then, unless that first call is a dry run, which writes nothing. */
  private open(agent: string, dryRun: boolean): AgentLetters {
    const bundle = path.join(this.deps.bundlesRoot, `${agent}.ouro`)
    if (!AGENT_NAME.test(agent) || !fs.existsSync(bundle)) throw new LetterRefusal("no-agent", `No agent bundle ${agent}.ouro is on this machine.`)
    const known = this.agents.get(agent)
    if (known) return known
    const store = new LetterStore(path.join(bundle, "state", "letters"))
    const index = new LetterIndex(store.loadAll(), store.readNextCode())
    const letters: AgentLetters = { agent, store, index, queue: Promise.resolve(), waiters: new Map() }
    this.agents.set(agent, letters)
    if (!dryRun) this.rollClosed(letters)
    return letters
  }

  private rollClosed(letters: AgentLetters): void {
    const now = this.now().getTime()
    for (const entry of letters.index.list({ all: true })) {
      const closed = closedAt(entry)
      if (entry.closed || closed === null || now - closed < ROLL_AFTER_MS) continue
      // Rolling is housekeeping: a letter that can't be moved stays where it is, readable, and is tried again later.
      try {
        letters.store.roll(entry.letter.id, new Date(closed))
        letters.index.markClosed(entry.letter.id)
      } catch (error) {
        emitNervesEvent({ level: "warn", component: "daemon", event: "letters.roll_failed", message: "a closed letter could not be rolled", meta: { reason: (error as Error).message } })
      }
    }
  }

  /** Runs a write after every write queued before it; a failed write doesn't stop the ones after it. */
  private serial(letters: AgentLetters, work: () => Promise<LetterResult>): Promise<LetterResult> {
    const next = letters.queue.then(work)
    letters.queue = next.catch(() => undefined)
    return next
  }

  private addEvent(letters: AgentLetters, id: string, event: LetterEvent): IndexedLetter {
    letters.store.append(id, event)
    const entry = letters.index.addEvent(id, event)
    for (const wake of letters.waiters.get(id) ?? []) wake()
    return entry
  }

  private find(letters: AgentLetters, input: Record<string, unknown>): IndexedLetter {
    const entry = typeof input.letter === "string" ? letters.index.get(input.letter) : undefined
    if (!entry) throw new LetterRefusal("not-found", `No letter is ${String(input.letter)}.`)
    return entry
  }

  private async person(agent: string): Promise<string> {
    const bundle = path.join(this.deps.bundlesRoot, `${agent}.ouro`)
    const ids = await ownerFriendIds(bundle, (this.deps.ownerUsername ?? machineOwnerUsername)(), this.deps.listFriends)
    if (ids.length === 1) return ids[0]!
    throw new LetterRefusal("no-person", ids.length === 0
      ? "No family friend record names this machine's owner, so Ouro can't tell who the letter is to."
      : `${ids.length} family records name this machine's owner, so Ouro can't tell which one the letter is to.`)
  }

  private async send(letters: AgentLetters, input: Record<string, unknown>, dryRun: boolean): Promise<LetterResult> {
    const checked = checkLetterInput(input)
    if (!checked.ok) throw new LetterRefusal("invalid-letter", checked.problem)
    const { lane, ...draft } = checked.letter
    const from: Letter["from"] = { agent: letters.agent, ...(lane ? { lane } : {}) }
    const now = this.now()
    const duplicate = letters.index.findDuplicate({ from, dedupeKey: draft.dedupeKey }, now.getTime())
    if (duplicate) {
      const { letter } = duplicate.entry
      if (dryRun) return { outcome: "preview", id: letter.id, code: letter.code, state: duplicate.entry.state, message: `Would return ${letter.code}, which is already ${duplicate.entry.state} with this dedupeKey.` }
      if (duplicate.why === "answered") {
        const answer = duplicate.entry.events.find((event) => event.t === "answered")!
        return { outcome: "done", id: letter.id, code: letter.code, state: "answered", message: `${letter.code} was answered ${optionText(letter, answer.option)} in the last day, so the answer stands.` }
      }
      this.addEvent(letters, letter.id, { t: "refiled", at: now.toISOString(), by: letters.agent })
      return { outcome: "done", id: letter.id, code: letter.code, state: "waiting", message: `${letter.code} is already waiting with this dedupeKey, so it was refiled, not filed again.` }
    }
    const to = await this.person(letters.agent)
    if (dryRun) return { outcome: "preview", id: "", code: "", state: "waiting", message: `Would file a new letter to ${to}.` }
    const number = letters.index.nextCode()
    // The counter moves first, so a crash after it can skip a code but never reuse one.
    letters.store.writeNextCode(number + 1)
    letters.index.reserve(number + 1)
    // The person's answering handle is frozen into the letter now, so a later change leaves this letter alone.
    const answeringHandle = readAnsweringHandles(letters.store.dir)[to]
    const letter: Letter = {
      v: 1, id: (this.deps.newId ?? newLetterId)(now.getTime()), code: `L${number}`, ...(answeringHandle ? { answeringHandle } : {}), to, from, ...draft, createdAt: now.toISOString(),
    }
    try {
      letters.store.create(letter)
    } catch (error) {
      // A create that fails after its write would leave a letter the index doesn't know, and a retry would file a
      // second one in the same dedupe scope. Remove it; if it can't be removed, index it so the retry finds it.
      // EEXIST means the file is another letter's, which this create never wrote, so it stays.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !letters.store.discard(letter.id)) {
        const left = letters.store.read(letter.id)
        if (left) letters.index.add(left)
      }
      throw error
    }
    letters.index.add({ letter, events: [], closed: false })
    return { outcome: "needs-human", id: letter.id, code: letter.code, state: "waiting", message: `Filed ${letter.code}, ${letter.subject}. It waits for the person's answer.` }
  }

  private list(letters: AgentLetters, input: Record<string, unknown>): LetterResult {
    const now = this.now().getTime()
    const entries = letters.index.list({
      all: input.all === true,
      ...(typeof input.kind === "string" ? { kind: input.kind as LetterKind } : {}),
      ...(input.mine === true ? { from: letters.agent } : {}),
    })
    const listing = entries.map((entry) => `${entry.letter.code}  ${entry.state}  ${ageOf(entry.letter.createdAt, now)}  ${entry.letter.subject}`).join("\n")
    return { outcome: "done", count: entries.length, listing }
  }

  private read(letters: AgentLetters, input: Record<string, unknown>): LetterResult {
    const entry = this.find(letters, input)
    return { outcome: "done", state: entry.state, letter: JSON.stringify(entry.letter), events: entry.events.map((event) => eventLine(entry.letter, event)).join("\n") }
  }

  /** Blocks until the letter leaves waiting, or has an event past the cursor, or the timeout ends. */
  private async wait(letters: AgentLetters, input: Record<string, unknown>): Promise<LetterResult> {
    const entry = this.find(letters, input)
    const cursor = Number.isInteger(input.cursor) && (input.cursor as number) >= 0 ? (input.cursor as number) : null
    const seconds = Number.isInteger(input.timeout) ? Math.min(WAIT_MAX_S, Math.max(1, input.timeout as number)) : WAIT_DEFAULT_S
    const ready = () => entry.state !== "waiting" || (cursor !== null && entry.events.length > cursor)
    if (!ready()) {
      const id = entry.letter.id
      await new Promise<void>((resolve) => {
        const waiters = letters.waiters.get(id) ?? new Set<() => void>()
        letters.waiters.set(id, waiters)
        const done = () => {
          clearTimeout(timer)
          waiters.delete(wake)
          if (waiters.size === 0) letters.waiters.delete(id)
          resolve()
        }
        const wake = () => {
          if (ready()) done()
        }
        const timer = setTimeout(done, seconds * (this.deps.waitUnitMs ?? 1000))
        waiters.add(wake)
      })
    }
    return { outcome: ready() ? "done" : "timeout", state: entry.state, cursor: entry.events.length }
  }

  private async withdraw(letters: AgentLetters, input: Record<string, unknown>, dryRun: boolean): Promise<LetterResult> {
    const entry = this.find(letters, input)
    if (entry.letter.from.agent !== letters.agent) throw new LetterRefusal("not-sender", `${entry.letter.code} was filed by ${entry.letter.from.agent}, and only the agent that filed a letter may withdraw it.`)
    if (entry.state !== "waiting") throw new LetterRefusal("not-waiting", `${entry.letter.code} is already ${entry.state}.`)
    const checked = checkWithdrawReason(input.reason)
    if (!checked.ok) throw new LetterRefusal("bad-input", `${checked.problem} Say in one line why the letter no longer needs an answer.`)
    const reason = checked.reason.trim()
    // A dry run checks everything a withdraw checks, then writes nothing.
    if (dryRun) return { outcome: "preview", state: entry.state }
    const after = this.addEvent(letters, entry.letter.id, { t: "withdrawn", at: this.now().toISOString(), reason })
    return { outcome: "done", state: after.state }
  }

  /**
   * Sends a waiting letter to the chat of the handle frozen into it when it was filed, in the text Ouro renders, and
   * records where it landed. Delivering again sends it again, so a person who lost the message can have it back.
   */
  private async deliver(letters: AgentLetters, input: Record<string, unknown>, dryRun: boolean): Promise<LetterResult> {
    const entry = this.find(letters, input)
    const { letter } = entry
    if (entry.state !== "waiting") throw new LetterRefusal("not-waiting", `${letter.code} is already ${entry.state}, so there is nothing to deliver.`)
    if (!letter.answeringHandle) {
      throw new LetterRefusal("no-answering-handle", `${letter.code} was filed before the person had an answering handle, so Ouro has no chat to send it to. It stays waiting.`)
    }
    const text = renderLetter(letter)
    if (dryRun) return { outcome: "preview", state: entry.state, text }
    if (!this.deps.deliverChat) throw new LetterRefusal("chat-unavailable", `This daemon has no chat to send ${letter.code} through. It stays waiting.`)
    let receipt: ChatReceipt
    try {
      receipt = await this.deps.deliverChat({ agent: letters.agent, handle: letter.answeringHandle, text })
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.deliver_failed", message: "a letter's chat send failed", meta: { code: letter.code, error: (error as Error).message } })
      throw new LetterRefusal("send-failed", `${letter.code} didn't send: ${(error as Error).message}. It stays waiting; deliver it again once the chat is back.`)
    }
    const after = this.addEvent(letters, letter.id, { t: "delivered", at: this.now().toISOString(), via: "chat", ...receipt })
    return { outcome: "done", state: after.state, channel: receipt.channel }
  }
}

/** The daemon's answer to a `letters.action` command: the result, or the refusal's code and text. */
export async function answerLettersCommand(writer: LettersWriter, command: LettersCommand): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    return { ok: true, data: await writer.run(command.agent, command.action, command.input, { dryRun: command.dryRun === true }) }
  } catch (error) {
    if (error instanceof LetterRefusal) return { ok: false, error: error.message, data: { code: error.code, message: error.message } }
    emitNervesEvent({ level: "error", component: "daemon", event: "letters.action_failed", message: "letters action failed", meta: { action: command.action } })
    return { ok: false, error: (error as Error).message }
  }
}

