import { describe, expect, it } from "vitest"
import {
  parseVoiceMeetingUrl,
  redactVoiceMeetingUrl,
} from "../../../senses/voice/meeting"

describe("voice meeting intake", () => {
  it("classifies Riverside studio links and derives a stable safe session key", () => {
    const meeting = parseVoiceMeetingUrl(" https://riverside.fm/studio/ari-weekly?token=secret#frag ")
    const sameRoom = parseVoiceMeetingUrl("https://riverside.fm/studio/ari-weekly?token=different")

    expect(meeting).toMatchObject({
      provider: "riverside",
      host: "riverside.fm",
      redactedUrl: "https://riverside.fm/studio/:redacted",
      requiresBrowserJoin: true,
    })
    expect(meeting.sessionKey).toMatch(/^voice-riverside-[a-f0-9]{12}$/)
    expect(sameRoom.sessionKey).toBe(meeting.sessionKey)
  })

  it("accepts generic HTTPS meeting links without leaking path details", () => {
    const meeting = parseVoiceMeetingUrl("https://meet.example.com/private-room-123?token=secret")

    expect(meeting).toMatchObject({
      provider: "generic",
      host: "meet.example.com",
      redactedUrl: "https://meet.example.com/:redacted",
      requiresBrowserJoin: true,
    })
    expect(meeting.sessionKey).toMatch(/^voice-generic-[a-f0-9]{12}$/)
  })

  it("rejects blank, non-web, insecure generic, and malformed Riverside links", () => {
    expect(() => parseVoiceMeetingUrl("   ")).toThrow("voice meeting URL is empty")
    expect(() => parseVoiceMeetingUrl("not a url")).toThrow("voice meeting URL is invalid")
    expect(() => parseVoiceMeetingUrl("mailto:ari@example.com")).toThrow("voice meeting URL must be http or https")
    expect(() => parseVoiceMeetingUrl("http://meet.example.com/private-room")).toThrow("generic voice meeting URLs must use https")
    expect(() => parseVoiceMeetingUrl("https://riverside.fm/not-studio/ari")).toThrow("Riverside voice meeting URLs must use /studio/")
  })

  it("redacts unsafe URL parts defensively", () => {
    expect(redactVoiceMeetingUrl("not a url")).toBe(":invalid")
    expect(redactVoiceMeetingUrl("https://riverside.fm/studio/room?token=secret#hash")).toBe("https://riverside.fm/studio/:redacted")
    expect(redactVoiceMeetingUrl("https://example.com")).toBe("https://example.com/")
  })
})
