import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import * as nerves from "../../../nerves/runtime"
import { PendingVoiceCalls, mintVoiceCallToken, newVoiceCallNonce } from "../../../senses/voice/call-auth"
import {
  computeOpenAIWebhookSignature,
  computeTwilioSignature,
  createTwilioPhoneBridge,
  writeTwilioOutboundCallJob,
  type TwilioPhoneBridgeOptions,
} from "../../../senses/voice/twilio-phone"

const AUTH_TOKEN = "twilio-auth-token-for-tests"
const BASE_URL = "https://voice.example.com"
const WEBHOOK_SECRET = `whsec_${Buffer.from("sip-auth-secret").toString("base64")}`
const LINE = "+15557654321"
const CALLER = "+15551234567"

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function fixture(overrides: Partial<TwilioPhoneBridgeOptions> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-sip-auth-"))
  dirs.push(outputDir)
  const agentRoot = path.join(outputDir, "slugger.ouro")
  await fs.mkdir(path.join(agentRoot, "friends"), { recursive: true })
  await fs.writeFile(path.join(agentRoot, "friends", "ari.json"), JSON.stringify({
    id: "ari", name: "Ari", role: "primary", trustLevel: "family", connections: [],
    externalIds: [{ provider: "imessage-handle", externalId: CALLER, linkedAt: "2026-09-09T00:00:00Z" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", schemaVersion: 1, kind: "human",
  }))
  const requests: Array<{ url: string; body: string }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") })
    return new Response("", { status: 200 })
  })
  const pending = new PendingVoiceCalls()
  const options = {
    agentName: "slugger",
    agentRoot,
    publicBaseUrl: BASE_URL,
    outputDir,
    transcriber: { transcribe: vi.fn(async (request: { utteranceId: string; audioPath: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "hi", audioPath: request.audioPath, source: "whisper.cpp" })) },
    tts: { synthesize: vi.fn() },
    runSenseTurn: vi.fn(async () => ({ response: "ok", ponderDeferred: false })),
    downloadRecording: vi.fn(),
    playbackMode: "buffered" as const,
    conversationEngine: "openai-sip" as const,
    transportMode: "media-stream" as const,
    twilioAuthToken: AUTH_TOKEN,
    pendingVoiceCalls: pending,
    openaiRealtime: { apiKey: "openai-secret", websocketUrl: "ws://127.0.0.1:9/v1/realtime" },
    openaiSip: {
      projectId: "proj_test", webhookPath: "/voice/sip", webhookSecret: WEBHOOK_SECRET,
      websocketBaseUrl: "ws://127.0.0.1:9/v1/realtime", apiBaseUrl: "https://api.openai.test/v1", fetch: fetchMock,
    },
    ...overrides,
  } as unknown as TwilioPhoneBridgeOptions
  const bridge = createTwilioPhoneBridge(options)
  let hook = 0
  return {
    options, pending, requests, outputDir, bridge,
    actions: () => requests.map(({ url }) => url.split("/").at(-1)),
    async twilio(route: string, params: Record<string, string>) {
      return bridge.handle({
        method: "POST", path: route, body: new URLSearchParams(params).toString(),
        headers: { "x-twilio-signature": computeTwilioSignature({ authToken: AUTH_TOKEN, url: new URL(route, BASE_URL).toString(), params }) },
      })
    },
    async webhook(callId: string, headers: Array<{ name: string; value: string }>, webhookId = `wh_${++hook}`) {
      const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: callId, sip_headers: headers } })
      const timestamp = String(Math.floor(Date.now() / 1_000))
      return bridge.handle({
        method: "POST", path: "/voice/sip", body: payload,
        headers: { "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${computeOpenAIWebhookSignature({ secret: WEBHOOK_SECRET, webhookId, timestamp, payload })}` },
      })
    },
  }
}

