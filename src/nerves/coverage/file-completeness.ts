/**
 * File completeness check (Rule 5).
 *
 * Every production file with executable code must have at least one
 * emitNervesEvent call. Type-only files (containing only type/interface/enum
 * declarations) are exempt.
 */

export interface FileCompletenessResult {
  status: "pass" | "fail"
  missing: string[]
  exempt: string[]
}

/**
 * Determines if a source file is type-only or a pure assembly/re-export file.
 * Exempt files contain no runtime behavior requiring independent observability.
 *
 * Exempt patterns:
 * - Files with only type/interface/enum declarations
 * - `const ... as const` declarations (frozen compile-time values)
 * - Files whose only executable code is const array spreads (assembly/composition)
 * - Files whose only executable code is re-exports
 */
export function isTypeOnlyFile(source: string): boolean {
  const lines = source.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    /* v8 ignore start -- regex branches: functionally tested in file-completeness.test.ts @preserve */
    // Skip lines that are const+as-const (type-equivalent frozen values)
    if (/\bconst\s/.test(trimmed) && /\bas\s+const\b/.test(trimmed)) continue
    // Skip const declarations that are pure data (arrays, objects, maps, sets)
    if (/\bconst\s+\w+[\s:][^=]*=\s*[\[{]/.test(trimmed)) continue
    if (/\bconst\s+\w+[\s:][^=]*=\s*\w+\.map\(/.test(trimmed)) continue
    if (/^export\s+const\s+\w+[\s:][^=]*=\s*[\[{]/.test(trimmed)) continue
    if (/^export\s+const\s+\w+[\s:][^=]*=\s*\w+\.map\(/.test(trimmed)) continue
    if (/\bconst\s+\w+[\s:][^=]*=\s*new\s+(Set|Map)\b/.test(trimmed)) continue
    // Check for executable code markers
    if (/\b(function|class|const|let|var)\s/.test(trimmed)) return false
    /* v8 ignore stop */
  }
  return true
}

// Sub-modules dispatched through a centralized pattern where the router
// handles all observability events. These files don't need independent
// emitNervesEvent calls.
const DISPATCH_EXEMPT_PATTERNS = [
  "repertoire/tools-files",
  "repertoire/tools-shell",
  "repertoire/tools-notes",
  "repertoire/tools-bridge",
  "repertoire/tools-session",
  "repertoire/tools-continuity",
  "repertoire/tools-surface",
  "repertoire/tools-config",
  "repertoire/tools-base",
  // CLI sub-modules: cli-exec.ts is the router with emitNervesEvent calls;
  // cli-parse, cli-render, cli-help, and their small helpers are pure functions/data with no side effects.
  "daemon/cli-parse",
  "daemon/cli-render",
  "daemon/cli-help",
  "daemon/vault-items",
  // Shared utility modules: pure helpers consumed by modules that own observability.
  "arc/json-store",
  "heart/mail-import-discovery",
  "repertoire/api-client",
  "repertoire/github-client",
  "mind/embedding-provider",
  // Commerce utility module: error classes and pure helpers (no independent side effects).
  "repertoire/commerce-errors",
  // Diary integrity: pure detection utility (pattern matching only). The caller
  // (diary.ts saveDiaryEntry) owns observability via mind.diary_integrity_warning.
  "mind/diary-integrity",
  // Provenance trust: pure classification function (no side effects). Callers
  // (note-search.ts, tools-notes.ts) own observability for note search results.
  "mind/provenance-trust",
  // Log redaction: pure utility consumed by the NDJSON sink (no independent side effects).
  "nerves/redact",
  // Bundle templates: pure constants (gitignore template string, PII
  // directory list). No runtime behavior — consumed by tools-bundle.ts
  // which owns the observability for bundle operations.
  "repertoire/bundle-templates",
  // HTTP health probe: pure HTTP utility factory. The HealthMonitor caller
  // owns observability via daemon.health_result events.
  "daemon/http-health-probe",
  // Attachment helper modules: generic file-path/extension utilities and the
  // source registry are pure support seams. The orchestrator/adapters that
  // call them own the observability.
  "heart/attachments/originals",
  "heart/attachments/sources/index",
  "heart/attachments/sources/cli-local-file",
  // Browser-safe Outlook contract helpers: shared types/formatting helpers
  // consumed by server readers and the UI. Outlook read/render modules own
  // the observability for these projections.
  "heart/outlook/outlook-types",
  // Mail search relevance scorer: pure heuristic function (regex + counter
  // arithmetic). The caller (search-cache.ts searchMailSearchCache) owns
  // observability via senses.mail_search_cache_upserted and friends.
  "mailroom/search-relevance",
  // Trip ledger crypto helpers: pure RSA/AES envelope construction + slug
  // hashing. The caller (trips/store.ts) owns observability via
  // trips.ledger_created and trips.evidence_attached.
  "trips/core",
  // Outlook HTTP helper modules: route/static/transport/hook seams are
  // dispatched by outlook-http.ts, whose server lifecycle owns observability.
  "heart/outlook/outlook-http-transport",
  "heart/outlook/outlook-http-static",
  "heart/outlook/outlook-http-hooks",
  "heart/outlook/outlook-http-routes",
  "heart/outlook/outlook-http-response",
]

function isDispatchExempt(filePath: string): boolean {
  return DISPATCH_EXEMPT_PATTERNS.some((pattern) => filePath.includes(pattern))
}

/**
 * Check that all production files have at least one emitNervesEvent call.
 *
 * @param filesWithKeys - Map of filePath -> keys found by source scanner
 * @param fileContents - Map of filePath -> source content for ALL production files
 */
export function checkFileCompleteness(
  filesWithKeys: Map<string, string[]>,
  fileContents: Map<string, string>,
): FileCompletenessResult {
  const missing: string[] = []
  const exempt: string[] = []

  for (const [filePath, source] of fileContents) {
    const hasKeys = filesWithKeys.has(filePath) && filesWithKeys.get(filePath)!.length > 0
    if (hasKeys) continue

    if (isTypeOnlyFile(source) || isDispatchExempt(filePath)) {
      exempt.push(filePath)
    } else {
      missing.push(filePath)
    }
  }

  return {
    status: missing.length === 0 ? "pass" : "fail",
    missing: missing.sort(),
    exempt: exempt.sort(),
  }
}
