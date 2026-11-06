// Outbound BlueBubbles meta-content guard.
//
// Blocks accidental delivery of internal/meta text — pipeline section markers,
// surfacing-mechanics prefixes, reasoning tags — to the live iMessage channel.
// Failure mode is "drop and log", never queue for later delivery.
//
// Patterns are deliberately narrow: bracketed system markers and angle-bracket
// reasoning tags. Plain prose mentioning "inner dialog" or "attention queue"
// is NOT blocked, so user-facing replies that legitimately discuss those
// concepts still pass.

import { emitNervesEvent } from "../nerves/runtime"

const META_CONTENT_PATTERNS: readonly RegExp[] = [
  /\[surfaced from inner dialog\]/i,
  /\[pending from [^\]]+\]:/i,
  /\[conversation scope:/i,
  /\[recent active lanes\]/i,
  /\[routing control:/i,
  /<\/?think>/i,
]

export function containsInternalMetaMarkers(text: string | undefined | null): boolean {
  if (!text) return false
  return META_CONTENT_PATTERNS.some((pattern) => pattern.test(text))
}

export interface BluebubblesMetaBlockedOptions {
  site: "flush" | "flushNow" | "proactive" | "drain"
  message: string
  meta?: Record<string, unknown>
}

export function emitBluebubblesMetaBlocked(options: BluebubblesMetaBlockedOptions): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_meta_blocked",
    message: options.message,
    meta: {
      site: options.site,
      ...options.meta,
    },
  })
}
