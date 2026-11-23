/**
 * The Telegram sense's door for a relayed approval answer. The A2A process forwards the raw sealed message here,
 * over `state/approvals/relay/sock`, without opening it. This process opens it and checks it, then decides it under
 * the same lock as a tap, because this is the process that owns the approval cards (security review H3).
 *
 * Every answer re-reads the switch, so revoking or letting it expire takes effect on the next one. The checks, in order:
 * 1. The trust-folder switch is on.
 * 2. It names the same DID as the owner route in `agent.json`.
 * 3. The envelope is sealed to us and signed by that DID. It is bound, fresh and unseen in this process's own ledger,
 *    and it carries the signed `approvalAnswer` field.
 * 4. Its decision is deny (v1).
 * 5. The relay token matches a card the Butler sent and is still waiting, found under the card's lock.
 *
 * Design: desk sanctuary-server/butler-productionization/ouroboros/2026-11-23-signed-relay-design-v3.md.
 */
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { parseDidKey, ready, type DidKeyIdentity, type SeenLedgerLike, type Sodium } from "@ouro.bot/friends/a2a-client"

import { APPROVAL_RELAY_FILE, checkRelayedDecision, readApprovalRelaySwitch } from "../a2a/approval-relay"
import { loadSelfA2AIdentity } from "../a2a/identity"
import { operatorTrustFile } from "../a2a/operator-trust"
import { loadAgentConfig } from "../heart/identity"
import { openApprovalAnswer } from "../a2a/sealed-chat"
import { FileA2ASeenLedger } from "../a2a/seen-ledger"
import type { A2AMessage } from "../a2a/types"
import { emitNervesEvent } from "../nerves/runtime"
import type { TelegramApprovalRuntime, TelegramRelayAnswer } from "./telegram-approval-runtime"

/** What the relay sends back to Slugger, who tells Ari word for word. */
export type RelayReply =
  | TelegramRelayAnswer
  | "refused:switch_off"
  | "refused:route_mismatch"
  | "refused:not_verified"
  | "refused:approve_not_in_v1"
  | "refused:unknown_decision"
  | "refused:malformed_request"

export interface RelayedAnswerDeps {
  agentRoot: string
  sodium: Sodium
  /** This agent's own A2A identity: the answer is sealed to it. */
  self: DidKeyIdentity | (() => Promise<DidKeyIdentity>)
  /** The owner route's DID from `agent.json`, read for each answer; undefined when no route is set. */
  routeDid: () => string | undefined
  runtime: Pick<TelegramApprovalRuntime, "relayDeny">
  /** This process's own seen ledger (`relayAnswerSeenLedger`), never the A2A process's. */
  seen: SeenLedgerLike
  now?: () => Date
}

/** The Telegram process's own replay ledger for relayed answers, at `state/approvals/relay-seen`. */
export function relayAnswerSeenLedger(agentRoot: string): FileA2ASeenLedger {
  return new FileA2ASeenLedger(agentRoot, { folder: ["state", "approvals", "relay-seen"] })
}

export async function handleRelayedApprovalAnswer(deps: RelayedAnswerDeps, message: A2AMessage): Promise<RelayReply> {
  const now = deps.now?.() ?? new Date()
  const refuse = (reply: RelayReply, detail: string): RelayReply => {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.telegram_relay_answer_refused", message: "refused a relayed approval answer", meta: { reply, detail } })
    return reply
  }
  const relaySwitch = readApprovalRelaySwitch(deps.agentRoot, now)
  if (!relaySwitch.on) return refuse("refused:switch_off", relaySwitch.reason)
  const routeDid = deps.routeDid()
  if (routeDid !== relaySwitch.did) return refuse("refused:route_mismatch", routeDid === undefined ? "no owner route" : "switch and owner route name different DIDs")
  const sender = parseDidKey(relaySwitch.did)
  if (!sender) return refuse("refused:route_mismatch", "the switch DID is not a did:key")
  const self = typeof deps.self === "function" ? await deps.self() : deps.self
  const opened = await openApprovalAnswer({
    sodium: deps.sodium, self, message, senderDid: relaySwitch.did, senderEd25519Pub: sender.ed25519Pub, seen: deps.seen, now,
  })
  if (!opened.ok) return refuse("refused:not_verified", opened.reason)
  const decision = checkRelayedDecision(opened.approvalAnswer.decision)
  /* v8 ignore next -- friends alpha.30 refuses any decision but deny before we see it; kept for when it allows more @preserve */
  if (!decision.ok) return refuse(`refused:${decision.reason}`, "decision")
  return deps.runtime.relayDeny({
    relayToken: opened.approvalAnswer.relayToken,
    routeDid,
    senderDid: relaySwitch.did,
    envelopeBindingId: opened.envelopeBindingId,
  })
}

/** The socket the A2A process forwards tagged envelopes to, alone in a folder only this agent's user can enter. */
export function approvalRelaySocketPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "approvals", "relay", "sock")
}

const MAX_REQUEST_BYTES = 256 * 1024
/** macOS takes a socket path of at most 104 bytes and mishandles a longer one, so a longer path is refused instead. */
export const MAX_SOCKET_PATH_BYTES = 104
/** Answers come one at a time from one peer; a few slots are plenty, and a client that holds one can't hold them all. */
export const MAX_RELAY_CONNECTIONS = 4

/**
 * Makes the socket's folder 0700 and owned by this user, so no other user can reach the socket whatever its own mode
 * is while listen() creates it. A symlink or another user's folder there is refused rather than used.
 */
