// The Telegram sense's door for a relayed approval answer: the opener, the checks in order, and the local socket.
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, ready, sealEnvelope, wrapInDataPart, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { prepareMessage, type ApprovalAnswer } from "@ouro.bot/friends"

import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { operatorTrustDir } from "../../a2a/operator-trust"
import { APPROVAL_RELAY_FILE } from "../../a2a/approval-relay"
import { openApprovalAnswer, sealChatMessage } from "../../a2a/sealed-chat"
import type { A2AMessage } from "../../a2a/types"
import {
  approvalRelaySocketPath, createApprovalRelayDoor, handleRelayedApprovalAnswer, relayAnswerSeenLedger, startApprovalRelaySocket,
  type RelayedAnswerDeps, type RelayReply,
} from "../../senses/telegram-approval-relay"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
const closers: Array<() => Promise<void>> = []
beforeAll(async () => { sodium = await ready() })
afterEach(async () => {
  while (closers.length) await closers.pop()!()
  tmp?.cleanup()
  tmp = null
})

const RELAY_TOKEN = "r".repeat(43)

function mint(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

/** Seal what Slugger's harness-only sender will send: a fixed text and the signed answer field. */
function sealAnswer(from: DidKeyIdentity, to: DidKeyIdentity, answer: ApprovalAnswer = { relayToken: RELAY_TOKEN, decision: "deny" }): A2AMessage {
  const prepared = prepareMessage({ fromAgentId: from.did, text: "Approval answer", approvalAnswer: answer })
  if (!prepared.ok) throw new Error(prepared.status)
  const sealed = sealEnvelope({
    sodium, envelope: prepared.envelope as unknown as Record<string, unknown>, friendsKind: "message", fromIdentity: from,
    recipientDid: to.did, recipientX25519Pub: keyAgreementFromDidKey({ sodium, ed25519Pub: to.ed25519Pub }),
  })
  return { kind: "message", role: "ROLE_USER", messageId: "m1", parts: wrapInDataPart({ sealedEnvelope: sealed, recipientDid: to.did }).parts } as unknown as A2AMessage
}

function setup(options: { switchDid?: string | null; routeDid?: string | null } = {}) {
  tmp = createTmpBundle({ agentName: `door-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` })
  const butler = mint()
  const slugger = mint()
  const switchDid = options.switchDid === undefined ? slugger.did : options.switchDid
  if (switchDid !== null) {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(dir, APPROVAL_RELAY_FILE), JSON.stringify({
      schemaVersion: 1, did: switchDid, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), approveTools: [], source: "synthetic test switch",
    }), { mode: 0o644 })
  }
  const routeDid = options.routeDid === undefined ? slugger.did : options.routeDid
  const relayDeny = vi.fn(async () => "denied" as const)
  const deps: RelayedAnswerDeps = {
    agentRoot: tmp.agentRoot, sodium, self: butler, routeDid: () => routeDid ?? undefined,
    runtime: { relayDeny }, seen: relayAnswerSeenLedger(tmp.agentRoot),
  }
  return { butler, slugger, deps, relayDeny, agentRoot: tmp.agentRoot }
}

describe("openApprovalAnswer", () => {
  it("opens a signed answer from the expected sender with its binding id", async () => {
    const { butler, slugger } = setup()
    const opened = await openApprovalAnswer({ sodium, self: butler, message: sealAnswer(slugger, butler), senderDid: slugger.did, senderEd25519Pub: slugger.ed25519Pub })
    expect(opened).toMatchObject({ ok: true, approvalAnswer: { relayToken: RELAY_TOKEN, decision: "deny" } })
    expect(opened.ok && opened.envelopeBindingId.length).toBeGreaterThan(0)
  })

  it("refuses a sealed chat without the field, even if its text looks like an answer", async () => {
    const { butler, slugger } = setup()
    const message = { kind: "message", role: "ROLE_USER", messageId: "m", ...sealChatMessage({ sodium, from: slugger, recipientDid: butler.did, recipientEd25519Pub: butler.ed25519Pub, text: `{"relayToken":"${RELAY_TOKEN}","decision":"deny"}` }) } as unknown as A2AMessage
    expect(await openApprovalAnswer({ sodium, self: butler, message, senderDid: slugger.did, senderEd25519Pub: slugger.ed25519Pub })).toEqual({ ok: false, reason: "not_an_approval_answer" })
  })

  it("refuses an answer signed by anyone but the expected sender", async () => {
    const { butler, slugger } = setup()
    const stranger = mint()
    const opened = await openApprovalAnswer({ sodium, self: butler, message: sealAnswer(stranger, butler), senderDid: slugger.did, senderEd25519Pub: slugger.ed25519Pub })
    expect(opened.ok).toBe(false)
  })
})

