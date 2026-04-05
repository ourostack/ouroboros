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
  "repertoire/tools-memory",
  "repertoire/tools-bridge",
  "repertoire/tools-session",
  "repertoire/tools-continuity",
  "repertoire/tools-surface",
  "repertoire/tools-config",
  // CLI sub-modules: cli-exec.ts is the router with emitNervesEvent calls;
  // cli-parse and cli-render are pure functions with no side effects.
  "daemon/cli-parse",
  "daemon/cli-render",
  // Shared utility modules: pure helpers consumed by modules that own observability.
  "arc/json-store",
  "repertoire/api-client",
  "mind/embedding-provider",
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
