import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"

import { readDiaryEntries, resolveDiaryRoot, type DiaryEntry } from "../mind/diary"
import type { FriendRecord } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"

export interface KeptNoteSource {
  kind: "diary" | "journal" | "friend-note"
  label: string
  ref?: string
}

export interface KeptNoteCandidate {
  text: string
  source: KeptNoteSource
}

export type KeptNotesJudgeResult =
  | { status: "none"; pressure: string[] }
  | { status: "found"; note: string; sourceIndexes?: number[] }
  | { status: "fuzzy"; hint: string; sourceIndexes?: number[] }

export interface KeptNotesJudgeInput {
  query: string
  candidates: KeptNoteCandidate[]
}

export type KeptNotesJudge = (input: KeptNotesJudgeInput) => Promise<KeptNotesJudgeResult>

export type KeptNotesOutcome =
  | { status: "none"; elapsedMs: number; pressure: string[] }
  | { status: "found"; note: string; sources: KeptNoteSource[]; elapsedMs: number }
  | { status: "fuzzy"; hint: string; sources: KeptNoteSource[]; elapsedMs: number }
  | { status: "timeout"; elapsedMs: number }
  | { status: "error"; reason: string; elapsedMs: number }

export interface InjectKeptNotesOptions {
  diaryRoot?: string
  journalDir?: string
  friend?: FriendRecord
  judge?: KeptNotesJudge
  timeoutMs?: number
  channel?: string
  traceId?: string
  signal?: AbortSignal
}

interface JournalIndexEntry {
  filename: string
  preview: string
}

interface KeptNotesRuntimeCallbacks {
  onModelStart(): void
  onModelStreamStart(): void
  onTextChunk(text: string): void
  onReasoningChunk(text: string): void
  onToolStart(name: string, args: Record<string, string>): void
  onToolEnd(name: string, summary: string, success: boolean): void
  onError(error: Error, severity: "transient" | "terminal"): void
}

export interface KeptNotesRuntime {
  resetTurnState?(messages: OpenAI.ChatCompletionMessageParam[]): void
  streamTurn(request: {
    messages: OpenAI.ChatCompletionMessageParam[]
    activeTools: OpenAI.ChatCompletionFunctionTool[]
    callbacks: KeptNotesRuntimeCallbacks
    signal?: AbortSignal
    toolChoiceRequired?: boolean
    reasoningEffort?: string
  }): Promise<{ content?: string }>
}

const DEFAULT_TIMEOUT_MS = 2500
const MAX_CANDIDATES = 8
const NOOP_CALLBACKS: KeptNotesRuntimeCallbacks = {
  onModelStart() {},
  onModelStreamStart() {},
  onTextChunk() {},
  onReasoningChunk() {},
  onToolStart() {},
  onToolEnd() {},
  onError() {},
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function latestUserText(messages: OpenAI.ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user" || typeof message.content !== "string") continue
    const text = message.content.trim()
    if (text) return text
  }
  return ""
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  )
}

function scoreText(queryTerms: Set<string>, text: string): number {
  const textTerms = tokenize(text)
  let matches = 0
  for (const term of queryTerms) {
    if (textTerms.has(term)) matches += 1
  }
  return matches / queryTerms.size
}

function readJournalIndex(journalDir: string): JournalIndexEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(journalDir, ".index.json"), "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is JournalIndexEntry => (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { filename?: unknown }).filename === "string" &&
        typeof (entry as { preview?: unknown }).preview === "string"
      ))
  } catch {
    return []
  }
}

function journalDirForDiaryRoot(diaryRoot: string, explicitJournalDir?: string): string {
  if (explicitJournalDir) return explicitJournalDir
  return path.join(path.dirname(diaryRoot), "journal")
}

function diaryCandidate(fact: DiaryEntry): KeptNoteCandidate {
  return {
    text: fact.text,
    source: { kind: "diary", label: "diary", ref: fact.id },
  }
}

function friendNoteCandidates(friend: FriendRecord | undefined, queryTerms: Set<string>): Array<{ candidate: KeptNoteCandidate; score: number }> {
  if (!friend) return []
  return Object.entries(friend.notes ?? {})
    .map(([key, note]) => {
      const text = `${friend.name} / ${key}: ${note.value}`
      return {
        candidate: {
          text,
          source: { kind: "friend-note" as const, label: `friend note: ${friend.name}`, ref: key },
        },
        score: scoreText(queryTerms, `${key} ${note.value}`),
      }
    })
    .filter((entry) => entry.score > 0)
}