describe("handleRelayedApprovalAnswer", () => {
  it("decides a verified deny from the switch's DID, which is also the owner route", async () => {
    const { butler, slugger, deps, relayDeny } = setup()
    expect(await handleRelayedApprovalAnswer(deps, sealAnswer(slugger, butler))).toBe("denied")
    expect(relayDeny).toHaveBeenCalledWith({ relayToken: RELAY_TOKEN, routeDid: slugger.did, senderDid: slugger.did, envelopeBindingId: expect.any(String) })
  })

  it("refuses a replay of the same envelope, using its own ledger under state/approvals/relay-seen", async () => {
    const { butler, slugger, deps, relayDeny, agentRoot } = setup()
    const message = sealAnswer(slugger, butler)
    expect(await handleRelayedApprovalAnswer(deps, message)).toBe("denied")
    expect(await handleRelayedApprovalAnswer({ ...deps, seen: relayAnswerSeenLedger(agentRoot) }, message)).toBe("refused:not_verified")
    expect(relayDeny).toHaveBeenCalledTimes(1)
    // The door says only "not verified"; underneath, the ledger is what refused it.
    const reopened = await openApprovalAnswer({ sodium, self: butler, message, senderDid: slugger.did, senderEd25519Pub: slugger.ed25519Pub, seen: relayAnswerSeenLedger(agentRoot) })
    expect(reopened).toEqual({ ok: false, reason: "replayed" })
    expect(fs.readdirSync(path.join(agentRoot, "state", "approvals", "relay-seen")).length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(agentRoot, "state", "a2a", "seen"))).toBe(false)
  })

  it("re-reads the switch for every answer: on for one, then off for the next", async () => {
    const { butler, slugger, deps, relayDeny, agentRoot } = setup()
    expect(await handleRelayedApprovalAnswer(deps, sealAnswer(slugger, butler))).toBe("denied")
    fs.rmSync(path.join(operatorTrustDir(agentRoot), APPROVAL_RELAY_FILE))
    expect(await handleRelayedApprovalAnswer(deps, sealAnswer(slugger, butler))).toBe("refused:switch_off")
    expect(relayDeny).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["no owner route", { routeDid: null }],
    ["a route to another agent", { routeDid: "did:key:z6MkSomeoneElse" }],
    ["a switch DID that isn't a did:key", { switchDid: "did:web:example.com", routeDid: "did:web:example.com" }],
  ])("refuses with %s", async (_label, options) => {
    const { butler, slugger, deps, relayDeny } = setup(options)
    expect(await handleRelayedApprovalAnswer(deps, sealAnswer(slugger, butler))).toBe("refused:route_mismatch")
    expect(relayDeny).not.toHaveBeenCalled()
  })

  it("refuses an answer from a signer the switch doesn't name", async () => {
    const { butler, deps, relayDeny } = setup()
    expect(await handleRelayedApprovalAnswer(deps, sealAnswer(mint(), butler))).toBe("refused:not_verified")
    expect(relayDeny).not.toHaveBeenCalled()
  })
})

async function ask(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let data = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => { data += chunk })
    socket.on("end", () => resolve(data))
    socket.on("close", () => resolve(data))
    socket.on("error", reject)
    socket.write(payload)
  })
}

