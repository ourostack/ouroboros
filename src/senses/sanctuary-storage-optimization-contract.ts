import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["unraid_get_storage", "sanctuary_get_media_optimization"] as const

function normalizedRequest(request: string): string {
  return request
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[^a-z0-9']+/gu, " ")
    .trim()
}

export function sanctuaryStorageOptimizationRequiredToolCalls(
  request: string,
  advertisedToolNames: readonly string[],
): { names: readonly string[]; retryMessage: string } | undefined {
  const normalized = normalizedRequest(request)
  const hasStorageSubject = /\b(?:space|storage)\b/u.test(normalized)
  const hasUsageDiagnosis = /\b(?:using|taking up|find what|diagnos(?:e|is))\b/u.test(normalized)
  const hasShrinkIntent = /\b(?:make it smaller|shrink|reclaim|free up|reduce|optimi[sz])\b/u.test(normalized)
  const advertised = new Set(advertisedToolNames)
  if (!hasStorageSubject || !hasUsageDiagnosis || !hasShrinkIntent || !REQUIRED_TOOL_NAMES.every((name) => advertised.has(name))) return undefined

  const names = [...REQUIRED_TOOL_NAMES]
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_storage_optimization_obligation",
    message: "storage diagnosis and optimization intent requires both safe evidence reads",
    meta: { requiredToolNames: names },
  })
  return {
    names,
    retryMessage: "Run both safe reads now, identify the largest measured evidence, report Unmanic and Jellyfin findings, and propose a sample encode without inventing future savings. Do not ask permission or send Ari to a shell or QDirStat while these typed reads are available.",
  }
}
