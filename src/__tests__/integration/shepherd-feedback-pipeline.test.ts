import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { FileFriendStore, getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"
import { getAgentRoot, resetIdentity } from "../../heart/identity"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import { executeFeedbackCommand, type FeedbackCommand } from "../../senses/shepherd/feedback-submit"
import { feedbackStorePath, openFeedbackStore } from "../../senses/shepherd/feedback-store"
import { startFeedbackWorker, type FeedbackWorker } from "../../senses/shepherd/feedback-worker"
import { createTeamsNoticeSender } from "../../senses/shepherd/owner-notice"
import { shepherdGuidanceToolDefinitions } from "../../repertoire/tools-shepherd-guidance"
import { readGuidance } from "../../senses/shepherd/guidance"
import { startFakeCmux, type FakeCmux } from "../senses/shepherd/fake-cmux"
import { tree } from "../senses/shepherd/fixtures"
import type { HostSession } from "../../senses/shepherd/host"
import type { TeamsConfig } from "../../heart/config"
import type { ToolContext } from "../../repertoire/tools-base"
import { machineShepherdHost } from "../../senses/shepherd/surface"

// The child has a real controlling PTY while its MCP stdin/stdout remain pipes.
const NATIVE = `
import os, pty, fcntl, termios, json, sys
master, slave = pty.openpty()
os.setsid()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
os.tcsetpgrp(slave, os.getpgrp())
os.set_inheritable(master, True)
os.set_inheritable(slave, True)
os.write(3, (json.dumps({"tty": os.ttyname(slave)}) + "\\n").encode())
os.execv(sys.argv[1], sys.argv[1:])
`
const previousHome = process.env.HOME
const children: ChildProcess[] = []
const workers: FeedbackWorker[] = []
const servers: net.Server[] = []
const cmuxServers: FakeCmux[] = []
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.stop()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
    child.stdin?.end()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await closed
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const server of cmuxServers.splice(0)) await server.close()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  resetIdentity()
  resetRuntimeCredentialConfigCache()
})

