/**
 * The Telegram sense's door for a relayed approval answer. The A2A process forwards the raw sealed message here,
 * over `state/approvals/relay.sock`, without opening it. This process opens it and checks it, then decides it under
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
import { approvalRelaySocketPath } from "../a2a/approval-relay-forward"
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

export { approvalRelaySocketPath } from "../a2a/approval-relay-forward"

const MAX_REQUEST_BYTES = 256 * 1024

/**
 * Listens on `relay.sock` (mode 0600, so only this agent's own user can connect). Each connection sends one
 * JSON line `{"message": <A2A message>}` and gets back one line `{"reply": "<RelayReply>"}`.
 */
export async function startApprovalRelaySocket(input: {
  socketPath: string
  handle: (message: A2AMessage) => Promise<RelayReply>
}): Promise<{ close(): Promise<void> }> {
  fs.mkdirSync(path.dirname(input.socketPath), { recursive: true })
  try {
    if (fs.lstatSync(input.socketPath).isSocket()) fs.rmSync(input.socketPath)
  } catch (error) {
    /* v8 ignore next -- only a missing file is expected here; anything else is a real fault @preserve */
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const server = net.createServer((socket) => {
    let buffered = ""
    let answered = false
    const answer = (reply: RelayReply): void => {
      if (answered) return
      answered = true
      socket.end(`${JSON.stringify({ reply })}\n`)
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) return answer("refused:malformed_request")
      const newline = buffered.indexOf("\n")
      if (newline < 0 || answered) return
      let message: unknown
      try { message = (JSON.parse(buffered.slice(0, newline)) as { message?: unknown }).message } catch { return answer("refused:malformed_request") }
      if (!message || typeof message !== "object" || Array.isArray(message)) return answer("refused:malformed_request")
      answered = true
      input.handle(message as A2AMessage).then(
        (reply) => socket.end(`${JSON.stringify({ reply })}\n`),
        (error: unknown) => {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_relay_socket_error", message: "a relayed approval answer failed while it was being decided", meta: { error: String(error) } })
          socket.destroy()
        },
      )
    })
    /* v8 ignore next -- a client that resets mid-request; whether that surfaces as an error is up to the OS @preserve */
    socket.on("error", () => socket.destroy())
  })
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
          self: () => (identity ??= loadIdentity()),
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
