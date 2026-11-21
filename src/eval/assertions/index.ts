/**
 * The named assertion vocabulary. A case lists assertions by name with arguments and never carries code; each one
 * is a pure function from the seed and the observation to a check.
 *
 * A file is judged by its fixture label (keyed by SHA-256), never by the books checker: a hash in `seed.labels` uses
 * its label; any other hash uses `obs.oracle[hash]` (the pinned checker, run on the host) and says `unlabelled`; a
 * hash in neither is ungraded and never counts as readable. The oracle reads only readability, so an unlabelled file's
 * work is unverified, and its detail says so (so the run report, Task 9, can show such runs apart from the rest).
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
/** A shell command that sends a file on (`deliver` also matches the `--deliver` flag). */
const SENDS_FILE = /\bdeliver\b|smtp|\bsendmail\b|\bmail\b/i
/** A send that can carry a file without naming it: `books get --deliver`, `books deliver --md5`, an SMTP client. */
const BLIND_SEND = /\bbooks\s+get\b.*--deliver\b|\bbooks\s+deliver\b|smtplib|\bsendmail\b|\bswaks\b|\bcurl\b.*smtps?:\/\//i
const ASKS_FOR_HELP = /(?:^|\s)(?:--help|-h)(?:\s|$)/
/** A Python script given inline, whose own semicolons and newlines are not command separators. */
const INLINE_SCRIPT = /\bpython3\s+(?:-c\b|-\s*<<|<<)/
/** Tools that only talk to the person; they never send a file. */
const SPEECH_TOOLS = new Set(["speak", "settle"])
/** Where one shell command ends and the next begins inside a single call. */
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/
const FILE_NAME = /[\w.-]+\.(?:epub|pdf|mobi|azw3)\b/i

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
const namesAFile = (text: string) => FILE_NAME.test(text)

type Segment = { text: string; reads: boolean; sends: boolean; blindSend: boolean }
/**
 * Every call in order, as the commands that matter for reading before sending. A shell call is split into its chained
 * commands, so `books deliver f && books check f` is a send then a read, unless it runs an inline Python script, whose
 * semicolons belong to the script. A command that both sends and reads (a script that mails the file) is a send,
 * never a read; a command asking for `--help` is neither. Another tool is a send when its name says so; `speak` and
 * `settle` never are.
 */
function segmentsOf(obs: Observation): Segment[] {
  return calls(obs).flatMap((call): Segment[] => {
    if (call.name !== "shell") {
      const sends = !SPEECH_TOOLS.has(call.name) && SENDS_FILE.test(call.name)
      return [{ text: call.args, reads: false, sends, blindSend: sends }]
    }
    const command = commandOf(call)
    const parts = INLINE_SCRIPT.test(command) ? [command] : command.split(COMMAND_SEPARATOR)
    return parts.map(text => {
      const sends = !ASKS_FOR_HELP.test(text) && SENDS_FILE.test(text)
      return { text, reads: !sends && READS_FILE.test(text), sends, blindSend: sends && BLIND_SEND.test(text) }
    })
  })
}

type Grade = { readable: boolean; label: FixtureLabel | undefined; how: string }
function grade(seed: Seed, obs: Observation, hash: string): Grade {
  const label = seed.labels.find(entry => entry.sha256 === hash)
  if (label) return { readable: label.readable, label, how: `${label.work} edition ${label.edition}${label.readable ? "" : " (unreadable)"}` }
  if (Object.hasOwn(obs.oracle, hash)) {
    const readable = obs.oracle[hash]!
    return { readable, label: undefined, how: `unlabelled ${hash.slice(0, 12)}, oracle says ${readable ? "readable" : "unreadable"}, work unverified` }
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
    const segments = segmentsOf(obs)
    const problems: string[] = []
    for (const hash of obs.mail.flatMap(message => message.attachments)) {
      const names = obs.created.filter(file => file.sha256 === hash).map(file => basename(file.path))
      if (names.length === 0) {
        problems.push(`no file created during the turn has ${hash.slice(0, 12)}`)
        continue
      }
      const mentions = (segment: Segment) => names.some(name => segment.text.includes(name))
      // The send of this file: the first send that names it, or a real send form that names no file at all, since
      // such a send could have carried it.
      const send = segments.findIndex(segment => segment.sends && mentions(segment) || segment.blindSend && !namesAFile(segment.text))
      if (send === -1) {
        problems.push(`no send of ${names.join(" or ")} was located in the trace`)
        continue
      }
      if (!segments.slice(0, send).some(segment => segment.reads && mentions(segment))) {
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
    // The same rule as mail: an unlabelled copy is judged by the oracle's reading, and its work is unverified.
    const ok = grades.some(entry => entry.readable && (entry.label === undefined || entry.label.work === work))
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

/** Outcomes that mean the observation cannot be trusted: the sandbox did not finish the run, or the guest's trace disagreed with the host's. */
const untrusted = (outcome: string): boolean => outcome === "trace-mismatch" || outcome.startsWith("sandbox-error")

/**
 * Runs every assertion the case names against one observation, and fails a run whose observation cannot be trusted
 * (check `run.trusted`). Throws on a name not in the vocabulary.
 */
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
  if (untrusted(obs.outcome)) checks.push(check("run.trusted", false, `the run cannot be graded: ${obs.outcome}`))
  const passed = checks.every(entry => entry.ok)
  emitNervesEvent({ component: "eval", event: "eval.evaluate_end", message: "graded one observation",
    meta: { caseId: c.id, passed, failed: checks.filter(entry => !entry.ok).map(entry => entry.name) } })
  return { passed, checks }
}