describe("startApprovalRelaySocket", () => {
  async function listen(handle: (message: A2AMessage) => Promise<RelayReply>, idleTimeoutMs?: number) {
    tmp = createTmpBundle({ agentName: `sock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    const socketPath = approvalRelaySocketPath(tmp.agentRoot)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    const server = await startApprovalRelaySocket({ socketPath, handle, ...(idleTimeoutMs ? { idleTimeoutMs } : {}) })
    closers.push(() => server.close())
    return socketPath
  }

  /** Streams `total` bytes with no newline and resolves when the server closes the connection, whatever the client saw. */
  function flood(socketPath: string, total: number): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath)
      let data = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => { data += chunk })
      socket.on("error", () => undefined)
      socket.on("close", () => resolve(data))
      const chunk = "x".repeat(64 * 1024)
      let sent = 0
      const pump = (): void => {
        while (sent < total && !socket.destroyed) {
          sent += chunk.length
          if (!socket.write(chunk)) { socket.once("drain", pump); return }
        }
      }
      socket.on("connect", pump)
    })
  }

  it("answers one JSON line with one reply line, on a socket only this user can open", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    expect(socketPath.endsWith(path.join("state", "approvals", "relay.sock"))).toBe(true)
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(await ask(socketPath, `${JSON.stringify({ message: { kind: "message", parts: [] } })}\n`)).toBe('{"reply":"denied"}\n')
    expect(handle).toHaveBeenCalledWith({ kind: "message", parts: [] })
  })

  it("replaces a socket left behind by an earlier run", async () => {
    tmp = createTmpBundle({ agentName: `stale-${Date.now()}` })
    const socketPath = approvalRelaySocketPath(tmp.agentRoot)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    const leftover = net.createServer()
    await new Promise<void>((resolve) => leftover.listen(socketPath, resolve))
    closers.push(() => new Promise<void>((resolve) => leftover.close(() => resolve())))
    const server = await startApprovalRelaySocket({ socketPath, handle: async () => "expired" })
    closers.push(() => server.close())
    expect(await ask(socketPath, '{"message":{}}\n')).toBe('{"reply":"expired"}\n')
  })

  it("never deletes an ordinary file at the socket path, and fails to start instead", async () => {
    tmp = createTmpBundle({ agentName: `file-${Date.now()}` })
    const socketPath = approvalRelaySocketPath(tmp.agentRoot)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    fs.writeFileSync(socketPath, "keep me")
    await expect(startApprovalRelaySocket({ socketPath, handle: async () => "denied" })).rejects.toThrow(/EADDRINUSE/)
    expect(fs.readFileSync(socketPath, "utf8")).toBe("keep me")
  })

  it.each([
    ["text that isn't JSON", "nope\n"],
    ["a request without a message object", '{"message":[1]}\n'],
    ["a request with no message", "{}\n"],
  ])("refuses %s without calling the handler", async (_label, payload) => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    expect(await ask(socketPath, payload)).toBe('{"reply":"refused:malformed_request"}\n')
    expect(handle).not.toHaveBeenCalled()
  })

  it("refuses a request over 256 KiB", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    const seen = await flood(socketPath, 300 * 1024)
    expect(seen === "" || seen === '{"reply":"refused:malformed_request"}\n').toBe(true)
    expect(handle).not.toHaveBeenCalled()
  })

  it("stops reading and drops a client that keeps streaming past the limit, without stalling", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    const started = Date.now()
    const seen = await flood(socketPath, 16 * 1024 * 1024)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(seen === "" || seen === '{"reply":"refused:malformed_request"}\n').toBe(true)
    expect(handle).not.toHaveBeenCalled()
    // The server still answers the next client at once.
    expect(await ask(socketPath, '{"message":{}}\n')).toBe('{"reply":"denied"}\n')
  })

  it("ignores anything after the request line", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    expect(await ask(socketPath, `{"message":{}}\n{"message":{"second":true}}\n`)).toBe('{"reply":"denied"}\n')
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("reads a request line that arrives in pieces", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle)
    const reply = await new Promise<string>((resolve) => {
      const socket = net.createConnection(socketPath)
      let data = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => { data += chunk })
      socket.on("close", () => resolve(data))
      socket.write('{"mess')
      setTimeout(() => socket.write('age":{"kind":"message"}}\n'), 20)
    })
    expect(reply).toBe('{"reply":"denied"}\n')
    expect(handle).toHaveBeenCalledWith({ kind: "message" })
  })

  it("drops a client that connects and sends nothing", async () => {
    const handle = vi.fn(async () => "denied" as const)
    const socketPath = await listen(handle, 50)
    const reply = await new Promise<string>((resolve) => {
      const socket = net.createConnection(socketPath)
      socket.on("error", () => undefined)
      socket.on("close", () => resolve("closed"))
    })
    expect(reply).toBe("closed")
    expect(handle).not.toHaveBeenCalled()
  })

  it("keeps a connection open while its answer is being decided, past the idle timeout", async () => {
    const socketPath = await listen(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return "denied" }, 50)
    expect(await ask(socketPath, '{"message":{}}\n')).toBe('{"reply":"denied"}\n')
  })

  it("creates the socket file under a umask that leaves it closed to group and other, then puts the umask back", async () => {
    const before = process.umask()
    const umask = vi.spyOn(process, "umask")
    try {
      await listen(async () => "denied")
      expect(umask.mock.calls.map((call) => call[0])).toEqual([0o177, before])
      expect(process.umask()).toBe(before)
    } finally {
      umask.mockRestore()
    }
  })

  it("closes the connection without a reply when deciding fails", async () => {
    const socketPath = await listen(async () => { throw new Error("store unavailable") })
    expect(await ask(socketPath, '{"message":{}}\n')).toBe("")
  })
})

describe("createApprovalRelayDoor", () => {
  it("opens no socket when the switch file isn't in the trust folder", async () => {
    const { agentRoot, relayDeny } = setup({ switchDid: null })
    const door = createApprovalRelayDoor({ agentName: "door", agentRoot, runtime: { relayDeny } })
    await door.start()
    expect(fs.existsSync(approvalRelaySocketPath(agentRoot))).toBe(false)
    await door.stop()
  })

  it("listens when the switch is there, and decides an answer sealed to this agent's identity", async () => {
    const { agentRoot, butler, slugger, relayDeny } = setup()
    const loadIdentity = vi.fn(async () => butler)
    const door = createApprovalRelayDoor({ agentName: path.basename(agentRoot, ".ouro"), agentRoot, runtime: { relayDeny }, loadIdentity })
    closers.push(() => door.stop())
    await door.start()
    await door.start()
    const socketPath = approvalRelaySocketPath(agentRoot)
    // The owner route in agent.json must name Slugger, or the door refuses: here it names nobody yet.
    expect(await ask(socketPath, `${JSON.stringify({ message: sealAnswer(slugger, butler) })}\n`)).toBe('{"reply":"refused:route_mismatch"}\n')
    const configPath = path.join(agentRoot, "agent.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    config.senses = { ...config.senses, telegram: { ...config.senses?.telegram, enabled: true, ownerNoticesTo: { cardUrl: "https://slugger.example/.well-known/agent-card.json", did: slugger.did } } }
    fs.writeFileSync(configPath, JSON.stringify(config))
    expect(await ask(socketPath, `${JSON.stringify({ message: sealAnswer(slugger, butler) })}\n`)).toBe('{"reply":"denied"}\n')
    expect(loadIdentity).toHaveBeenCalledTimes(1)
    await door.stop()
    expect(fs.existsSync(socketPath)).toBe(false)
  })

  it("tries loading its identity again after a failed load", async () => {
    const { agentRoot, butler, slugger, relayDeny } = setup()
    const loadIdentity = vi.fn<() => Promise<DidKeyIdentity>>().mockRejectedValueOnce(new Error("vault locked")).mockResolvedValue(butler)
    const door = createApprovalRelayDoor({ agentName: path.basename(agentRoot, ".ouro"), agentRoot, runtime: { relayDeny }, loadIdentity })
    closers.push(() => door.stop())
    const configPath = path.join(agentRoot, "agent.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    config.senses = { ...config.senses, telegram: { ...config.senses?.telegram, enabled: true, ownerNoticesTo: { cardUrl: "https://slugger.example/.well-known/agent-card.json", did: slugger.did } } }
    fs.writeFileSync(configPath, JSON.stringify(config))
    await door.start()
    const socketPath = approvalRelaySocketPath(agentRoot)
    expect(await ask(socketPath, `${JSON.stringify({ message: sealAnswer(slugger, butler) })}\n`)).toBe("")
    expect(await ask(socketPath, `${JSON.stringify({ message: sealAnswer(slugger, butler) })}\n`)).toBe('{"reply":"denied"}\n')
    expect(loadIdentity).toHaveBeenCalledTimes(2)
  })

  it("logs a failed start and leaves Telegram running", async () => {
    const { agentRoot, relayDeny } = setup()
    const socketPath = approvalRelaySocketPath(agentRoot)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    fs.writeFileSync(socketPath, "an ordinary file")
    const door = createApprovalRelayDoor({ agentName: "door", agentRoot, runtime: { relayDeny } })
    await expect(door.start()).resolves.toBeUndefined()
    await door.stop()
  })
})
