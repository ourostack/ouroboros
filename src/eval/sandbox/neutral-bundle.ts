/**
 * What an interview run's projected bundle is made to say about providers, and the check that it names no vendor.
 *
 * In the sandbox the model is always the host's, served over the container's stdin and stdout, so the bundle's
 * provider fields pick nothing there. The seed's still name vendors and models (`agent.json`'s lanes and
 * `providerFallback`, `provider-readiness.json`'s list), and an arm that reads one sends it to the host, whose brand
 * scan voids the request (version 2, an H arm). So for an interview run each lane names one neutral provider and
 * model, the fallback list goes, and the readiness list is empty. `github-copilot` is a provider `agent.json` accepts
 * (`heart/identity.ts`), and the turn never builds it: the injected runtime replaces the lane's provider.
 *
 * Then every regular text file of the projected bundle is scanned for `VENDOR_PATTERN`, and a hit refuses the run
 * before any container starts.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { VENDOR_PATTERN } from "../interviews/protocol"

/** The provider and model each lane of an interview's `agent.json` names. */
export const NEUTRAL_LANE = { provider: "github-copilot", model: "model" } as const
/** A text file larger than this is not scanned, and refuses the run. */
export const VENDOR_SCAN_MAX_BYTES = 8 * 1024 * 1024
/** How much of a file is read to tell a binary (a NUL byte in it) from text. */
const SNIFF_BYTES = 8000
const LANES = ["humanFacing", "agentFacing"] as const

type Json = Record<string, unknown>

function readObject(file: string): Json | undefined {
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined
}

const writeJson = (file: string, value: Json): void => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

/** Rewrites the bundle's provider fields to the neutral ones and returns a gap for each file it changed. */
export function neutralProviders(bundle: string): string[] {
  const gaps: string[] = []
  const agentFile = path.join(bundle, "agent.json")
  const agent = readObject(agentFile)
  if (agent) {
    let changed = "providerFallback" in agent
    delete agent.providerFallback
    for (const lane of LANES) {
      const value = agent[lane]
      if (value === null || typeof value !== "object" || !("provider" in value)) continue
      agent[lane] = { ...value, ...NEUTRAL_LANE }
      changed = true
    }
    if (changed) {
      writeJson(agentFile, agent)
      gaps.push(`agent.json: each provider lane names ${NEUTRAL_LANE.provider} and model "${NEUTRAL_LANE.model}", and providerFallback is left out; the host's runtime serves the model in the sandbox`)
    }
  }
  const readinessFile = path.join(bundle, "provider-readiness.json")
  const readiness = readObject(readinessFile)
  if (readiness && Array.isArray(readiness.providers) && readiness.providers.length > 0) {
    writeJson(readinessFile, { ...readiness, providers: [] })
    gaps.push("provider-readiness.json: its providers list is empty; the host's runtime serves the model in the sandbox")
  }
  emitNervesEvent({ component: "eval", event: "eval.sandbox_neutral_providers", message: "named neutral providers in an interview's bundle", meta: { rewritten: gaps.length } })
  return gaps
}

/** Every regular file under `root`, relative to it, sorted; symbolic links are left out. */
function regularFiles(root: string, relative = ""): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...regularFiles(root, child))
    else if (entry.isFile()) found.push(child)
  }
  return found
}

/** Throws, naming each file and its count of vendor words (never the text around them), when the bundle has any. */
export function checkVendorWords(bundle: string): void {
  const pattern = new RegExp(VENDOR_PATTERN, "gi")
  const found: string[] = []
  let hits = 0
  for (const file of regularFiles(bundle)) {
    const full = path.join(bundle, file)
    const head = Buffer.alloc(SNIFF_BYTES)
    const fd = fs.openSync(full, "r")
    let read: number
    try { read = fs.readSync(fd, head, 0, SNIFF_BYTES, 0) } finally { fs.closeSync(fd) }
    if (head.subarray(0, read).includes(0)) continue
    if (fs.statSync(full).size > VENDOR_SCAN_MAX_BYTES) {
      found.push(`${file} (too large to scan)`)
      continue
    }
    const count = [...fs.readFileSync(full, "utf8").matchAll(pattern)].length
    if (count === 0) continue
    found.push(`${file} (${count})`)
    hits += count
  }
  if (found.length === 0) return
  emitNervesEvent({ component: "eval", level: "error", event: "eval.sandbox_vendor_words", message: "refused an interview bundle that names a vendor", meta: { files: found.length, hits } })
  throw new Error(`the interview's projected bundle names vendor or model words, which would void its sessions; no container was started: ${found.join(", ")}`)
}
