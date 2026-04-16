export const REQUIRED_ENVELOPE_FIELDS = [
  "ts",
  "level",
  "event",
  "trace_id",
  "component",
  "message",
  "meta",
] as const

export const SENSITIVE_PATTERNS: RegExp[] = [
  /\btoken\b["']?\s*[:=]/i,
  /\bapi[_-]?key\b["']?\s*[:=]/i,
  /\bpassword\b["']?\s*[:=]/i,
  /\bsecret\b["']?\s*[:=]/i,
  /\bauthorization\b["']?\s*[:=]/i,
]

export function eventKey(component: string, event: string): string {
  return `${component}:${event}`
}
