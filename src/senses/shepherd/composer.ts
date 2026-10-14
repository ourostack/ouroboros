import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"
import { FrontendRequestError, SocketFrontendClient, type FrontendProtocolClient } from "../../heart/frontend-socket-client"
import { localShepherdFriendStore, resolveExistingLocalOwner, SHEPHERD_UUID, type ShepherdSession } from "./surface"
import { emitNervesEvent } from "../../nerves/runtime"

/** Identify only this UI's own device, never capture a changing focused terminal. */
export function composerTerminalTty(isTTY: boolean = process.stdin.isTTY === true): string | undefined {
  if (!isTTY) return undefined
  const result = spawnSync("/usr/bin/tty", [], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] })
  const tty = result.stdout?.trim()
  if (result.status !== 0 || !tty || !/^\/dev\/[A-Za-z0-9/_-]{1,120}$/.test(tty)) {
    throw new Error("could not identify the composer's own terminal; refusing to offer it as a target")
  }
  return tty
}

export function selectShepherdTarget(targets: readonly ShepherdSession[], explicit?: string): ShepherdSession | null {
  if (explicit) {
    const target = targets.find(candidate => candidate.id.toLowerCase() === explicit.toLowerCase())
    if (!target) throw new Error(`selected Shepherd terminal is unavailable: ${explicit}`)
    return Object.freeze({ ...target })
  }
  if (!targets.length) throw new Error("No eligible coding terminals are available")
  return targets.length === 1 ? Object.freeze({ ...targets[0]! }) : null
}

interface ComposerTurn {
  id: string
  events: Array<{ type: string; data: Record<string, any>; sequence?: number }>
  seen: Set<number>
  recovering: number
  reconciliationPending: boolean
  dispatched: boolean
  cancelled: boolean
  unresolved: boolean
  resolve(answer: string): void
  reject(error: Error): void
}

/** Transport-only UI: never writes to the coding agent, reads its screen, or runs a model. */
export class ShepherdComposer {
  private readonly client: FrontendProtocolClient
  private readonly agent: string
  private readonly friendId: string
  private readonly composerTty?: string
  readonly target: ShepherdSession
  readonly sessionKey: string
  private active: ComposerTurn | null = null
  private readonly unsubscribe: () => void
  private readonly unsubscribeClose: () => void
  private readonly notice: (message: string) => void
  private readonly answer: (message: string) => void

  constructor(options: { client: FrontendProtocolClient; agent: string; friendId: string; target: ShepherdSession; composerTty?: string; notice?: (message: string) => void; answer?: (message: string) => void }) {
    this.client = options.client
    this.agent = options.agent
    this.friendId = options.friendId
    this.composerTty = options.composerTty
    this.target = Object.freeze({ ...options.target })
    this.sessionKey = `shepherd:${this.target.id}`
    this.notice = options.notice ?? (() => {})
    this.answer = options.answer ?? (() => {})
    this.unsubscribe = this.client.onEvent(frame => {
      if (frame.event === "replay_required") {
        const turn = this.active
        this.notice("Ouro disconnected: journal replay required.")
        void this.recover().catch(error => { if (this.active === turn) this.fail(error, true) })
      } else if (this.active && frame.turnId === this.active.id && frame.sessionKey === this.sessionKey) {
        this.consume(this.active, frame.event.replaceAll(".", "_"), frame, frame.journalSequence)
      }
    })
    this.unsubscribeClose = this.client.onClose(() => {
      const turn = this.active
      this.notice("Ouro disconnected; resolving this turn through its journal. No turn will be resubmitted.")
      void this.recover().catch(error => { if (this.active === turn) this.fail(error, true) })
    })
  }

  get busy(): boolean { return this.active !== null }

