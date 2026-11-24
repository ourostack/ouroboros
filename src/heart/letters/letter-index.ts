// The daemon's in-memory index of letters (design §3.2): every letter's id, code, state and dedupe scope, rebuilt from
// the files when the daemon starts. There is no database; an agent has tens of open letters, not thousands.
import { emitNervesEvent } from "../../nerves/runtime"
import { letterState, type Letter, type LetterEvent, type LetterKind, type LetterState } from "./letter"
import type { StoredLetter } from "./store"

export interface IndexedLetter extends StoredLetter {
  state: LetterState
}

/** A send matching a letter answered this recently gets that answer, not a second letter. */
export const ANSWERED_DEDUPE_MS = 24 * 60 * 60 * 1000

/** `(from.agent, from.peer?.did ?? "local", dedupeKey)` (review M4); null when the letter has no dedupe key. */
export function dedupeScope(letter: Pick<Letter, "from" | "dedupeKey">): string | null {
  if (!letter.dedupeKey) return null
  return JSON.stringify([letter.from.agent, letter.from.peer?.did ?? "local", letter.dedupeKey])
}

function codeNumber(code: string): number {
  const match = /^L(\d+)$/.exec(code)
  return match ? Number(match[1]) : 0
}

export class LetterIndex {
  private readonly byId = new Map<string, IndexedLetter>()
  private highestCode = 0

  constructor(letters: readonly StoredLetter[], private recordedNextCode: number) {
    for (const stored of letters) this.add(stored)
    emitNervesEvent({ component: "daemon", event: "letters.index_built", message: "letters index built", meta: { letters: this.byId.size } })
  }

  add(stored: StoredLetter): IndexedLetter {
    const entry: IndexedLetter = { ...stored, events: [...stored.events], state: letterState(stored.events) }
    this.byId.set(stored.letter.id, entry)
    this.highestCode = Math.max(this.highestCode, codeNumber(stored.letter.code))
    return entry
  }

  addEvent(id: string, event: LetterEvent): IndexedLetter {
    const entry = this.byId.get(id)
    if (!entry) throw new Error(`The index has no letter ${id}.`)
    entry.events.push(event)
    entry.state = letterState(entry.events)
    return entry
  }

  markClosed(id: string): void {
    this.byId.get(id)!.closed = true
  }

  /** A letter by its id, or by its code in any case ("l7" finds L7). */
  get(idOrCode: string): IndexedLetter | undefined {
    const byId = this.byId.get(idOrCode)
    if (byId) return byId
    const code = idOrCode.toUpperCase()
    return [...this.byId.values()].find((entry) => entry.letter.code === code)
  }

  /** Waiting letters, or every letter with `all`, oldest first; narrowed by kind or by the agent that filed them. */
  list(filter: { all?: boolean; kind?: LetterKind; from?: string }): IndexedLetter[] {
    return [...this.byId.values()]
      .filter((entry) => (filter.all || entry.state === "waiting")
        && (!filter.kind || entry.letter.kind === filter.kind)
        && (!filter.from || entry.letter.from.agent === filter.from))
      .sort((a, b) => a.letter.createdAt.localeCompare(b.letter.createdAt))
  }

  /** The letter a new send duplicates: one waiting in the same scope, or one answered there in the last 24 hours. */
  findDuplicate(candidate: Pick<Letter, "from" | "dedupeKey">, now: number): { entry: IndexedLetter; why: "open" | "answered" } | null {
    const scope = dedupeScope(candidate)
    if (!scope) return null
    for (const entry of this.byId.values()) {
      if (dedupeScope(entry.letter) !== scope) continue
      if (entry.state === "waiting") return { entry, why: "open" }
      const answer = entry.events.find((event) => event.t === "answered")
      if (answer && now - Date.parse(answer.at) <= ANSWERED_DEDUPE_MS) return { entry, why: "answered" }
    }
    return null
  }

  /** Records that the counter moved past a code, so a create that fails after it can't hand the code out again. */
  reserve(next: number): void {
    this.recordedNextCode = Math.max(this.recordedNextCode, next)
  }

  /** The next code number: past the recorded counter and past every code on disk, so none is ever reused. */
  nextCode(): number {
    return Math.max(this.recordedNextCode, this.highestCode + 1)
  }
}