export function gatherKeptNotesCandidates(query: string, options: InjectKeptNotesOptions = {}): KeptNoteCandidate[] {
  const queryTerms = tokenize(query)
  if (queryTerms.size === 0) return []

  const diaryRoot = resolveDiaryRoot(options.diaryRoot)
  const diaryEntries = readDiaryEntries(diaryRoot)
  const diaryCandidates = diaryEntries
    .map((fact) => ({ candidate: diaryCandidate(fact), score: scoreText(queryTerms, fact.text) }))
    .filter((entry) => entry.score > 0)

  const journalDir = journalDirForDiaryRoot(diaryRoot, options.journalDir)
  const journalCandidates = readJournalIndex(journalDir)
    .map((entry) => ({
      candidate: {
        text: `${entry.filename}: ${entry.preview}`,
        source: { kind: "journal" as const, label: "journal", ref: entry.filename },
      },
      score: scoreText(queryTerms, `${entry.filename} ${entry.preview}`),
    }))
    .filter((entry) => entry.score > 0)

  return [...diaryCandidates, ...journalCandidates, ...friendNoteCandidates(options.friend, queryTerms)]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.candidate)
}

function selectedSources(candidates: KeptNoteCandidate[], indexes?: number[]): KeptNoteSource[] {
  if (!indexes || indexes.length === 0) return []
  const sources: KeptNoteSource[] = []
  for (const index of indexes) {
    if (!Number.isInteger(index)) continue
    const candidate = candidates[index]
    if (candidate) sources.push(candidate.source)
  }
  return sources
}

function isFirstPerson(text: string): boolean {
  return /^(i|i'm|i’ve|i've|my|me)\b/i.test(text.trim())
}

function foundLine(text: string): string {
  const trimmed = text.trim()
  if (isFirstPerson(trimmed)) return trimmed
  return `I kept this: ${trimmed}`
}

function fuzzyLine(text: string): string {
  const trimmed = text.trim()
  if (isFirstPerson(trimmed)) return trimmed
  return `I may have kept something related: ${trimmed}`
}

const SOURCE_KIND_ORDER: KeptNoteSource["kind"][] = ["diary", "journal", "friend-note"]
const SOURCE_KIND_LABELS: Record<KeptNoteSource["kind"], string> = {
  diary: "my diary",
  journal: "my journal",
  "friend-note": "my friend notes",
}

function joinLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

function sourceHeading(sources: KeptNoteSource[]): string {
  const sourceKinds = new Set(sources.map((source) => source.kind))
  const labels = SOURCE_KIND_ORDER
    .filter((kind) => sourceKinds.has(kind))
    .map((kind) => SOURCE_KIND_LABELS[kind])
  if (labels.length === 0) return "## from notes i chose to keep"
  return `## from ${joinLabels(labels)}`
}

export function renderKeptNotesOutcome(outcome: KeptNotesOutcome): string | null {
  if (outcome.status === "found") {
    return `${sourceHeading(outcome.sources)}\nThis may matter now:\n${foundLine(outcome.note)}`
  }
  if (outcome.status === "fuzzy") {
    return `${sourceHeading(outcome.sources)}\nThis is only a possible match; I should verify it before relying on it:\n${fuzzyLine(outcome.hint)}`
  }
  return null
}

function finish(outcome: KeptNotesOutcome, traceId?: string): KeptNotesOutcome {
  emitNervesEvent({
    component: "mind",
    event: "mind.kept_notes_end",
    trace_id: traceId,
    message: "kept notes completed",
    meta: { status: outcome.status, elapsedMs: outcome.elapsedMs },
  })
  return outcome
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return await new Promise<T | "timeout">((resolve, reject) => {
    const timeout = setTimeout(() => resolve("timeout"), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timeout)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timeout)
        reject(error)
      })
  })
}