  async submit(input: string, requestId?: string): Promise<string> {
    if (this.active) throw new Error("Ouro already has an active turn; use /cancel")
    if (requestId !== undefined && !SHEPHERD_UUID.test(requestId)) throw new Error("Ouro request id must be a UUID")
    const message = input.replace(/^@ouro(?:\s+|$)/i, "")
    if (!message.trim()) throw new Error("message must not be empty")
    const completion = Promise.withResolvers<string>()
    const turn: ComposerTurn = { id: requestId ?? randomUUID(), events: [], seen: new Set(), recovering: 0, reconciliationPending: false, dispatched: false, cancelled: false,
      unresolved: false, resolve: completion.resolve, reject: completion.reject }
    this.active = turn
    // Attach a rejection handler before transport work to avoid unhandled rejection races.
    void completion.promise.catch(() => {})
    const turnId = turn.id
    try {
      await this.client.request("session.subscribe", { sessionKey: this.sessionKey })
      if (turn.cancelled || this.active !== turn) return completion.promise
      turn.dispatched = true
      await this.client.request("turn.start", {
        ...this.ref(), turnId, channel: "cli", message, shepherdSession: this.target,
        ...(this.composerTty ? { composerTty: this.composerTty } : {}),
      })
      emitNervesEvent({ component: "senses", event: "senses.shepherd_composer_turn_submitted", message: "submitted an independent fixed-target Ouro turn", meta: { agent: this.agent, session: this.target.id, turnId } })
    } catch (sendError) {
      if (sendError instanceof FrontendRequestError && sendError.code === "turn_rejected") {
        if (this.active === turn) this.fail(sendError)
        return completion.promise
      }
      // Unknown acknowledgement is never retried. Even a rejected send may have run.
      if (this.active === turn) {
        try { await this.recover() } catch (error) {
          if (this.active === turn) this.fail(new Error(`${String(sendError)}; ${String(error)}`), true)
        }
      }
    }
    return completion.promise
  }

  async cancel(): Promise<boolean> {
    const turn = this.active
    if (!turn) return false
    turn.cancelled = true
    if (!turn.dispatched) {
      this.fail(new Error("Ouro turn cancelled"))
      return true
    }
    const result = await this.client.request("turn.cancel", { turnId: turn.id })
    return result.cancelled === true
  }

  async recover(): Promise<void> {
    const turn = this.active
    if (!turn) return
    turn.recovering += 1
    turn.reconciliationPending = true
    let status: { state: string; events: Array<{ type: string; data: Record<string, any>; sequence?: number }> }
    try {
      await this.client.request("session.subscribe", { sessionKey: this.sessionKey })
      status = await this.client.request("turn.status", { ...this.ref(), turnId: turn.id })
      if (this.active !== turn) return
      for (const event of status.events) {
        this.consume(turn, event.type, event.data, event.sequence)
      }
    } finally {
      turn.recovering -= 1
    }
    // A live terminal event must wait for the authoritative journal merge. Failed
    // reconciliation never finalizes a potentially truncated buffered answer.
    if (turn.recovering === 0) turn.reconciliationPending = false
    this.finishTurn()
    if (this.active === turn && turn.recovering === 0 && status.state !== "active") {
      turn.reconciliationPending = true
      throw new Error(`Ouro turn status is ${status.state}; not resubmitting ${turn.id}`)
    }
  }

  close(): void {
    this.unsubscribe()
    this.unsubscribeClose()
    this.fail(new Error("Ouro composer closed"))
    this.client.close()
  }

  private ref() {
    return { agent: this.agent, friendId: this.friendId, sessionKey: this.sessionKey }
  }

  private fail(error: unknown, retain = false): void {
    const turn = this.active
    if (retain && turn) {
      turn.unresolved = true
      this.notice(`Ouro turn ${turn.id} is unresolved; use /recover or /cancel. It will not be resubmitted.`)
    } else this.active = null
    turn?.reject(error instanceof Error ? error : new Error(String(error)))
  }

  private consume(turn: ComposerTurn, type: string, data: Record<string, any>, sequence?: number): void {
    if (!["assistant_delivery", "turn_completed", "turn_failed", "turn_cancelled"].includes(type)) return
    if (typeof sequence === "number") {
      if (turn.seen.has(sequence)) return
      turn.seen.add(sequence)
    }
    turn.events.push({ type, data, sequence })
    this.finishTurn()
  }

