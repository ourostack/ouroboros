import { createHash } from "crypto"
import { emitNervesEvent } from "../../nerves/runtime"

export type VoiceMeetingProvider = "riverside" | "generic"

export interface VoiceMeeting {
  originalUrl: string
  provider: VoiceMeetingProvider
  host: string
  pathname: string
  redactedUrl: string
  sessionKey: string
  requiresBrowserJoin: boolean
}

function isRiversideHost(host: string): boolean {
  return host === "riverside.fm" || host === "riverside.com"
}

function stableMeetingHash(provider: VoiceMeetingProvider, url: URL): string {
  return createHash("sha256")
    .update(`${provider}:${url.protocol}//${url.host}${url.pathname}`)
    .digest("hex")
    .slice(0, 12)
}

function redactPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return "/"
  if (parts.length === 1) return "/:redacted"
  return `/${parts[0]}/:redacted`
}

export function redactVoiceMeetingUrl(input: string): string {
  try {
    const url = new URL(input)
    return `${url.protocol}//${url.host}${redactPath(url.pathname)}`
  } catch {
    return ":invalid"
  }
}

export function parseVoiceMeetingUrl(input: string): VoiceMeeting {
  const trimmed = input.trim()
  if (!trimmed) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_meeting_rejected",
      message: "voice meeting URL is empty",
      meta: { reason: "empty" },
    })
    throw new Error("voice meeting URL is empty")
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_meeting_rejected",
      message: "voice meeting URL is invalid",
      meta: { reason: "invalid_url" },
    })
    throw new Error("voice meeting URL is invalid")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_meeting_rejected",
      message: "voice meeting URL must be http or https",
      meta: { protocol: url.protocol },
    })
    throw new Error("voice meeting URL must be http or https")
  }

  const host = url.hostname.toLowerCase()
  const provider: VoiceMeetingProvider = isRiversideHost(host) ? "riverside" : "generic"
  if (provider === "riverside" && !url.pathname.startsWith("/studio/")) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_meeting_rejected",
      message: "Riverside voice meeting URLs must use /studio/",
      meta: { host, redactedUrl: redactVoiceMeetingUrl(trimmed) },
    })
    throw new Error("Riverside voice meeting URLs must use /studio/")
  }
  if (provider === "generic" && url.protocol !== "https:") {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_meeting_rejected",
      message: "generic voice meeting URLs must use https",
      meta: { host, redactedUrl: redactVoiceMeetingUrl(trimmed) },
    })
    throw new Error("generic voice meeting URLs must use https")
  }

  const hash = stableMeetingHash(provider, url)
  const meeting: VoiceMeeting = {
    originalUrl: trimmed,
    provider,
    host,
    pathname: url.pathname,
    redactedUrl: redactVoiceMeetingUrl(trimmed),
    sessionKey: `voice-${provider}-${hash}`,
    requiresBrowserJoin: true,
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_meeting_parsed",
    message: "voice meeting URL parsed",
    meta: {
      provider: meeting.provider,
      host: meeting.host,
      sessionKey: meeting.sessionKey,
      redactedUrl: meeting.redactedUrl,
    },
  })

  return meeting
}
