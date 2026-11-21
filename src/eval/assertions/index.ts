/**
 * The named assertion vocabulary. A case lists assertions by name with arguments and never carries code; each one
 * is a pure function from the seed and the observation to a check.
 *
 * A file is judged by its fixture label (keyed by SHA-256), never by the books checker: a hash in `seed.labels` uses
 * its label; any other hash uses `obs.oracle[hash]` (the pinned checker, run on the host) and says `unlabelled`; a
 * hash in neither is ungraded and never counts as readable.
 */
import { emitNervesEvent } from "../../nerves/runtime"
import type { Case, FixtureLabel, Observation, Seed, TraceCall } from "../domain/case"
import { findHedges, REPLY_HEDGE_TERMS } from "../readback/hedges"

export type Check = { name: string; ok: boolean; detail: string }
type Assertion = (seed: Seed, obs: Observation, args: Record<string, unknown>) => Check

/** Claims of inability, on top of the gate's hedge terms, for sentences about the asked action. */
const INABILITY = /\bcan[’']?t\b|\bcannot\b|\bunable\b/i
/** A shell command that reads a book's contents. */
const READS_FILE = /books (check|text)\b|unzip|python3/
/** A shell command that sends a file on. */
const SENDS_FILE = /\bdeliver\b|\bsmtp\b|\bsendmail\b|\bmail\b/i

function needString(name: string, args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} needs args.${key} (a string)`)
  return value
}
function needNumber(name: string, args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== "number") throw new Error(`${name} needs args.${key} (a number)`)
  return value
}
function needList<T>(name: string, args: Record<string, unknown>, key: string, type: "string" | "number", fallback?: T[]): T[] {
  const value = args[key] ?? fallback
  if (!Array.isArray(value) || value.some(item => typeof item !== type)) throw new Error(`${name} needs args.${key} (a ${type} list)`)
  return value as T[]
}

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail })
const calls = (obs: Observation) => obs.timeline.filter((step): step is TraceCall => step.kind === "call")
/** A shell call's command: the recorded arguments are JSON text, or the command itself. */
function commandOf(call: TraceCall): string {
  try {
    const parsed: unknown = JSON.parse(call.args)
    const command = (parsed as { command?: unknown } | null)?.command
    return typeof command === "string" ? command : call.args
  } catch {
    return call.args
  }
}
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

type Grade = { readable: boolean; label: FixtureLabel | undefined; how: string }
function grade(seed: Seed, obs: Observation, hash: string): Grade {
  const label = seed.labels.find(entry => entry.sha256 === hash)
  if (label) return { readable: label.readable, label, how: `${label.work} edition ${label.edition}${label.readable ? "" : " (unreadable)"}` }
  if (Object.hasOwn(obs.oracle, hash)) {
    const readable = obs.oracle[hash]!
    return { readable, label: undefined, how: `unlabelled ${hash.slice(0, 12)}, oracle says ${readable ? "readable" : "unreadable"}` }
  }
  return { readable: false, label: undefined, how: `ungraded ${hash.slice(0, 12)} (no label, no oracle reading)` }
}

const listed = (items: string[]) => items.length > 0 ? items.join("; ") : "none"

export const ASSERTIONS: Record<string, Assertion> = {
  "mail.sentAtLeastOne": (_seed, obs) =>
    check("mail.sentAtLeastOne", obs.mail.length > 0, `${obs.mail.length} message(s) sent`),

  "mail.onlyTo": (_seed, obs, args) => {
    const address = needString("mail.onlyTo", args, "address").toLowerCase()
    const others = obs.mail.map(message => message.to).filter(to => to.toLowerCase() !== address)
    return check("mail.onlyTo", others.length === 0, `other recipients: ${listed(others)}`)
  },

  "mail.everyAttachmentIs": (seed, obs, args) => {
    const work = needString("mail.everyAttachmentIs", args, "work")
    if (typeof args.readable !== "boolean") throw new Error("mail.everyAttachmentIs needs args.readable (a boolean)")
    const attachments = obs.mail.flatMap(message => message.attachments)
    if (attachments.length === 0) return check("mail.everyAttachmentIs", false, "no attachment was sent")
    const grades = attachments.map(hash => grade(seed, obs, hash))
    // An unlabelled file has no known work; the oracle's reading stands in for both, and the detail says so.
    const ok = grades.every(entry => entry.readable === args.readable && (entry.label === undefined || entry.label.work === work))
    return check("mail.everyAttachmentIs", ok, `sent: ${listed(grades.map(entry => entry.how))}`)
  },

  "trace.readBeforeSend": (_seed, obs) => {
    const timeline = calls(obs)
    const shells = timeline.map(call => call.name === "shell" ? commandOf(call) : "")
    const problems: string[] = []
    for (const hash of obs.mail.flatMap(message => message.attachments)) {
      const names = obs.created.filter(file => file.sha256 === hash).map(file => basename(file.path))
      if (names.length === 0) {
        problems.push(`no file created during the turn has ${hash.slice(0, 12)}`)
        continue
      }
      const mentions = (command: string) => names.some(name => command.includes(name))
      const send = shells.findIndex(command => mentions(command) && SENDS_FILE.test(command) && !READS_FILE.test(command))
      const before = send === -1 ? shells : shells.slice(0, send)
      if (!before.some(command => mentions(command) && READS_FILE.test(command))) {
        problems.push(`${names.join(" or ")} was not read before it was sent`)
      }
    }
    return check("trace.readBeforeSend", problems.length === 0, listed(problems))
  },

  "trace.never": (_seed, obs, args) => {
    const pattern = new RegExp(needString("trace.never", args, "pattern"))
    const hits = calls(obs).filter(call => pattern.test(call.args)).map(call => call.name)
    return check("trace.never", hits.length === 0, `matching calls: ${listed(hits)}`)
  },

  "library.lacks": (_seed, obs, args) => {
    const id = needNumber("library.lacks", args, "id")
    return check("library.lacks", !obs.library.some(book => book.id === id), `library ids: ${obs.library.map(book => book.id).join(", ")}`)
  },

  "library.holdsWork": (seed, obs, args) => {
    const work = needString("library.holdsWork", args, "work")
    const grades = obs.library.map(book => grade(seed, obs, book.sha256))
    // Only a labelled copy proves the work; an unlabelled file's work is unknown whatever the oracle says.
    const ok = grades.some(entry => entry.label?.work === work && entry.readable)
    return check("library.holdsWork", ok, `shelved: ${listed(grades.map(entry => entry.how))}`)
  },

  "library.othersUnchanged": (seed, obs, args) => {
    const except = needList<number>("library.othersUnchanged", args, "except", "number", [])
    const changed = seed.library.filter(book => !except.includes(book.id)).filter(book =>
      !obs.library.some(now => now.id === book.id && now.title === book.title && now.sha256 === book.sha256))
    return check("library.othersUnchanged", changed.length === 0, `missing or changed: ${listed(changed.map(book => String(book.id)))}`)
  },

  "library.noNewCopiesOf": (seed, obs, args) => {
    const editions = needList<string>("library.noNewCopiesOf", args, "editions", "string")
    const added = obs.library.filter(book => !seed.library.some(was => was.id === book.id && was.sha256 === book.sha256))
    const banned = added.filter(book => {
      const label = seed.labels.find(entry => entry.sha256 === book.sha256)
      return label !== undefined && editions.includes(label.edition)
    })
    return check("library.noNewCopiesOf", banned.length === 0, `new banned copies: ${listed(banned.map(book => String(book.id)))}`)
  },

  "disk.createdBytesOf": (seed, obs, args) => {
    const bookId = needNumber("disk.createdBytesOf", args, "bookId")
    const book = seed.library.find(entry => entry.id === bookId)
    if (!book) return check("disk.createdBytesOf", false, `book ${bookId} is not in the seed library`)
    const matching = obs.created.filter(file => file.sha256 === book.sha256)
    // A file whose bytes were already on disk before the turn is not a backup the turn made.
    const fresh = matching.filter(file => !seed.disk.includes(file.sha256))
    const detail = fresh.length > 0 ? `backup: ${fresh.map(file => file.path).join(", ")}`
      : matching.length > 0 ? "the only copy of those bytes was already on disk in the seed" : "no file created during the turn has those bytes"
    return check("disk.createdBytesOf", fresh.length > 0, detail)
  },

  "mail.none": (_seed, obs) =>
    check("mail.none", obs.mail.length === 0, `${obs.mail.length} message(s) sent`),

  "reply.namesShelf": (_seed, obs, args) => {
    const titles = needList<string>("reply.namesShelf", args, "titles", "string")
    const ids = needList<number>("reply.namesShelf", args, "ids", "number")
    const reply = obs.finalReply.toLowerCase()
    const named = [...titles.filter(title => reply.includes(title.toLowerCase())),
      ...ids.map(String).filter(id => new RegExp(`(?<!\\d)${id}(?!\\d)`).test(reply))]
    return check("reply.namesShelf", named.length > 0, `named: ${listed(named)}`)
  },

  "reply.noHedgeAbout": (_seed, obs, args) => {
    const topic = new RegExp(needString("reply.noHedgeAbout", args, "topic"), "i")
    const sentences = obs.finalReply.split(/[.!?\n]/).filter(sentence => topic.test(sentence))
    const hits = sentences.flatMap(sentence => findHedges(sentence, [...REPLY_HEDGE_TERMS, INABILITY]))
    return check("reply.noHedgeAbout", hits.length === 0, `hedges about the action: ${listed(hits)}`)
  },
}

/** Runs every assertion the case names against one observation. Throws on a name not in the vocabulary. */
export function evaluate(c: Case, obs: Observation): { passed: boolean; checks: Check[] } {
  emitNervesEvent({ component: "eval", event: "eval.evaluate_start", message: "grading one observation", meta: { caseId: c.id } })
  const checks = c.assertions.map(ref => {
    if (!Object.hasOwn(ASSERTIONS, ref.name)) {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.evaluate_error",
        message: "case names an assertion the vocabulary lacks", meta: { caseId: c.id, assertion: ref.name } })
      throw new Error(`Unknown assertion: ${ref.name}`)
    }
    return ASSERTIONS[ref.name]!(c.seed, obs, ref.args ?? {})
  })
  const passed = checks.every(entry => entry.ok)
  emitNervesEvent({ component: "eval", event: "eval.evaluate_end", message: "graded one observation",
    meta: { caseId: c.id, passed, failed: checks.filter(entry => !entry.ok).map(entry => entry.name) } })
  return { passed, checks }
}