interface Frame { id: number; result: { isError: boolean; content: Array<{ text: string }> } }
async function nativeCaller(home: string, agent: string, friendId: string, socket: string) {
  const entry = path.join(home, "native", agent, "copilot", "pkg", "fixture", "bin", "cli-main.js")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  const module = path.resolve(__dirname, "../../../dist/heart/mcp/mcp-server.js")
  // Integration tests run after the normal build, not from a replacement live runtime.
  if (!fs.existsSync(module)) throw new Error("Build the package before the native feedback integration test")
  fs.writeFileSync(entry, `const {createMcpServer}=require(${JSON.stringify(module)});createMcpServer({agent:process.argv[2],friendId:process.argv[3],socketPath:process.argv[4],stdin:process.stdin,stdout:process.stdout}).start();`)
  const child = spawn("python3", ["-c", NATIVE, process.execPath, entry, agent, friendId, socket], {
    cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe", "pipe"],
  })
  children.push(child)
  let metadata = "", output = "", errors = ""
  const frames: Frame[] = []
  child.stdio[3]!.on("data", (chunk: Buffer) => { metadata += chunk.toString() })
  child.stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    let newline: number
    while ((newline = output.indexOf("\n")) >= 0) {
      frames.push(JSON.parse(output.slice(0, newline)))
      output = output.slice(newline + 1)
    }
  })
  child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString() })
  await viWait(() => {
    if (child.exitCode !== null) throw new Error(`Owned native caller exited: ${errors}`)
    return metadata.includes("\n")
  })
  const tty = (JSON.parse(metadata.trim()) as { tty: string }).tty
  let nextId = 0
  return {
    tty,
    async call(name: string, args: Record<string, unknown>): Promise<Frame["result"]> {
      const id = ++nextId
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n")
      await viWait(() => frames.some(frame => frame.id === id))
      return frames.find(frame => frame.id === id)!.result
    },
  }
}
async function viWait(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Owned feedback fixture timed out")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function owner(id: string, aadObjectId: string): FriendRecord {
  return { id, name: "Fixture owner", role: "friend", trustLevel: "family", connections: [],
    externalIds: [{ provider: "local", externalId: os.userInfo().username, linkedAt: "2026-10-15" },
      { provider: "aad", externalId: aadObjectId, tenantId: "fixture-tenant", linkedAt: "2026-10-15" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z", schemaVersion: 1 }
}

describe("owned native session feedback pipeline", () => {
  it("binds two real caller PTYs and two configured agents through durable correction and private Teams receipts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-feedback-"))
    process.env.HOME = home
    resetIdentity()
    const cmux = await startFakeCmux({ capability: "v1.fixture.capability" })
    cmuxServers.push(cmux)
    let sessions: Array<Partial<HostSession> & { id: string; ref: string; title: string }> = []
    cmux.respond("system.tree", () => tree(sessions))
    cmux.respond("surface.read_text", params => ({ text: `Plan written for ${params.surface_id}. Want me to proceed?` }))
    const socket = path.join(home, "feedback.sock")
    const server = net.createServer(connection => {
      let buffer = ""
      connection.on("data", chunk => {
        buffer += chunk.toString()
        const newline = buffer.indexOf("\n")
        if (newline < 0) return
        const command: FeedbackCommand = JSON.parse(buffer.slice(0, newline))
        void executeFeedbackCommand(command).then(response => connection.end(JSON.stringify(response) + "\n"))
          .catch(() => connection.destroy())
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(socket, resolve))
    const profiles = [
      { agent: "native-one", name: "Orchid One", friend: owner(randomUUID(), "fixture-aad-one") },
      { agent: "native-two", name: "Maple Two", friend: owner(randomUUID(), "fixture-aad-two") },
    ]
    const callers = []
    for (const profile of profiles) {
      const root = getAgentRoot(profile.agent)
      fs.mkdirSync(path.join(root, "friends"), { recursive: true })
      fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: profile.name, senses: { shepherd: { enabled: true } } }))
      fs.writeFileSync(path.join(root, "friends", `${profile.friend.id}.json`), JSON.stringify(profile.friend))
      cacheMachineRuntimeCredentialConfig(profile.agent, { cmux: { socketPath: cmux.socketPath, socketCapability: "v1.fixture.capability" } })
      const caller = await nativeCaller(home, profile.agent, profile.friend.id, socket)
      const id = randomUUID()
      sessions.push({ id, ref: `surface:${sessions.length + 1}`, title: `Task for ${profile.name}`, tty: caller.tty })
      callers.push({ ...profile, caller, id, root, requestId: randomUUID() })
    }
    expect(callers[0]!.caller.tty).not.toBe(callers[1]!.caller.tty)
    const discovered = await machineShepherdHost(callers[0]!.agent).list()
    expect(discovered.map(session => session.agent)).toEqual(["Copilot", "Copilot"])
    const feedback = "You should have caught this premature stop. Keep the correction scoped to this session."
    for (const profile of callers) {
      const receipt = await profile.caller.call("shepherd_feedback", { request_id: profile.requestId, feedback })
      expect(receipt.isError, receipt.content[0]?.text).toBe(false)
      expect(receipt.content[0]!.text).toContain(profile.name)
      expect(receipt.content[0]!.text).toContain("follow up in Teams")
      const store = openFeedbackStore(feedbackStorePath(profile.root))
      try {
        expect(store.read(`feedback:${profile.requestId}`, profile.friend.id)?.source).toMatchObject({
          id: profile.id, tty: profile.caller.tty,
        })
      } finally { store.close() }
    }
    const delivered: Array<{ agent: string; recipient: string; text: string }> = []
    for (const profile of callers) {
      const config: TeamsConfig = { clientId: `fixture-bot-${profile.agent}`, clientSecret: "", tenantId: "fixture-tenant", managedIdentityClientId: "" }
      const sender = createTeamsNoticeSender(profile.root, {
        primary: () => config, secondary: () => ({ ...config, clientId: "" }),
        botApi: async () => ({
          id: config.clientId,
          conversations: {
            create: async (params: { members: Array<{ id: string }> }) => {
              expect(params.members.map(member => member.id)).toEqual([profile.friend.externalIds[1]!.externalId])
              return { id: `private-${profile.agent}` }
            },
            activities: (conversation: string) => ({
              create: async (message: { text: string }) => {
                expect(conversation).toBe(`private-${profile.agent}`)
                delivered.push({ agent: profile.agent, recipient: profile.friend.id, text: message.text })
                return { id: `activity-${profile.agent}` }
              },
            }),
          },
        }),
      })
      const worker = startFeedbackWorker({
        agent: profile.agent, agentRoot: profile.root, now: Date.now, schedule: () => () => {},
        friendStore: new FileFriendStore(path.join(profile.root, "friends")), send: sender,
        run: async options => {
          const prepared = await options.prepareRunAgentOptions!({
            messages: [], currentUserMessages: [], activeCares: [], careEvidenceNow: 0,
            resolvedContext: { friend: profile.friend, channel: getChannelCapabilities("mcp") },
            runAgentOptions: { toolContext: { signin: async () => undefined, agentName: profile.agent, agentRoot: profile.root,
              context: { friend: profile.friend, channel: getChannelCapabilities("mcp") } } },
          })
          if (!prepared?.toolContext) throw new Error("Missing native feedback policy")
          const correct = shepherdGuidanceToolDefinitions.find(definition => definition.tool.function.name === "shepherd_correct")!
          const result = JSON.parse(await correct.handler({ request_id: profile.requestId, feedback,
            principle: "Finish this session's authorized work instead of stopping at a plan." }, prepared.toolContext as ToolContext))
          expect(result.revision).toBe(1)
          const response = "I recorded a session-only correction. Should the same preference apply to the whole project?"
          return { response, ponderDeferred: false, turnOutcome: "settled", deliveries: [{ kind: "settle", text: response }], deliveryFailures: [] }
        },
      })
      workers.push(worker)
      await worker.drain()
      await worker.drain()
      const status = await profile.caller.call("shepherd_feedback_status", { request_id: profile.requestId })
      expect(status.isError).toBe(false)
      expect(JSON.parse(status.content[0]!.text)).toMatchObject({ review: "complete", delivery: "sent" })
      expect(readGuidance(profile.root).principles).toMatchObject([{ scope: "session", target: { session: profile.id } }])
    }
    expect(delivered).toHaveLength(2)
    expect(delivered[0]!.text).toContain("Orchid One")
    expect(delivered[0]!.text).not.toContain("Maple Two")
    expect(delivered[1]!.text).toContain("Maple Two")
    expect(delivered[1]!.text).not.toContain("Orchid One")
    expect(cmux.methods.some(entry => ["terminal.paste", "surface.send_key", "surface.send_text", "notification.create"].includes(entry.method))).toBe(false)
    // A stored receipt/status does not require continued native source availability.
    sessions = []
    const retried = await callers[0]!.caller.call("shepherd_feedback", { request_id: callers[0]!.requestId, feedback })
    expect(retried.isError).toBe(false)
    expect(delivered).toHaveLength(2)
  })
})
