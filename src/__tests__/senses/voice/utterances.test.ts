import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../../nerves/runtime"
import { turnSpoke } from "../../../senses/turn-attempts"
import {
  failLeftoverVoiceUtterances,
  recordVoiceUtterance,
  seenVoiceUtterance,
  closeVoiceUtteranceBridge,
  openVoiceUtteranceBridge,
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

const asRoot = process.getuid?.() === 0

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

  it.skipIf(asRoot)("logs an outcome it cannot record instead of throwing into the call", () => {
    const dir = outputDir()
    const utterance = recordVoiceUtterance(dir, "twilio-CA1-RE1", payload)!
    vi.spyOn(nerves, "emitNervesEvent")
    fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o500)
    try {
      expect(() => utterance.settle("answered")).not.toThrow()
    } finally { fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o700) }
    expect(emitted("senses.voice_utterance_settle_failed")).toEqual([expect.objectContaining({ level: "error" })])
    expect(voiceUtterances(dir).get("twilio-CA1-RE1")).not.toBeNull()
  })

  it.skipIf(asRoot)("logs a try or a send it cannot note instead of costing the caller the answer", () => {
    const dir = outputDir()
    const utterance = recordVoiceUtterance(dir, "twilio-CA1-RE1", payload)!
    vi.spyOn(nerves, "emitNervesEvent")
    fs.chmodSync(path.join(dir, "utterances", "pending-inbound"), 0o500)
    try {
      expect(() => utterance.beginAttempt()).not.toThrow()
      expect(() => utterance.noteSpoke(turnSpoke("speech:text", "Hello."))).not.toThrow()
    } finally { fs.chmodSync(path.join(dir, "utterances", "pending-inbound"), 0o700) }
    expect(emitted("senses.voice_utterance_note_failed").map((event) => (event as { meta: { note: string } }).meta.note)).toEqual(["attempt", "speech:text"])
  })

  it.skipIf(asRoot)("leaves an utterance it cannot record as failed for the next start, and goes on with the rest", () => {
    const dir = outputDir()
    recordVoiceUtterance(dir, "twilio-CA1-1", payload)
    recordVoiceUtterance(dir, "twilio-CA1-2", payload)
    vi.spyOn(nerves, "emitNervesEvent")
    fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o500)
    try {
      expect(failLeftoverVoiceUtterances(dir, "start")).toBe(0)
    } finally { fs.chmodSync(path.join(dir, "utterances", "inbound-outcomes"), 0o700) }
    expect(emitted("senses.voice_utterance_settle_failed")).toHaveLength(2)
    expect(voiceUtterances(dir).pending()).toHaveLength(2)
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(2)
  })

  it("fails nothing when the leftover records cannot be listed", () => {
    const dir = outputDir()
    vi.spyOn(voiceUtterances(dir), "pending").mockImplementation(() => { throw new Error("EIO") })
    vi.spyOn(nerves, "emitNervesEvent")
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(0)
    expect(emitted("senses.voice_utterance_record_failed")).toEqual([expect.objectContaining({ meta: expect.objectContaining({ error: "Error: EIO" }) })])
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

describe("whose leftover utterances a sweep records as failed", () => {
  const leftover = (dir: string, id: string, owner?: VoiceUtterancePayload["owner"]) => {
    voiceUtterances(dir).record(id, { ...payload, ...(owner ? { owner } : {}) })
  }

  it("stamps each record with the process and the bridge that made it", () => {
    const dir = outputDir()
    const bridge = openVoiceUtteranceBridge()
    recordVoiceUtterance(dir, "twilio-CA1-mine", payload, bridge)
    recordVoiceUtterance(dir, "twilio-CA1-loose", payload)
    expect(voiceUtterances(dir).get("twilio-CA1-mine")?.payload.owner).toEqual({ pid: process.pid, bridge })
    expect(voiceUtterances(dir).get("twilio-CA1-loose")?.payload.owner).toEqual({ pid: process.pid })
    closeVoiceUtteranceBridge(bridge)
  })

  it("leaves another open bridge's utterances alone, and fails its own and those of a bridge that closed", () => {
    const dir = outputDir()
    const first = openVoiceUtteranceBridge()
    const second = openVoiceUtteranceBridge()
    recordVoiceUtterance(dir, "twilio-CA1-first", payload, first)
    recordVoiceUtterance(dir, "twilio-CA2-second", payload, second)
    recordVoiceUtterance(dir, "twilio-CA3-nobridge", payload)
    expect(failLeftoverVoiceUtterances(dir, "shutdown", second)).toBe(2)
    expect(voiceUtterances(dir).outcome("twilio-CA2-second")).toMatchObject({ outcome: "failed" })
    expect(voiceUtterances(dir).outcome("twilio-CA3-nobridge")).toMatchObject({ outcome: "failed" })
    expect(voiceUtterances(dir).get("twilio-CA1-first")).not.toBeNull()
    closeVoiceUtteranceBridge(second)
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(0)
    closeVoiceUtteranceBridge(first)
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(1)
    expect(voiceUtterances(dir).outcome("twilio-CA1-first")).toMatchObject({ outcome: "failed" })
  })

  it("leaves a live process's utterances alone, and fails those of a stopped process or an older build", () => {
    const dir = outputDir()
    const stopped = spawnSync(process.execPath, ["-e", ""]).pid!
    leftover(dir, "twilio-CA1-live", { pid: process.ppid, bridge: "theirs" })
    // A process this user may not signal, such as launchd or init, is still running.
    leftover(dir, "twilio-CA2-unsignalable", { pid: 1, bridge: "theirs" })
    leftover(dir, "twilio-CA3-stopped", { pid: stopped, bridge: "theirs" })
    leftover(dir, "twilio-CA4-older", undefined)
    expect(failLeftoverVoiceUtterances(dir, "start")).toBe(asRoot ? 3 : 2)
    expect(voiceUtterances(dir).outcome("twilio-CA3-stopped")).toMatchObject({ outcome: "failed" })
    expect(voiceUtterances(dir).outcome("twilio-CA4-older")).toMatchObject({ outcome: "failed" })
    expect(voiceUtterances(dir).get("twilio-CA1-live")).not.toBeNull()
    if (!asRoot) expect(voiceUtterances(dir).get("twilio-CA2-unsignalable")).not.toBeNull()
  })
})
