import { afterEach, describe, expect, it } from "vitest"
import * as path from "node:path"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { reportFailureToolDefinition } from "../../repertoire/tools-escalation"
import { setEscalationGrant } from "../../a2a/escalation-grants"
import { FileOutboxStore } from "../../a2a/outbox-store"

let tmp: TmpBundleHandle | null = null
afterEach(() => { tmp?.cleanup(); tmp = null })

const run = (args: Record<string, unknown>, agentRoot?: string, session?: { friendId: string; channel: string; key: string }) =>
  reportFailureToolDefinition.handler(args as never, { ...(agentRoot ? { agentRoot } : {}), ...(session ? { currentSession: { ...session, sessionPath: "/x" } } : {}) } as never) as Promise<string>

async function withPeer() {
  tmp = createTmpBundle({ agentName: `report-tool-${Date.now()}` })
  const store = new FileFriendStore(path.join(tmp.agentRoot, "friends"))
  const peer = await upsertAgentPeer(store, { name: "Claude Code", agentId: "did:key:zC", trustLevel: "family", a2a: { did: "did:key:zC", agentId: "did:key:zC", endpointUrl: "https://c.example/a2a" } })
  await store.put(peer.id, { ...peer, admissionState: "active" })
  return { agentRoot: tmp.agentRoot, peerId: peer.id }
}

describe("report_failure tool", () => {
  it("is shaped for the model: three required fields and a severity enum", () => {
    const fn = reportFailureToolDefinition.tool.function
    expect(fn.name).toBe("report_failure")
    expect(fn.parameters).toMatchObject({ required: ["ari_words", "tried", "error"], additionalProperties: false })
    expect((fn.parameters as { properties: { severity: { enum: string[] } } }).properties.severity.enum).toEqual(["low", "medium", "high"])
  })

  it("tells the model to file at once when asked for something it cannot do, never to ask permission first", () => {
    const description = reportFailureToolDefinition.tool.function.description
    expect(description).toMatch(/file it right away/i)
    expect(description).toMatch(/do not ask his permission before filing/i)
  })

  it("needs an agent runtime", async () => {
    expect(await run({})).toContain("unavailable")
  })

  it("files into the escalation holder's outbox, taking the session from the runtime and defaulting severity", async () => {
    const { agentRoot, peerId } = await withPeer()
    setEscalationGrant(agentRoot, peerId, { grant: true, source: "test", did: "did:key:z6MkHolderOne" })
    const out = JSON.parse(await run({ ari_words: "dim the lights", tried: "searched tools", error: "no lights tool", failed_tool: "lights", severity: "bogus" }, agentRoot, { friendId: "ari", channel: "telegram", key: "chat-1" }))
    expect(out).toMatchObject({ filed: true, duplicate: false, recipients: 1 })
    const entries = new FileOutboxStore(agentRoot).list(peerId).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.body).toContain("telegram/chat-1")
    expect(entries[0]!.body).toContain("(medium)")
    const again = JSON.parse(await run({ ari_words: "dim the lights", tried: "searched tools", error: "no lights tool", failed_tool: "lights", severity: "high" }, agentRoot))
    expect(again.duplicate).toBe(true)
  })

  it("explains why nothing was filed, and treats non-string fields as missing", async () => {
    const { agentRoot } = await withPeer()
    expect(await run({ ari_words: "x", tried: "y", error: "z" }, agentRoot)).toContain("no_escalation_peer")
    expect(await run({ ari_words: 1, tried: null }, agentRoot)).toContain("invalid")
  })
})
