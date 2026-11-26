// The letters on disk (design §3.2): one append-only JSONL file per letter in <bundle>/state/letters/, the letter on
// the first line and an event on each line after it. Only the daemon's writer (writer.ts) uses this, one call at a
// time, so nothing here locks. Every append is fsynced, and a torn last line from a crash is cut off before the next
// append so it never fuses with a new event.
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Letter, LetterEvent } from "./letter"

/** The file calls the store makes; tests pass a copy that records the fsyncs. */
export type StoreIo = Pick<typeof fs,
  "openSync" | "closeSync" | "writeSync" | "fsyncSync" | "fstatSync" | "readSync" | "ftruncateSync" | "readFileSync"
  | "renameSync" | "mkdirSync" | "readdirSync" | "existsSync" | "unlinkSync">

export interface StoredLetter {
  letter: Letter
  events: LetterEvent[]
  /** Whether it has been rolled into closed/. */
  closed: boolean
}

const LETTER_ID = /^ltr_[0-9A-Za-z]+$/
const NEXT_CODE = "next-code"

export class LetterStore {
  constructor(readonly dir: string, private readonly io: StoreIo = fs) {
    emitNervesEvent({ level: "debug", component: "daemon", event: "letters.store_opened", message: "letters store opened", meta: {} })
  }

  /** Writes a new letter's file, then syncs the file and the folder, so the letter survives a crash once this returns. */
  create(letter: Letter): void {
    const file = this.openFile(letter.id)
    this.makeDir(this.dir)
    const fd = this.io.openSync(file, "wx", 0o600)
    try {
      this.io.writeSync(fd, `${JSON.stringify(letter)}\n`)
      this.io.fsyncSync(fd)
    } finally {
      this.io.closeSync(fd)
    }
    this.syncDir(this.dir)
    emitNervesEvent({ component: "daemon", event: "letters.letter_created", message: "letter file created", meta: { kind: letter.kind } })
  }

  /**
   * Removes a letter file a failed create left behind, then syncs the folder. Returns whether no file is left; a
   * leftover the call couldn't remove is the writer's to index, so a retry finds it.
   */
  discard(id: string): boolean {
    const file = this.openFile(id)
    try {
      if (this.io.existsSync(file)) {
        this.io.unlinkSync(file)
        this.syncDir(this.dir)
      }
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.discard_failed", message: "a failed create's letter file could not be removed", meta: { reason: (error as Error).message } })
    }
    return !this.io.existsSync(file)
  }

  /** Appends one event to an open letter, after cutting any torn last line back to the last newline. */
  append(id: string, event: LetterEvent): void {
    const fd = this.io.openSync(this.openFile(id), "r+")
    try {
      const end = this.lastNewlineEnd(fd)
      this.io.ftruncateSync(fd, end)
      this.io.writeSync(fd, `${JSON.stringify(event)}\n`, end)
      this.io.fsyncSync(fd)
    } finally {
      this.io.closeSync(fd)
    }
    emitNervesEvent({ component: "daemon", event: "letters.event_appended", message: "letter event appended", meta: { t: event.t } })
  }

  /** One letter, open or closed; null when there is none or its first line is torn. */
  read(id: string): StoredLetter | null {
    const open = this.openFile(id)
    if (this.io.existsSync(open)) return this.parse(open, false)
    const closed = this.closedFiles().find((file) => path.basename(file, ".jsonl") === id)
    return closed ? this.parse(closed, true) : null
  }

  /** Moves a closed letter into closed/YYYY-MM/ with a rename, then syncs both folders. */
  roll(id: string, at: Date): void {
    const month = at.toISOString().slice(0, 7)
    const target = path.join(this.dir, "closed", month)
    this.makeDir(target)
    this.io.renameSync(this.openFile(id), path.join(target, `${id}.jsonl`))
    this.syncDir(target)
    this.syncDir(this.dir)
    emitNervesEvent({ component: "daemon", event: "letters.letter_rolled", message: "closed letter rolled", meta: { month } })
  }

  /** Every readable letter, open and closed, for rebuilding the index when the daemon starts. */
  loadAll(): StoredLetter[] {
    const loaded: StoredLetter[] = []
    for (const file of this.letterFiles(this.dir)) {
      const letter = this.parse(file, false)
      if (letter) loaded.push(letter)
    }
    for (const file of this.closedFiles()) {
      const letter = this.parse(file, true)
      if (letter) loaded.push(letter)
    }
    emitNervesEvent({ component: "daemon", event: "letters.store_loaded", message: "letters loaded from disk", meta: { letters: loaded.length } })
    return loaded
  }