function makePrivateFolder(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    /* v8 ignore next -- only an existing folder is expected here; anything else is a real fault @preserve */
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid!()) {
    throw new Error(`the relay socket's folder ${dir} isn't a folder this user owns`)
  }
  fs.chmodSync(dir, 0o700)
}
/** A connection that sends no byte for this long before its request line is in is dropped. */
export const RELAY_SOCKET_IDLE_TIMEOUT_MS = 10_000

/**
 * Listens on `relay/sock` inside a 0700 folder, so only this agent's own user can connect, with at most
 * MAX_RELAY_CONNECTIONS connections open at once. Each connection sends one JSON line `{"message": <A2A message>}` and gets back one line `{"reply": "<RelayReply>"}`.
 */
export async function startApprovalRelaySocket(input: {
  socketPath: string
  handle: (message: A2AMessage) => Promise<RelayReply>
  /** Tests: how long a connection may wait between bytes before its request line is in. */
  idleTimeoutMs?: number
}): Promise<{ close(): Promise<void> }> {
  if (Buffer.byteLength(input.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`the relay socket path is over ${MAX_SOCKET_PATH_BYTES} bytes: ${input.socketPath}`)
  }
  makePrivateFolder(path.dirname(input.socketPath))
  try {
    if (fs.lstatSync(input.socketPath).isSocket()) fs.rmSync(input.socketPath)
  } catch (error) {
    /* v8 ignore next -- only a missing file is expected here; anything else is a real fault @preserve */
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = []
    let bytes = 0
    /** Stop reading: a request is answered once, and nothing after its first line is ever read. */
    const stopReading = (): void => {
      socket.setTimeout(0)
      socket.removeAllListeners("data")
      socket.pause()
    }
    const refuse = (): void => {
      stopReading()
      socket.end(`${JSON.stringify({ reply: "refused:malformed_request" satisfies RelayReply })}\n`, () => socket.destroy())
    }
    // A client that connects and sends nothing, or dribbles, is dropped; the wait while an answer is decided isn't idle.
    socket.setTimeout(input.idleTimeoutMs ?? RELAY_SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy())
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a)
      const take = newline < 0 ? chunk : chunk.subarray(0, newline)
      bytes += take.length
      if (bytes > MAX_REQUEST_BYTES) return refuse()
      chunks.push(take)
      if (newline < 0) return
      stopReading()
      let message: unknown
      try { message = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { message?: unknown }).message } catch { return refuse() }
      if (!message || typeof message !== "object" || Array.isArray(message)) return refuse()
      input.handle(message as A2AMessage).then(
        // Reading is paused, so the client's close would never be seen: close this side once the reply is flushed.
        (reply) => socket.end(`${JSON.stringify({ reply })}\n`, () => socket.destroy()),
        (error: unknown) => {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_relay_socket_error", message: "a relayed approval answer failed while it was being decided", meta: { error: String(error) } })
          socket.destroy()
        },
      )
    })
    /* v8 ignore next -- a client that resets mid-request; whether that surfaces as an error is up to the OS @preserve */
    socket.on("error", () => socket.destroy())
  })
  // Node closes a connection past this limit as soon as it arrives.
  server.maxConnections = MAX_RELAY_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.socketPath, () => resolve())
  })
  fs.chmodSync(input.socketPath, 0o600)
  emitNervesEvent({ component: "senses", event: "senses.telegram_relay_socket_listening", message: "listening for relayed approval answers", meta: { socketPath: input.socketPath } })
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface ApprovalRelayDoor {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * The door as the Telegram sense runs it. It listens only when the switch file is in the trust folder at startup, so a
 * Butler without the grant has no socket at all; each answer still re-reads the switch. Failing to start is logged and
 * leaves Telegram running: the relay is an extra way to answer, never the only one.
 */
export function createApprovalRelayDoor(input: {
  agentName: string
  agentRoot: string
  runtime: Pick<TelegramApprovalRuntime, "relayDeny">
  /** Tests: the identity and the socket path. */
  loadIdentity?: () => Promise<DidKeyIdentity>
  socketPath?: string
}): ApprovalRelayDoor {
  let server: { close(): Promise<void> } | undefined
  return {
    async start() {
      if (server || !fs.existsSync(operatorTrustFile(input.agentRoot, APPROVAL_RELAY_FILE))) return
      try {
        const sodium = await ready()
        let identity: Promise<DidKeyIdentity> | undefined
        /* v8 ignore next 2 -- the default identity load reads machine config and the vault; tests pass their own @preserve */
        const loadIdentity = input.loadIdentity ?? (() => loadSelfA2AIdentity({ agentName: input.agentName, sodium }))
        const deps: RelayedAnswerDeps = {
          agentRoot: input.agentRoot,
          sodium,
          // A failed load is forgotten, so the next answer tries again instead of failing forever.
          self: () => (identity ??= loadIdentity().catch((error: unknown) => { identity = undefined; throw error })),
          routeDid: () => loadAgentConfig({ agentName: input.agentName, agentRoot: input.agentRoot }).senses?.telegram.ownerNoticesTo?.did,
          runtime: input.runtime,
          seen: relayAnswerSeenLedger(input.agentRoot),
        }
        server = await startApprovalRelaySocket({
          socketPath: input.socketPath ?? approvalRelaySocketPath(input.agentRoot),
          handle: (message) => handleRelayedApprovalAnswer(deps, message),
        })
      } catch (error) {
        emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_relay_door_start_error", message: "the approval relay door could not start; taps still work", meta: { agentName: input.agentName, error: String(error) } })
      }
    },
    async stop() {
      const current = server
      server = undefined
      await current?.close()
    },
  }
}
