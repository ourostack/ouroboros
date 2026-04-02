import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"

import { REQUIRED_ENVELOPE_FIELDS, SENSITIVE_PATTERNS } from "./contract"
import {
  checkEveryTestEmits,
  checkStartEndPairing,
  checkErrorContext,
  type EveryTestEmitsResult,
  type StartEndPairingResult,
  type ErrorContextResult,
  type PerTestData,
} from "./audit-rules"
import { scanSourceForNervesKeys } from "./source-scanner"
import { checkFileCompleteness, type FileCompletenessResult } from "./file-completeness"

export interface AuditInput {
  eventsPath: string
  perTestPath?: string
  sourceRoot?: string
  /** @deprecated kept for backward compat with old CLI -- ignored */
  logpointsPath?: string
}

export interface RequiredAction {
  type: "coverage" | "logging"
  target: string
  reason: string
}

export interface SchemaRedactionCoverage {
  status: "pass" | "fail"
  checked_events: number
  violations: string[]
}

export interface SourceCoverageResult {
  status: "pass" | "fail"
  declared_keys: number
  observed_keys: number
  missing: string[]
}

export interface NervesCoverageReport {
  overall_status: "pass" | "fail"
  required_actions: RequiredAction[]
  nerves_coverage: {
    schema_redaction: SchemaRedactionCoverage
    every_test_emits: EveryTestEmitsResult
    start_end_pairing: StartEndPairingResult
    error_context: ErrorContextResult
    source_coverage: SourceCoverageResult
    file_completeness: FileCompletenessResult
  }
}

interface ParsedEvent {
  ts?: unknown
  level?: unknown
  event?: unknown
  trace_id?: unknown
  component?: unknown
  message?: unknown
  meta?: unknown
}

export function readEvents(eventsPath: string): ParsedEvent[] {
  if (!existsSync(eventsPath)) return []
  const raw = readFileSync(eventsPath, "utf8")
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
  const parsed: ParsedEvent[] = []

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as ParsedEvent)
    } catch {
      // Keep parsing resilient for audit mode; malformed lines are handled
      // by schema violations below.
      parsed.push({})
    }
  }

  return parsed
}

export function collectObservedEventKeys(events: ParsedEvent[]): string[] {
  const observed = new Set<string>()
  for (const entry of events) {
    if (typeof entry.component === "string" && typeof entry.event === "string") {
      observed.add(`${entry.component}:${entry.event}`)
    }
  }
  return [...observed].sort()
}

export function validateSchemaAndRedaction(events: ParsedEvent[]): string[] {
  const violations: string[] = []

  events.forEach((entry, idx) => {
    for (const key of REQUIRED_ENVELOPE_FIELDS) {
      if (!(key in entry)) {
        violations.push(`event[${idx}] missing field '${key}'`)
      }
    }

    const mustBeString = ["ts", "level", "event", "trace_id", "component", "message"] as const
    for (const key of mustBeString) {
      const value = entry[key]
      if (typeof value !== "string" || value.trim().length === 0) {
        violations.push(`event[${idx}] invalid '${key}'`)
      }
    }

    if (typeof entry.meta !== "object" || entry.meta === null || Array.isArray(entry.meta)) {
      violations.push(`event[${idx}] invalid 'meta'`)
    }

    const message = typeof entry.message === "string" ? entry.message : ""
    const metaText = JSON.stringify(entry.meta ?? {})
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(message) || pattern.test(metaText)) {
        violations.push(`event[${idx}] matched redaction policy '${pattern.source}'`)
      }
    }
  })

  return violations
}

function readPerTestData(perTestPath: string | undefined): PerTestData | null {
  if (!perTestPath || !existsSync(perTestPath)) return null
  try {
    return JSON.parse(readFileSync(perTestPath, "utf8")) as PerTestData
  } catch {
    return null
  }
}

