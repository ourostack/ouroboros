import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"
import { SocketFrontendClient, type FrontendProtocolClient } from "../../heart/frontend-socket-client"
import { localShepherdFriendStore, resolveExistingLocalOwner, type ShepherdSession } from "./surface"

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
  deliveries: string[]
  seen: Set<number>
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

  constructor(options: { client: FrontendProtocolClient; agent: string; friendId: string; target: ShepherdSession; composerTty?: string; notice?: (message: string) => void }) {
    this.client = options.client
    this.agent = options.agent
    this.friendId = options.friendId
    this.composerTty = options.composerTty
    this.target = Object.freeze({ ...options.target })
    this.sessionKey = `shepherd:${this.target.id}`
    this.notice = options.notice ?? (() => {})
    this.unsubscribe = this.client.onEvent(frame => {
      if (frame.event === "replay_required") {
        this.notice("Ouro disconnected: journal replay required.")
        void this.recover().catch(error => this.fail(error, true))
      } else if (this.active && frame.turnId === this.active.id && frame.sessionKey === this.sessionKey) {
        this.consume(frame.event.replaceAll(".", "_"), frame, frame.journalSequence)
      }
    })
    this.unsubscribeClose = this.client.onClose(() => {
      this.notice("Ouro disconnected; resolving this turn through its journal. No turn will be resubmitted.")
      void this.recover().catch(error => this.fail(error, true))
    })
  }

  async submit(input: string): Promise<string> {
    if (this.active) throw new Error("Ouro already has an active turn; use /cancel")
    const message = input.replace(/^@ouro(?:\s+|$)/i, "")
    if (!message.trim()) throw new Error("message must not be empty")
    const completion = Promise.withResolvers<string>()
    this.active = { id: randomUUID(), deliveries: [], seen: new Set(), unresolved: false, resolve: completion.resolve, reject: completion.reject }
    // Attach a rejection handler before transport work to avoid unhandled rejection races.
    void completion.promise.catch(() => {})
    const turnId = this.active.id
    try {
      await this.client.request("session.subscribe", { sessionKey: this.sessionKey })
      await this.client.request("turn.start", {
        ...this.ref(), turnId, channel: "cli", message, shepherdSession: this.target,
        ...(this.composerTty ? { composerTty: this.composerTty } : {}),
      })
    } catch (sendError) {
      // Unknown acknowledgement is never retried. Even a rejected send may have run.
      try { await this.recover() } catch (error) {
        this.fail(new Error(`${String(sendError)}; ${String(error)}`), true)
      }
    }
    return completion.promise
  }

  async cancel(): Promise<boolean> {
    if (!this.active) return false
    const result = await this.client.request("turn.cancel", { turnId: this.active.id })
    return result.cancelled === true
  }

  async recover(): Promise<void> {
    const turn = this.active
    if (!turn) return
    await this.client.request("session.subscribe", { sessionKey: this.sessionKey })
    const status = await this.client.request("turn.status", { ...this.ref(), turnId: turn.id })
    if (this.active !== turn) return
    for (const event of status.events) {
      this.consume(event.type, event.data, event.sequence)
    }
    if (this.active === turn && status.state !== "active") {
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

  private consume(type: string, data: Record<string, any>, sequence?: number): void {
    const turn = this.active
    if (!turn) return
    if (typeof sequence === "number") {
      if (turn.seen.has(sequence)) return
      turn.seen.add(sequence)
    }
    if (type === "assistant_delivery" && typeof data.text === "string") turn.deliveries.push(data.text)
    if (type === "turn_completed") {
      this.active = null
      if (data.result?.outcome === "errored" || data.result?.outcome === "aborted") {
        turn.reject(new Error(`Ouro turn ${data.result.outcome}`))
      } else {
        const answer = turn.deliveries.length ? turn.deliveries.join("\n") : String(data.result?.response ?? "")
        if (turn.unresolved) this.notice(`Ouro: ${answer}`)
        turn.resolve(answer)
      }
    } else if (type === "turn_failed" || type === "turn_cancelled") {
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