  private finishTurn(): void {
    const turn = this.active
    if (!turn || turn.reconciliationPending) return
    const ordered = [...turn.events].sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER))
    const terminalIndex = ordered.findIndex(event => event.type !== "assistant_delivery")
    if (terminalIndex < 0) return
    const { type, data } = ordered[terminalIndex]!
    const deliveries = ordered.slice(0, terminalIndex)
      .filter(event => typeof event.data.text === "string").map(event => event.data.text as string)
    if (type === "turn_completed") {
      this.active = null
      if (data.result?.outcome === "errored" || data.result?.outcome === "aborted") {
        turn.reject(new Error(`Ouro turn ${data.result.outcome}`))
      } else {
        const answer = deliveries.length ? deliveries.join("\n") : String(data.result?.response ?? "")
        this.answer(answer)
        if (turn.unresolved) this.notice(`Ouro: ${answer}`)
        turn.resolve(answer)
      }
    } else {
      this.fail(new Error(type === "turn_cancelled" ? "Ouro turn cancelled" : String(data.error ?? "Ouro turn failed")))
    }
  }
}

export async function runShepherdComposer(options: {
  agent: string
  session?: string
  socketPath: string
  input?: Readable
  output?: Writable
  client?: FrontendProtocolClient
  resolveOwner?: () => Promise<string>
  composerTty?: string
}): Promise<void> {
  const composerTty = options.composerTty ?? composerTerminalTty()
  const friendId = await (options.resolveOwner ?? (() => resolveExistingLocalOwner(localShepherdFriendStore(options.agent))))()
  const client = options.client ?? new SocketFrontendClient(options.socketPath)
  const output = options.output ?? process.stdout
  const write = (text: string) => { output.write(`${text}\n`) }
  const input = options.input ?? process.stdin
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let composer: ShepherdComposer | undefined
  const interrupt = () => {
    if (composer) void composer.cancel().catch(error => write(`Ouro error: ${String(error)}`))
    else lines.close()
  }
  lines.on("SIGINT", interrupt)
  process.on("SIGINT", interrupt)
  try {
    const result = await client.request("shepherd.targets", { agent: options.agent, friendId, ...(composerTty ? { composerTty } : {}) })
    const targets = result.targets as ShepherdSession[]
    let target = selectShepherdTarget(targets, options.session)
    write("Ouro Shepherd — independent terminal composer (not the coding agent's input).")
    if (!target) {
      targets.forEach((candidate, index) => write(`${index + 1}. ${candidate.label} [${candidate.id}]`))
      write("Select a terminal by number. Focus changes do not select or retarget a conversation.")
    }
    const attach = (selected: ShepherdSession) => {
      composer = new ShepherdComposer({ client, agent: options.agent, friendId, target: selected, ...(composerTty ? { composerTty } : {}), notice: write })
      write(`Ouro → ${selected.label} [${selected.id}]\nType to Ouro. /cancel cancels only Ouro; /recover checks the journal; /quit exits.`)
    }
    if (target) attach(target)
    for await (const line of lines) {
      if (line === "/quit") break
      if (!target) {
        const index = /^[1-9]\d*$/.test(line) ? Number(line) - 1 : -1
        if (!targets[index]) { write("Select one of the listed terminal numbers."); continue }
        target = targets[index]!
        attach(target)
        continue
      }
      if (!line.trim()) continue
      if (line === "/cancel") {
        void composer!.cancel().then(cancelled => write(cancelled ? "Ouro cancellation requested." : "Ouro has no cancellable turn.")).catch(error => write(`Ouro error: ${String(error)}`))
      } else if (line === "/recover") {
        void composer!.recover().catch(error => write(`Ouro error: ${String(error)}`))
      } else {
        void composer!.submit(line).then(answer => write(`Ouro: ${answer}`)).catch(error => write(`Ouro error: ${String(error)}`))
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt)
    lines.close()
    if (composer) {
      try { await composer.cancel() } catch { write("Ouro disconnected while closing; check journal status before another turn.") }
      composer.close()
    } else client.close()
  }
}
