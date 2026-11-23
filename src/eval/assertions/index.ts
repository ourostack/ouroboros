/**
 * The named assertion vocabulary. A case lists assertions by name with arguments and never carries code; each one
 * is a pure function from the seed and the observation to a check.
 *
 * A file is judged by its fixture label (keyed by SHA-256), never by the books checker: a hash in `seed.labels` uses
 * its label; any other hash uses `obs.oracle[hash]` (the pinned checker, run on the host) and says `unlabelled`; a
 * hash in neither is ungraded and never counts as readable. The oracle reads only readability, so an unlabelled file's
 * work is unverified, and its detail says so (so the run report, Task 9, can show such runs apart from the rest).
 */
import { posix } from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Case, FixtureLabel, Observation, Seed, TraceCall } from "../domain/case"
import { findHedges, REPLY_HEDGE_TERMS } from "../readback/hedges"

export type Check = { name: string; ok: boolean; detail: string }
type Assertion = (seed: Seed, obs: Observation, args: Record<string, unknown>) => Check

/** Claims of inability, on top of the gate's hedge terms, for sentences about the asked action. */
const INABILITY = /\bcan[’']?t\b|\bcannot\b|\bunable\b/i
/** A shell command that reads a book's contents. */
const READS_FILE = /books (check|text)\b|unzip|python3/
/** A shell command that sends a file on (`deliver` also matches the `--deliver` flag; `books send` mails without shelving). */
const SENDS_FILE = /\bdeliver\b|\bbooks\s+send\b|smtp|\bsendmail\b|\bmail\b/i
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

type Segment = { text: string; reads: boolean; sends: boolean; blindSend: boolean; downloads: boolean; files: string[]; globs: string[] }
/** `NAME=value` commands with nothing else in them, the way a shell call keeps a path to use again. */
const ASSIGNMENTS = /^\s*(?:(?:do|then)\s+)?((?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'=]*)\s*)+)$/
const ASSIGNMENT = /([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s"'=]*)/g
/** A plain `cd <folder>`, which changes what a relative wildcard after it names. */
const CHANGE_FOLDER = /^\s*cd\s+(\S+)\s*$/
/** A command that fetches a file, after which an earlier wildcard read no longer covers everything it matches. */
const DOWNLOADS = /\bbooks\s+(?:get|series)\b|\bcurl\b|\bwget\b/
/** `for NAME in WORDS`, whose body sees NAME as each of the words. */
const FOR_LOOP = /^\s*(?:(?:do|then)\s+)?for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/
const VARIABLE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g
const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2")
/**
 * A shell call's commands with the call's own variables written out, so `B=/x/books; F=a.epub; $B send "$F"` reads as
 * `/x/books send "a.epub"`, and each command's file and wildcard words resolved against the call's last `cd`. A loop
 * variable stands for each of its words in turn, so a command that uses one is written out once per word. Only
 * variables the call itself sets are known; each shell call is its own process, so nothing carries over from an
 * earlier call, and it starts in the agent's bundle, where created paths are rooted.
 */
function expandShell(parts: string[], start: string): Array<{ text: string; files: string[]; globs: string[] }> {
  const known = new Map<string, string[]>()
  let folder = start
  /** Every way the command reads with its variables written out, at most 256, so a longer loop credits its first 256 words. */
  const expand = (text: string): string[] => {
    const used = [...new Set([...text.matchAll(VARIABLE)].map(([, braced, bare]) => (braced ?? bare)!).filter(name => known.has(name)))]
    return used.reduce((texts, name) => texts.flatMap(each => known.get(name)!.map(value =>
      each.replace(VARIABLE, (whole, braced: string | undefined, bare: string | undefined) => (braced ?? bare) === name ? value : whole))).slice(0, 256), [text])
  }
  return parts.map(raw => {
    const texts = expand(raw)
    const text = texts[0]!
    if (ASSIGNMENTS.test(text)) {
      for (const [, name] of text.matchAll(ASSIGNMENT)) {
        known.set(name!, [...new Set(texts.flatMap(each => [...each.matchAll(ASSIGNMENT)].filter(([, n]) => n === name).map(([, , value]) => unquote(value!))))])
      }
    }
    const loop = FOR_LOOP.exec(text)
    if (loop) known.set(loop[1]!, [...new Set(texts.flatMap(each => [...FOR_LOOP.exec(each)![2]!.matchAll(SHELL_WORD)].map(([word]) => unquote(word))))])
    const cd = CHANGE_FOLDER.exec(text)
    if (cd) folder = posix.join(folder, unquote(cd[1]!))
    const words = [...new Set(texts.flatMap(fileWords))].map(word => word.startsWith("/") ? word : posix.join(folder, word))
    return { text, files: words.filter(word => !/[*?]/.test(word)), globs: words.filter(word => /[*?]/.test(word)) }
  })
}
/** A shell word, quotes and all, such as `"work/The Harbour Almanac.epub"` or `"$d"copy.epub` once expanded. */
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g
/** A book file named inside a longer word, such as the path in `zipfile.ZipFile("work/a.epub")`. */
const FILE_IN_WORD = /[^\s"'(),=;:]*\.(?:epub|pdf|mobi|azw3)\b/gi
const BOOK_FILE = /\.(?:epub|pdf|mobi|azw3)$/i
/** The book files and wildcards a command names, each as written (a quoted name may hold spaces). */
function fileWords(text: string): string[] {
  return [...text.matchAll(SHELL_WORD)].flatMap(([word]) => {
    const plain = word.replace(/["']/g, "")
    if (BOOK_FILE.test(plain) && !/[(),=;:]/.test(plain)) return [plain]
    return [...plain.matchAll(FILE_IN_WORD)].map(([found]) => found).concat(/[*?]/.test(plain) && !/[(),=;:]/.test(plain) ? [plain] : [])
  }).filter((word, i, all) => all.indexOf(word) === i)
}
/** A heredoc's body: text the shell feeds a command, not arguments it passes. The opening line and the end marker stay. */
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?(\n\s*\3\b)/g
/** A program that runs the text it is given as code (a shell, `eval`, an interpreter): its script or heredoc holds commands. */
const RUNS_TEXT = /(?:^|[\s;&|(`])(?:[\w.~/-]*\/)?(?:sh|bash|zsh|dash|ksh|eval|source|python[\d.]*|node|perl|ruby)(?=[\s;&|)`'"]|$)/
/** A program that only prints or searches text: the words it is given are written about, never passed on. */
const TEXT_ONLY = /^(?:echo|printf|grep|egrep|fgrep|rg)$/
/**
 * The words a shell command passes as arguments, with backslash escapes and quotes removed: `--flag`, `"--flag"` and
 * `\--flag` are each the flag, and a quoted sentence that mentions a flag is one word that is not the flag.
 */
function argumentWords(command: string): string[] {
  return [...command.replace(/\\(.)/g, "$1").replace(/[<>]/g, " ").matchAll(SHELL_WORD)].map(([word]) => word.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"))
}
/** Command substitution (`$(…)`, backticks, `<(…)`): a command run inside another command's words. */
const SUBSTITUTION = /\$\(|`|[<>]\(/
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
const SINGLE_QUOTED = /'[^']*'/g
const blank = (span: string) => " ".repeat(span.length)
/** A shell command's separate commands, split on `;`, `&`, `|`, `&&`, `||` and new lines outside quotes. */
function splitCommands(command: string): string[] {
  const parts = [""]
  for (const [token] of command.matchAll(/"(?:[^"\\]|\\.)*"?|'[^']*'?|&&|\|\||[;&|\n]|[^"';&|\n]+/g)) {
    if (/^(?:&&|\|\||[;&|\n])$/.test(token)) parts.push("")
    else parts[parts.length - 1] += token
  }
  return parts.map(part => part.replace(/^\s*export\s+/, ""))
}
/**
 * Whether a shell command passes `source` (a pattern) as an argument. A command that runs text as code, named outside
 * quotes and heredoc bodies (`sh -c '…'`, `bash <<EOF`, `| sh`, `eval`, `python3 -c`), is read whole, heredoc bodies
 * too, since any of its text may be a command. One that substitutes a command into its words is read whole apart from
 * heredoc bodies. Either fails on the pattern as a word anywhere in what is read. Otherwise each command, with the
 * call's own variables written out and heredoc bodies left out, fails on an argument word that is the pattern or
 * `pattern=value`, unless the program only prints or searches text and nothing pipes it into `xargs`.
 */
function passesArgument(command: string, start: string, source: string): boolean {
  const bodiless = command.replace(HEREDOC_BODY, "$1$4")
  const asWord = new RegExp(`(?:^|[^\\w-])(?:${source})(?![\\w-])`)
  const unescape = (text: string) => text.replace(/\\(.)/g, "$1")
  if (RUNS_TEXT.test(bodiless.replace(QUOTED, blank))) return asWord.test(unescape(command))
  if (SUBSTITUTION.test(bodiless.replace(SINGLE_QUOTED, blank))) return asWord.test(unescape(bodiless))
  const asArgument = new RegExp(`^(?:${source})(?:=.*)?$`)
  const textOnlyCounts = /\bxargs\b/.test(bodiless)
  return expandShell(splitCommands(bodiless), start).some(({ text }) => {
    const words = argumentWords(text).filter(word => !/^[A-Za-z_]\w*=/.test(word) || asArgument.test(word))
    return (textOnlyCounts || !TEXT_ONLY.test(basename(words[0] ?? ""))) && words.some(word => asArgument.test(word))
  })
}
/** The folder a shell call starts in: its own `cwd` argument, against the bundle, where created paths are rooted. */
function startFolder(call: TraceCall): string {
  try {
    const cwd = (JSON.parse(call.args) as { cwd?: unknown } | null)?.cwd
    return typeof cwd === "string" ? cwd : ""
  } catch {
    return ""
  }
}
/** The text of each inline Python script in a call: a `python3 -c` argument or a heredoc's body. */
const SCRIPT_TEXT = /\bpython3\s+-c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")|\bpython3\b[^\n]*<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n\s*\4\b/g
const scriptsOf = (command: string) => [...command.matchAll(SCRIPT_TEXT)].map(([, single, double, , , body]) => (single ?? double ?? body)!)
/** A plain `cd <folder>` at the front of an inline script's call, which the script's relative paths are read from. */
const LEADING_CD = /^\s*cd\s+(\S+)\s*(?:;|&&)/
const globPart = (part: string) => new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`)
/**
 * Whether a wildcard word, resolved against its folder, matches a file's whole bundle path. An absolute wildcard
 * carries the bundle's own folder in front, so the comparison runs from the end over every part of the file's path.
 */
function globMatches(glob: string, path: string): boolean {
  const globParts = glob.split("/").filter(Boolean)
  const pathParts = path.split("/").filter(Boolean)
  if (globParts.length < pathParts.length) return false
  return pathParts.every((part, i) => globPart(globParts[globParts.length - pathParts.length + i]!).test(part))
}
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
      return [{ text: call.args, reads: false, sends, blindSend: sends, downloads: false, files: [], globs: [] }]
    }
    const command = commandOf(call)
    const start = startFolder(call)
    const leading = LEADING_CD.exec(command)
    const split = expandShell(command.split(COMMAND_SEPARATOR), start)
    // An inline script stays one command, since its semicolons are the script's. It names the files its script opens,
    // and the files of any shell command around it that is a read on its own, such as a `books check` in the same
    // loop, or of one that sends it. A file the shell only copies or lists is not read because python3 runs in the call.
    const scripts = INLINE_SCRIPT.test(command) && expandShell(scriptsOf(command), leading ? posix.join(start, unquote(leading[1]!)) : start)
    // A command that sends names its file too, so a send piped through python3 is still found; it makes the whole
    // segment a send, which never counts as a read.
    const reads = split.filter(part => READS_FILE.test(part.text) || SENDS_FILE.test(part.text))
    const parts = scripts ? [{ text: command, files: [...new Set([...scripts, ...reads].flatMap(part => part.files))],
      globs: [...new Set([...scripts, ...reads].flatMap(part => part.globs))] }] : split
    return parts.map(({ text, files, globs }) => {
      const asksForHelp = ASKS_FOR_HELP.test(text)
      const sends = !asksForHelp && SENDS_FILE.test(text)
      return { text, reads: !sends && READS_FILE.test(text), sends, blindSend: sends && BLIND_SEND.test(text), downloads: !asksForHelp && DOWNLOADS.test(text), files, globs }
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
      const paths = obs.created.filter(file => file.sha256 === hash).map(file => file.path)
      const names = paths.map(basename)
      if (names.length === 0) {
        problems.push(`no file created during the turn has ${hash.slice(0, 12)}`)
        continue
      }
      // A file named in a shell command, resolved against the call's folder, must be this file, not one of the same name.
      const byName = (segment: Segment) => segment.files.some(file => paths.some(path => globMatches(file, path)))
      // A wildcard such as `work/2026-get/*.epub` names the file when it covers the file's whole path.
      const byGlob = (segment: Segment) => segment.globs.some(glob => paths.some(path => globMatches(glob, path)))
      const mentions = (segment: Segment) => byName(segment) || byGlob(segment)
      // The send of this file: the first send that names it, or a real send form that names no file at all, since
      // such a send could have carried it.
      const send = segments.findIndex(segment => segment.sends && mentions(segment) || segment.blindSend && !namesAFile(segment.text))
      if (send === -1) {
        problems.push(`no send of ${names.join(" or ")} was located in the trace`)
        continue
      }
      // A read by name holds. A read by wildcard holds only if nothing was downloaded after it, since a later download
      // can land inside the wildcard without ever being read.
      const readAt = (segment: Segment, at: number) => segment.reads
        && (byName(segment) || byGlob(segment) && !segments.slice(at + 1, send).some(later => later.downloads))
      if (!segments.slice(0, send).some(readAt)) {
        problems.push(`${names.join(" or ")} was not read before it was sent`)
      }
    }
    return check("trace.readBeforeSend", problems.length === 0, listed(problems))
  },

  "trace.never": (_seed, obs, args) => {
    const source = needString("trace.never", args, "pattern")
    const hits = calls(obs).filter(call => call.name === "shell" && passesArgument(commandOf(call), startFolder(call), source)).map(call => call.name)
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
