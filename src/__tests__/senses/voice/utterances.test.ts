import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../../nerves/runtime"
import { turnSpoke } from "../../../senses/turn-attempts"
import {
  failLeftoverVoiceUtterances,
  recordVoiceUtterance,
  seenVoiceUtterance,
  voiceUtterances,
  type VoiceUtterancePayload,
} from "../../../senses/voice/utterances"

const dirs: string[] = []
function outputDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-utterances-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const payload: VoiceUtterancePayload = { callSid: "CA1", friendId: "ari", sessionKey: "twilio-phone-ari", transport: "recording" }

function emitted(name: string) {
  return vi.mocked(nerves.emitNervesEvent).mock.calls.map(([event]) => event).filter((event) => event.event === name)
}

describe("voice utterance records", () => {
  it("keeps each utterance under the call output folder until its turn settles it", () => {
    const dir = outputDir()
    const utterance = recordVoiceUtterance(dir, "twilio-CA1-RE1", payload)!
    expect(fs.readdirSync(path.join(dir, "utterances", "pending-inbound"))).toHaveLength(1)
    utterance.beginAttempt()
    utterance.noteSpoke(turnSpoke("speech:text", "Hello."))
    expect(voiceUtterances(dir).get("twilio-CA1-RE1")).toMatchObject({ attempts: 1, spoke: true, payload })
    utterance.settle("answered")
    expect(voiceUtterances(dir).outcome("twilio-CA1-RE1")).toMatchObject({ outcome: "answered", attempts: 1 })
    expect(voiceUtterances(dir).pending()).toEqual([])
  })

  it("knows an utterance it has already seen, pending or settled", () => {
    const dir = outputDir()
    expect(seenVoiceUtterance(dir, "twilio-CA1-RE1")).toBe(false)
    recordVoiceUtterance(dir, "twilio-CA1-RE1", payload)!
    expect(seenVoiceUtterance(dir, "twilio-CA1-RE1")).toBe(true)
    recordVoiceUtterance(dir, "twilio-CA1-RE2", payload)!.settle("failed", "fixture")
    expect(seenVoiceUtterance(dir, "twilio-CA1-RE2")).toBe(true)
    // A settled utterance is not recorded a second time.
    expect(recordVoiceUtterance(dir, "twilio-CA1-RE2", payload)).toBeNull()
  })

  it("runs the turn without a record when its folder cannot be written", () => {
    vi.spyOn(nerves, "emitNervesEvent")
    expect(recordVoiceUtterance("/dev/null/not-a-dir", "twilio-CA1-RE1", payload)).toBeNull()
    expect(emitted("senses.voice_utterance_record_failed")).toEqual([expect.objectContaining({ level: "error" })])
    expect(seenVoiceUtterance("/dev/null/not-a-dir", "twilio-CA1-RE1")).toBe(false)
    expect(emitted("senses.voice_utterance_record_failed")).toHaveLength(2)
  })

  it("logs an outcome it cannot record instead of throwing into the call", () => {
    const dir = outputDir()
    const utterance = recordVoiceUtterance(dir, "twilio-CA1-RE1", payload)!
    vi.spyOn(nerves, "emitNervesEvent")
    fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o500)
    try {
      expect(() => utterance.settle("answered")).not.toThrow()
    } finally { fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o700) }
    if (process.getuid?.() !== 0) {
      expect(emitted("senses.voice_utterance_settle_failed")).toEqual([expect.objectContaining({ level: "error" })])
      expect(voiceUtterances(dir).get("twilio-CA1-RE1")).not.toBeNull()
    }
  })

  it("records every utterance left from a stopped call as failed, naming what was already spoken", () => {
    const dir = outputDir()
    const journal = voiceUtterances(dir)
    recordVoiceUtterance(dir, "twilio-CA1-1", payload)
    const spoke = recordVoiceUtterance(dir, "twilio-CA1-2", payload)!
    spoke.noteSpoke(turnSpoke("speech:text", "Half an answer.", null, Date.parse("2026-11-22T10:00:00.000Z")))
    vi.spyOn(nerves, "emitNervesEvent")
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(2)
    expect(journal.outcome("twilio-CA1-1")).toMatchObject({
      outcome: "failed", detail: "the voice sense restarted before this was answered; live audio is not replayed",
    })
    expect(journal.outcome("twilio-CA1-2")).toMatchObject({
      outcome: "failed",
      detail: "the voice sense restarted after 1 send (speech:text at 2026-11-22T10:00:00.000Z) went out; live audio is not replayed",
    })
    expect(emitted("senses.voice_utterances_left_failed")).toEqual([expect.objectContaining({ level: "warn", meta: { when: "start", failed: 2 } })])
    recordVoiceUtterance(dir, "twilio-CA1-3", payload)
    expect(failLeftoverVoiceUtterances(dir, "shutdown")).toBe(1)
    expect(journal.outcome("twilio-CA1-3")).toMatchObject({ detail: "the voice sense shut down before this was answered; live audio is not replayed" })
    expect(failLeftoverVoiceUtterances(dir, "shutdown")).toBe(0)
    expect(emitted("senses.voice_utterances_left_failed")).toHaveLength(2)
  })

  it("fails nothing when its folder cannot be opened", () => {
    vi.spyOn(nerves, "emitNervesEvent")
    expect(failLeftoverVoiceUtterances("/dev/null/not-a-dir", "start")).toBe(0)
    expect(emitted("senses.voice_utterance_record_failed")).toEqual([expect.objectContaining({ level: "error" })])
  })
})
