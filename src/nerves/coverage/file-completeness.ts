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
    // Skip lines that are const+as-const (type-equivalent frozen values)
    if (/\bconst\s/.test(trimmed) && /\bas\s+const\b/.test(trimmed)) continue
    // Skip const array assembly: const x = [...a, ...b] or const x: Type[] = [...]
    if (/\bconst\s+\w+[\s:][^=]*=\s*\[/.test(trimmed)) continue
    // Skip const that is a .map() call on another const (derived array)
    if (/\bconst\s+\w+[\s:][^=]*=\s*\w+\.map\(/.test(trimmed)) continue
    // Skip export const re-assignments
    if (/^export\s+const\s+\w+[\s:][^=]*=\s*\[/.test(trimmed)) continue
    if (/^export\s+const\s+\w+[\s:][^=]*=\s*\w+\.map\(/.test(trimmed)) continue
    // Skip Set constructors (e.g., export const x = new Set(...))
    if (/\bconst\s+\w+[\s:][^=]*=\s*new\s+Set\b/.test(trimmed)) continue
    // Check for executable code markers
    if (/\b(function|class|const|let|var)\s/.test(trimmed)) return false
  }
  return true
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

    if (isTypeOnlyFile(source)) {
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