export async function injectKeptNotes(
  messages: OpenAI.ChatCompletionMessageParam[],
  options: InjectKeptNotesOptions = {},
): Promise<KeptNotesOutcome> {
  const startedAt = Date.now()
  const systemMessage = messages[0]
  const query = latestUserText(messages)

  if (systemMessage?.role !== "system" || typeof systemMessage.content !== "string" || !query) {
    return { status: "none", elapsedMs: elapsedSince(startedAt), pressure: [] }
  }

  emitNervesEvent({
    component: "mind",
    event: "mind.kept_notes_start",
    trace_id: options.traceId,
    message: "kept notes started",
    meta: { channel: options.channel ?? "unknown" },
  })

  try {
    const candidates = gatherKeptNotesCandidates(query, options)
    if (candidates.length === 0 || !options.judge) {
      return finish({ status: "none", elapsedMs: elapsedSince(startedAt), pressure: [] }, options.traceId)
    }

    const judged = await withTimeout(
      options.judge({ query, candidates }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (judged === "timeout") {
      return finish({ status: "timeout", elapsedMs: elapsedSince(startedAt) }, options.traceId)
    }

    const elapsedMs = elapsedSince(startedAt)
    const outcome: KeptNotesOutcome =
      judged.status === "found"
        ? { status: "found", note: judged.note, sources: selectedSources(candidates, judged.sourceIndexes), elapsedMs }
        : judged.status === "fuzzy"
          ? { status: "fuzzy", hint: judged.hint, sources: selectedSources(candidates, judged.sourceIndexes), elapsedMs }
          : { status: "none", pressure: judged.pressure, elapsedMs }

    if (outcome.status === "found" || outcome.status === "fuzzy") {
      const rendered = renderKeptNotesOutcome(outcome)
      messages[0] = { role: "system", content: `${systemMessage.content}\n\n${rendered}` }
      emitNervesEvent({
        component: "mind",
        event: "mind.kept_notes_injected",
        trace_id: options.traceId,
        message: "kept notes injected",
        meta: { status: outcome.status, sourceCount: outcome.sources.length },
      })
    }

    return finish(outcome, options.traceId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const outcome: KeptNotesOutcome = { status: "error", reason, elapsedMs: elapsedSince(startedAt) }
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.kept_notes_error",
      trace_id: options.traceId,
      message: "kept notes failed",
      meta: { reason },
    })
    return finish(outcome, options.traceId)
  }
}

function parseJudgeResult(content: string): KeptNotesJudgeResult {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "none", pressure: ["invalid kept notes judge output"] }
    }
    const record = parsed as Record<string, unknown>
    if (record.status === "found" && typeof record.note === "string" && record.note.trim()) {
      return {
        status: "found",
        note: record.note.trim(),
        sourceIndexes: Array.isArray(record.sourceIndexes) ? record.sourceIndexes.filter((index): index is number => typeof index === "number") : undefined,
      }
    }
    if (record.status === "fuzzy" && typeof record.hint === "string" && record.hint.trim()) {
      return {
        status: "fuzzy",
        hint: record.hint.trim(),
        sourceIndexes: Array.isArray(record.sourceIndexes) ? record.sourceIndexes.filter((index): index is number => typeof index === "number") : undefined,
      }
    }
    if (record.status === "none") {
      return {
        status: "none",
        pressure: Array.isArray(record.pressure) ? record.pressure.filter((value): value is string => typeof value === "string") : [],
      }
    }
    return { status: "none", pressure: ["invalid kept notes judge output"] }
  } catch {
    return { status: "none", pressure: ["invalid kept notes judge output"] }
  }
}

function createJudgePrompt(input: KeptNotesJudgeInput): OpenAI.ChatCompletionMessageParam[] {
  const candidates = input.candidates
    .map((candidate, index) => `${index}. [${candidate.source.kind}] ${candidate.text}`)
    .join("\n")
  return [
    {
      role: "system",
      content: [
        "Decide whether these intentionally kept notes matter to the user's current turn.",
        "Return only JSON.",
        "Use found when a note clearly helps, fuzzy when a note is close but uncertain, and none when nothing should be surfaced.",
        "Shapes: {\"status\":\"found\",\"note\":\"...\",\"sourceIndexes\":[0]}, {\"status\":\"fuzzy\",\"hint\":\"...\",\"sourceIndexes\":[0]}, or {\"status\":\"none\",\"pressure\":[]}.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Current turn:\n${input.query}\n\nCandidates:\n${candidates}`,
    },
  ]
}

export function createKeptNotesJudge(runtime: KeptNotesRuntime, signal?: AbortSignal): KeptNotesJudge {
  return async (input) => {
    const messages = createJudgePrompt(input)
    runtime.resetTurnState?.(messages)
    const result = await runtime.streamTurn({
      messages,
      activeTools: [],
      callbacks: NOOP_CALLBACKS,
      signal,
      toolChoiceRequired: false,
      reasoningEffort: "low",
    })
    return parseJudgeResult(result.content ?? "")
  }
}
