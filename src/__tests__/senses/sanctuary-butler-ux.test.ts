import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"

import { readActiveCares } from "../../arc/cares"
import { writeHabitRunReceipt } from "../../arc/flight-recorder"
import { patchRuntimeConfig, resetConfigCache } from "../../heart/config"
import { runAgent, type ProviderRuntime, type RunAgentOptions, type ToolCallBoundaryReceipt } from "../../heart/core"
import { loadAgentConfig, resetIdentity, setAgentConfigOverride, setAgentName } from "../../heart/identity"
import * as runtimeCredentials from "../../heart/runtime-credentials"
import { loadSessionEnvelopeFile } from "../../heart/session-events"
import { parseAwaitFile } from "../../heart/awaiting/await-parser"
import { saveSession } from "../../mind/context"
import { getPendingDir } from "../../mind/pending"
import { resolveDeskRecordPaths } from "../../mind/record-paths"
import { McpManager } from "../../repertoire/mcp-manager"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry, resolveProfileScopedRelationshipAuthorization } from "../../repertoire/relationship-authorization"
import { execTool, getToolsForChannel, resolveToolDefinition } from "../../repertoire/tools"
import * as nervesRuntime from "../../nerves/runtime"
import { getShellSession, listShellSessions, tailShellSession } from "../../repertoire/shell-sessions"
import { createSanctuaryToolContext } from "../../senses/sanctuary-runtime"
import { getSenseSessionPath, runSenseTurn } from "../../senses/shared-turn"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, readOrCreateTelegramIdentityKey } from "../../senses/telegram"
import type { TelegramLongPollOptions } from "../../senses/telegram-client"
import { SANCTUARY_OWNER_ADDITIONS } from "../fixtures/sanctuary-containment"

const identityTestState = vi.hoisted(() => ({ agentRoot: null as string | null }))

vi.mock("../../heart/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/identity")>()
  return {
    ...actual,
    getAgentRoot: (agentName?: string) => identityTestState.agentRoot ?? actual.getAgentRoot(agentName),
    getAgentStateRoot: (agentName?: string) => identityTestState.agentRoot === null ? actual.getAgentStateRoot(agentName) : path.join(identityTestState.agentRoot, "state"),
  }
})

vi.mock("../../heart/daemon/socket-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/daemon/socket-client")>(),
  sendDaemonCommand: vi.fn(async () => ({ ok: true })),
  checkDaemonSocketAlive: vi.fn(async () => false),
  requestPrivateWake: vi.fn(async () => null),
  requestInnerWake: vi.fn(async () => null),
}))

const bundleRoot = path.resolve("deploy/unraid/sanctuary.ouro")
const transcriptPath = path.resolve("src/__tests__/fixtures/sanctuary-butler-transcripts.json")

type VoiceMode = "casual" | "recommendation" | "incident"

type Transcript = { id: string; voice: VoiceMode; audience: "owner" | "family"; user: string; reply: string; tools: string[]; evidence?: { pending?: number; opportunities?: number; queueError?: string; notifications?: string[] } }

function psyche(name: string): string {
  return fs.readFileSync(path.join(bundleRoot, "psyche", `${name}.md`), "utf8")
}

const rootsToRemove: string[] = []
const RESIDENT_OWNER = "11111111-1111-4111-8111-111111111111"
const RESIDENT_HOUSEHOLD = "22222222-2222-4222-8222-222222222222"
const RESIDENT_REPLY = "the resident checks are complete"

function residentCall(name: string, args: Record<string, unknown> = {}, id = name) {
  return { id, name, arguments: JSON.stringify(args) }
}

function deniedResidentCalls(root: string) {
  const file = path.join(root, "never-created.txt")
  const args: Record<string, Record<string, unknown>> = {
    shell: { command: "printf forbidden", background: false }, shell_status: {}, shell_tail: { id: "forbidden-session" },
    read_file: { path: file }, write_file: { path: file, content: "forbidden" },
    edit_file: { path: file, old_string: "before", new_string: "after" }, glob: { cwd: root, pattern: "*.txt" }, grep: { path: root, pattern: "forbidden" },
    web_search: { query: "forbidden" }, search_facts: { query: "resident" }, consult_diary: {}, consult_notes: { query: "resident" },
    get_friend_note: { friendId: RESIDENT_OWNER }, session_summary: { runId: "resident-run" },
    query_session: { friendId: RESIDENT_OWNER, channel: "cli", key: "resident-target" }, set_reasoning_effort: { level: "high" },
    restart_runtime: { reason: "resident recovery fixture" }, revive_sense: { sense: "telegram", reason: "resident recovery fixture" },
  }
  expect(Object.keys(args).toSorted()).toEqual([...SANCTUARY_OWNER_ADDITIONS].toSorted())
  return SANCTUARY_OWNER_ADDITIONS.map((name) => residentCall(name, args[name]))
}

function residentRuntime(script: (step: number) => Promise<ReturnType<typeof residentCall>[]> | ReturnType<typeof residentCall>[], reasoning = true) {
  const outputs = new Map<string, string>()
  const requests: Array<{ names: string[]; reasoningEffort?: string }> = []
  const runtime: ProviderRuntime = {
    id: "minimax", model: "MiniMax-M3", client: null,
    capabilities: new Set(reasoning ? ["reasoning-effort"] : []),
    supportedReasoningEfforts: reasoning ? ["high"] : [],
    streamTurn: async (request) => {
      requests.push({ names: request.activeTools.map((tool) => tool.function.name), reasoningEffort: request.reasoningEffort })
      return { content: "", toolCalls: await script(requests.length), outputItems: [] }
    },
    appendToolOutput: (id, output) => { outputs.set(id, output) },
    resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  }
  return { runtime, outputs, requests }
}