  /** The next code number on record; 1 when none is, or the record can't be read. */
  readNextCode(): number {
    const file = path.join(this.dir, NEXT_CODE)
    if (!this.io.existsSync(file)) return 1
    const value = Number(this.io.readFileSync(file, "utf8"))
    return Number.isInteger(value) && value > 0 ? value : 1
  }

  /** Records the next code number: a temporary file, synced, renamed over the record, then the folder synced. */
  writeNextCode(next: number): void {
    this.makeDir(this.dir)
    const temp = path.join(this.dir, `${NEXT_CODE}.tmp`)
    const fd = this.io.openSync(temp, "w", 0o600)
    try {
      this.io.writeSync(fd, String(next))
      this.io.fsyncSync(fd)
    } finally {
      this.io.closeSync(fd)
    }
    this.io.renameSync(temp, path.join(this.dir, NEXT_CODE))
    this.syncDir(this.dir)
  }

  private openFile(id: string): string {
    if (!LETTER_ID.test(id)) throw new Error(`${id} is not a letter id.`)
    return path.join(this.dir, `${id}.jsonl`)
  }

  /** Makes a folder and any missing parents, syncing the parent of each one it made so the new entries survive a crash. */
  private makeDir(dir: string): void {
    const missing: string[] = []
    for (let at = dir; !this.io.existsSync(at); at = path.dirname(at)) missing.push(at)
    if (missing.length === 0) return
    this.io.mkdirSync(dir, { recursive: true })
    for (const made of missing) this.syncDir(path.dirname(made))
  }

  private syncDir(dir: string): void {
    const fd = this.io.openSync(dir, "r")
    try {
      this.io.fsyncSync(fd)
    } finally {
      this.io.closeSync(fd)
    }
  }

  /** The length of the file up to and including its last newline. */
  private lastNewlineEnd(fd: number): number {
    const size = this.io.fstatSync(fd).size
    const buffer = Buffer.alloc(size)
    this.io.readSync(fd, buffer, 0, size, 0)
    return buffer.lastIndexOf(0x0a) + 1
  }

  private letterFiles(dir: string): string[] {
    if (!this.io.existsSync(dir)) return []
    return this.io.readdirSync(dir).filter((name) => name.startsWith("ltr_") && name.endsWith(".jsonl")).map((name) => path.join(dir, name))
  }

  private closedFiles(): string[] {
    const closed = path.join(this.dir, "closed")
    if (!this.io.existsSync(closed)) return []
    // Only the month folders the roll writes; anything else under closed/ is left alone.
    return this.io.readdirSync(closed).filter((month) => /^\d{4}-\d{2}$/.test(month)).flatMap((month) => this.letterFiles(path.join(closed, month)))
  }

  /**
   * Complete lines only: a torn last line is left for the next append to cut. A first line that isn't a letter makes
   * the file unreadable; a later line that isn't JSON is skipped.
   */
  private parse(file: string, closed: boolean): StoredLetter | null {
    const [first, ...rest] = this.io.readFileSync(file, "utf8").split("\n").slice(0, -1).map(parseLine)
    if (!isStoredLetter(first, path.basename(file, ".jsonl"))) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.file_unreadable", message: "a letter file without a letter on its first line was skipped", meta: { file: path.basename(file) } })
      return null
    }
    const events = rest.filter(isStoredEvent)
    if (events.length < rest.length) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.line_unreadable", message: "letter lines that aren't events were skipped", meta: { skipped: rest.length - events.length } })
    }
    return { letter: first, events, closed }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The fields the index and the doors read from a stored letter, with its id matching its file's name. */
function isStoredLetter(value: unknown, id: string): value is Letter {
  return isRecord(value) && value.v === 1 && value.id === id && typeof value.code === "string" && /^L\d+$/.test(value.code)
    && typeof value.kind === "string" && typeof value.subject === "string" && typeof value.createdAt === "string"
    && Array.isArray(value.options) && isRecord(value.from) && typeof value.from.agent === "string"
}

function isStoredEvent(value: unknown): value is LetterEvent {
  return isRecord(value) && typeof value.t === "string" && typeof value.at === "string"
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}