/** The headers OpenAI would forward from the `<Sip>` URI the signed Twilio webhook returned. */
function headersFromDial(twiml: unknown): Array<{ name: string; value: string }> {
  const uri = String(twiml).match(/<Sip>([^<]+)<\/Sip>/)?.[1]?.replace(/&amp;/g, "&")
  if (!uri) throw new Error(`no <Sip> in ${String(twiml)}`)
  return [...new URL(uri.replace(/^sip:/, "sip://")).searchParams].map(([name, value]) => ({ name, value }))
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

function refusals(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map(([event]) => event as { event: string; meta?: { reason?: string } })
    .filter((event) => event.event === "senses.voice_openai_sip_call_refused")
    .map((event) => event.meta?.reason ?? "")
}

describe("authenticated OpenAI SIP calls", () => {
  it("dials the SIP URI with the agent, CallSid and token and no identity headers", async () => {
    const f = await fixture()
    const response = await f.twilio("/voice/twilio/incoming", { CallSid: "CAsip", From: CALLER, To: LINE })
    const names = headersFromDial(response.body).map((header) => header.name)

    expect(names.sort()).toEqual(["X-Ouro-Agent", "X-Ouro-Call-Sid", "X-Ouro-Call-Token"])
    expect(f.pending.has("CAsip")).toBe(true)
  })

  it("accepts a webhook carrying the issued token and takes the caller from the record", async () => {
    const f = await fixture({ defaultFriendId: "someone-else" })
    const headers = headersFromDial((await f.twilio("/voice/twilio/incoming", { CallSid: "CAok", From: CALLER, To: LINE })).body)
    // A forged friend header must change nothing.
    const response = await f.webhook("call_ok", [...headers, { name: "X-Ouro-Friend-Id", value: "forged" }, { name: "X-Ouro-From", value: "+15550000000" }])

    expect(response.statusCode).toBe(200)
    await vi.waitFor(() => expect(f.actions()).toContain("accept"))
    const accept = JSON.parse(f.requests.find(({ url }) => url.endsWith("/accept"))!.body) as { instructions: string }
    expect(accept.instructions).toContain("friendId=ari")
    expect(accept.instructions).not.toContain("forged")
    expect(accept.instructions).not.toContain("someone-else")
    await settle()
  })

  it("does not fall back to defaultFriendId for an unknown inbound caller", async () => {
    const f = await fixture({ defaultFriendId: "ari" })
    const headers = headersFromDial((await f.twilio("/voice/twilio/incoming", { CallSid: "CAstranger", From: "+15550009999", To: LINE })).body)
    await f.webhook("call_stranger", headers)

    await vi.waitFor(() => expect(f.actions()).toContain("accept"))
    const accept = JSON.parse(f.requests.find(({ url }) => url.endsWith("/accept"))!.body) as { instructions: string }
    expect(accept.instructions).not.toContain("friendId=ari,")
    await settle()
  })

  it("takes the friend for an outbound call from the job record", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, {
      schemaVersion: 1, outboundId: "out-sip", agentName: "slugger", friendId: "ari",
      from: LINE, to: CALLER, reason: "checking in", createdAt: "2026-10-09T00:00:00.000Z", status: "requested",
    })
    const headers = headersFromDial((await f.twilio("/voice/twilio/outgoing/out-sip", { CallSid: "CAsipout", To: CALLER, From: LINE })).body)
    await f.webhook("call_out", [...headers, { name: "X-Ouro-Friend-Id", value: "forged" }])

    await vi.waitFor(() => expect(f.actions()).toContain("accept"))
    const accept = JSON.parse(f.requests.find(({ url }) => url.endsWith("/accept"))!.body) as { instructions: string }
    expect(accept.instructions).toContain("friendId=ari")
    expect(accept.instructions).not.toContain("forged")
    await settle()
  })

  it.each([
    ["no token", () => []],
    ["a bad token", () => [{ name: "X-Ouro-Agent", value: "slugger" }, { name: "X-Ouro-Call-Sid", value: "CAbad" }, { name: "X-Ouro-Call-Token", value: "x.y" }]],
    ["a token signed with another secret", () => [{ name: "X-Ouro-Agent", value: "slugger" }, { name: "X-Ouro-Call-Sid", value: "CAbad" }, {
      name: "X-Ouro-Call-Token",
      value: mintVoiceCallToken({ secret: "another-secret", purpose: "sip", agentName: "slugger", callSid: "CAbad", direction: "inbound", from: CALLER, to: LINE, nowMs: Date.now() }),
    }]],
    ["a stream-purpose token", () => [{ name: "X-Ouro-Agent", value: "slugger" }, { name: "X-Ouro-Call-Sid", value: "CAbad" }, {
      name: "X-Ouro-Call-Token",
      value: mintVoiceCallToken({ secret: AUTH_TOKEN, purpose: "stream", agentName: "slugger", callSid: "CAbad", direction: "inbound", nowMs: Date.now() }),
    }]],
  ])("rejects a webhook with %s and never accepts the call", async (_label, headers) => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const response = await f.webhook("call_bad", headers())

    expect(response.statusCode).toBe(200)
    expect(f.actions()).toEqual(["reject"])
    expect(f.requests[0]!.url).toBe("https://api.openai.test/v1/realtime/calls/call_bad/reject")
    expect(refusals(events)).toHaveLength(1)
  })

  it("rejects a mismatched X-Ouro-Agent and an unconfigured auth token", async () => {
    const f = await fixture()
    const headers = headersFromDial((await f.twilio("/voice/twilio/incoming", { CallSid: "CAagent", From: CALLER, To: LINE })).body)
    await f.webhook("call_agent", headers.map((header) => header.name === "X-Ouro-Agent" ? { ...header, value: "someone-else" } : header))
    expect(f.actions()).toEqual(["reject"])
    // The mismatch did not spend the record; the real header set still works once.
    expect(f.pending.has("CAagent")).toBe(true)

    const noSecret = await fixture({ twilioAuthToken: "" })
    await noSecret.webhook("call_nosecret", headers)
    expect(noSecret.actions()).toEqual(["reject"])
  })

  it("rejects a replayed token after the record was consumed", async () => {
    const f = await fixture()
    const headers = headersFromDial((await f.twilio("/voice/twilio/incoming", { CallSid: "CAonce", From: CALLER, To: LINE })).body)
    await f.webhook("call_first", headers)
    await vi.waitFor(() => expect(f.actions()).toContain("accept"))
    await f.webhook("call_second", headers)

    expect(f.actions().filter((action) => action === "reject")).toHaveLength(1)
    expect(f.requests.filter(({ url }) => url.endsWith("/accept"))).toHaveLength(1)
    await settle()
  })

  it("rejects a token whose recorded from/to differ from what was signed", async () => {
    const f = await fixture()
    const nonce = newVoiceCallNonce()
    f.pending.record({ callSid: "CAmis", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "openai-sip" }, nonce)
    const token = mintVoiceCallToken({ secret: AUTH_TOKEN, purpose: "sip", agentName: "slugger", callSid: "CAmis", direction: "inbound", from: "+15550001111", to: LINE, nowMs: Date.now(), nonce })
    await f.webhook("call_mis", [{ name: "X-Ouro-Agent", value: "slugger" }, { name: "X-Ouro-Call-Sid", value: "CAmis" }, { name: "X-Ouro-Call-Token", value: token }])

    expect(f.actions()).toEqual(["reject"])
  })

  it("ignores a duplicate call_id or webhook-id", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const headers = headersFromDial((await f.twilio("/voice/twilio/incoming", { CallSid: "CAdupe", From: CALLER, To: LINE })).body)
    await f.webhook("call_dupe", headers, "wh_same")
    await vi.waitFor(() => expect(f.actions()).toContain("accept"))
    const before = f.requests.length

    expect((await f.webhook("call_dupe", headers, "wh_other")).statusCode).toBe(200)
    expect((await f.webhook("call_new", headers, "wh_same")).statusCode).toBe(200)

    expect(f.requests.length).toBe(before)
    expect(events.mock.calls.filter(([event]) => (event as { event: string }).event === "senses.voice_openai_sip_webhook_duplicate")).toHaveLength(2)
    await settle()
  })

  it("rejects without a reject call when OpenAI SIP is not configured for actions", async () => {
    const f = await fixture({ openaiRealtime: undefined })
    await f.webhook("call_nokey", [])
    expect(f.requests).toEqual([])
  })

  it("logs and survives a failing reject request", async () => {
    const failing = vi.fn(async () => new Response("no", { status: 500 }))
    const f = await fixture({ openaiSip: { projectId: "proj_test", webhookPath: "/voice/sip", webhookSecret: WEBHOOK_SECRET, apiBaseUrl: "https://api.openai.test/v1", fetch: failing } as never })
    const events = vi.spyOn(nerves, "emitNervesEvent")
    expect((await f.webhook("call_fail", [])).statusCode).toBe(200)
    expect(failing).toHaveBeenCalledOnce()
    expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_openai_sip_call_reject_error")).toBe(true)
  })

  it("does not admit a SIP call without a CallSid", async () => {
    const f = await fixture()
    const response = await f.twilio("/voice/twilio/incoming", { From: CALLER, To: LINE })

    expect(String(response.body)).not.toContain("<Sip>")
    expect(String(response.body)).toContain("<Hangup />")
    expect(f.pending.size()).toBe(0)
  })
})
