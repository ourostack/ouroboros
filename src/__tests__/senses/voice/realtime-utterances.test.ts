import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isAudioPart, realtimeUtteranceLedger, responseMadeAudio } from "../../../senses/voice/realtime-utterances"
import { voiceUtterances } from "../../../senses/voice/utterances"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function ledger(engine: "openai-realtime" | "openai-sip" = "openai-realtime") {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-realtime-utterances-"))
  dirs.push(outputDir)
  const calls = realtimeUtteranceLedger({ outputDir, engine, callSid: "CA/one", friendId: "ari", sessionKey: "twilio-phone-ari" })
  const journal = voiceUtterances(outputDir)
  return { calls, journal, outcome: (id: string) => journal.outcome(id), pending: (id: string) => journal.get(id) }
}

describe("realtime utterance ledger", () => {
  it("records what the caller said before a reply is asked for, and answers it once the reply's audio played", () => {
    const { calls, outcome, pending } = ledger()
    calls.heard("item-1")
    expect(pending("realtime-CA-one-item-1")).toMatchObject({
      attempts: 1, spoke: false, payload: { callSid: "CA/one", friendId: "ari", sessionKey: "twilio-phone-ari", transport: "openai-realtime" },
    })
    calls.replyStarted("resp-1", true)
    calls.speaking("resp-1")
    calls.speaking("resp-1")
    expect(pending("realtime-CA-one-item-1")).toMatchObject({ spoke: true, spokeRecords: [expect.objectContaining({ kind: "speech:audio" })] })
    calls.played("resp-1")
    calls.played("resp-1")
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("names SIP utterances apart, and numbers one with no item id", () => {
    const { calls, pending } = ledger("openai-sip")
    calls.heard("")
    calls.heard("")
    expect(pending("sip-CA-one-caller-1")).toMatchObject({ payload: { transport: "openai-sip" } })
    expect(pending("sip-CA-one-caller-2")).not.toBeNull()
  })

  it("lets one reply answer everything the caller said since the last one, and not a reply the call asked for itself", () => {
    const { calls, outcome } = ledger()
    calls.heard("item-1")
    calls.replyStarted("greeting", false)
    calls.speaking("greeting")
    calls.played("greeting")
    expect(outcome("realtime-CA-one-item-1")).toBeNull()
    calls.heard("item-2")
    calls.replyStarted("", true)
    calls.replyStarted("resp-1", true)
    calls.replyStarted("resp-2", true)
    calls.speaking("resp-1")
    calls.played("resp-1")
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "answered" })
    expect(outcome("realtime-CA-one-item-2")).toMatchObject({ outcome: "answered" })
  })

  it("gives a reply's utterances back to the next reply when it made no audio, such as one that only called a tool", () => {
    const { calls, outcome } = ledger()
    calls.heard("item-1")
    calls.replyStarted("tool-call", true)
    calls.replyDone("tool-call")
    calls.replyDone("unknown")
    calls.replyStarted("follow-up", true)
    calls.speaking("follow-up")
    calls.replyDone("follow-up")
    expect(outcome("realtime-CA-one-item-1")).toBeNull()
    calls.played("follow-up")
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "answered" })
  })

  it("takes the engine's word on whether a finished reply made audio", () => {
    const { calls, outcome } = ledger("openai-sip")
    calls.heard("item-1")
    calls.replyStarted("resp-1", true)
    calls.replyDone("resp-1", false)
    calls.replyStarted("resp-2", true)
    calls.replyDone("resp-2", true)
    calls.replyStarted("resp-3", true)
    calls.played("resp-2")
    expect(outcome("sip-CA-one-item-1")).toMatchObject({ outcome: "answered" })
  })

  it("records a reply whose sent audio was cleared before any played as failed, saying why", () => {
    const { calls, outcome } = ledger()
    calls.heard("item-1")
    calls.replyStarted("resp-1", true)
    calls.heard("item-2")
    calls.replyStarted("resp-2", true)
    calls.cutOff("the caller spoke again before the reply was played")
    expect(outcome("realtime-CA-one-item-1")).toBeNull()
    calls.speaking("resp-1")
    calls.cutOff("the caller spoke again before the reply was played")
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "failed", detail: "the caller spoke again before the reply was played" })
    expect(outcome("realtime-CA-one-item-2")).toBeNull()
    calls.speaking("resp-2")
    calls.played("resp-2")
    expect(outcome("realtime-CA-one-item-2")).toMatchObject({ outcome: "answered" })
  })

  it("notes a tool that may message a person on every utterance still waiting, before it runs", () => {
    const { calls, pending } = ledger()
    calls.heard("item-1")
    calls.replyStarted("resp-1", true)
    calls.heard("item-2")
    calls.toolSending("web_search", { query: "weather" })
    calls.toolSending("send_message", { friendId: "self", content: "later" })
    expect(pending("realtime-CA-one-item-1")).toMatchObject({ spoke: false })
    calls.toolSending("send_message", { friendId: "ari", content: "on my way", urgent: true })
    expect(pending("realtime-CA-one-item-1")).toMatchObject({ spokeRecords: [expect.objectContaining({ kind: "tool:send_message", textLength: 9 })] })
    expect(pending("realtime-CA-one-item-2")).toMatchObject({ spokeRecords: [expect.objectContaining({ kind: "tool:send_message" })] })
  })

  it("records everything still waiting as failed when the call ends, or silent when a voicemail menu answered", () => {
    const { calls, outcome } = ledger()
    calls.heard("item-1")
    calls.replyStarted("resp-1", true)
    calls.heard("item-2")
    calls.ended()
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "failed", detail: "the call ended before the reply was played" })
    expect(outcome("realtime-CA-one-item-2")).toMatchObject({ outcome: "failed", detail: "the call ended before this was answered" })

    const voicemail = ledger("openai-sip")
    voicemail.calls.heard("item-1")
    voicemail.calls.replyStarted("resp-1", true)
    voicemail.calls.heard("item-2")
    voicemail.calls.ended("a voicemail menu answered the call, so it was ended")
    expect(voicemail.outcome("sip-CA-one-item-1")).toMatchObject({ outcome: "silent", detail: "a voicemail menu answered the call, so it was ended" })
    expect(voicemail.outcome("sip-CA-one-item-2")).toMatchObject({ outcome: "silent" })
  })

  it("skips an utterance that already has an outcome", () => {
    const { calls, outcome } = ledger()
    calls.heard("item-1")
    calls.ended()
    calls.heard("item-1")
    calls.replyStarted("resp-1", true)
    calls.speaking("resp-1")
    calls.played("resp-1")
    expect(outcome("realtime-CA-one-item-1")).toMatchObject({ outcome: "failed" })
  })
})

describe("responseMadeAudio", () => {
  it("finds audio in a finished response's output", () => {
    expect(responseMadeAudio({ response: { output: [{ type: "message", content: [{ type: "output_audio" }] }] } })).toBe(true)
    expect(responseMadeAudio({ response: { output: [{ type: "message", content: [{ type: "audio" }] }] } })).toBe(true)
    expect(responseMadeAudio({ response: { output: [{ type: "function_call" }, { type: "message", content: [{ type: "output_text" }] }] } })).toBe(false)
    expect(responseMadeAudio({ response: { output: [null, "x", { content: "x" }, { content: [null] }] } })).toBe(false)
    expect(responseMadeAudio({ response: { output: "x" } })).toBe(false)
    expect(responseMadeAudio({ response: [] })).toBe(false)
    expect(responseMadeAudio({})).toBe(false)
    expect(isAudioPart({ type: "output_audio" })).toBe(true)
    expect(isAudioPart({ type: "output_text" })).toBe(false)
    expect(isAudioPart(undefined)).toBe(false)
  })
})