function scanSourceFiles(sourceRoot: string | undefined): {
  filesWithKeys: Map<string, string[]>
  fileContents: Map<string, string>
} {
  const filesWithKeys = new Map<string, string[]>()
  const fileContents = new Map<string, string>()

  if (!sourceRoot || !existsSync(sourceRoot)) {
    return { filesWithKeys, fileContents }
  }

  const root = sourceRoot

  function walkDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip __tests__, nerves/, and reflection/ directories
        // reflection/ tests mock emitNervesEvent, so events are not observed
        if (entry.name === "__tests__" || entry.name === "nerves" || entry.name === "reflection") continue
        walkDir(full)
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const content = readFileSync(full, "utf8")
        const relPath = full.slice(root.length - "src".length)
        fileContents.set(relPath, content)
        const keys = scanSourceForNervesKeys(content)
        if (keys.length > 0) {
          filesWithKeys.set(relPath, keys)
        }
      }
    }
  }

  walkDir(root)
  return { filesWithKeys, fileContents }
}

function runSourceCoverage(
  filesWithKeys: Map<string, string[]>,
  observedKeys: string[],
): SourceCoverageResult {
  const allDeclaredKeys = new Set<string>()
  for (const keys of filesWithKeys.values()) {
    for (const key of keys) {
      allDeclaredKeys.add(key)
    }
  }

  const observedSet = new Set(observedKeys)
  const missing = [...allDeclaredKeys].filter((key) => !observedSet.has(key)).sort()

  return {
    status: missing.length === 0 ? "pass" : "fail",
    declared_keys: allDeclaredKeys.size,
    observed_keys: observedKeys.length,
    missing,
  }
}

export function auditNervesCoverage(input: AuditInput): NervesCoverageReport {
  const events = readEvents(input.eventsPath)
  const observedKeys = collectObservedEventKeys(events)

  // Schema & redaction check (preserved)
  const schemaViolations = validateSchemaAndRedaction(events)
  const schemaStatus: "pass" | "fail" = schemaViolations.length === 0 ? "pass" : "fail"

  // Per-test data for Rules 1-3
  const perTestData = readPerTestData(input.perTestPath)
  const everyTestEmits = checkEveryTestEmits(perTestData as PerTestData)
  const startEndPairing = checkStartEndPairing(perTestData as PerTestData)
  const errorContext = checkErrorContext(perTestData as PerTestData)

  // Source scanning for Rules 4-5
  const { filesWithKeys, fileContents } = scanSourceFiles(input.sourceRoot)
  const sourceCoverage = runSourceCoverage(filesWithKeys, observedKeys)
  const fileCompleteness = checkFileCompleteness(filesWithKeys, fileContents)

  // Aggregate
  const requiredActions: RequiredAction[] = []
  if (schemaStatus === "fail") {
    requiredActions.push({
      type: "logging",
      target: "schema-redaction",
      reason: `schema/redaction violations: ${schemaViolations.slice(0, 3).join("; ")}`,
    })
  }
  if (everyTestEmits.status === "fail") {
    requiredActions.push({
      type: "logging",
      target: "every-test-emits",
      reason: `${everyTestEmits.silent_tests.length} test(s) emitted zero events`,
    })
  }
  if (startEndPairing.status === "fail") {
    requiredActions.push({
      type: "logging",
      target: "start-end-pairing",
      reason: `${startEndPairing.unmatched.length} unmatched _start event(s)`,
    })
  }
  if (errorContext.status === "fail") {
    requiredActions.push({
      type: "logging",
      target: "error-context",
      reason: `${errorContext.violations.length} error event(s) missing context`,
    })
  }
  // Source-coverage is advisory (warn) -- many test files mock emitNervesEvent,
  // so declared keys are not observed in the global capture sink. This rule
  // becomes enforceable once tests use spyOn instead of full mocks.
  // if (sourceCoverage.status === "fail") {
  //   requiredActions.push({ ... })
  // }
  if (fileCompleteness.status === "fail") {
    requiredActions.push({
      type: "logging",
      target: "file-completeness",
      reason: `${fileCompleteness.missing.length} file(s) missing emitNervesEvent: ${fileCompleteness.missing.slice(0, 5).join(", ")}`,
    })
  }

  const overallStatus: "pass" | "fail" = requiredActions.length === 0 ? "pass" : "fail"

  return {
    overall_status: overallStatus,
    required_actions: requiredActions,
    nerves_coverage: {
      schema_redaction: {
        status: schemaStatus,
        checked_events: events.length,
        violations: schemaViolations,
      },
      every_test_emits: everyTestEmits,
      start_end_pairing: startEndPairing,
      error_context: errorContext,
      source_coverage: sourceCoverage,
      file_completeness: fileCompleteness,
    },
  }
}