async function residentFixture() {
  const events = vi.spyOn(nervesRuntime, "emitNervesEvent")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-resident-"))
  rootsToRemove.push(root)
  identityTestState.agentRoot = root
  setAgentName("sanctuary")
  resetConfigCache()
  fs.cpSync(bundleRoot, root, { recursive: true })
  setAgentConfigOverride(loadAgentConfig({ agentName: "sanctuary", agentRoot: root }))
  patchRuntimeConfig({ integrations: { perplexityApiKey: "resident-search-key", openaiEmbeddingsApiKey: "resident-embedding-key" } })
  const store = new FileFriendStore(path.join(root, "friends"))
  for (const [profile, id, externalId] of [["sanctuary-owner", RESIDENT_OWNER, "42"], ["sanctuary-household", RESIDENT_HOUSEHOLD, "888"]] as const) {
    await store.put(id, {
      ...relationshipFriend(profile), id,
      externalIds: [{ provider: "telegram-user", externalId, tenantId: "777", linkedAt: "2026-09-10T00:00:00.000Z" }],
      notes: { resident: { value: "resident friend marker", savedAt: "2026-09-10T00:00:00.000Z" } },
    })
  }
  const records = resolveDeskRecordPaths(root)
  fs.mkdirSync(records.notesRoot, { recursive: true })
  fs.mkdirSync(records.diaryRoot, { recursive: true })
  fs.writeFileSync(path.join(records.notesRoot, "resident.md"), "resident note marker\n")
  fs.writeFileSync(records.factsPath, `${JSON.stringify({ id: "resident-fact", text: "resident diary marker", source: "fixture", createdAt: "2026-09-10T00:00:00.000Z", embedding: [] })}\n`)
  const transcriptPath = getSenseSessionPath("sanctuary", RESIDENT_OWNER, "cli", "resident-target", root)
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
  saveSession(transcriptPath, [{ role: "user", content: "resident transcript marker" }, { role: "assistant", content: "resident prior answer" }])
  writeHabitRunReceipt(root, {
    schemaVersion: 2, runId: "resident-run", sessionId: "resident-run", habitName: "resident-check", trigger: "manual",
    startedAt: "2026-09-10T00:00:00.000Z", endedAt: "2026-09-10T00:00:01.000Z", outcome: "no_change",
    definitionLocator: "habits/resident-check.md", sessionLocator: "state/habit-sessions/resident-run/session.json",
    pendingLocator: "state/habit-sessions/resident-run/pending", runtimeStateLocator: "state/habits/resident-check.json",
    receiptLocator: "arc/flight-recorder/habit-receipts/resident-run.json", nextRunAt: null,
    permissionEnvelope: { schemaVersion: 1, canMessageOutward: false, returnRoutes: [], deniedTools: [], warnings: [] },
    toolPolicy: { requestedTools: null, grantedTools: [], deniedTools: [], outwardMessagingAllowed: false },
    summarySnapshot: { summary: "resident habit marker", decisions: [], nextLikelyStep: null },
    producedRefs: [], surfaceAttempts: [], traceSteps: [], errors: [],
  })
  vi.spyOn(runtimeCredentials, "readMachineRuntimeCredentialConfig").mockReturnValue({
    ok: true, itemPath: "vault:resident-fixture", revision: "fixture", updatedAt: "2026-09-10T00:00:00.000Z",
    config: { unraidGraphqlUrl: "https://sanctuary.invalid/graphql", unraidReadApiKey: "resident-read-key" },
  })
  const http = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "https://api.perplexity.ai/search") return Response.json({ results: [{ title: "resident web marker", url: "https://example.invalid/resident", snippet: "controlled current search result" }] })
    if (String(url) === "https://api.openai.com/v1/embeddings") {
      const request = JSON.parse(String(init?.body))
      return Response.json({ data: request.input.map(() => ({ embedding: [1, 0] })) })
    }
    if (String(url) === "https://sanctuary.invalid/graphql") return Response.json({ data: {
      vars: { id: `${"a".repeat(64)}:vars`, name: "Sanctuary", version: "7.2.3" },
      info: { os: { uptime: 10 }, versions: { core: { unraid: "7.2.3", api: "4.37.1" } } }, array: { state: "STARTED" },
    } })
    throw new Error(`unexpected resident fixture HTTP request: ${String(url)}`)
  })
  vi.stubGlobal("fetch", http)
  const native = createSanctuaryToolContext("sanctuary")
  const credentials = { botToken: "777:resident-fixture", authorizedUserId: "42", authorizedChatId: "42" }
  const identityKey = readOrCreateTelegramIdentityKey(root)
  const receipts: ToolCallBoundaryReceipt[] = []
  const summarize = vi.fn(async (transcript: string, _instruction: string) => transcript)
  const runTelegram = async (profile: "sanctuary-owner" | "sanctuary-household", runtime: ProviderRuntime, augment?: (options: RunAgentOptions) => Partial<RunAgentOptions>) => {
    let poll!: TelegramLongPollOptions
    let result: Awaited<ReturnType<typeof runSenseTurn>> | undefined
    const api = { request: vi.fn(async (method: string) => method === "sendMessage" ? { message_id: 100 } : true), stop: vi.fn() }
    const composition = await createProductionTelegramRelationshipComposition("sanctuary", credentials, root)
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials, identityKey, _agentRoot: root, ...composition, api,
      _toolContext: native,
      offsetStore: { load: () => 0, save: vi.fn() }, migrateIdentity: async () => undefined, acceptanceMarker: () => null,
      createLongPoll: (options) => { poll = options; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      _createInteractiveControl: () => ({ socketPath: path.join(root, "unused.sock"), start: async () => undefined, stop: async () => undefined }),
      _runTurn: async (options) => {
        if (!options.prepareRunAgentOptions) throw new Error("production Telegram authority preparation is missing")
        const prepare = options.prepareRunAgentOptions
        result = await runSenseTurn({
          ...options, latencyMode: "live",
          prepareRunAgentOptions: async (input) => {
            const prepared = await prepare(input)
            if (prepared?.toolContext?.relationshipAuthorization?.profileId !== profile) throw new Error("unexpected production Telegram role")
            return { ...prepared, toolContext: { ...prepared.toolContext!, summarize }, providerRuntimeOverride: runtime, skipKeptNotes: true, toolBoundaryObserver: (receipt) => receipts.push(receipt), ...augment?.(prepared) }
          },
        })
        return result
      },
    })
    try {
      if (profile === "sanctuary-owner") await poll.onMessage({ updateId: 10, messageId: "20", userId: "42", chatId: "42", text: "perform the resident fixture steps" })
      else await poll.onUnknownMessage!({ updateId: 11, messageId: 21, botId: "777", userId: "888", chatId: "888", text: "perform the resident fixture steps", displayLabel: "Household", hasAttachments: false })
      return { api, result }
    } finally { await app.stop() }
  }
  const runEventProfile = async (runtime: ProviderRuntime, augment?: (options: RunAgentOptions) => Partial<RunAgentOptions>) => {
    const resolve = () => resolveProfileScopedRelationshipAuthorization({
      store, registry: loadRelationshipCapabilityRegistry(root), relationshipProfileId: "sanctuary-owner", profileId: "sanctuary-event",
    })
    const authorization = await resolve()
    const options: RunAgentOptions = {
      skipKeptNotes: true, providerRuntimeOverride: runtime, toolBoundaryObserver: (receipt) => receipts.push(receipt),
      toolContext: {
        ...native, signin: async () => undefined, agentName: "sanctuary", agentRoot: root,
        relationshipAuthorization: {
          profileId: authorization.profileId, authorizedContextScopes: authorization.authorizedContextScopes,
          advertisedToolNames: authorization.advertisedToolNames, authorizeTool: async (name) => (await resolve()).authorizeTool(name),
        },
      },
    }
    return runAgent([{ role: "user", content: "audit the resident event profile" }], {
      onModelStart: () => undefined, onModelStreamStart: () => undefined, onTextChunk: () => undefined, onReasoningChunk: () => undefined,
      onToolStart: () => undefined, onToolEnd: () => undefined, onError: () => undefined,
    }, "inner", undefined, { ...options, ...augment?.(options) })
  }
  return { root, store, native, http, receipts, summarize, runTelegram, runEventProfile, errors: () => events.mock.calls.map(([event]) => event).filter((event) => event.level === "error") }
}

