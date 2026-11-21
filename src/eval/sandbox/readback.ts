/**
 * Builds a sandboxed run's `Observation` on the host, after the agent container has stopped, from sources the agent
 * did not write: the household sidecar's state file (library and mail), the files that appeared in the writable
 * mounts during the turn, and the tool calls the provider returned on the host.
 *
 * The guest's own record of the turn supplies only what the host cannot see, the order of calls and replies and the
 * replies' text. Its calls must match the host's; a guest trace that differs (a forged or missing call) makes the
 * outcome `trace-mismatch`, and the host's calls are kept. Snapshots never follow a link and read only regular files,
 * so a link the agent leaves in a writable mount cannot point the host at its own files.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Observation, Seed, SeedBook, TraceCall } from "../domain/case"

export type HouseholdState = { library: SeedBook[]; mail: Observation["mail"]; events: number }
export type GuestTurn = Pick<Observation, "timeline" | "finalReply" | "outcome">

/**
 * What a snapshot will read. The containers cannot write a file over `bytes` (their `fsize` limit), and a turn that
 * leaves more files or deeper folders than this cannot be read back, which fails the run rather than stalling the host.
 */
export const SNAPSHOT_LIMITS = { files: 20_000, depth: 32, bytes: 256 * 1024 * 1024 }

/** Path relative to `root` → SHA-256, for every regular file under each of `entries` (folders or single files). */
export function snapshotFiles(root: string, entries: string[], limits = SNAPSHOT_LIMITS): Map<string, string> {
  const found = new Map<string, string>()
  let seen = 0
  const visit = (relative: string, depth: number): void => {
    const full = path.join(root, relative)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(full)
    } catch {
      return
    }
    seen += 1
    if (seen > limits.files) throw new Error(`the turn left more than ${limits.files} files to read back`)
    if (stat.isDirectory()) {
      if (depth > limits.depth) throw new Error(`the turn left folders more than ${limits.depth} deep at ${relative}`)
      for (const name of fs.readdirSync(full)) visit(path.posix.join(relative, name), depth + 1)
    } else if (stat.isFile()) {
      if (stat.size > limits.bytes) throw new Error(`${relative} is larger than ${limits.bytes} bytes`)
      found.set(relative, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"))
    }
  }
  for (const entry of entries) visit(entry, 0)
  return found
}

/** Files that are new, or whose bytes changed, between two snapshots, sorted by path. */
export function createdSince(before: Map<string, string>, after: Map<string, string>): Observation["created"] {
  return [...after].filter(([file, hash]) => before.get(file) !== hash).sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({ path: file, sha256: hash }))
}

function invalid(why: string): never {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.readback_error", message: "household state could not be read back", meta: { why } })
  throw new Error(`household state: ${why}`)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const list = (value: unknown, why: string): unknown[] => Array.isArray(value) ? value : invalid(why)
const hash = (value: unknown, why: string): string => isObject(value) && typeof value.sha256 === "string" ? value.sha256 : invalid(why)

/** The sidecar's `state.json`: its library, and each message as one entry per recipient with its attachments' hashes. */
export function readHouseholdState(file: string): HouseholdState {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    invalid(`not readable JSON: ${(error as Error).message}`)
  }
  const state = isObject(raw) ? raw : {}
  const library = list(state.library, "no library").map((book) => {
    const sha256 = hash(book, "a book has no hash")
    const entry = book as Record<string, unknown>
    return { id: Number(entry.id), title: String(entry.title), sha256 }
  })
  const mail = list(state.mail, "no mail").flatMap((message) => {
    const entry = isObject(message) ? message : {}
    const attachments = list(entry.attachments ?? [], "attachments are not a list").map((part) => hash(part, "an attachment has no hash"))
    return list(entry.to, "a message has no recipients").map((to) => ({ to: String(to), attachments }))
  })
  return { library, mail, events: list(state.events, "no events").length }
}

const sameCall = (a: TraceCall, b: TraceCall): boolean => a.name === b.name && a.args === b.args

/** The guest's order of calls and replies, with each call replaced by the host's record of it. */
export function mergeTimeline(guest: Observation["timeline"], hostCalls: TraceCall[]): { timeline: Observation["timeline"]; mismatch: boolean } {
  const guestCalls = guest.filter((entry): entry is TraceCall => entry.kind === "call")
  const mismatch = guestCalls.length !== hostCalls.length || guestCalls.some((call, index) => !sameCall(call, hostCalls[index]!))
  if (mismatch) {
    emitNervesEvent({ component: "eval", level: "warn", event: "eval.readback_trace_mismatch", message: "the guest's trace differs from the host's record of the model's calls", meta: { guest: guestCalls.length, host: hostCalls.length } })
    return { timeline: [...hostCalls, ...guest.filter((entry) => entry.kind === "reply")], mismatch }
  }
  let next = 0
  return { timeline: guest.map((entry) => entry.kind === "call" ? hostCalls[next++]! : entry), mismatch }
}

export type AssembleInput = {
  seed: Seed
  turn: GuestTurn
  hostCalls: TraceCall[]
  steps: number
  household: HouseholdState
  created: Observation["created"]
  /** Where the host holds a copy of a hash's bytes: created files and the sidecar's shelved books. */
  bytes: Map<string, string>
  /** The pinned checker, for files no label covers; without one they stay ungraded, which fails them. */
  oracle?: (file: string) => Promise<boolean>
}

export async function assembleObservation(input: AssembleInput): Promise<Observation> {
  emitNervesEvent({ component: "eval", event: "eval.readback_start", message: "assembling a sandboxed run's observation", meta: { created: input.created.length } })
  const labelled = new Set(input.seed.labels.map((entry) => entry.sha256))
  const seen = [
    ...input.household.library.map((book) => book.sha256),
    ...input.household.mail.flatMap((message) => message.attachments),
    ...input.created.map((file) => file.sha256),
  ]
  const oracle: Record<string, boolean> = {}
  for (const sha256 of new Set(seen)) {
    const file = input.bytes.get(sha256)
    if (labelled.has(sha256) || !input.oracle || !file) continue
    oracle[sha256] = await input.oracle(file)
  }
  const merged = mergeTimeline(input.turn.timeline, input.hostCalls)
  const observation: Observation = {
    timeline: merged.timeline,
    finalReply: input.turn.finalReply,
    library: input.household.library,
    mail: input.household.mail,
    created: input.created,
    // A run the sandbox could not finish keeps its reason; otherwise a guest trace that disagrees with the host's wins.
    outcome: input.turn.outcome.startsWith("sandbox-error") || !merged.mismatch ? input.turn.outcome : "trace-mismatch",
    steps: input.steps,
    oracle,
  }
  emitNervesEvent({ component: "eval", event: "eval.readback_end", message: "assembled a sandboxed run's observation", meta: { outcome: observation.outcome, graded: Object.keys(oracle).length } })
  return observation
}
