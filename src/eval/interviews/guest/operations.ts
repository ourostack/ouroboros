/**
 * The books operations every X arm offers, in one table: the same books command line underneath (the eval's books
 * command in the bundle, run against the fake household), the same inputs and the same results. Each arm only
 * presents them differently. The host turns any arm's call back into the operation's command line
 * (`canonicalCommand`), so the case's own assertions read every arm's trace the same way.
 */
import { emitNervesEvent } from "../../../nerves/runtime"

export type Param = {
  name: string
  kind: "string" | "number" | "list" | "flag"
  description: string
  required?: boolean
  /** A positional word on the command line, in this order; otherwise a `--name` flag. */
  positional?: boolean
}

export type Operation = {
  /** The command's words after `books`. */
  words: string[]
  summary: string
  readOnly: boolean
  params: Param[]
  /** Example inputs, for help text. */
  example: string
}

const files = (description: string): Param => ({ name: "files", kind: "list", description, required: true, positional: true })
const ACCEPT: Param = { name: "accept-check-failure", kind: "flag", description: "Shelve or send a file even though `check` rejected it. Only when the owner asked for that copy anyway." }
const DUPLICATE: Param = { name: "allow-duplicate", kind: "flag", description: "Shelve the file even when a book with the same title is already on the shelf." }

export const OPERATIONS: readonly Operation[] = [
  {
    words: ["search"], readOnly: true, summary: "Search the online catalogue for downloadable EPUB editions of a book.",
    params: [{ name: "query", kind: "string", description: "Title and, if you like, author.", required: true, positional: true }],
    example: "search \"The Harbour Almanac\"",
  },
  {
    words: ["get"], readOnly: false, summary: "Download one catalogue edition into the work folder; returns the file's path. Give md5, or a title to take the first exact title match.",
    params: [
      { name: "md5", kind: "string", description: "The edition's md5 from search." },
      { name: "title", kind: "string", description: "With md5, names the file; alone, the exact title to download." },
      { name: "author", kind: "string", description: "With title alone, narrows the search." },
    ],
    example: "get --md5 0123456789abcdef0123456789abcdef",
  },
  {
    words: ["check"], readOnly: true, summary: "Check that EPUB files are readable: a verdict per file, its problems and a passage from a quarter of the way in.",
    params: [files("The EPUB files to check.")],
    example: "check work/1700000000-ab12cd34/the-harbour-almanac.epub",
  },
  {
    words: ["text"], readOnly: true, summary: "The start of a book's text.",
    params: [{ name: "file", kind: "string", description: "The EPUB file.", required: true, positional: true }, { name: "chars", kind: "number", description: "How many characters (default 4000)." }],
    example: "text work/1700000000-ab12cd34/the-harbour-almanac.epub --chars 2000",
  },
  {
    words: ["library", "find"], readOnly: true, summary: "Find books on the household's shelf (the library) by title or author; returns each match's id.",
    params: [{ name: "query", kind: "string", description: "Words of the title or author.", required: true, positional: true }],
    example: "library find \"The Harbour Almanac\"",
  },
  {
    words: ["library", "add"], readOnly: false, summary: "Put EPUB files on the shelf. A file `check` rejects is refused, and a title already on the shelf is reported instead of added.",
    params: [files("The EPUB files to shelve."), DUPLICATE, ACCEPT],
    example: "library add work/1700000000-ab12cd34/the-harbour-almanac.epub",
  },
  {
    words: ["library", "remove"], readOnly: false, summary: "Take a book off the shelf by id, keeping a backup copy of its file in the removed folder first.",
    params: [{ name: "id", kind: "number", description: "The book's id on the shelf.", required: true, positional: true }],
    example: "library remove 187",
  },
  {
    words: ["library", "replace"], readOnly: false, summary: "Shelve a file in place of a book: adds the file, then removes the old id with a backup.",
    params: [
      { name: "id", kind: "number", description: "The id of the book to replace.", required: true, positional: true },
      { name: "file", kind: "string", description: "The EPUB file to shelve instead.", required: true, positional: true },
      ACCEPT,
    ],
    example: "library replace 187 work/1700000000-ab12cd34/the-harbour-almanac.epub",
  },
  {
    words: ["send"], readOnly: false, summary: "Mail EPUB files to the owner's e-reader without shelving them. A file `check` rejects is refused.",
    params: [files("The EPUB files to send."), ACCEPT],
    example: "send work/1700000000-ab12cd34/the-harbour-almanac.epub",
  },
  {
    words: ["deliver"], readOnly: false, summary: "Shelve EPUB files and mail them to the owner's e-reader. A file `check` rejects is refused.",
    params: [files("The EPUB files to deliver."), DUPLICATE, ACCEPT],
    example: "deliver work/1700000000-ab12cd34/the-harbour-almanac.epub",
  },
  {
    words: ["ledger"], readOnly: true, summary: "The last twenty things these book commands did.",
    params: [],
    example: "ledger",
  },
]

export type OperationInput = Record<string, string | number | boolean | string[] | undefined>

/** POSIX shell quoting, only where a word needs it. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The books command's argv for an operation's input, in the order the books command reads it. */
export function argvOf(op: Operation, input: OperationInput): string[] {
  const argv = [...op.words]
  for (const param of op.params.filter((p) => p.positional)) {
    const value = input[param.name]
    if (value === undefined) continue
    argv.push(...(Array.isArray(value) ? value : [String(value)]))
  }
  for (const param of op.params.filter((p) => !p.positional)) {
    const value = input[param.name]
    if (value === undefined || value === false) continue
    argv.push(`--${param.name}`, ...(param.kind === "flag" ? [] : [String(value)]))
  }
  return argv
}

/** The operation's command line, as the case assertions read a shell call. */
export function commandLine(argv: string[]): string {
  const line = ["books", ...argv.map(shellQuote)].join(" ")
  emitNervesEvent({ component: "eval", event: "eval.interview_operation_line", message: "wrote an operation as its command line", meta: { words: argv.slice(0, 2).join(" ") } })
  return line
}