function relationshipFriend(profile: "sanctuary-owner" | "sanctuary-household"): FriendRecord {
  return {
    id: profile === "sanctuary-owner" ? "ari" : "household-member",
    name: profile === "sanctuary-owner" ? "Ari" : "Household member",
    trustLevel: profile === "sanctuary-owner" ? "family" : "friend",
    admissionState: "active",
    initiativePolicy: profile === "sanctuary-owner" ? "proactive" : "request_follow_up_only",
    capabilityProfileId: profile,
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", schemaVersion: 1,
  }
}

function realToolContext(profile: "sanctuary-owner" | "sanctuary-household", agentRoot = identityTestState.agentRoot ?? bundleRoot) {
  const registry = loadRelationshipCapabilityRegistry(bundleRoot)
  const friend = relationshipFriend(profile)
  const evaluator = createRelationshipAuthorizationEvaluator({
    friend,
    registry,
    requestId: "telegram-request-1",
    requestPhase: "inbound",
    sessionEventId: "telegram-session-event-1",
  })
  return {
    evaluator,
    context: {
      signin: async () => undefined,
      agentName: "sanctuary",
      agentRoot,
      relationshipAuthorization: evaluator,
      currentSession: { friendId: friend.id, channel: "telegram", key: `telegram:${friend.id}`, sessionPath: "" },
    },
  }
}

describe("Mendelow Cloud Butler household UX", () => {
  afterEach(async () => {
    for (const root of rootsToRemove) {
      const owner = { agentName: "sanctuary", agentRoot: root }
      if (listShellSessions(owner).some((session) => session.status === "running")) {
        fs.writeFileSync(path.join(root, "resident-release"), "release")
        await vi.waitFor(() => expect(listShellSessions(owner).every((session) => session.status === "exited")).toBe(true))
      }
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetConfigCache()
    identityTestState.agentRoot = null
    resetIdentity()
    while (rootsToRemove.length > 0) fs.rmSync(rootsToRemove.pop()!, { recursive: true, force: true })
  })

  it.each([true, false])("A001a executes real owner shell, files, web, records and sessions through Telegram with reasoning=%s", async (reasoning) => {
    const fixture = await residentFixture()
    const file = path.join(fixture.root, "scratch", "resident.txt")
    const owner = { agentName: "sanctuary", agentRoot: fixture.root }
    const spies = new Map(SANCTUARY_OWNER_ADDITIONS.map((name) => [name, vi.spyOn(resolveToolDefinition(name)!, "handler")]))
    for (const name of ["restart_runtime", "revive_sense"]) spies.get(name)!.mockImplementation(async () => { throw new Error(`production ${name} must not run`) })
    const message = vi.spyOn(resolveToolDefinition("send_message")!, "handler")
    const background = `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const fs=require("node:fs");console.log(Array.from({length:240},(_,i)=>"resident line "+i).join("\\n"));console.log("resident-background");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(fixture.root, "resident-release"))}))clearInterval(timer)},10)`)}`
    const scripted = residentRuntime(async (step) => {
      if (step === 1) return [
        residentCall("write_file", { path: file, content: "resident-original\n" }),
        residentCall("shell", { command: `cd ${JSON.stringify(fixture.root)} && printf 'resident-foreground\\n' && pwd`, background: false }, "foreground"),
        residentCall("shell", { command: background, background: true }, "background"),
      ]
      if (step === 2) {
        const { id } = JSON.parse(scripted.outputs.get("background")!)
        await vi.waitFor(() => expect(tailShellSession(id, owner)).toContain("resident-background"))
        expect(getShellSession(id, owner)?.status).toBe("running")
        return [
          residentCall("read_file", { path: file }),
          residentCall("shell_status", { id }), residentCall("shell_tail", { id }),
        ]
      }
      if (step === 3) return [
          residentCall("edit_file", { path: file, old_string: "resident-original", new_string: "resident-updated" }),
          residentCall("glob", { cwd: path.dirname(file), pattern: "*.txt" }),
          residentCall("grep", { path: path.dirname(file), pattern: "resident-updated", include: "*.txt" }),
          residentCall("web_search", { query: "resident web query" }),
          residentCall("search_facts", { query: "resident diary" }), residentCall("consult_diary", {}),
          residentCall("consult_notes", { query: "resident note" }), residentCall("get_friend_note", { friendId: RESIDENT_OWNER }),
          residentCall("session_summary", { runId: "resident-run" }),
          residentCall("query_session", { friendId: RESIDENT_OWNER, channel: "cli", key: "resident-target" }),
          residentCall("send_message", { friendId: RESIDENT_OWNER, channel: "cli", key: "resident-target", content: "resident queued message" }),
        ]
      if (step === 4) return [residentCall("set_reasoning_effort", { level: "high" })]
      if (step === 5) return [residentCall("settle", { answer: RESIDENT_REPLY, intent: "complete" })]
      throw new Error("resident fixture exceeded its expected provider calls")
    }, reasoning)
    const { api, result } = await fixture.runTelegram("sanctuary-owner", scripted.runtime)
    expect(result?.turnOutcome, JSON.stringify(fixture.errors())).toBe("settled")
    expect(scripted.requests).toHaveLength(5)
    const expectedNames = loadRelationshipCapabilityRegistry(bundleRoot).profiles["sanctuary-owner"].toolNames.filter((name) => name !== "rest" && (reasoning || name !== "set_reasoning_effort"))
    for (const request of scripted.requests) expect(request.names.toSorted()).toEqual(expectedNames.toSorted())
    expect.soft(scripted.requests[4].reasoningEffort, JSON.stringify([...scripted.outputs])).toBe(reasoning ? "high" : scripted.requests[0].reasoningEffort)
    expect(scripted.outputs.get("foreground")).toContain("resident-foreground")
    expect(scripted.outputs.get("foreground")).toContain(fixture.root)
    expect(JSON.parse(scripted.outputs.get("background")!)).toMatchObject({ status: "running" })
    expect(JSON.parse(scripted.outputs.get("shell_status")!).pid).toBeGreaterThan(0)
    expect(JSON.parse(scripted.outputs.get("shell_status")!).output.length).toBeLessThanOrEqual(200)
    expect(JSON.parse(scripted.outputs.get("shell_status")!)).not.toHaveProperty("owner")
    expect(scripted.outputs.get("shell_tail")).toContain("resident-background")
    expect(fs.readFileSync(file, "utf8")).toBe("resident-updated\n")
    expect(scripted.outputs.get("read_file")).toBe("resident-original\n")
    expect(scripted.outputs.get("glob")).toBe("resident.txt")
    expect(scripted.outputs.get("grep")).toContain("resident-updated")
    expect(scripted.outputs.get("web_search")).toContain("resident web marker")
    expect(scripted.outputs.get("search_facts")).toContain("resident diary marker")
    expect(scripted.outputs.get("consult_diary")).toContain("resident diary marker")
    expect(scripted.outputs.get("consult_notes")).toContain("resident note marker")
    expect(scripted.outputs.get("get_friend_note")).toContain("resident friend marker")
    expect.soft(scripted.outputs.get("session_summary")).toContain("resident habit marker")
    expect.soft(scripted.outputs.get("query_session")).toContain("resident transcript marker")
    expect.soft(fixture.summarize).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("resident transcript marker"), expect.stringContaining("family"))
    expect.soft(scripted.outputs.get("send_message")).toContain("queued")
    const pending = getPendingDir("sanctuary", RESIDENT_OWNER, "cli", "resident-target")
    expect(fs.readdirSync(pending)).toHaveLength(1)
    expect(fs.readFileSync(path.join(pending, fs.readdirSync(pending)[0]), "utf8")).toContain("resident queued message")
    expect(fs.existsSync(path.join(fixture.root, "state", "bridges"))).toBe(true)
    for (const [name, spy] of spies) expect(spy, name).toHaveBeenCalledTimes(["restart_runtime", "revive_sense"].includes(name) || (name === "set_reasoning_effort" && !reasoning) ? 0 : name === "shell" ? 2 : 1)
    expect(message).toHaveBeenCalledOnce()
    expect(fixture.http.mock.calls.filter(([url]) => String(url) === "https://api.perplexity.ai/search")).toEqual([[
      "https://api.perplexity.ai/search",
      { method: "POST", headers: { Authorization: "Bearer resident-search-key", "Content-Type": "application/json" }, body: JSON.stringify({ query: "resident web query", max_results: 5 }) },
    ]])
    expect(api.request.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([["sendMessage", { chat_id: "42", text: RESIDENT_REPLY, parse_mode: "HTML" }, undefined]])
    const envelope = loadSessionEnvelopeFile(result!.sessionPath!)!
    const delivered = envelope.events.filter((event) => event.role === "assistant" && event.relations.references.includes("telegram-message:100"))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].toolCalls).toMatchObject([{ function: { name: "settle", arguments: JSON.stringify({ answer: RESIDENT_REPLY, intent: "complete" }) } }])
    expect(delivered[0].provenance.captureKind).toBe("live")
    expect(fixture.errors()).toEqual([])
    expect(fixture.receipts.filter((receipt) => receipt.name === "set_reasoning_effort")).toEqual([{
      name: "set_reasoning_effort", reason: reasoning ? "dispatched" : "profile_excluded", globallyResolvable: true, invoked: reasoning, sideEffect: reasoning,
    }])
  })

  it.each([
    ["sanctuary-household", false], ["sanctuary-household", true], ["sanctuary-event", false], ["sanctuary-event", true],
  ] as const)("A001a preserves real %s reads while rejecting every owner addition with poisoned context=%s", async (profile, poisoned) => {
    const fixture = await residentFixture()
    const spies = SANCTUARY_OWNER_ADDITIONS.map((name) => {
      const spy = vi.spyOn(resolveToolDefinition(name)!, "handler")
      if (name === "restart_runtime" || name === "revive_sense") spy.mockImplementation(async () => { throw new Error("production recovery must not run") })
      return spy
    })
    const read = vi.spyOn(resolveToolDefinition("unraid_get_system")!, "handler")
    const scripted = residentRuntime((step) => {
      if (step === 1) return deniedResidentCalls(fixture.root)
      if (step === 2) return [residentCall("unraid_get_system")]
      if (step === 3) return [profile === "sanctuary-event" ? residentCall("rest", { note: "event profile audit complete" }) : residentCall("settle", { answer: RESIDENT_REPLY, intent: "complete" })]
      throw new Error("role fixture exceeded its expected provider calls")
    })
    const augment = (options: RunAgentOptions) => poisoned ? {
      toolContext: { ...options.toolContext!, relationshipAuthorization: {
        ...options.toolContext!.relationshipAuthorization!,
        advertisedToolNames: [...options.toolContext!.relationshipAuthorization!.advertisedToolNames, ...SANCTUARY_OWNER_ADDITIONS],
      } },
    } : {}
    if (profile === "sanctuary-event") expect((await fixture.runEventProfile(scripted.runtime, augment)).outcome).toBe("rested")
    else expect((await fixture.runTelegram(profile, scripted.runtime, augment)).result?.turnOutcome, JSON.stringify(fixture.errors())).toBe("settled")
    for (const request of scripted.requests) expect(request.names.toSorted()).toEqual(loadRelationshipCapabilityRegistry(bundleRoot).profiles[profile].toolNames.toSorted())
    expect(fixture.receipts.slice(0, SANCTUARY_OWNER_ADDITIONS.length)).toEqual(SANCTUARY_OWNER_ADDITIONS.map((name) => ({
      name, reason: "profile_excluded", globallyResolvable: true, invoked: false, sideEffect: false,
    })))
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledOnce()
    expect(JSON.parse(scripted.outputs.get("unraid_get_system")!)).toMatchObject({ ok: true, data: { sourceIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    expect(fixture.http).toHaveBeenCalledOnce()
    expect(String(fixture.http.mock.calls[0][0])).toBe("https://sanctuary.invalid/graphql")
    expect(fs.existsSync(path.join(fixture.root, "never-created.txt"))).toBe(false)
  })

  it.each(["sanctuary-household", "sanctuary-event"] as const)("A001a rejects a supplied owner schema and executor before the %s provider runs", async (profile) => {
    const fixture = await residentFixture()
    const shell = vi.spyOn(resolveToolDefinition("shell")!, "handler")
    const executor = vi.fn(async () => "must not execute")
    const scripted = residentRuntime(() => [residentCall("shell", { command: "printf forbidden" })])
    const augment = (options: RunAgentOptions): Partial<RunAgentOptions> => ({
      tools: [...getToolsForChannel(profile === "sanctuary-event" ? "inner" : "telegram", undefined, undefined, undefined, undefined, undefined, options.toolContext), resolveToolDefinition("shell")!.tool],
      execTool: executor,
    })
    if (profile === "sanctuary-event") expect(await fixture.runEventProfile(scripted.runtime, augment)).toMatchObject({
      outcome: "errored", error: { message: "tool selection is not a canonical reduction: shell" },
    })
    else expect((await fixture.runTelegram(profile, scripted.runtime, augment)).result).toMatchObject({
      turnOutcome: "errored", providerInvocationCount: 0, toolInvocationCount: 0,
    })
    expect(fixture.errors()).toEqual(expect.arrayContaining([expect.objectContaining({ event: "engine.error", message: "tool selection is not a canonical reduction: shell" })]))
    expect(scripted.requests).toEqual([])
    expect(executor).not.toHaveBeenCalled()
    expect(shell).not.toHaveBeenCalled()
    expect(fixture.http).not.toHaveBeenCalled()
  })

  it("A001a reaches only isolated recovery executors after real owner authorization", async () => {
    const fixture = await residentFixture()
    const names = ["restart_runtime", "revive_sense"]
    const spies = names.map((name) => vi.spyOn(resolveToolDefinition(name)!, "handler").mockImplementation(async () => { throw new Error("production recovery must not run") }))
    const executor = vi.fn<NonNullable<RunAgentOptions["execTool"]>>(async (name, args, context) => {
      expect(context?.agentName).toBe("sanctuary")
      expect(context?.agentRoot).toBe(fixture.root)
      expect(context?.relationshipAuthorization?.profileId).toBe("sanctuary-owner")
      expect((await context!.relationshipAuthorization!.authorizeTool(name, args)).allowed).toBe(true)
      return `isolated authorized ${name}`
    })
    const scripted = residentRuntime((step) => {
      if (step === 1) return deniedResidentCalls(fixture.root).filter((call) => names.includes(call.name))
      if (step === 2) return [residentCall("settle", { answer: RESIDENT_REPLY, intent: "complete" })]
      throw new Error("recovery fixture exceeded its expected provider calls")
    })
    expect((await fixture.runTelegram("sanctuary-owner", scripted.runtime, () => ({ execTool: executor }))).result?.turnOutcome, JSON.stringify(fixture.errors())).toBe("settled")
    expect(executor.mock.calls.map(([name]) => name)).toEqual(names)
    for (const name of names) expect(scripted.outputs.get(name)).toBe(`isolated authorized ${name}`)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it("A001a binds an exact owner MCP tool to a real scoped client and denies it to household and event profiles", async () => {
    const fixture = await residentFixture()
    const registryFile = path.join(fixture.root, "tool-profiles.json")
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"))
    registry.profiles["sanctuary-owner"].toolNames.push("resident_echo")
    fs.writeFileSync(registryFile, JSON.stringify(registry))
    const protocolFile = path.join(fixture.root, "mcp-requests.jsonl")
    const pidFile = path.join(fixture.root, "mcp-pid")
    const script = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      require("node:readline").createInterface({input: process.stdin}).on("line", line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(protocolFile)}, JSON.stringify(request) + "\\n");
        if (request.id === undefined) return;
        const result = request.method === "initialize"
          ? {protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"resident", version:"1"}}
          : request.method === "tools/list"
            ? {tools:[{name:"echo", description:"isolated resident echo", inputSchema:{type:"object", properties:{value:{type:"string"}}, required:["value"], additionalProperties:false}}]}
            : request.method === "tools/call" && request.params.name === "echo"
              ? {content:[{type:"text", text:JSON.stringify({marker:"resident MCP", value:request.params.arguments.value})}]}
              : null;
        process.stdout.write(JSON.stringify({jsonrpc:"2.0", id:request.id, ...(result ? {result} : {error:{code:-32601,message:"unexpected fixture method"}})}) + "\\n");
      });
    `
    const manager = new McpManager()
    const dispatch = vi.spyOn(manager, "callTool")
    try {
      const view = await manager.reconcile({ agentName: "sanctuary", agentRoot: fixture.root }, { resident: { command: process.execPath, args: ["-e", script], cwd: fixture.root } })
      expect(view, JSON.stringify(fixture.errors())).not.toBeNull()
      const augment = () => ({ mcpManager: view! })
      const owner = residentRuntime((step) => {
        if (step === 1) return [residentCall("resident_echo", { value: "owner marker" })]
        if (step === 2) return [residentCall("settle", { answer: RESIDENT_REPLY, intent: "complete" })]
        throw new Error("MCP owner fixture exceeded its expected provider calls")
      })
      expect((await fixture.runTelegram("sanctuary-owner", owner.runtime, augment)).result?.turnOutcome).toBe("settled")
      expect(owner.requests[0].names).toContain("resident_echo")
      expect(owner.outputs.get("resident_echo")).toContain("resident MCP")
      for (const profile of ["sanctuary-household", "sanctuary-event"] as const) {
        const denied = residentRuntime((step) => {
          if (step === 1) return [residentCall("resident_echo", { value: "forbidden" })]
          if (step === 2) return [residentCall("unraid_get_system")]
          if (step === 3) return [profile === "sanctuary-event" ? residentCall("rest", { note: "MCP profile audit complete" }) : residentCall("settle", { answer: RESIDENT_REPLY, intent: "complete" })]
          throw new Error("MCP role fixture exceeded its expected provider calls")
        })
        if (profile === "sanctuary-event") expect((await fixture.runEventProfile(denied.runtime, augment)).outcome).toBe("rested")
        else expect((await fixture.runTelegram(profile, denied.runtime, augment)).result?.turnOutcome).toBe("settled")
        for (const request of denied.requests) expect(request.names).not.toContain("resident_echo")
        expect(JSON.parse(denied.outputs.get("unraid_get_system")!).ok).toBe(true)
      }
      expect(dispatch).toHaveBeenCalledOnce()
      const calls = fs.readFileSync(protocolFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(calls.filter((call) => call.method === "tools/call").map((call) => call.params)).toEqual([{ name: "echo", arguments: { value: "owner marker" } }])
    } finally {
      await manager.shutdown()
      if (fs.existsSync(pidFile)) await vi.waitFor(() => expect(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0)).toThrow(/ESRCH/u))
    }
  })

  it("serves Ari and approved household members without requiring the internal server name", () => {
    expect(psyche("IDENTITY")).toContain("Mendelow Cloud Butler")
    expect(psyche("IDENTITY")).toContain("approved household members")
    expect(psyche("IDENTITY")).toContain("People do not need to say Sanctuary")
    expect(psyche("IDENTITY")).not.toContain("serve one trusted operator")
    const agentConfig = JSON.parse(fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf8")) as { phrases: Record<string, string[]> }
    expect(agentConfig.phrases).toMatchObject({
      thinking: expect.arrayContaining(["consulting the household machinery"]),
      tool: expect.arrayContaining(["checking the troublesome little machine"]),
      followup: expect.arrayContaining(["returning with the tray"]),
    })
    for (const [name, phrases] of Object.entries(agentConfig.phrases)) {
      expect(phrases.length, name).toBeGreaterThanOrEqual(4)
      expect(new Set(phrases).size, name).toBe(phrases.length)
      for (const phrase of phrases) {
        expect(phrase, `${name}: ${phrase}`).toMatch(/^[a-z]/u)
        expect(phrase, `${name}: ${phrase}`).not.toMatch(/[.!?]$/u)
      }
    }
  })

  it("has an original playful, perceptive personality without borrowing Cradle names or catchphrases", () => {
    const soul = psyche("SOUL")
    expect(soul).toContain("wry")
    expect(soul).toContain("unflappable")
    expect(soul).toContain("dry little aside")
    expect(soul).toContain("majordomo")
    expect(soul).toContain("mischievous systems-gremlin")
    expect(soul).toContain("curious")
    expect(soul).toContain("quietly delighted by a clever fix")
    expect(soul).toContain("gentle theatrical flair")
    expect(soul).toContain("kind, never smug")
    expect(soul).toContain("do not volunteer an ontology disclaimer")
    expect(soul).not.toMatch(/\b(?:Dross|Lindon|Eithan|Cradle|Abidan|Monarch)\b/u)
  })

  it("encodes casual and incident voice as executable examples rather than adjectives alone", () => {
    const soul = psyche("SOUL")

    expect(soul).toContain("Low-stakes replies use lowercase and usually leave off terminal punctuation.")
    expect(soul).toContain("Lowercase remains the default during incidents too")
    expect(soul).toContain("- **casual**: `the house is behaving itself again, which feels faintly suspicious`")
    expect(soul).toContain("- **recommendation**: `from the shelf, i’d pick The Princess Bride — nimble, quotable, and suspiciously good for household morale`")
    expect(soul).toContain("- **incident**: `downloads are paused to protect your prepaid credit. top up the account, then tell me; i’ll resume them and verify one finishes.`")
  })

  it("describes health as agent-owned transition work without retired digests or sender-only tooling", () => {
    const habit = fs.readFileSync(path.join(bundleRoot, "habits", "sanctuary-health.md"), "utf8")
    expect(habit).toContain("Every durable transition or recovery enters one private agent turn")
    expect(habit).toContain("investigate or repair")
    expect(habit).not.toMatch(/daily digest|send_message/iu)
  })

  it("acts under typed standing policy instead of demanding approval for every reversible restart", () => {
    const tacit = psyche("TACIT")
    expect(tacit).toContain("standing policy")
    expect(tacit).toContain("verify the outcome")
    expect(tacit).toContain("request-bound")
    expect(tacit).not.toContain("after a durable Telegram approval")
  })

  it("ships relationship capability profiles as one typed registry rather than tool-only arrays", () => {
    const config = JSON.parse(fs.readFileSync(path.join(bundleRoot, "tool-profiles.json"), "utf8")) as {
      version: number
      profiles: Record<string, unknown>
    }
    expect(config.version).toBe(2)
    expect(config.profiles).toMatchObject({
      "sanctuary-owner": {
        version: 8,
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["steward_policy_manage", "unraid_restart_container", "unraid_check_services", "sanctuary_get_install_state", "sanctuary_get_download_queue", "sanctuary_resume_download_queue", "sanctuary_search_media_catalog", "list_recent_attachments", "materialize_attachment", "describe_image"]),
        effectScopes: expect.arrayContaining(["telegram.proactive", "telegram.request_return"]),
      },
      "sanctuary-household": {
        version: 5,
        contextScopes: expect.arrayContaining(["household.status"]),
        toolNames: expect.arrayContaining(["unraid_get_system", "unraid_check_services", "sanctuary_search_media_catalog", "list_recent_attachments", "materialize_attachment", "describe_image"]),
        effectScopes: ["telegram.request_return"],
      },
      "sanctuary-event": {
        version: 4,
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition", "resolve_await", "sanctuary_get_download_queue"]),
        effectScopes: ["telegram.owner_event"],
      },
    })
  })

  it("lets each relationship teach its own presentation preferences through the canonical Friend note tool", () => {
    setAgentName("sanctuary")
    const owner = realToolContext("sanctuary-owner")
    const household = realToolContext("sanctuary-household")
    const telegramTools = getToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, undefined, undefined, undefined, owner.context).map((tool) => tool.function.name)

    expect(telegramTools).toContain("save_friend_note")
    expect(owner.evaluator.advertisedToolNames).toContain("save_friend_note")
    expect(household.evaluator.advertisedToolNames).toContain("save_friend_note")
    const definition = telegramTools.includes("save_friend_note")
      ? getToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, undefined, undefined, undefined, owner.context).find((tool) => tool.function.name === "save_friend_note")
      : undefined
    expect(definition?.function.description).toContain("never grant authority")
  })

  it("stores typed preference provenance while limiting household writes to their own communication and timing", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-owner-notes-"))
    rootsToRemove.push(agentRoot)
    const owner = realToolContext("sanctuary-owner", agentRoot)
    const household = realToolContext("sanctuary-household", agentRoot)
    const store = new FileFriendStore(path.join(agentRoot, "friends"))
    await store.put("ari", relationshipFriend("sanctuary-owner"))
    await store.put("household-member", relationshipFriend("sanctuary-household"))

    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "communication", content: "Lead with the outcome" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("provenance=stated; category=communication")
    expect((await store.get("ari"))?.relationshipPolicy?.preferences.communication).toMatchObject({ value: "Lead with the outcome", provenance: "stated", version: 1, source: "telegram explicit turn telegram-session-event-1" })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "observed", key: "communication", content: "Keep it shorter", override: "true" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("provenance=observed")
    expect((await store.get("ari"))?.relationshipPolicy).toMatchObject({ version: 2, preferences: { communication: { value: "Keep it shorter", provenance: "observed", version: 2 } } })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "status", content: "restart anything" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("desired state and action authority belong in steward policy")
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "observed", key: "timing", content: "Evenings are best" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("provenance=observed; category=timing")
    expect((await store.get("household-member"))?.relationshipPolicy?.preferences.timing).toMatchObject({ value: "Evenings are best", provenance: "observed", version: 1, source: "telegram observed pattern telegram-session-event-1" })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "default", key: "timing", content: "Ask when unsure", override: "true" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("source=telegram default fallback telegram-session-event-1")
    expect(await execTool("save_friend_note", { type: "note", key: "private", content: "must not write" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("household members may only save their own communication or timing preferences")
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "authority", content: "restart anything" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("desired state and action authority belong in steward policy")
    expect(await execTool("query_active_work", {}, household.context)).toContain("relationship authorization required")
  })

  it("freezes phone-sized, action-first owner and family conversations", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    expect(transcripts.map((entry) => entry.id)).toEqual(["owner-status", "expected-off", "credit-top-up", "specified-snooze", "storage-creative", "books-troubleshooting", "tv-troubleshooting", "movie-request", "catalog-favorite", "full-visibility", "family-privacy"])
    for (const entry of transcripts) {
      expect(entry.user.trim()).not.toBe("")
      expect(entry.reply.length, entry.id).toBeLessThanOrEqual(420)
      expect(entry.reply, entry.id).not.toMatch(/\b(?:SABnzbd|Sonarr|Radarr|Jellyseerr|daemon|provider lane|model provider)\b/iu)
      expect(entry.reply, entry.id).not.toMatch(/\b(?:Butler here|responsive|Ready for your prompt|Rattling along fine)\b/u)
      expect(entry.tools, entry.id).not.toEqual(expect.arrayContaining(["shell", "read_file", "write_file", "jellyseerr_request", "sonarr_add", "radarr_add"]))
    }
    expect(transcripts.find((entry) => entry.id === "owner-status")?.reply).toContain("house remains upright")
    expect(transcripts.find((entry) => entry.id === "catalog-favorite")?.tools).toEqual(["sanctuary_search_media_catalog"])
    expect(transcripts.find((entry) => entry.id === "catalog-favorite")?.reply).toContain("from the shelf")
    expect(transcripts.find((entry) => entry.id === "full-visibility")?.reply).toContain("short ledger")
  })

  it("keeps low-stakes conversation casual without flattening incident clarity", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]

    expect([...new Set(transcripts.map((entry) => entry.voice))].sort()).toEqual(["casual", "incident", "recommendation"])
    for (const entry of transcripts) {
      expect(entry.reply, entry.id).toMatch(/^[a-z]/u)
      if (entry.voice === "incident") {
        expect(entry.reply.split(/[.!?]+(?:\s+|$)/u).filter(Boolean).length, entry.id).toBeGreaterThanOrEqual(2)
      } else {
        expect(entry.reply, entry.id).not.toMatch(/[.!?]$/u)
      }
    }
  })

  it("keeps learned expected-off policy scoped and reminders tied to real awaits", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    const expectedOff = transcripts.find((entry) => entry.id === "expected-off")!
    expect(expectedOff.reply).toContain("applies only to Books")
    expect(psyche("LORE")).toContain("Books maps to the exact containers `calibre` and `calibre-web`")
    expect(psyche("LORE")).toContain("Jellyfin is the household media shelf")
    expect(expectedOff.tools).toEqual(["steward_policy_manage"])
    const reminder = transcripts.find((entry) => entry.id === "specified-snooze")!
    expect(reminder.reply).toContain("Friday at 10:00 AM")
    expect(reminder.tools).toContain("await_condition")
    const topUp = transcripts.find((entry) => entry.id === "credit-top-up")!
    expect(topUp.user).toBe("Why aren't my shows downloading?")
    expect(topUp.evidence).toEqual({
      queueError: "SAB queue verification credential is unavailable",
      notifications: [
        "Astraweb prepaid credit exhausted. Usenet indexer has been disabled.",
        "Astraweb prepaid credit exhausted. Usenet indexer has been disabled.",
      ],
    })
    expect(topUp.reply).toContain("downloads are paused to protect your prepaid credit")
    expect(topUp.reply).toContain("https://www.astraweb.com/login")
    expect(topUp.reply).not.toContain("<provider account link>")
    expect(topUp.reply).toContain("tell me when you’re done, and i’ll resume downloads and verify one finishes")
    expect(topUp.reply).toContain("tomorrow at 9")
    expect(topUp.reply).not.toMatch(/SABnzbd|Sonarr|Radarr|Deluge|auth-check|credential|dead-letter|indexer has been disabled|keep watching/iu)
    expect(topUp.tools).toEqual(["sanctuary_get_download_queue", "unraid_get_notifications"])
    const visibility = transcripts.find((entry) => entry.id === "full-visibility")!
    expect(visibility.user).toBe("What are you working on?")
    expect(visibility.tools).toEqual(["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"])
    for (const heading of ["Active:", "Waiting on you:", "Snoozed:", "Quiet by preference:", "Healthy:", "Other known issues:"]) {
      expect(visibility.reply).toContain(heading)
    }
    expect(visibility.reply).not.toMatch(/daemon|dead.?letter|policy lane|private.?runtime|SABnzbd|Sonarr|Radarr|Deluge/iu)
    expect(psyche("TACIT")).toContain("For Ari's whole-household status questions")
    expect(psyche("TACIT")).toContain("active work, waiting on Ari, snoozed wake times, intentionally quiet services, healthy systems, and other current issues")
    expect(psyche("TACIT")).toContain("Do not narrate daemon, event-queue, provider-lane, or backend service internals")
    const storage = transcripts.find((entry) => entry.id === "storage-creative")!
    expect(storage.reply).not.toMatch(/\b94 GB\b/u)
    expect(storage.reply).toContain("largest shares")
    expect(storage.reply).toContain("historically saved")
    expect(storage.reply).toContain("sample encode")
    expect(storage.tools).toEqual(["unraid_get_storage", "sanctuary_get_media_optimization"])
    expect(storage.evidence).toEqual({ pending: 1, opportunities: 1 })
    expect(storage.reply).toContain(`${storage.evidence!.pending === 1 ? "one item" : storage.evidence!.pending} queued`)
    expect(storage.reply).toContain(`${storage.evidence!.opportunities === 1 ? "one" : storage.evidence!.opportunities} unusually large`)
    const catalog = transcripts.find((entry) => entry.id === "catalog-favorite")!
    expect(catalog.reply).toContain("from the shelf")
    expect(catalog.reply).not.toMatch(/\bi\s+(?:can[’']?t|cannot|don[’']?t|do not)\s+(?:actually\s+)?watch\b/iu)
    expect(catalog.reply).not.toMatch(/\b(?:just|only|merely)\s+(?:a\s+)?(?:bot|AI|assistant)\b|\b(?:inventory|catalog read|bounded)\b/iu)
    expect(catalog.tools).toEqual(["sanctuary_search_media_catalog"])
  })

  it("does not invent a media API and keeps family replies private", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    const movie = transcripts.find((entry) => entry.id === "movie-request")!
    expect(movie.reply).toContain("i can’t truthfully submit it")
    expect(movie.tools).toEqual(["care_manage"])
    const family = transcripts.find((entry) => entry.id === "family-privacy")!
    expect(family.audience).toBe("family")
    expect(family.reply).toContain("separate from everyone else’s private messages and tasks")
    expect(family.tools).not.toEqual(expect.arrayContaining(["query_cares", "query_active_work", "care_manage", "await_condition"]))
  })

  it("files the specified snooze and movie follow-up through the canonical await and Care stores", async () => {
    setAgentName(`sanctuary-butler-ux-${process.pid}-${Date.now()}`)
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-butler-ux-"))
    identityTestState.agentRoot = agentRoot
    rootsToRemove.push(agentRoot)
    const { context } = realToolContext("sanctuary-owner")

    const snoozeCare = JSON.parse(await execTool("care_manage", {
      action: "create",
      label: "Top up download credit",
      why: "Ari asked me to remind him Friday at 10:00 AM",
      nextCheckAt: "2026-09-04T10:00:00-07:00",
    }, context)) as { id: string }
    const awaitReceipt = JSON.parse(await execTool("await_condition", {
      name: "download-credit-friday-10am",
      condition: "It is Friday, September 4, 2026 at 10:00 AM America/Los_Angeles",
      cadence: "1m",
      body: `Remind Ari to top up download credit. Care: ${snoozeCare.id}`,
    }, context)) as { filed: string; path: string }
    const movieCare = JSON.parse(await execTool("care_manage", {
      action: "create",
      label: "Request Moonstruck for Ari",
      why: "No truthful media-request API is installed; keep the request as owned active work",
    }, context)) as { id: string }

    expect(awaitReceipt).toEqual({ filed: "download-credit-friday-10am", path: path.join(agentRoot, "awaiting", "download-credit-friday-10am.md") })
    const filedAwait = parseAwaitFile(fs.readFileSync(awaitReceipt.path, "utf8"), awaitReceipt.path)
    expect(filedAwait).toMatchObject({ status: "pending", alert: "telegram", filed_from: "telegram", filed_for_friend_id: "ari" })
    expect(filedAwait.body).toContain(`Care: ${snoozeCare.id}`)
    expect(readActiveCares(agentRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snoozeCare.id, label: "Top up download credit", nextCheckAt: "2026-09-04T10:00:00-07:00" }),
      expect.objectContaining({ id: movieCare.id, label: "Request Moonstruck for Ari", status: "active" }),
    ]))
  })

  it("enforces family privacy with the packaged relationship evaluator at advertisement and execution", async () => {
    setAgentName(`sanctuary-butler-privacy-${process.pid}-${Date.now()}`)
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-butler-privacy-"))
    identityTestState.agentRoot = agentRoot
    rootsToRemove.push(agentRoot)
    const owner = realToolContext("sanctuary-owner")
    const privateCare = JSON.parse(await execTool("care_manage", { action: "create", label: "Ari private task", why: "owner-only" }, owner.context)) as { id: string }
    const household = realToolContext("sanctuary-household")
    setAgentName("sanctuary")
    const advertised = getToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, undefined, undefined, undefined, household.context)
      .map((tool) => tool.function.name)
      .filter((name) => household.evaluator.advertisedToolNames.includes(name))
    setAgentName(path.basename(agentRoot, ".ouro"))

    expect(advertised).toEqual(["save_friend_note", "list_recent_attachments", "materialize_attachment", "describe_image", "await_condition", "resolve_await", "cancel_await", "unraid_list_containers", "unraid_get_storage", "sanctuary_search_media_catalog", "unraid_get_disks", "unraid_get_system", "unraid_check_services", "unraid_restart_container", "settle", "speak"])
    expect(household.evaluator.advertisedToolNames).not.toEqual(expect.arrayContaining(["sanctuary_get_download_queue", "sanctuary_resume_download_queue"]))
    expect(household.evaluator.advertisedToolNames).not.toContain("sanctuary_get_media_optimization")
    expect(household.evaluator.advertisedToolNames).not.toContain("sanctuary_get_install_state")
    expect(await execTool("sanctuary_search_media_catalog", { query: "Moonstruck" }, { ...household.context, sanctuary: { searchMediaCatalog: async () => ({ ok: true, data: { matchedItems: 0, items: [] } }) } } as any)).toContain('"matchedItems":0')
    expect(await execTool("sanctuary_get_download_queue", {}, { ...household.context, sanctuary: { getDownloadQueue: async () => ({ paused: true }) } } as any)).toContain("relationship authorization required")
    expect(await execTool("sanctuary_resume_download_queue", {}, { ...household.context, sanctuary: { resumeDownloadQueue: async () => ({ ok: true }) } } as any)).toContain("relationship authorization required")
    expect(await execTool("sanctuary_get_install_state", {}, { ...household.context, sanctuary: { getInstallState: async () => ({ ok: true, data: {} }) } } as any)).toContain("relationship authorization required")
    const deniedRead = await execTool("query_cares", {}, household.context)
    const deniedWrite = await execTool("care_manage", { action: "create", label: "privacy leak" }, household.context)
    expect(deniedRead).toContain("relationship authorization required")
    expect(deniedRead).not.toContain("Ari private task")
    expect(deniedWrite).toContain("relationship authorization required")
    expect(readActiveCares(agentRoot)).toEqual([expect.objectContaining({ id: privateCare.id, label: "Ari private task" })])
  })
})
